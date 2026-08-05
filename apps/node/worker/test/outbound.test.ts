import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { getEvidence, putEvidence } from "../src/evidence-store.ts";
import {
  cancelSend, dailySendState, dispatchDue, dispatchOne, isAutoRetryable,
} from "../src/outbound/dispatch.ts";
import {
  assertHeaderSafe, encodeHeaderValue, normalizeBody, rebuildReferences, renderRfc822, sealManifest,
} from "../src/outbound/manifest.ts";
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
  for (const table of ["send_manifests", "send_counters", "messages", "addresses", "mailboxes", "node_capabilities"]) {
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
  ]);
});

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
    expect(() => assertHeaderSafe("subject", "clean")).not.toThrow();
    expect(() => assertHeaderSafe("subject", "dirty\r\n")).toThrow(/refused rather than stripped/);
  });

  it("refuses a non-ASCII address and encodes a non-ASCII subject", async () => {
    await expect(
      sealManifest(testEnv, ctx(), ORG, { ...composition, to: ["café@example.net"] }),
    ).rejects.toThrow(/E_NON_ASCII_ADDRESS/);

    // A subject *is* encodable, and a raw UTF-8 header is non-conformant even when it survives.
    const sealed = await sealManifest(testEnv, ctx(), ORG, { ...composition, subject: "Réf: café" });
    const text = new TextDecoder().decode((await renderRfc822(testEnv, sealed.id)).raw);
    expect(text).toContain("Subject: =?utf-8?B?");
    expect(text).not.toContain("Réf");
  });

  it("encodes only what needs encoding", () => {
    expect(encodeHeaderValue("plain ascii")).toBe("plain ascii");
    expect(encodeHeaderValue("café")).toMatch(/^=\?utf-8\?B\?.+\?=$/);
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
    const raw = new TextEncoder().encode(`References: ${chain}\r\nSubject: deep\r\n\r\nbody`);
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
