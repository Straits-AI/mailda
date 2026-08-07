import { utf8 } from "@mailda/evidence";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { getEvidence, putEvidence } from "../src/evidence-store.ts";
import {
  cancelSend, dailySendState, dispatchDue, dispatchOne, isAutoRetryable,
} from "../src/outbound/dispatch.ts";
import { normalizeBody, rebuildReferences, renderRfc822, sealManifest } from "../src/outbound/manifest.ts";
import { HeaderBlock, normalizeAddress, safeFilename } from "../src/outbound/headers.ts";
import { CallerError } from "../src/errors.ts";
import { classifyError, type SubmitOutcome, type TransportAdapter } from "../src/outbound/transport.ts";

const testEnv = env as unknown as Env;
const ORG = "org_outbound";
const MAILBOX = "mbx_outbound";
const ADDRESS = "support@acme.example";
const AUTHOR = "usr_alice";

/** A transport that returns whatever the test asks for, and records what it was handed. */
function fakeTransport(outcome: SubmitOutcome): TransportAdapter & { submitted: unknown[] } {
  const submitted: unknown[] = [];
  return {
    name: "fake",
    submitted,
    async capability() {
      return { canSend: true, arbitraryRecipients: true, verifiedAt: "2026-08-04T00:00:00.000Z", detail: "fake" };
    },
    async submit(_env, request, fidelity) {
      submitted.push({ request, fidelity });
      return outcome;
    },
  };
}

/** A ctx with a controlled clock and real entropy — frozen ctx would collide on ULID keys. */
function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  for (const table of ["send_manifests", "send_counters", "messages", "addresses", "mailboxes",
                       "node_capabilities", "relationship_tuples",
                       "send_recipients", "send_recipient_events"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    // Sending is authorized explicitly. Before Layer 2 this fixture needed no grant, because sealing
    // checked only that the mailbox was in the organisation — which is the hole the grant closes.
    grantSend(ctx, AUTHOR, MAILBOX),
  ]);
});

/** The tuple that lets a principal send as a mailbox. §7 reads it live on every seal and dispatch. */
function grantSend(ctx: Ctx, userId: string, mailboxId: string) {
  return testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, userId, "send.propose", "mailbox", mailboxId,
    new Date(ctx.now()).toISOString());
}

const composition = {
  mailboxId: MAILBOX,
  authorUserId: AUTHOR,
  to: ["customer@example.net"],
  subject: "Re: Invoice 4500219877",
  bodyTyped: "We have revised the schedule.   \r\nBest,\nSupport",
  fidelity: "authored" as const,
};

describe("normalization (ADR 35)", () => {
  it("normalizes line endings and trailing whitespace, and nothing else", () => {
    // Anything that could change *meaning* is excluded, because approval binds this output — a
    // normalizer that altered meaning would mean the approver reviewed something else.
    expect(normalizeBody("a  \r\nb\nc")).toBe("a\r\nb\r\nc");
    // A trailing line terminator is *preserved*, not trimmed: the input had one, and dropping it
    // would change the body — which is the one thing this function must not do.
    expect(normalizeBody("a\r\nb\nc\r")).toBe("a\r\nb\r\nc\r\n");
    expect(normalizeBody('He said "hi" -- really')).toBe('He said "hi" -- really');
  });
});

