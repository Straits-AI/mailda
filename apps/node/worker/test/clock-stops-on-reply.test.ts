import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { dispatchDue } from "../src/outbound/dispatch.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import { sweepResponseClocks } from "../src/response-clock.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import type { SubmitOutcome, TransportAdapter } from "../src/outbound/transport.ts";

/**
 * Does replying actually stop the first-response clock?
 *
 * ## Why this file exists, and it is not a nice-to-have
 *
 * `response-clock.test.ts` has eighteen passing tests and every one of them calls
 * `stopClockForConversation` **directly**, handed a `conversationId` the test already knows. Not one goes
 * through `dispatch.ts`, which is the **only** caller in `src/` and the only code that has to *find* the
 * conversation from a handed-over manifest. So the mechanism was thoroughly tested and the wiring was not
 * tested at all — and the wiring was broken.
 *
 * The join read `m.rfc_message_id = s.in_reply_to_message_id`. Those columns hold different kinds of value,
 * and their own schema comments say so: `send_manifests.in_reply_to_message_id` is *"our own msg_ id, NULL
 * for a new thread"* (`0007_outbound.sql:20`) while `messages.rfc_message_id` is *"the provider/sender
 * Message-ID header"* (`0002_message_metadata.sql:12`). The comparison was `msg_01J…` against
 * `<…@domain>`, so it could never match, `stopClockForConversation` never ran, and **every case in a
 * mailbox with a response target was swept to breached sixty minutes later however fast the reply left.**
 * `renderRfc822` resolves the same column correctly — by `id` — twenty lines further down the same file.
 *
 * This is the third defect of one shape in a single day's work: a format or wiring mismatch that every test
 * passed straight over because each test supplied the thing the mismatch would have broken. The other two
 * were `datetime()` versus `toISOString()` in the clock's own SQL, and a queue gated on `send.propose`
 * returning message metadata because every test granted whatever the mechanism under test needed.
 *
 * So this test is deliberately written the expensive way: **seal a real reply, dispatch it through a fake
 * transport, and then ask the sweep whether it still thinks the case is late.** Nothing is handed to the
 * function under test that the production path would not have had to derive for itself.
 */

const testEnv = env as unknown as Env;
const ORG = "org_clockwire";
const MAILBOX = "mbx_clockwire";
const ADDRESS = "support@acme.example";
const AUTHOR = "usr_author";
const PARENT_RFC_ID = "<inbound-from-customer@example.net>";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

function fakeTransport(outcome: SubmitOutcome): TransportAdapter {
  return {
    name: "fake",
    async capability() {
      return { canSend: true, arbitraryRecipients: true, verifiedAt: "2026-08-04T00:00:00.000Z", detail: "fake" };
    },
    async submit() {
      return outcome;
    },
  };
}

/** The inbound message, its conversation, and a case whose clock is running. Returns our own message id. */
async function anInboundAwaitingReply(ctx: Ctx, arrivedAt: string): Promise<{ messageId: string; caseId: string }> {
  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, PARENT_RFC_ID);
  // A real delivery, not just a messages row: the reply path resolves its parent through
  // `ingress_receipts.envelope_to` -> `addresses` to find which mailbox it landed in, and then checks
  // `mailbox.content.read` on that mailbox. A bare messages row is unreachable by that join, which is
  // exactly what `test/reply-parent-authority.test.ts` is about.
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, "customer@example.net", ADDRESS, 10, arrivedAt, "k", "sha", ctx.id("pe")).run();

  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(messageId, ORG, "2026-08", "k", "sha", 10, PARENT_RFC_ID, ctx.id("thr"),
    "Invoice query", "customer@example.net", arrivedAt, arrivedAt, receiptId, arrivedAt,
    conversationId).run();

  const caseId = ctx.id("cas");
  await testEnv.CATALOG.prepare(
    `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
                        created_at, response_due_at, first_response_at, response_breached_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?, ?, NULL, NULL)`,
  ).bind(caseId, ORG, conversationId, MAILBOX, arrivedAt, arrivedAt,
    // Due an hour after arrival, matching a 60-minute mailbox target.
    "2026-08-10T10:00:00.000Z").run();
  return { messageId, caseId };
}

