import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "@mailda/evidence";
import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { metering } from "../src/cost-meter.ts";
import { claim, close } from "../src/cases.ts";
import { saveDraft } from "../src/drafts.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { conversationForDelivery } from "../src/conversations.ts";

/**
 * What one Butler step costs, **measured** rather than counted by reading.
 *
 * ## Why these functions and not "nodes"
 *
 * There is no Butler engine yet, so a node cannot be executed. But every node in the shipped set is a name
 * for an operation that already exists — `case.assign` is `claim`, `case.close` is `close`, `draft` is
 * `saveDraft`, `mail.send.propose` is `sealManifest`. Measuring those measures the node, and does it before
 * the engine is built rather than after.
 *
 * ## Why the existing meter could not do this
 *
 * `doctor.ts`'s meter counts `prepare`, not execution; treats a `batch()` as its statement count rather than
 * as one round trip; and cannot see Durable Object RPCs at all. It would price `mail.send.propose` at 6
 * against a real 10, the four missing being vault RPCs — about 40% of the cost. `src/cost-meter.ts` counts
 * executions, prices a batch as one, and proxies the vault.
 *
 * ## What the figures are for
 *
 * `butler-step-budget.md` measured the ceiling at **10,000 subrequests per Workflow instance** — per
 * instance, shared across every step. So a bounded loop's `maxItems` has to be checked against what the rest
 * of the AST already spends, and these are the per-item numbers that arithmetic needs.
 *
 * The assertions are **bounds, not equalities.** An equality on an I/O count is a test that fails on every
 * harmless refactor, and this file's job is to catch a node becoming an order of magnitude more expensive —
 * which is what makes a `maxItems` derived from it unsafe. Each bound is the measured figure with headroom,
 * and the measured figures are printed so the receipt can be disputed.
 */

const testEnv = env as unknown as Env;
const ORG = "org_stepcost";
const MAILBOX = "mbx_stepcost";
const ADDRESS = "support@acme.example";
const ACTOR = "usr_actor";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

function report(node: string, cost: { subrequests: number; d1Executions: number; d1Batches: number; r2Operations: number; doRpcs: number }): void {
  console.log(
    `MEASURE node=${node}  subrequests=${cost.subrequests}  d1=${cost.d1Executions}` +
    ` (batches=${cost.d1Batches})  r2=${cost.r2Operations}  do_rpc=${cost.doRpcs}`,
  );
}