describe("sealing a manifest (ADR 35)", () => {
  it("seals into `held`, which is what makes undo honest", async () => {
    const sealed = await sealManifest(testEnv, createSystemCtx(), ORG, composition);
    expect(sealed.state).toBe("held");
    expect(sealed.id).toMatch(/^snd_/);
    // Nothing has been sent. Cancelling stops something that genuinely never left.
    const row = await testEnv.CATALOG.prepare("SELECT state, attempts FROM send_manifests WHERE id = ?")
      .bind(sealed.id).first<{ state: string; attempts: number }>();
    expect(row?.state).toBe("held");
    expect(row?.attempts).toBe(0);
  });

  it("stores both bodies, so a later dispute about normalization is settleable", async () => {
    const sealed = await sealManifest(testEnv, createSystemCtx(), ORG, composition);
    const row = await testEnv.CATALOG.prepare(
      "SELECT body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256 FROM send_manifests WHERE id = ?",
    ).bind(sealed.id).first<Record<string, string>>() as Record<string, string>;

    const typed = new TextDecoder().decode(await getEvidence(testEnv, row.body_typed_key!));
    const normalized = new TextDecoder().decode(await getEvidence(testEnv, row.body_normalized_key!));
    expect(typed).toBe(composition.bodyTyped);
    expect(normalized).toBe(normalizeBody(composition.bodyTyped));
    expect(row.body_typed_sha256).not.toBe(row.body_normalized_sha256);
  });

  it("makes editing impossible by giving a revision a new id (ADR 11, ADR 35)", async () => {
    const ctx = createSystemCtx();
    const first = await sealManifest(testEnv, ctx, ORG, composition);
    const revised = await sealManifest(testEnv, ctx, ORG, { ...composition, bodyTyped: "Different." });

    // An approval bound to `first.id` references a manifest nobody will dispatch. Invalidation is a
    // property of the identifiers rather than a rule someone must remember to enforce.
    expect(revised.id).not.toBe(first.id);
    const count = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests").first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("honours a per-mailbox hold window, including zero", async () => {
    const at = 2_000_000_000_000;
    const byDefault = await sealManifest(testEnv, atTime(at), ORG, composition);
    expect(Date.parse(byDefault.releaseAt) - at).toBe(BUDGETS["send.hold_window_default_seconds"] * 1000);

    // Zero is a legitimate configuration, not a missing value — a password-reset mailbox needs it.
    await testEnv.CATALOG.prepare("UPDATE mailboxes SET hold_window_seconds = 0 WHERE id = ?").bind(MAILBOX).run();
    const immediate = await sealManifest(testEnv, atTime(at), ORG, composition);
    expect(Date.parse(immediate.releaseAt)).toBe(at);
  });

  it("refuses a mailbox with no address, because From is the mailbox (ADR 36)", async () => {
    await testEnv.CATALOG.prepare("DELETE FROM addresses").run();
    await expect(sealManifest(testEnv, createSystemCtx(), ORG, composition)).rejects.toThrow(
      /E_MAILBOX_HAS_NO_ADDRESS/,
    );
  });
});

describe("rendering (ADR 36)", () => {
  it("puts the mailbox in From and the author nowhere", async () => {
    const sealed = await sealManifest(testEnv, createSystemCtx(), ORG, composition);
    const { raw } = await renderRfc822(testEnv, sealed.id);
    const text = new TextDecoder().decode(raw);

    expect(text).toContain(`From: ${ADDRESS}`);
    // A staff name in From discloses employee identity and turnover to every correspondent,
    // permanently. The author is in the manifest and the audit trail, never on the wire.
    expect(text).not.toContain(AUTHOR);
    expect(text).toContain("To: customer@example.net");
    expect(text).toContain(`Message-ID: <${sealed.rfcMessageId}>`);
  });

  it("omits Bcc from the headers while keeping it in the manifest", async () => {
    const sealed = await sealManifest(testEnv, createSystemCtx(), ORG, {
      ...composition, bcc: ["archive@acme.example"],
    });
    const text = new TextDecoder().decode((await renderRfc822(testEnv, sealed.id)).raw);

    // That is what Bcc means: the other recipients must not learn it. The envelope carries it.
    expect(text).not.toContain("archive@acme.example");
    const row = await testEnv.CATALOG.prepare("SELECT envelope_bcc FROM send_manifests WHERE id = ?")
      .bind(sealed.id).first<{ envelope_bcc: string }>();
    expect(JSON.parse(row!.envelope_bcc)).toEqual(["archive@acme.example"]);
  });
});

