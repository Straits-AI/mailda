import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import worker from "../src/index.ts";
import { checkKeptForwards } from "../src/doctor/delivery.ts";
import { COPY_TOPIC, keptForwards, setKeptForwardCopy } from "../src/kept-forward.ts";
import { materialiseReceipt } from "../src/materialise.ts";
import { dispatch } from "../src/pipeline.ts";
import { metering } from "../src/cost-meter.ts";
import { dispatchOne } from "../src/outbound/dispatch.ts";
import { renderRfc822 } from "../src/outbound/manifest.ts";
import { resendMayDuplicate, retryEffect } from "../src/outbound/retry.ts";
import { bindEnvelope, ENVELOPE_COLUMNS, type EnvelopeRow } from "../src/outbound/recheck.ts";
import type { TransportAdapter } from "../src/outbound/transport.ts";

/**
 * A copy when a kept forward is refused as not verified (ADR 47, amended 3 October 2026): the stored message sealed
 * again as an ordinary send, From the address with the sender's name in the display name, Reply-To the sender, the
 * body as written. Every refusal is recorded on the attempt row; nothing is copied twice.
 */

const testEnv = env as unknown as Env;
const ORG = "org_keptcopy";
const MAILBOX = "mbx_keptcopy";
const ADDRESS = "hello@keptcopy.example";
const DEST = "someone@gmail.test";
const CLAIM = "clm_01KEPTCOPYMARKER0000000000";
const ADMIN = "usr_01KEPTCOPYADMIN00000000000";
const NOT_VERIFIED = "destination address not verified";

const BODY = "--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello there, café.\r\n--b1--\r\n";
const ORIGINAL = [
  'From: "Alice Example" <alice@sender.example>',
  "To: hello@keptcopy.example",
  "Subject: Quarterly figures",
  "Message-ID: <orig-1@sender.example>",
  "In-Reply-To: <earlier@sender.example>",
  "References: <root@sender.example> <earlier@sender.example>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  BODY,
].join("\r\n");

async function tuple(subject: string, relation: string, objectType: string, objectId: string) {
  await testEnv.CATALOG.prepare(
    "INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at) VALUES (?,?,?,?,?,?,?)",
  ).bind(createSystemCtx().id("rt"), ORG, subject, relation, objectType, objectId, new Date().toISOString()).run();
}

beforeEach(async () => {
  for (const table of ["outbox", "log_entries", "ingress_receipts", "addresses", "mailboxes", "node_claim", "kept_forward_attempts",
    "messages", "send_manifests", "send_recipients", "send_copies", "relationship_tuples", "audit_entries", "mailbox_items", "cases"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = new Date().toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,'x',?,?)").bind(CLAIM, at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)").bind(MAILBOX, ORG, "Whyme Labs", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at, kept_forward_to, copy_by, copy_at) VALUES (?,?,?,?,?,?,?,?)",
    ).bind("addr_keptcopy", ORG, ADDRESS, MAILBOX, at, DEST, ADMIN, at),
  ]);
  await tuple(ADMIN, "org.admin", "organization", ORG);
  await tuple(ADMIN, "send.propose", "mailbox", MAILBOX);
});

/** One delivery through the email handler, forward() answering as `forward` says, then the outbox's copy events. */
async function deliver(options: { raw?: string; headers?: Record<string, string>; forward?: () => Promise<unknown> } = {}) {
  const raw = options.raw ?? ORIGINAL;
  const message = {
    from: "alice@sender.example",
    to: ADDRESS,
    headers: new Headers({ "message-id": `<${crypto.randomUUID()}@sender.example>`, ...options.headers }),
    raw: new Response(raw).body,
    rawSize: raw.length,
    setReject: () => { throw new Error("a stored message is never rejected"); },
    forward: options.forward ?? (async () => { throw new Error(NOT_VERIFIED); }),
  } as unknown as ForwardableEmailMessage;
  /*
   * The outbox's Durable Object is counted, not run: armed for real it drains the same events on its own alarm, and
   * can still be draining one test's after the next test's `beforeEach`, which made these tests flaky. `drainCopies`
   * runs the handler instead.
   */
  let armed = 0;
  const sweeper = { getByName: () => ({ schedule: async () => { armed++; } }) };
  const execution = createExecutionContext();
  await worker.email!(message, { ...testEnv, OUTBOX_SWEEPER: sweeper } as unknown as Env, execution);
  await waitOnExecutionContext(execution);
  return { armed };
}

