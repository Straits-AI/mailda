import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { metering } from "../src/cost-meter.ts";
import { createPolicyDraft, evaluate, publishPolicy, type Outcome, type PolicyConditions } from "../src/policy.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { utf8 } from "@mailda/evidence";

/**
 * What policy evaluation costs, **measured** — the receipt #60 recorded as owed.
 *
 * ## Why this file exists rather than a count
 *
 * #60's resolution counted the cost by reading: *"Evaluation adds at most three queries to a seal: one to
 * read matching policies, one for the domain set behind `recipient_external`, one for `send_counters`."* It
 * then said so explicitly — *"Counted by reading, not measured — and that is a hypothesis… It cannot be
 * measured before there is an implementation, so the figure is recorded as an expectation with a receipt
 * owed."*
 *
 * There is an implementation now. `src/cost-meter.ts` exists precisely to settle this class of question: it
 * counts **executions** rather than `prepare`, prices a `batch()` as the one round trip it is, and sees
 * Durable Object RPCs — all three of which `doctor`'s meter gets wrong, and the third of which is invisible
 * to it entirely.
 *
 * ## What is measured, and against what
 *
 * Real `workerd` under `vitest-pool-workers`, against a real D1 and a real R2. **Not a deployed Node** —
 * miniflare's D1 is a local SQLite, so what is measured here is the *number of operations Mailda performs*,
 * which is what the subrequest budget is spent in, and not their latency. `doctor-check-cost.md`'s 18 August
 * correction makes the same distinction, and it is the honest boundary of this instrument.
 *
 * ## The figures are bounds, not equalities
 *
 * An equality on an I/O count fails on every harmless refactor and gets deleted. These exist to catch policy
 * evaluation becoming an order of magnitude more expensive, which is what would make it unsafe on the seal
 * path — a Butler sealing in a loop spends from one 10,000-subrequest pot per Workflow instance
 * (`butler-step-budget.md`), and `authz.check.max_queries` is explicitly *not* the budget this spends from:
 * that receipt bounds one authorization check, and policy evaluation is a separate step on the same request.
 */

const testEnv = env as unknown as Env;
const ORG = "org_policycost";
const MAILBOX = "mbx_policycost";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_admin_pc";
const AUTHOR = "usr_author_pc";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const AUGUST_10 = Date.parse("2026-08-10T09:00:00.000Z");

function report(scenario: string, cost: {
  subrequests: number; d1Executions: number; d1Batches: number; r2Operations: number; doRpcs: number;
}): void {
  console.log(
    `MEASURE policy scenario=${scenario}  subrequests=${cost.subrequests}` +
    `  d1=${cost.d1Executions} (batches=${cost.d1Batches})  r2=${cost.r2Operations}` +
    `  do_rpc=${cost.doRpcs}`,
  );
}

async function publish(name: string, outcome: Outcome, conditions?: PolicyConditions): Promise<void> {
  const ctx = atTime(AUGUST_10);
  const draft = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, { name, outcome, conditions });
  await publishPolicy(testEnv, ctx, ORG, ADMIN, draft.policyId);
}

const FACTS = {
  mailboxId: MAILBOX,
  actorUserId: AUTHOR,
  recipients: ["customer@example.net"],
  isReply: false,
};

beforeEach(async () => {
  for (const table of ["policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "mailboxes", "addresses", "users", "audit_entries", "outbox",
                       "messages", "ingress_receipts", "conversations", "cases"]) {
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
      .bind(ADMIN, ORG, "admin@local.invalid", at),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(AUTHOR, ORG, "author@local.invalid", at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, ADMIN, ORG, at),
    ...["send.propose", "mailbox.content.read"].map((relation) =>
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, AUTHOR, relation, MAILBOX, at)),
  ]);
});