describe("header injection", () => {
  const ctx = () => createSystemCtx();

  it("refuses CR, LF or NUL in a subject — the canonical mail vulnerability", async () => {
    // ADR 36 keeps the author out of headers and Bcc out of the emitted headers. A subject carrying
    // `\r\nBcc:` defeats *both* decisions at once, and lets an author end the header block early.
    for (const hostile of ["ok\r\nBcc: attacker@example.net", "ok\nX-Evil: 1", "ok\u0000trunc"]) {
      await expect(
        sealManifest(testEnv, ctx(), ORG, { ...composition, subject: hostile }),
      ).rejects.toThrow(/E_HEADER_INJECTION/);
    }
    // Nothing hostile reached the database.
    const count = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("refuses it in recipients too, not only the subject", async () => {
    await expect(
      sealManifest(testEnv, ctx(), ORG, { ...composition, to: ["a@b.com\r\nBcc: c@d.com"] }),
    ).rejects.toThrow(/E_HEADER_INJECTION/);
    await expect(
      sealManifest(testEnv, ctx(), ORG, { ...composition, bcc: ["x@y.com\nX-Evil: 1"] }),
    ).rejects.toThrow(/E_HEADER_INJECTION/);
  });

  it("rejects rather than strips, because sending altered bytes is worse", () => {
    // ADR 35: the bytes sent must be the bytes approved. Silently removing a control character and
    // sending anyway is exactly the quiet alteration that forbids.
    expect(() => new HeaderBlock().add("Subject", "clean")).not.toThrow();
    expect(() => new HeaderBlock().add("Subject", "dirty\r\n")).toThrow(/refused rather than stripped/);
  });

  it("makes injection unrepresentable rather than checked — a NEW header cannot bypass it", () => {
    // This is the property that matters, and the reason this is a builder rather than a set of
    // asserts. There is no array to push a pre-formatted line onto, so a future author adding a
    // header gets the validation whether they thought about it or not.
    const block = new HeaderBlock();
    expect(() => block.add("X-Someone-Adds-This-Later", "value\r\nBcc: attacker@example.net")).toThrow(
      /E_HEADER_INJECTION/,
    );
    // And the only exit produces bytes from fields that all went through add().
    expect(block.fieldCount).toBe(0);
    const bytes = new HeaderBlock().add("Subject", "hi").bytes("body");
    expect(new TextDecoder().decode(bytes)).toBe("Subject: hi\r\n\r\nbody");
  });

  it("refuses an invalid header name too, not only a hostile value", () => {
    expect(() => new HeaderBlock().add("Bad: Name", "x")).toThrow(/E_HEADER_NAME_INVALID/);
    expect(() => new HeaderBlock().add("Has Space", "x")).toThrow(/E_HEADER_NAME_INVALID/);
  });

  it("carries its own HTTP status, so there is no table to keep in agreement", () => {
    try {
      new HeaderBlock().add("Subject", "x\r\ny");
      expect.unreachable();
    } catch (error) {
      // ADR 35 rejected exactly this correspondence for the effect key: two places that must agree.
      expect(error).toBeInstanceOf(CallerError);
      expect((error as CallerError).status).toBe(422);
      expect((error as CallerError).code).toBe("E_HEADER_INJECTION");
    }
  });

  it("encodes a non-ASCII subject rather than sending it raw", async () => {
    // A raw UTF-8 header is non-conformant even when it survives, and mime.ts has decoded these words
    // since #27 — the encoder's absence was a correctness gap, not only a hardening one.
    const sealed = await sealManifest(testEnv, ctx(), ORG, { ...composition, subject: "Réf: café" });
    const text = new TextDecoder().decode((await renderRfc822(testEnv, sealed.id)).raw);
    expect(text).toContain("Subject: =?utf-8?B?");
    expect(text).not.toContain("Réf");
  });

  it("punycodes an internationalised domain instead of refusing it (ADR 41)", async () => {
    // The first fix refused every non-ASCII address, which would have made Mailda unable to write to
    // anyone on an internationalised domain — a product limitation invented inside a security fix.
    expect(normalizeAddress("to", "sales@café.example")).toBe("sales@xn--caf-dma.example");
    expect(normalizeAddress("to", "A.User@Example.COM")).toBe("A.User@example.com");

    const sealed = await sealManifest(testEnv, ctx(), ORG, { ...composition, to: ["sales@café.example"] });
    const text = new TextDecoder().decode((await renderRfc822(testEnv, sealed.id)).raw);
    expect(text).toContain("To: sales@xn--caf-dma.example");
  });

  it("refuses a non-ASCII local part, naming SMTPUTF8 as the reason", () => {
    // Unlike a domain, a mailbox name has no ASCII encoding. Refused with the actual reason rather
    // than as "invalid address", because the two are different problems with different remedies.
    expect(() => normalizeAddress("to", "café@example.net")).toThrow(/E_SMTPUTF8_UNSUPPORTED/);
    expect(() => normalizeAddress("to", "café@example.net")).toThrow(/SMTPUTF8/);
  });

  it("refuses a malformed address distinctly from a hostile one", () => {
    expect(() => normalizeAddress("to", "no-at-sign")).toThrow(/E_ADDRESS_MALFORMED/);
    expect(() => normalizeAddress("to", "@example.net")).toThrow(/E_ADDRESS_MALFORMED/);
    expect(() => normalizeAddress("to", "a@b\r\nBcc: c@d")).toThrow(/E_HEADER_INJECTION/);
  });

  it("sanitises a filename for Content-Disposition", () => {
    // Found by audit rather than review, and not exploitable today — but "not reachable" was a
    // property of two other functions rather than of this one.
    expect(safeFilename('rcpt_123"; x="y', ".eml")).toBe("rcpt_123___x__y.eml");
    expect(safeFilename("", ".eml")).toBe("message.eml");
    expect(safeFilename("../../etc/passwd", ".eml")).toBe(".._.._etc_passwd.eml");
  });
});

describe("cross-tenant references", () => {
  it("refuses to seal a reply to another organization's message", async () => {
    const ctx = createSystemCtx();
    const foreign = ctx.id("msg");
    const at = new Date(ctx.now()).toISOString();
    await testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes,
         rfc_message_id, thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
         created_at) VALUES (?,'org_someone_else','2026-Q3','k','h',1,'secret@theirs.com',?,'s','f@x',?,?,?,?)`,
    ).bind(foreign, ctx.id("thr"), at, at, ctx.id("rcpt"), at).run();

    // Storing an id nothing verified is the defect; the header is only where it becomes visible.
    await expect(
      sealManifest(testEnv, ctx, ORG, { ...composition, inReplyToMessageId: foreign }),
    ).rejects.toThrow(/E_NO_SUCH_PARENT/);

    const count = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("refuses to render a manifest whose parent is out of org, even if one was written directly", async () => {
    const ctx = createSystemCtx();
    const sealed = await sealManifest(testEnv, ctx, ORG, composition);
    // Simulate a future write path that skipped the seal-time check. Rendering reads from D1, so it
    // must not trust whatever wrote the row.
    await testEnv.CATALOG.prepare("UPDATE send_manifests SET in_reply_to_message_id = ? WHERE id = ?")
      .bind("msg_not_ours", sealed.id).run();

    await expect(renderRfc822(testEnv, sealed.id)).rejects.toThrow(/E_PARENT_NOT_IN_ORG/);
  });
});

describe("threading reconstruction (#27, ADR 38)", () => {
  it("bounds the References chain rather than reproducing it faithfully", async () => {
    const chain = Array.from({ length: 60 }, (_, i) => `<id${i}@x.com>`).join(" ");
    const raw = utf8(`References: ${chain}\r\nSubject: deep\r\n\r\nbody`);
    const stored = await putEvidence(testEnv, `${ORG}/raw/2026-Q3/deep.eml`, raw);

    const header = await rebuildReferences(testEnv, stored.blobKey, "parent@x.com");
    const emitted = header!.split(" ");

    // Cloudflare rejects a reply whose incoming message carries more than 100 entries, so the
    // reconstruction is bounded rather than faithful.
    expect(emitted.length).toBe(BUDGETS["send.references_emitted_max"]);
    // The two entries that actually decide threading survive: the root and the immediate parent.
    expect(emitted[0]).toBe("<id0@x.com>");
    expect(emitted.at(-1)).toBe("<parent@x.com>");
  });

  it("still threads when the parent's evidence is unreadable", async () => {
    // Refusing to reply because the archive is damaged would be worse than threading on the parent
    // alone.
    const header = await rebuildReferences(testEnv, `${ORG}/raw/2026-Q3/gone.eml`, "parent@x.com");
    expect(header).toBe("<parent@x.com>");
  });
});

describe("the hold window and cancellation (ADR 39)", () => {
  it("does not dispatch while held", async () => {
    const at = 2_100_000_000_000;
    const transport = fakeTransport({ kind: "handed_over", transportMessageId: "cf-1" });
    await sealManifest(testEnv, atTime(at), ORG, composition);

    const results = await dispatchDue(testEnv, atTime(at + 1000), ORG, transport);
    expect(results).toEqual([]);
    expect(transport.submitted).toEqual([]);
  });

  it("dispatches once the window closes", async () => {
    const at = 2_200_000_000_000;
    const transport = fakeTransport({ kind: "handed_over", transportMessageId: "cf-2" });
    await sealManifest(testEnv, atTime(at), ORG, composition);

    const after = at + (BUDGETS["send.hold_window_default_seconds"] + 1) * 1000;
    const results = await dispatchDue(testEnv, atTime(after), ORG, transport);
    expect(results[0]?.state).toBe("handed_over");
    expect(transport.submitted.length).toBe(1);
  });

  it("cancels a held send, and says why it cannot cancel one already handed over", async () => {
    const at = 2_300_000_000_000;
    const transport = fakeTransport({ kind: "handed_over", transportMessageId: "cf-3" });
    const sealed = await sealManifest(testEnv, atTime(at), ORG, composition);

    expect((await cancelSend(testEnv, atTime(at + 1000), ORG, sealed.id)).cancelled).toBe(true);

    // A cancelled manifest is not dispatched, even after its window closes.
    const after = at + (BUDGETS["send.hold_window_default_seconds"] + 1) * 1000;
    expect(await dispatchDue(testEnv, atTime(after), ORG, transport)).toEqual([]);

    const second = await sealManifest(testEnv, atTime(at), ORG, composition);
    await dispatchOne(testEnv, atTime(after), ORG, second.id, transport);
    const refused = await cancelSend(testEnv, atTime(after + 1000), ORG, second.id);
    expect(refused.cancelled).toBe(false);
    // Honest about *why*. "Cancel failed" would leave a user unsure whether their message went out.
    expect(refused.reason).toContain("cannot be recalled");
  });
});

describe("the state machine and retry rule (ADR 40)", () => {
  const at = 2_400_000_000_000;
  const due = at + (BUDGETS["send.hold_window_default_seconds"] + 1) * 1000;

  async function dispatchWith(outcome: SubmitOutcome) {
    const sealed = await sealManifest(testEnv, atTime(at), ORG, composition);
    return dispatchOne(testEnv, atTime(due), ORG, sealed.id, fakeTransport(outcome));
  }

  it("never reports sent or delivered", async () => {
    const result = await dispatchWith({ kind: "handed_over", transportMessageId: "cf-4" });
    expect(result.state).toBe("handed_over");
    // §5C forbids claiming an outcome nobody observed, and the transport reports acceptance.
    expect(result.detail).not.toMatch(/\bsent\b|\bdelivered\b/i);
    expect(result.detail).toContain("Whether it arrived");
  });

  it("keeps throttled, refused, suppressed and unknown genuinely distinct", async () => {
    expect((await dispatchWith({ kind: "throttled", reason: "429" })).state).toBe("throttled");
    expect((await dispatchWith({ kind: "refused", reason: "bad", retryable: false })).state).toBe("refused");
    expect((await dispatchWith({ kind: "suppressed", reason: "on list" })).state).toBe("suppressed");
    expect((await dispatchWith({ kind: "outcome_unknown", reason: "timeout" })).state).toBe("outcome_unknown");
  });

  it("retries only what provably never left", () => {
    expect(isAutoRetryable("throttled")).toBe(true);
    // A retry after an unknown outcome could deliver a second copy that cannot be recalled, and
    // Cloudflare offers no idempotency key to deduplicate against.
    expect(isAutoRetryable("outcome_unknown")).toBe(false);
    expect(isAutoRetryable("handed_over")).toBe(false);
    expect(isAutoRetryable("suppressed")).toBe(false);
  });

  it("picks a throttled send back up automatically, and leaves an unknown one alone", async () => {
    const throttled = await dispatchWith({ kind: "throttled", reason: "429" });
    const retried = await dispatchDue(
      testEnv, atTime(due + 60_000), ORG, fakeTransport({ kind: "handed_over", transportMessageId: "cf-5" }),
    );
    expect(retried.map((r) => r.manifestId)).toContain(throttled.manifestId);

    const unknown = await dispatchWith({ kind: "outcome_unknown", reason: "timeout" });
    const notRetried = await dispatchDue(
      testEnv, atTime(due + 120_000), ORG, fakeTransport({ kind: "handed_over", transportMessageId: "cf-6" }),
    );
    expect(notRetried.map((r) => r.manifestId)).not.toContain(unknown.manifestId);
  });

  it("leaves a send that died mid-dispatch in the state that forbids retry", async () => {
    const sealed = await sealManifest(testEnv, atTime(at), ORG, composition);
    // The claim writes `outcome_unknown` *before* submitting, so an invocation that dies between the
    // two leaves the manifest in the one state the system will not retry — which is exactly right,
    // because that is precisely when we do not know whether it left.
    const transport: TransportAdapter = {
      name: "dies",
      async capability() { return { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "" }; },
      async submit() { throw new Error("isolate died"); },
    };
    await expect(dispatchOne(testEnv, atTime(due), ORG, sealed.id, transport)).rejects.toThrow();

    const row = await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(sealed.id).first<{ state: string }>();
    expect(row?.state).toBe("outcome_unknown");
  });

  it("stores the submitted bytes as evidence for an authored send (§12 invariant 2)", async () => {
    const sealed = await sealManifest(testEnv, atTime(at), ORG, composition);
    await dispatchOne(testEnv, atTime(due), ORG, sealed.id, fakeTransport({ kind: "handed_over", transportMessageId: "cf-7" }));

    const row = await testEnv.CATALOG.prepare(
      "SELECT submitted_key, submitted_sha256, fidelity FROM send_manifests WHERE id = ?",
    ).bind(sealed.id).first<Record<string, string>>() as Record<string, string>;

    expect(row.fidelity).toBe("authored");
    const submitted = new TextDecoder().decode(await getEvidence(testEnv, row.submitted_key!));
    expect(submitted).toContain(`From: ${ADDRESS}`);
    expect(row.submitted_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the measured daily limit (ADR 34)", () => {
  const at = 2_500_000_000_000;
  const due = at + (BUDGETS["send.hold_window_default_seconds"] + 1) * 1000;

  it("counts what was handed over", async () => {
    for (let i = 0; i < 3; i++) {
      const sealed = await sealManifest(testEnv, atTime(at), ORG, composition);
      await dispatchOne(testEnv, atTime(due), ORG, sealed.id, fakeTransport({ kind: "handed_over", transportMessageId: `cf-${i}` }));
    }
    expect((await dailySendState(testEnv, atTime(due), ORG)).handedOver).toBe(3);
  });

  it("records the count at which throttling first happened — the observed limit", async () => {
    for (let i = 0; i < 2; i++) {
      const ok = await sealManifest(testEnv, atTime(at), ORG, composition);
      await dispatchOne(testEnv, atTime(due), ORG, ok.id, fakeTransport({ kind: "handed_over", transportMessageId: `cf-ok-${i}` }));
    }
    const blocked = await sealManifest(testEnv, atTime(at), ORG, composition);
    await dispatchOne(testEnv, atTime(due), ORG, blocked.id, fakeTransport({ kind: "throttled", reason: "daily limit" }));

    const state = await dailySendState(testEnv, atTime(due), ORG);
    // Cloudflare publishes no daily quota, so this is the only version of that limit which exists.
    expect(state.throttledAtCount).toBe(2);
    expect(state.firstThrottledAt).not.toBeNull();
  });
});

describe("error classification", () => {
  it("keeps the four transport outcomes apart", () => {
    expect(classifyError("429 Too Many Requests").kind).toBe("throttled");
    expect(classifyError("recipient is on the suppression list").kind).toBe("suppressed");
    expect(classifyError("E_HEADER_VALUE_TOO_LONG").kind).toBe("refused");
    // The safe default for an unclassifiable failure is the state that forbids automatic retry.
    expect(classifyError("connection reset by peer").kind).toBe("outcome_unknown");
  });

  it("classifies per-subdomain onboarding as refused, not unknown", () => {
    // Measured against the live API. It provably never left, and it is the most fixable failure in
    // the set, so it must not carry the state that forbids retry and alarms the reader.
    const outcome = classifyError("email sending not authorized for subdomain 'mail.example.com'");
    expect(outcome.kind).toBe("refused");
    expect("reason" in outcome && outcome.reason).toContain("per-subdomain");
    expect("reason" in outcome && outcome.reason).toContain("wrangler email sending enable");
  });

  it("never surfaces Cloudflare's verified-address wording (#19)", () => {
    const outcome = classifyError("destination address is not a verified address");
    expect(outcome.kind).toBe("refused");
    // That string names neither the plan nor domain verification, so it teaches an operator nothing.
    expect("reason" in outcome && outcome.reason).not.toContain("not a verified address");
    expect("reason" in outcome && outcome.reason).toContain("onboarded");
  });
});

describe("sender authorization (Layer 2's first requirement)", () => {
  it("refuses to seal for a principal with no send relation", async () => {
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();

    await expect(sealManifest(testEnv, createSystemCtx(), ORG, composition))
      .rejects.toThrow(/E_MAY_NOT_SEND_AS_MAILBOX/);

    // Nothing persisted. A refusal that still wrote a manifest would leave a send somebody could
    // dispatch by other means.
    const rows = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM send_manifests")
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("does not distinguish an unauthorized mailbox from one that does not exist", async () => {
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();

    const unauthorized = await sealManifest(testEnv, createSystemCtx(), ORG, composition)
      .then(() => null, (e: Error) => e.message);
    const absent = await sealManifest(testEnv, createSystemCtx(), ORG,
      { ...composition, mailboxId: "mbx_does_not_exist" })
      .then(() => null, (e: Error) => e.message);

    // Identical refusals. Different ones let a caller enumerate mailbox ids by reading which error came
    // back — an organisation-wide oracle out of two individually reasonable messages.
    expect(unauthorized).toBe(absent);
  });

  it("reading a mailbox does not confer sending as it", async () => {
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, AUTHOR, "mailbox.content.read", "mailbox", MAILBOX,
      new Date(ctx.now()).toISOString()).run();

    // A shared mailbox several people read is exactly the kind whose outbound identity should be held by
    // fewer of them. Collapsing the two relations would be the easy shape and the wrong one.
    await expect(sealManifest(testEnv, ctx, ORG, composition))
      .rejects.toThrow(/E_MAY_NOT_SEND_AS_MAILBOX/);
  });

  it("withholds a held send when authority is revoked inside the hold window", async () => {
    const ctx = atTime(1_800_000_000_000);
    const sealed = await sealManifest(testEnv, ctx, ORG, composition);
    expect(sealed.state).toBe("held");

    // The revocation. §7 and §28 require withdrawn authority to stop working immediately, and the hold
    // window is inside "immediately" — the sweeper dispatches seconds later with no principal in scope.
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();

    const transport = fakeTransport({ kind: "handed_over", transportMessageId: "<x@acme.example>" });
    const after = atTime(1_800_000_000_000 + 60_000);
    const results = await dispatchDue(testEnv, after, ORG, transport);

    expect(results[0]?.state).toBe("withheld");
    // Never offered to the transport. "Refused" would blame the mail service for a decision this Node
    // made, and it was never asked.
    expect(transport.submitted).toHaveLength(0);
  });

  it("does not spend an attempt or claim the manifest when withholding", async () => {
    const ctx = atTime(1_800_000_100_000);
    const sealed = await sealManifest(testEnv, ctx, ORG, composition);
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();

    await dispatchDue(testEnv, atTime(1_800_000_160_000), ORG,
      fakeTransport({ kind: "handed_over", transportMessageId: "<y@acme.example>" }));

    const row = await testEnv.CATALOG.prepare(
      "SELECT state, attempts, transport_message_id FROM send_manifests WHERE id = ?",
    ).bind(sealed.id).first<{ state: string; attempts: number; transport_message_id: string | null }>();

    // The check runs *before* the claim on purpose. Afterwards it would have burned an attempt and left
    // the manifest in outcome_unknown — "we do not know whether it left" — when it demonstrably did not.
    expect(row?.state).toBe("withheld");
    expect(row?.attempts).toBe(0);
    expect(row?.transport_message_id).toBeNull();
  });

  it("records the withholding in the same transaction as the state", async () => {
    const ctx = atTime(1_800_000_200_000);
    const sealed = await sealManifest(testEnv, ctx, ORG, composition);
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();
    await dispatchDue(testEnv, atTime(1_800_000_260_000), ORG,
      fakeTransport({ kind: "handed_over", transportMessageId: "<z@acme.example>" }));

    const entry = await testEnv.CATALOG.prepare(
      "SELECT action, outcome FROM audit_entries WHERE subject = ? AND action = 'send.withheld'",
    ).bind(sealed.id).first<{ action: string; outcome: string }>();
    expect(entry?.outcome).toBe("refused");
  });

  it("still sends when authority is intact, so the gate is not simply a wall", async () => {
    const ctx = atTime(1_800_000_300_000);
    const sealed = await sealManifest(testEnv, ctx, ORG, composition);
    const transport = fakeTransport({ kind: "handed_over", transportMessageId: "<ok@acme.example>" });
    const results = await dispatchDue(testEnv, atTime(1_800_000_360_000), ORG, transport);

    expect(results.find((r) => r.manifestId === sealed.id)?.state).toBe("handed_over");
    expect(transport.submitted).toHaveLength(1);
  });
});

describe("per-recipient state (Layer 2's proof line)", () => {
  async function recipientsOf(manifestId: string) {
    const rows = await testEnv.CATALOG.prepare(
      `SELECT kind, address, submission_state, delivery_state, bounce_type
         FROM send_recipients WHERE manifest_id = ? ORDER BY address`,
    ).bind(manifestId).all<{
      kind: string; address: string; submission_state: string;
      delivery_state: string | null; bounce_type: string | null;
    }>();
    return rows.results;
  }

  it("writes one row per recipient at seal, keeping to/cc/bcc apart", async () => {
    const sealed = await sealManifest(testEnv, createSystemCtx(), ORG, {
      ...composition,
      to: ["a@example.com"], cc: ["b@example.com"], bcc: ["c@example.com"],
    });

    const rows = await recipientsOf(sealed.id);
    expect(rows.map((r) => [r.address, r.kind])).toEqual([
      ["a@example.com", "to"], ["b@example.com", "cc"], ["c@example.com", "bcc"],
    ]);
    // Kind is kept because a Bcc recipient must never be rendered beside a To recipient, and the
    // envelope alone cannot tell them apart once submitted.
  });

  it("leaves delivery_state NULL, because nothing has been observed yet", async () => {
    const sealed = await sealManifest(testEnv, createSystemCtx(), ORG, composition);
    const rows = await recipientsOf(sealed.id);

    // The load-bearing NULL. Any default here — 'pending', 'unknown', 'ok' — would make "we have heard
    // nothing" indistinguishable from an outcome, which is the ambiguity this table exists to remove.
    expect(rows.every((r) => r.delivery_state === null)).toBe(true);
    expect(rows.every((r) => r.submission_state === "held")).toBe(true);
  });

  it("collapses an address that appears twice, so one bounce is not counted twice", async () => {
    const sealed = await sealManifest(testEnv, createSystemCtx(), ORG, {
      ...composition,
      to: ["dup@example.com"], cc: ["DUP@example.com"],
    });

    const rows = await recipientsOf(sealed.id);
    expect(rows).toHaveLength(1);
    // First mention wins, so a To recipient is never demoted to Cc.
    expect(rows[0]?.kind).toBe("to");
  });

  it("mirrors hand-over onto every recipient, in the same transaction as the manifest", async () => {
    const ctx = atTime(1_900_000_000_000);
    const sealed = await sealManifest(testEnv, ctx, ORG, {
      ...composition, to: ["x@example.com", "y@example.com"],
    });
    await dispatchDue(testEnv, atTime(1_900_000_060_000), ORG,
      fakeTransport({ kind: "handed_over", transportMessageId: "<t@acme.example>" }));

    const manifest = await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(sealed.id).first<{ state: string }>();
    const rows = await recipientsOf(sealed.id);

    // Submission is one act on one envelope, so its outcome is true of every recipient in it. What must
    // never be reachable is the manifest saying handed_over while its recipients still say held.
    expect(manifest?.state).toBe("handed_over");
    expect(rows.map((r) => r.submission_state)).toEqual(["handed_over", "handed_over"]);
    // And hand-over still says nothing about delivery.
    expect(rows.every((r) => r.delivery_state === null)).toBe(true);
  });

  it("mirrors a refusal too, so a failed send has no recipients claiming otherwise", async () => {
    const ctx = atTime(1_900_000_100_000);
    const sealed = await sealManifest(testEnv, ctx, ORG, { ...composition, to: ["r@example.com"] });
    await dispatchDue(testEnv, atTime(1_900_000_160_000), ORG,
      fakeTransport({ kind: "refused", reason: "550 nope", retryable: false }));

    const rows = await recipientsOf(sealed.id);
    expect(rows[0]?.submission_state).toBe("refused");
  });

  it("mirrors cancellation, so a stopped send is not simultaneously pending", async () => {
    const ctx = atTime(1_900_000_200_000);
    const sealed = await sealManifest(testEnv, ctx, ORG, { ...composition, to: ["c1@example.com"] });
    const outcome = await cancelSend(testEnv, ctx, ORG, sealed.id);
    expect(outcome.cancelled).toBe(true);

    const rows = await recipientsOf(sealed.id);
    expect(rows[0]?.submission_state).toBe("cancelled");
  });

  it("mirrors withholding, so a revoked send does not read as pending", async () => {
    const ctx = atTime(1_900_000_300_000);
    const sealed = await sealManifest(testEnv, ctx, ORG, { ...composition, to: ["w1@example.com"] });
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples").run();
    await dispatchDue(testEnv, atTime(1_900_000_360_000), ORG,
      fakeTransport({ kind: "handed_over", transportMessageId: "<w@acme.example>" }));

    const rows = await recipientsOf(sealed.id);
    expect(rows[0]?.submission_state).toBe("withheld");
  });
});

describe("the authored path carries one recipient (a platform constraint, not a choice)", () => {
  /** The real adapter's guard, exercised without touching Cloudflare. */
  async function submitAuthored(to: string[], cc?: string[]) {
    const { cloudflareTransport } = await import("../src/outbound/transport.ts");
    return cloudflareTransport.submit(
      { EMAIL: { async send() { throw new Error("must not be reached"); } } } as unknown as Env,
      {
        from: ADDRESS, to, cc, subject: "s",
        raw: new TextEncoder().encode("From: a\r\n\r\nbody\r\n") as Uint8Array<ArrayBuffer>,
      },
      "authored",
    );
  }

  it("refuses more than one recipient instead of submitting a malformed address", async () => {
    const outcome = await submitAuthored(["a@example.com"], ["b@example.com"]);

    // Previously this joined the addresses with a comma and let Cloudflare reject the result, which
    // reported the recipient list as invalid when the request was. Measured on the deployed Node.
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") {
      expect(outcome.retryable).toBe(false);
      // The reason has to say nothing was sent, because "refused" alone leaves a reader guessing.
      expect(outcome.reason).toContain("Nothing was submitted");
      expect(outcome.reason).toContain("2");
    }
  });

  it("does not reach the transport at all when it refuses", async () => {
    // The stub throws if called. A refusal that still submitted would be the worse bug: a message
    // delivered to one recipient while the Node reports the send as refused.
    await expect(submitAuthored(["a@example.com"], ["b@example.com"])).resolves.toMatchObject({
      kind: "refused",
    });
  });
});