/** Consumes the copy events the way the sweeper would, through the registered handler. */
async function drainCopies(): Promise<number> {
  const { results } = await testEnv.CATALOG.prepare("SELECT id, org_id, topic, payload FROM outbox WHERE topic = ?")
    .bind(COPY_TOPIC).all<{ id: string; org_id: string; topic: string; payload: string }>();
  for (const event of results) await dispatch(testEnv, createSystemCtx(), { id: event.id, orgId: event.org_id, topic: event.topic, payload: event.payload });
  return results.length;
}

const attempt = async () => await testEnv.CATALOG.prepare(
  "SELECT state, error, copy_state, copy_error FROM kept_forward_attempts LIMIT 1",
).first<{ state: string; error: string | null; copy_state: string | null; copy_error: string | null }>();

const copies = async () => (await testEnv.CATALOG.prepare(
  "SELECT c.manifest_id, m.envelope_to, m.subject, m.state, m.author_user_id FROM send_copies c JOIN send_manifests m ON m.id = c.manifest_id",
).all<{ manifest_id: string; envelope_to: string; subject: string; state: string; author_user_id: string }>()).results;

describe("a copy when the kept forward is refused as not verified", () => {
  it("seals the original as a send from the address, under the administrator's opt-in, with the forward's refusal kept", async () => {
    // Armed twice: once for the delivery, and again for the copy asked for after it.
    expect((await deliver()).armed).toBe(2);
    expect(await drainCopies()).toBe(1);
    expect(await attempt()).toMatchObject({ state: "refused", error: NOT_VERIFIED, copy_state: "sealed", copy_error: null });
    const [copy] = await copies();
    expect(copy).toMatchObject({ envelope_to: JSON.stringify([DEST]), subject: "Quarterly figures", author_user_id: ADMIN });
    // The Node sealed it; the administrator is the one accountable, never the actor.
    const sealed = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, actor_kind, delegator_user_id, detail FROM audit_entries WHERE action = 'send.sealed' AND subject = ?",
    ).bind(copy!.manifest_id).first<{ actor_user_id: string | null; actor_kind: string; delegator_user_id: string | null; detail: string }>();
    expect(sealed).toMatchObject({ actor_user_id: null, actor_kind: "node", delegator_user_id: ADMIN });
    expect(JSON.parse(sealed!.detail).copyOf).toMatchObject({ messageId: expect.stringMatching(/^msg_/) });
  });

  it("renders the sender's name via the mailbox, Reply-To the sender, the thread's ids, both markers, and the body byte for byte", async () => {
    await deliver();
    await drainCopies();
    const [copy] = await copies();
    const text = new TextDecoder().decode((await renderRfc822(testEnv, copy!.manifest_id)).raw);
    const [head, body] = [text.slice(0, text.indexOf("\r\n\r\n")), text.slice(text.indexOf("\r\n\r\n") + 4)];
    expect(head).toContain('From: "Alice Example via Whyme Labs" <hello@keptcopy.example>');
    expect(head).toContain('Reply-To: "Alice Example" <alice@sender.example>');
    expect(head).toContain('X-Original-From: "Alice Example" <alice@sender.example>');
    expect(head).toContain(`X-Mailda-Copy-Of: ${CLAIM}`);
    expect(head).toContain("To: someone@gmail.test");
    expect(head).toContain("Subject: Quarterly figures");
    expect(head).toContain('Content-Type: multipart/alternative; boundary="b1"');
    expect(head).toContain("Content-Transfer-Encoding: 8bit");
    expect(head).toContain("In-Reply-To: <earlier@sender.example>");
    expect(head).toContain("References: <root@sender.example> <earlier@sender.example>");
    // A new Message-ID, never the original's.
    expect(head).toMatch(/Message-ID: <snd_[0-9A-Z]+@keptcopy\.example>/);
    expect(head).not.toContain("orig-1@sender.example");
    expect(body).toBe(BODY);
  });

  it("binds, in its effect envelope, exactly the header names its bytes carry", async () => {
    await deliver();
    await drainCopies();
    const [copy] = await copies();
    const text = new TextDecoder().decode((await renderRfc822(testEnv, copy!.manifest_id)).raw);
    const names = text.slice(0, text.indexOf("\r\n\r\n")).split("\r\n").filter((line) => !line.startsWith(" "))
      .map((line) => line.slice(0, line.indexOf(":")));
    const row = await testEnv.CATALOG.prepare(`SELECT ${ENVELOPE_COLUMNS} FROM send_manifests WHERE id = ?`)
      .bind(copy!.manifest_id).first<EnvelopeRow>();
    const transport = { name: "test", capability: async () => ({ canSend: true, arbitraryRecipients: true, verifiedAt: null }) };
    expect((await bindEnvelope(testEnv, ORG, copy!.manifest_id, row!, transport as never)).emittedHeaders).toEqual(names);
    expect(names).toContain("In-Reply-To");
  });

  it("seals one copy however often the outbox delivers the event", async () => {
    await deliver();
    await drainCopies();
    await drainCopies();
    expect(await copies()).toHaveLength(1);
  });

  it("asks for no copy when the address did not opt in", async () => {
    await testEnv.CATALOG.prepare("UPDATE addresses SET copy_by = NULL, copy_at = NULL").run();
    expect((await deliver()).armed).toBe(1);
    expect(await drainCopies()).toBe(0);
    expect(await attempt()).toMatchObject({ state: "refused", copy_state: null });
  });

  it("asks for no copy on a refusal not measured to deliver nothing, and says why", async () => {
    await deliver({ forward: async () => { throw new Error("message already forwarded to this destination"); } });
    expect(await drainCopies()).toBe(0);
    const row = await attempt();
    expect(row?.copy_state).toBe("refused");
    expect(row?.copy_error).toContain("may already have this message");
  });

  it("asks for no copy when the forward was handed over", async () => {
    await deliver({ forward: async () => undefined });
    expect(await drainCopies()).toBe(0);
    expect(await attempt()).toMatchObject({ state: "handed_over", copy_state: null });
  });

  it("withholds the forward of a copy that came back, by its X-Mailda-Copy-Of marker, so nothing is copied", async () => {
    await deliver({ headers: { "x-mailda-copy-of": CLAIM } });
    expect(await drainCopies()).toBe(0);
    expect(await attempt()).toMatchObject({ state: "withheld", copy_state: null });
  });
});