describe("what policy evaluation costs (#60's owed receipt)", () => {
  it("costs one query when there is no policy at all", async () => {
    // The majority path on a Node that has not written a policy yet. The one query is the read of the
    // published set, which cannot be skipped: not knowing whether a policy exists is not a decision.
    const { env: metered, cost } = metering(testEnv);
    const decision = await evaluate(metered, atTime(AUGUST_10), ORG, FACTS);
    expect(decision.outcome).toBe("allow");

    report("evaluate/no-policies", cost);
    expect(cost.d1Executions).toBe(1);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["policy.evaluate_max_subrequests"]);
    expect(cost.r2Operations).toBe(0);
    expect(cost.doRpcs).toBe(0);
  });

  it("costs one query when no published policy constrains a derived condition", async () => {
    // Three policies on the three column-answerable conditions. Still one query, because neither derived
    // input is asked for — which is the whole reason the predicate is not pushed into SQL.
    await publish("by mailbox", "hold", { mailboxId: MAILBOX });
    await publish("by actor", "allow", { actorUserId: AUTHOR });
    await publish("by reply", "allow", { isReply: true });

    const { env: metered, cost } = metering(testEnv);
    const decision = await evaluate(metered, atTime(AUGUST_10), ORG, FACTS);
    expect(decision.outcome).toBe("hold");
    expect(decision.fetched).toEqual({ domains: false, dailyVolume: false });

    report("evaluate/three-column-conditions", cost);
    expect(cost.d1Executions).toBe(1);
  });

  it("costs two queries when one derived condition is in play", async () => {
    await publish("external", "require_approval", { recipientExternal: true });

    const { env: metered, cost } = metering(testEnv);
    const decision = await evaluate(metered, atTime(AUGUST_10), ORG, FACTS);
    expect(decision.fetched).toEqual({ domains: true, dailyVolume: false });

    report("evaluate/recipient-external", cost);
    expect(cost.d1Executions).toBe(2);
  });

  it("costs three queries at the worst case, which is the figure #60 predicted", async () => {
    // Every condition in play at once: the published set, the domain set, and today's counter. Three is the
    // ceiling rather than the typical cost, and it is reached only when a live policy asks for both derived
    // inputs.
    await publish("external", "require_approval", { recipientExternal: true });
    await publish("busy", "hold", { orgDailyVolumeMin: 100 });
    await publish("by mailbox", "allow", { mailboxId: MAILBOX });

    const { env: metered, cost } = metering(testEnv);
    const decision = await evaluate(metered, atTime(AUGUST_10), ORG, FACTS);
    expect(decision.fetched).toEqual({ domains: true, dailyVolume: true });

    report("evaluate/all-five-conditions", cost);
    expect(cost.d1Executions).toBe(3);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["policy.evaluate_max_subrequests"]);
    expect(cost.r2Operations).toBe(0);
    expect(cost.doRpcs).toBe(0);
  });

  it("costs the same at 3 published policies as at 30, because the read is one query either way", async () => {
    // The cost this design accepts, measured rather than argued: every published policy is read on every
    // seal, and reading thirty costs the same *number of operations* as reading three. What grows is rows
    // read inside one query, not queries — which is the term the subrequest budget is spent in.
    for (let n = 0; n < 30; n++) await publish(`rule ${n}`, "allow", { mailboxId: MAILBOX });

    const { env: metered, cost } = metering(testEnv);
    const decision = await evaluate(metered, atTime(AUGUST_10), ORG, FACTS);
    expect(decision.matched).toHaveLength(30);

    report("evaluate/thirty-published-policies", cost);
    expect(cost.d1Executions).toBe(1);
  });

  it("adds one to a seal in the ordinary case, and three at the worst case", async () => {
    // The figure that actually matters, because `mail.send.propose` is the most expensive Butler node and
    // `butler-step-cost.md` divides the per-instance budget by its bound.
    const bare = metering(testEnv);
    await sealManifest(bare.env, atTime(AUGUST_10 + 1000), ORG, {
      mailboxId: MAILBOX, authorUserId: AUTHOR, to: ["customer@example.net"],
      subject: "No policies", bodyTyped: "Hello.", fidelity: "authored",
    });
    report("seal/no-policies", bare.cost);

    await publish("external", "require_approval", { recipientExternal: true });
    await publish("busy", "hold", { orgDailyVolumeMin: 100 });

    const gated = metering(testEnv);
    const sealed = await sealManifest(gated.env, atTime(AUGUST_10 + 2000), ORG, {
      mailboxId: MAILBOX, authorUserId: AUTHOR, to: ["customer@example.net"],
      subject: "Both derived conditions", bodyTyped: "Hello.", fidelity: "authored",
    });
    expect(sealed.state).toBe("awaiting");
    report("seal/both-derived-conditions", gated.cost);

    // Exactly two more operations than the bare seal: the domain set and the counter. The published-set read
    // is in both, because a seal always evaluates.
    expect(gated.cost.subrequests - bare.cost.subrequests).toBe(2);
    // And the whole seal still fits inside the bound `butler-step-cost.md`'s loop arithmetic divides by.
    expect(gated.cost.subrequests).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_send_propose"]);
  });

  it("prices the worst seal in the product: a reply with both derived conditions in play", async () => {
    // The figure `butler-step-cost.md`'s loop arithmetic has to survive, because the reply path is the more
    // expensive of the two and both derived conditions is the worst policy set. Measured rather than derived
    // by adding two to the reply figure — that addition is exactly the kind of arithmetic that has been off
    // by one twice in this repository.
    await publish("external", "require_approval", { recipientExternal: true });
    await publish("busy", "hold", { orgDailyVolumeMin: 100 });
    const messageId = await aParentMessage(atTime(AUGUST_10));

    const { env: metered, cost } = metering(testEnv);
    await sealManifest(metered, atTime(AUGUST_10 + 3000), ORG, {
      mailboxId: MAILBOX, authorUserId: AUTHOR, to: ["customer@example.net"],
      subject: "Re: q", bodyTyped: "Answered.", fidelity: "authored", inReplyToMessageId: messageId,
    });

    report("seal/reply-both-derived-conditions", cost);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_send_propose"]);
  });

  it("prices a publication, because an administrator does it on a request like any other", async () => {
    const draft = await createPolicyDraft(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      name: "measured", outcome: "deny", conditions: { recipientExternal: true },
    });
    const { env: metered, cost } = metering(testEnv);
    await publishPolicy(metered, atTime(AUGUST_10), ORG, ADMIN, draft.policyId);

    report("publish", cost);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["policy.publish_max_subrequests"]);
    expect(cost.d1Batches).toBe(1);
  });
});

/** A real inbound message the author may read, so a reply can be sealed against it. */
async function aParentMessage(ctx: Ctx): Promise<string> {
  const at = new Date(ctx.now()).toISOString();
  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, "<in@example.net>");
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
  return messageId;
}
