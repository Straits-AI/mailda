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

  it("prices lookup, the third shipped node that had no measurement (#54)", async () => {
    /*
     * `nodes.ts` declares `lookup` as *"reads one row of storage that exists, by id, from a closed set of
     * entities"* and says in the same breath that **its cost is unmeasured** and that #54 is what closes it.
     * The affordability pass needs a figure for every shipped kind or the sum under-reports, which is the
     * permissive direction — so this is the measurement, and it is of the operation the node is defined as
     * rather than of an implementation, because the engine does not exist to hold one.
     *
     * Measured per entity rather than once: five tables, five indexes, and if one of them cost more than a
     * row read the maximum is the figure the checker has to price, not the average.
     */
    const ctx = atTime(2_400_000_000_000);
    const { caseId, messageId } = await aCase(ctx);
    const draft = await saveDraft(testEnv, ctx, ORG, ACTOR, null, {
      mailboxId: MAILBOX, to: ["customer@example.net"], subject: "Re: q", body: "Answered.",
    });
    const conversationId = await testEnv.CATALOG.prepare("SELECT conversation_id AS id FROM cases WHERE id = ?")
      .bind(caseId).first<{ id: string }>();

    const rows: Array<[string, string, string]> = [
      ["message", "messages", messageId],
      ["conversation", "conversations", conversationId!.id],
      ["case", "cases", caseId],
      ["mailbox", "mailboxes", MAILBOX],
      ["draft", "drafts", draft.id],
    ];

    let worst = 0;
    for (const [entity, table, id] of rows) {
      const { env: metered, cost } = metering(testEnv);
      const row = await metered.CATALOG.prepare(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`)
        .bind(id, ORG).first();
      // Non-vacuity: a lookup that read nothing would cost one query and prove nothing about the entity.
      expect(row, `${entity} must actually resolve, or this measures a miss`).not.toBeNull();
      console.log(
        `MEASURE node=lookup entity=${entity}  subrequests=${cost.subrequests}  d1=${cost.d1Executions}`
        + `  r2=${cost.r2Operations}  do_rpc=${cost.doRpcs}`,
      );
      expect(cost.doRpcs, `a ${entity} lookup reads a row, not evidence`).toBe(0);
      expect(cost.r2Operations, `a ${entity} lookup reads a row, not a body`).toBe(0);
      worst = Math.max(worst, cost.subrequests);
    }

    console.log(`MEASURE node=lookup  worst_entity_subrequests=${worst}`);
    /*
     * The bound is 4 against a measured 1, and the headroom is not decoration: `authz.check.max_queries = 2`
     * is what a re-check of the caller's authority over the looked-up object costs, and a `lookup` that grew
     * one would be at 3. 4 is one past that.
     */
    expect(worst).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_lookup"]);
    expect(worst + BUDGETS["authz.check.max_queries"])
      .toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_lookup"]);
  });

  it("states the loop arithmetic the checker has to do, on both plans", () => {
    // Not an assertion about code — an assertion about the budgets, so that a change to any figure fails
    // here and forces the arithmetic to be redone. Two rows, because the pot is plan-conditional and a
    // Node cannot tell which plan it is on: one row was the Paid one, unlabelled, and the rule stated in
    // docs/receipts/butler-step-cost.md was therefore 10x too permissive on Free (#68).
    const perSendUpperBound = BUDGETS["butler.step_cost_max_send_propose"];
    const rows = [
      { plan: "paid", budget: BUDGETS["workflow.paid.subrequest_budget_per_instance"], expected: 500 },
      { plan: "free", budget: BUDGETS["workflow.free.subrequest_budget_per_instance"], expected: 50 },
    ] as const;

    for (const { plan, budget, expected } of rows) {
      const itemsThatExhaustTheRun = Math.floor(budget / perSendUpperBound);
      console.log(
        `MEASURE loop_arithmetic  plan=${plan}  budget_per_instance=${budget}` +
        `  send_upper_bound=${perSendUpperBound}  items_that_exhaust_the_run=${itemsThatExhaustTheRun}`,
      );
      // The receipt prints these two numbers; if either moves, the prose has to move with it.
      expect(itemsThatExhaustTheRun, `the ${plan} row of the loop arithmetic`).toBe(expected);
    }

    // The Free row is a tenth of the Paid one, which is the whole reason the rule cannot be stated without
    // saying which plan it assumes.
    expect(rows[0].budget).toBe(rows[1].budget * 10);
  });
});

describe("the meter's coverage is a property, not a claim", () => {
  it("throws on a binding it does not classify, rather than counting it free", () => {
    // The instrument's own header used to *state* that `EMAIL` and the queue were uncovered. A gap named in a
    // comment is a gap nothing enforces, and pricing a node that reached one would have under-reported in the
    // permissive direction. Now the world is closed: an unclassified binding is an error at the moment it is
    // read, and `test/node/cost-meter-coverage.test.ts` catches it earlier still, from the config.
    const { env: metered } = metering({ ...testEnv, SOMETHING_NEW: { send: () => undefined } } as unknown as Env);
    expect(() => (metered as unknown as Record<string, unknown>).SOMETHING_NEW)
      .toThrow(/not classified/);
  });

  it("meters the transport and the queue, which nothing priced reaches yet", () => {
    // Metered *because* nothing reaches them. "Nothing reaches it today" is the assumption that expired for
    // the transport the moment a Butler node was going to hand bytes over.
    const { env: metered, cost } = metering(testEnv);
    expect(cost.transportSends).toBe(0);
    expect(cost.queuePublishes).toBe(0);
    // Reading them must not throw — they are classified, merely unused here.
    expect(() => (metered as unknown as Record<string, unknown>).EMAIL).not.toThrow();
    expect(() => (metered as unknown as Record<string, unknown>).SENDING_EVENTS).not.toThrow();
  });

  it("still lets every existing binding through", () => {
    const { env: metered } = metering(testEnv);
    for (const binding of ["CATALOG", "EVIDENCE", "KEY_VAULT", "OUTBOX_SWEEPER"]) {
      expect(() => (metered as unknown as Record<string, unknown>)[binding], binding).not.toThrow();
    }
  });
});