describe("what a copy refuses, each recorded on the attempt", () => {
  const refusedWith = async (fragment: string) => {
    expect(await drainCopies()).toBe(1);
    const row = await attempt();
    expect(row?.copy_state).toBe("refused");
    expect(row?.copy_error).toContain(fragment);
    expect(await copies()).toHaveLength(0);
  };

  it("an opt-in turned off between the refusal and the copy", async () => {
    await deliver();
    await testEnv.CATALOG.prepare("UPDATE addresses SET copy_by = NULL, copy_at = NULL").run();
    await refusedWith("copies were turned off");
  });

  it("an administrator who no longer is one", async () => {
    await deliver();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE relation = 'org.admin'").run();
    await refusedWith("is no longer an administrator");
  });

  it("an administrator who may not send as the mailbox", async () => {
    await deliver();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE relation = 'send.propose'").run();
    await refusedWith("E_MAY_NOT_SEND_AS_MAILBOX");
  });

  it("a destination on a domain this organisation receives at", async () => {
    await testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES ('addr_two', ?, 'x@gmail.test', ?, ?)")
      .bind(ORG, MAILBOX, new Date().toISOString()).run();
    await deliver();
    await refusedWith("where this organisation receives mail");
  });

  it("a quarantined message", async () => {
    await testEnv.CATALOG.prepare("UPDATE mailboxes SET quarantine_dangerous_attachments = 1").run();
    await deliver({ raw: withAttachment("run.exe", "TVqQAAMAAAAEAAAA") });
    await refusedWith("quarantined");
  });

  it("a message with an attachment this Node judges dangerous", async () => {
    await deliver({ raw: withAttachment("run.exe", "TVqQAAMAAAAEAAAA") });
    await refusedWith("judges dangerous");
  });

  it("a message whose attachments this Node could not read", async () => {
    await deliver();
    // Filed first, then made unread: NULL is what the parser leaves when it could not look (0057).
    const { receiptId } = JSON.parse((await testEnv.CATALOG.prepare("SELECT payload FROM outbox WHERE topic = ?").bind(COPY_TOPIC)
      .first<{ payload: string }>())!.payload) as { receiptId: string };
    await materialiseReceipt(testEnv, createSystemCtx(), receiptId);
    await testEnv.CATALOG.prepare("UPDATE messages SET attachments_dangerous = NULL").run();
    await refusedWith("could not read the message's attachments");
  });

  it("a message whose stored bytes carry this Node's marker, the second lock behind the email handler's", async () => {
    // The handler reads the envelope's headers; the copy reads the stored message. Only the second says so here.
    await deliver({ raw: `X-Mailda-Copy-Of: ${CLAIM}\r\n${ORIGINAL}` });
    await refusedWith("left this Node and came back");
  });

  it("a message that names no sender", async () => {
    await deliver({ raw: ORIGINAL.replace(/^From: .*\r\n/, "") });
    await refusedWith("names no sender");
  });

  it("a message whose sender's domain failed DMARC", async () => {
    await deliver({ raw: `Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=sender.example policy.dmarc=none\r\n${ORIGINAL}` });
    await refusedWith("failed DMARC");
  });

  it("a copy over email.outbound.max_bytes, naming the budget, the limit and the size", async () => {
    const big = "x".repeat(76) + "\r\n";
    const padding = big.repeat(Math.ceil(BUDGETS["email.outbound.max_bytes"] / big.length) + 1);
    await deliver({ raw: `From: alice@sender.example\r\nSubject: big\r\nContent-Type: text/plain\r\n\r\n${padding}` });
    await refusedWith(`email.outbound.max_bytes=${BUDGETS["email.outbound.max_bytes"]}, this copy is `);
  });

  it("a body with 8-bit bytes that are not UTF-8", async () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode("From: alice@sender.example\r\nSubject: l1\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\ncaf"), 0xe9, 0x0d, 0x0a]);
    await deliver({ raw: latin1 as unknown as string });
    await refusedWith("E_COPY_NOT_UTF8");
  });
});