async function aCase(ctx: Ctx): Promise<{ caseId: string; messageId: string }> {
  const at = new Date(ctx.now()).toISOString();
  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, `<in-${ctx.id("x")}@example.net>`);
  const raw = utf8("Message-ID: <p@example.net>\r\nSubject: q\r\n\r\nbody\r\n");
  const stored = await putEvidence(testEnv, `${ORG}/parent-${ctx.id("k")}.eml`, raw);
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, "customer@example.net", ADDRESS, raw.byteLength, at,
    stored.blobKey, stored.plaintextSha256, ctx.id("pe")).run();
  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
    "<p@example.net>", ctx.id("thr"), "q", "customer@example.net", at, at, receiptId, at,
    conversationId).run();
  const caseId = ctx.id("cas");
  await testEnv.CATALOG.prepare(
    `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
                        created_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
  ).bind(caseId, ORG, conversationId, MAILBOX, at, at).run();
  return { caseId, messageId };
}

beforeEach(async () => {
  for (const table of ["cases", "conversations", "messages", "ingress_receipts", "relationship_tuples",
                       "mailboxes", "addresses", "drafts", "send_manifests", "send_recipients",
                       "send_counters", "audit_entries", "outbox", "users"]) {
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
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(ACTOR, ORG, "actor@local.invalid", at),
    ...["send.propose", "mailbox.content.read"].map((relation) =>
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, ACTOR, relation, MAILBOX, at)),
  ]);
});

describe("what one Butler step costs (#54)", () => {
  it("prices case.assign", async () => {
    const ctx = atTime(2_400_000_000_000);
    const { caseId } = await aCase(ctx);
    const { env: metered, cost } = metering(testEnv);

    const outcome = await claim(metered, ctx, ORG, ACTOR, caseId);
    expect(outcome.kind).toBe("claimed");

    report("case.assign", cost);
    // Measured 5. Bounded generously: the shape that matters is "a handful", not the exact number.
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_case_assign"]);
    expect(cost.doRpcs).toBe(0);
  });

  it("prices case.close", async () => {
    const ctx = atTime(2_400_000_000_000);
    const { caseId } = await aCase(ctx);
    await claim(testEnv, ctx, ORG, ACTOR, caseId);
    const { env: metered, cost } = metering(testEnv);

    await close(metered, ctx, ORG, ACTOR, caseId);

    report("case.close", cost);
    // The cheapest effect in the set: one conditional UPDATE, deliberately unaudited.
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_case_close"]);
  });

  it("prices draft, and shows the vault RPC the old meter could not see", async () => {
    const ctx = atTime(2_400_000_000_000);
    const { env: metered, cost } = metering(testEnv);

    await saveDraft(metered, ctx, ORG, ACTOR, null, {
      mailboxId: MAILBOX, to: ["customer@example.net"], subject: "Re: q", body: "Answered.",
    });

    report("draft", cost);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_draft"]);
    // The point of the new meter: a draft writes evidence, and writing evidence is a vault RPC.
    expect(cost.doRpcs, "a draft writes evidence, which fetches a sealing key by RPC").toBeGreaterThan(0);
  });

  it("prices mail.send.propose, the most expensive node, with and without a parent", async () => {
    const ctx = atTime(2_400_000_000_000);
    const { messageId } = await aCase(ctx);

    const fresh = metering(testEnv);
    await sealManifest(fresh.env, atTime(2_400_000_001_000), ORG, {
      mailboxId: MAILBOX, authorUserId: ACTOR, to: ["customer@example.net"],
      subject: "New thread", bodyTyped: "Hello.", fidelity: "authored",
    });
    report("mail.send.propose (new thread)", fresh.cost);

    const reply = metering(testEnv);
    await sealManifest(reply.env, atTime(2_400_000_002_000), ORG, {
      mailboxId: MAILBOX, authorUserId: ACTOR, to: ["customer@example.net"],
      subject: "Re: q", bodyTyped: "Answered.", fidelity: "authored", inReplyToMessageId: messageId,
    });
    report("mail.send.propose (reply)", reply.cost);

    // A reply costs strictly more: it resolves the parent and rebuilds the References chain from its
    // evidence, which is an R2 get plus an opening-key RPC.
    expect(reply.cost.subrequests).toBeGreaterThan(fresh.cost.subrequests);
    expect(fresh.cost.doRpcs, "sealing evidence fetches a sealing key per write").toBeGreaterThan(0);
    expect(reply.cost.subrequests).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_send_propose"]);
  });

  it("prices a fifty-recipient send the same as a one-recipient send", async () => {
    // The single most useful thing the corrected meter reveals, and the old one got it exactly backwards:
    // the per-recipient INSERTs ride inside one `batch()`, so recipients are free. doctor's meter would
    // have counted fifty.

    const one = metering(testEnv);
    await sealManifest(one.env, atTime(2_400_000_001_000), ORG, {
      mailboxId: MAILBOX, authorUserId: ACTOR, to: ["a@example.net"],
      subject: "One", bodyTyped: "Hello.", fidelity: "authored",
    });

    const many = metering(testEnv);
    await sealManifest(many.env, atTime(2_400_000_002_000), ORG, {
      mailboxId: MAILBOX, authorUserId: ACTOR,
      to: Array.from({ length: 50 }, (_, i) => `r${i}@example.net`),
      subject: "Fifty", bodyTyped: "Hello.", fidelity: "authored",
    });

    report("mail.send.propose (1 recipient)", one.cost);
    report("mail.send.propose (50 recipients)", many.cost);
    expect(many.cost.subrequests).toBe(one.cost.subrequests);
    expect(many.cost.d1Batches).toBe(one.cost.d1Batches);
  });

  it("states the loop arithmetic the checker has to do", async () => {
    // Not an assertion about code — an assertion about the budget, so that a change to either figure fails
    // here and forces the arithmetic to be redone.
    const budget = BUDGETS["workflow.subrequest_budget_per_instance"];
    expect(budget).toBe(10000);

    // At the measured cost of a reply-send, a loop of this many items consumes the whole run's budget.
    const perSendUpperBound = BUDGETS["butler.step_cost_max_send_propose"];
    const itemsThatExhaustTheRun = Math.floor(budget / perSendUpperBound);
    console.log(
      `MEASURE loop_arithmetic  budget_per_instance=${budget}  send_upper_bound=${perSendUpperBound}` +
      `  items_that_exhaust_the_run=${itemsThatExhaustTheRun}`,
    );
    // 500 items of sending is a whole run. A maxItems anywhere near that leaves nothing for the rest of the
    // AST, which is why the checker cannot price a loop in isolation.
    expect(itemsThatExhaustTheRun).toBeLessThan(1000);
  });
});