beforeEach(async () => {
  for (const table of ["cases", "conversations", "messages", "relationship_tuples", "mailboxes", "addresses",
                       "send_manifests", "send_recipients", "send_recipient_events", "send_counters",
                       "audit_entries", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      "INSERT INTO mailboxes (id, org_id, name, created_at, first_response_minutes) VALUES (?,?,?,?,60)",
    ).bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'send.propose','mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, AUTHOR, MAILBOX, at),
    // Replying to a message now requires being able to read it — see reply-parent-authority.test.ts.
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'mailbox.content.read','mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, AUTHOR, MAILBOX, at),
  ]);
});

describe("handing a reply over stops the clock, through the real dispatch path", () => {
  it("stops the clock, so the sweep does not report the case as breached", async () => {
    const arrived = 1_786_000_000_000;          // the inbound
    const ctx = atTime(arrived);
    const { messageId, caseId } = await anInboundAwaitingReply(ctx, "2026-08-10T09:00:00.000Z");

    // Seal a reply *to that message*, which is what puts our own msg_ id in the manifest.
    const sealedAt = arrived + 60_000;
    await sealManifest(testEnv, atTime(sealedAt), ORG, {
      mailboxId: MAILBOX,
      authorUserId: AUTHOR,
      to: ["customer@example.net"],
      subject: "Re: Invoice query",
      bodyTyped: "Answered within the hour.",
      fidelity: "authored" as const,
      inReplyToMessageId: messageId,
    });

    // Let the hold window close and dispatch for real.
    const after = sealedAt + (BUDGETS["send.hold_window_default_seconds"] + 1) * 1000;
    const results = await dispatchDue(
      testEnv, atTime(after), ORG, fakeTransport({ kind: "handed_over", transportMessageId: "cf-1" }),
    );
    expect(results[0]?.state).toBe("handed_over");

    // The clock must have stopped. This is the assertion the eighteen direct tests could not make.
    const row = await testEnv.CATALOG.prepare(
      "SELECT first_response_at FROM cases WHERE id = ?",
    ).bind(caseId).first<{ first_response_at: string | null }>();
    expect(row?.first_response_at, "hand-over did not stop the clock").not.toBeNull();

    // And the sweep must agree, because the sweep is what a person sees.
    const swept = await sweepResponseClocks(
      testEnv, atTime(Date.parse("2026-08-10T11:00:00.000Z")), ORG,
    );
    expect(swept.breached, "answered case reported as breached").toEqual([]);
  });

  it("leaves the clock running for a send that is not a reply", async () => {
    // The complement, so the test above cannot pass by stopping every clock indiscriminately. A new-thread
    // send carries no parent, so it answers nothing and the case stays due.
    const arrived = 1_786_000_000_000;
    const { caseId } = await anInboundAwaitingReply(atTime(arrived), "2026-08-10T09:00:00.000Z");

    const sealedAt = arrived + 60_000;
    await sealManifest(testEnv, atTime(sealedAt), ORG, {
      mailboxId: MAILBOX,
      authorUserId: AUTHOR,
      to: ["someone-else@example.net"],
      subject: "Unrelated",
      bodyTyped: "A new thread.",
      fidelity: "authored" as const,
    });

    const after = sealedAt + (BUDGETS["send.hold_window_default_seconds"] + 1) * 1000;
    await dispatchDue(testEnv, atTime(after), ORG,
      fakeTransport({ kind: "handed_over", transportMessageId: "cf-2" }));

    const row = await testEnv.CATALOG.prepare(
      "SELECT first_response_at FROM cases WHERE id = ?",
    ).bind(caseId).first<{ first_response_at: string | null }>();
    expect(row?.first_response_at).toBeNull();

    const swept = await sweepResponseClocks(
      testEnv, atTime(Date.parse("2026-08-10T11:00:00.000Z")), ORG,
    );
    expect(swept.breached).toEqual([caseId]);
  });
});