describe("a sealed copy at dispatch", () => {
  const handedOver = (): TransportAdapter & { submitted: number } => {
    const transport = {
      submitted: 0, name: "test", capability: async () => ({ canSend: true, arbitraryRecipients: true, verifiedAt: null }),
      async submit() { transport.submitted++; return { kind: "handed_over" as const, transportMessageId: "<cf@keptcopy.example>" }; },
    };
    return transport as never;
  };
  const due = () => ({ ...createSystemCtx(), now: () => Date.now() + 3_600_000 });

  it("is handed over like any send", async () => {
    await deliver();
    await drainCopies();
    const [copy] = await copies();
    const transport = handedOver();
    expect((await dispatchOne(testEnv, due(), ORG, copy!.manifest_id, transport)).state).toBe("handed_over");
    expect(transport.submitted).toBe(1);
  });

  it("costs what a plain send does, plus the administrator's read and the original's evidence (dispatch-recheck-cost.md)", async () => {
    await deliver();
    await drainCopies();
    const [copy] = await copies();
    const metered = metering(testEnv);
    expect((await dispatchOne(metered.env, due(), ORG, copy!.manifest_id, handedOver())).state).toBe("handed_over");
    console.log(`MEASURE dispatch scenario=unapproved/copy  subrequests=${metered.cost.subrequests}  d1=${metered.cost.d1Executions}  r2=${metered.cost.r2Operations}  do_rpc=${metered.cost.doRpcs}`);
    // A stated bound per copy, as attachments have one per part: no body of its own to read, one evidence read of the
    // original instead, and the opt-in's isAdmin read (one or two D1 statements, the team arm included).
    expect(metered.cost.subrequests).toBeLessThanOrEqual(BUDGETS["send.dispatch_unapproved_max_subrequests"] + 2);
  });

  it("is withheld when the opt-in it was sealed under was turned off before hand-over", async () => {
    await deliver();
    await drainCopies();
    await testEnv.CATALOG.prepare("UPDATE addresses SET copy_by = NULL, copy_at = NULL").run();
    const [copy] = await copies();
    const transport = handedOver();
    const result = await dispatchOne(testEnv, due(), ORG, copy!.manifest_id, transport);
    expect(result).toMatchObject({ state: "withheld" });
    expect(result.detail).toContain("opt-in");
    expect(transport.submitted).toBe(0);
  });

  it("is withheld when its administrator is no longer one", async () => {
    await deliver();
    await drainCopies();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE relation = 'org.admin'").run();
    const [copy] = await copies();
    expect((await dispatchOne(testEnv, due(), ORG, copy!.manifest_id, handedOver())).state).toBe("withheld");
  });
});

function withAttachment(name: string, base64: string): string {
  return [
    "From: alice@sender.example", "Subject: with a file", "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="b2"', "",
    "--b2", "Content-Type: text/plain", "", "see attached", "--b2",
    `Content-Type: application/octet-stream; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`,
    "Content-Transfer-Encoding: base64", "", base64, "--b2--", "",
  ].join("\r\n");
}

describe("a fault while sealing a copy", () => {
  it("is thrown, so the outbox tries again, and leaves the attempt with no copy state", async () => {
    await deliver();
    await testEnv.CATALOG.prepare("ALTER TABLE send_copies RENAME TO send_copies_away").run();
    try {
      await expect(drainCopies()).rejects.toThrow();
    } finally {
      await testEnv.CATALOG.prepare("ALTER TABLE send_copies_away RENAME TO send_copies").run();
    }
    expect(await attempt()).toMatchObject({ state: "refused", copy_state: null });
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("turning copies on and off", () => {
  const ctx = createSystemCtx();
  const off = () => testEnv.CATALOG.prepare("UPDATE addresses SET copy_by = NULL, copy_at = NULL").run();

  it("records who and when, audited without the destination, and clears both when turned off", async () => {
    await off();
    const on = await setKeptForwardCopy(testEnv, ctx, ORG, ADMIN, "Hello@KeptCopy.example", true);
    expect(on).toMatchObject({ address: ADDRESS, to: DEST, by: ADMIN });
    const entry = await testEnv.CATALOG.prepare("SELECT actor_user_id, subject, detail FROM audit_entries WHERE action = 'kept_forward.copy_set'")
      .first<{ actor_user_id: string; subject: string; detail: string }>();
    expect(entry).toMatchObject({ actor_user_id: ADMIN, subject: ADDRESS });
    expect(entry!.detail).not.toContain(DEST);
    expect((await keptForwards(testEnv, ORG))[0]!.copy).toMatchObject({ by: ADMIN });
    expect(await setKeptForwardCopy(testEnv, ctx, ORG, ADMIN, ADDRESS, false)).toMatchObject({ by: null, at: null });
    expect((await keptForwards(testEnv, ORG))[0]!.copy).toBeNull();
  });

  it("refuses an address that keeps no forward", async () => {
    await testEnv.CATALOG.prepare("UPDATE addresses SET kept_forward_to = NULL").run();
    await expect(setKeptForwardCopy(testEnv, ctx, ORG, ADMIN, ADDRESS, true)).rejects.toThrow("E_ADDRESS_KEEPS_NO_FORWARD");
  });

  it("refuses an administrator who may not send as the mailbox", async () => {
    await off();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE relation = 'send.propose'").run();
    await expect(setKeptForwardCopy(testEnv, ctx, ORG, ADMIN, ADDRESS, true)).rejects.toThrow("E_COPY_NEEDS_SEND_PROPOSE");
    // Turning them off needs nothing but being an administrator.
    await expect(setKeptForwardCopy(testEnv, ctx, ORG, ADMIN, ADDRESS, false)).resolves.toMatchObject({ by: null });
  });

  it("refuses a destination on a domain this organisation receives at, including the address's own", async () => {
    await off();
    await testEnv.CATALOG.prepare("UPDATE addresses SET kept_forward_to = 'me@keptcopy.example'").run();
    await expect(setKeptForwardCopy(testEnv, ctx, ORG, ADMIN, ADDRESS, true)).rejects.toThrow("E_COPY_WOULD_LOOP");
    await testEnv.CATALOG.prepare("UPDATE addresses SET kept_forward_to = ?").bind(DEST).run();
    await testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES ('addr_g', ?, 'x@gmail.test', ?, ?)")
      .bind(ORG, MAILBOX, new Date().toISOString()).run();
    await expect(setKeptForwardCopy(testEnv, ctx, ORG, ADMIN, ADDRESS, true)).rejects.toThrow("E_COPY_WOULD_LOOP");
  });

  it("refuses a Node with no send_email binding", async () => {
    await off();
    await expect(setKeptForwardCopy({ ...testEnv, EMAIL: undefined } as unknown as Env, ctx, ORG, ADMIN, ADDRESS, true))
      .rejects.toThrow("E_COPY_NEEDS_SENDING");
  });
});

describe("what People and doctor read of copies", () => {
  it("names the sealed copy's send and its state on the latest attempt, and doctor does not call it getting nothing", async () => {
    await deliver();
    await drainCopies();
    const [row] = await keptForwards(testEnv, ORG);
    const [copy] = await copies();
    expect(row!.last!.copy).toMatchObject({ state: "sealed", sendId: copy!.manifest_id, sendState: "held", error: null });
    expect((await checkKeptForwards(testEnv, createSystemCtx(), ORG))[0]).toMatchObject({ ok: true });
  });

  it("names a refused copy's reason, and doctor degrades saying a copy was refused", async () => {
    await deliver();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE relation = 'org.admin'").run();
    await drainCopies();
    const [row] = await keptForwards(testEnv, ORG);
    expect(row!.last!.copy).toMatchObject({ state: "refused", sendId: null });
    const [finding] = await checkKeptForwards(testEnv, createSystemCtx(), ORG);
    expect(finding).toMatchObject({ ok: false });
    expect(finding!.detail).toContain("1 of them asked for a copy that was refused");
  });
});

describe("a copy after its first dispatch", () => {
  const due = () => ({ ...createSystemCtx(), now: () => Date.now() + 3_600_000 });
  const transport = (outcome: object) => ({
    name: "test", capability: async () => ({ canSend: true, arbitraryRecipients: true, verifiedAt: null }),
    submitted: [] as Uint8Array[],
    async submit(_env: Env, request: { raw?: Uint8Array }) { this.submitted.push(request.raw!); return outcome; },
  });

  it("is never resent from its manifest, whose own body is empty", async () => {
    await deliver();
    await drainCopies();
    const [copy] = await copies();
    await testEnv.CATALOG.prepare("UPDATE send_manifests SET state = 'outcome_unknown', submitted_key = 'x' WHERE id = ?").bind(copy!.manifest_id).run();
    await expect(resendMayDuplicate(testEnv, createSystemCtx(), ORG, { userId: ADMIN, acceptDuplicateRisk: true, reason: "again" }, copy!.manifest_id))
      .rejects.toThrow("E_RESEND_NOT_FOR_A_COPY");
  });

  it("is retried, after a throttle, with the original's body again", async () => {
    await deliver();
    await drainCopies();
    const [copy] = await copies();
    const throttled = transport({ kind: "throttled", reason: "slow down" });
    expect((await dispatchOne(testEnv, due(), ORG, copy!.manifest_id, throttled as never)).state).toBe("throttled");
    const again = transport({ kind: "handed_over", transportMessageId: "<cf@keptcopy.example>" });
    await retryEffect(testEnv, due(), ORG, ADMIN, copy!.manifest_id, again as never);
    expect(new TextDecoder().decode(again.submitted[0])).toContain(BODY);
  });

  it("is refused at render when the original no longer hashes to its receipt", async () => {
    await deliver();
    await drainCopies();
    const [copy] = await copies();
    await testEnv.CATALOG.prepare("UPDATE messages SET blob_sha256 = 'f00d'").run();
    await expect(renderRfc822(testEnv, copy!.manifest_id)).rejects.toThrow("E_ORIGINAL_CHANGED");
  });

  it("whose send stopped for good leaves doctor saying the destination is getting nothing", async () => {
    await deliver();
    await drainCopies();
    const [copy] = await copies();
    await testEnv.CATALOG.prepare("UPDATE send_manifests SET state = 'refused' WHERE id = ?").bind(copy!.manifest_id).run();
    const [finding] = await checkKeptForwards(testEnv, createSystemCtx(), ORG);
    expect(finding).toMatchObject({ ok: false });
    expect(finding!.detail).toContain("with no copy that is still going");
  });
});
