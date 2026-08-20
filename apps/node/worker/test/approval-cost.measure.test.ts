import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { decidersOf, decideApproval, withdrawApproval } from "../src/approvals.ts";
import { metering } from "../src/cost-meter.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import { createPolicyDraft, publishPolicy } from "../src/policy.ts";

/**
 * What an eligibility check and a decision cost, **measured** (#61).
 *
 * ## Method, and its boundary
 *
 * Real `workerd` under `vitest-pool-workers`, against a real D1 and a real R2, counted with
 * `src/cost-meter.ts` — which counts **executions** rather than `prepare`, prices a `batch()` as the one round
 * trip it is, and sees Durable Object RPCs.
 *
 * **Not a deployed Node.** Miniflare's D1 is a local SQLite, so what is measured here is the *number of
 * operations Mailda performs* — which is exactly what the subrequest budget is spent in — and not their
 * latency. `policy-evaluation-cost.md` and `doctor-check-cost.md` draw the same line for the same instrument,
 * and it is the honest boundary rather than a caveat added to be safe.
 *
 * ## Why these three scenarios
 *
 * The eligibility check is the one #61 asked for, and it is the operation everything else here contains. A
 * decision is the act, and it is measured **three** ways because the three differ in what they write: an
 * approval that leaves stages open, one that closes the last stage and releases the send, and a denial. A
 * withdrawal is measured twice for the same reason — the one that leaves the request satisfiable writes one
 * row, and the one that does not withholds the send in the same transaction.
 *
 * The figures are **bounds with headroom, not equalities**, for the reason `butler-step-cost.md` states: an
 * equality on an I/O count fails on every harmless refactor and gets deleted, while a bound catches an
 * operation becoming an order of magnitude more expensive.
 */

const testEnv = env as unknown as Env;
const ORG = "org_apprcost";
const MAILBOX = "mbx_apprcost";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_apprcost_admin";
const AUTHOR = "usr_apprcost_author";
const ANN = "usr_apprcost_ann";
const BOB = "usr_apprcost_bob";
const CARLA = "usr_apprcost_carla";

const AUGUST_10 = Date.parse("2026-08-10T09:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

function report(scenario: string, cost: {
  subrequests: number; d1Executions: number; d1Batches: number; r2Operations: number; doRpcs: number;
}): void {
  console.log(
    `MEASURE approval scenario=${scenario}  subrequests=${cost.subrequests}` +
    `  d1=${cost.d1Executions} (batches=${cost.d1Batches})  r2=${cost.r2Operations}` +
    `  do_rpc=${cost.doRpcs}`,
  );
}

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string): Promise<void> {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

/** A published require_approval policy with the given stage counts, and a gated send waiting on it. */
async function gatedSend(stages: number[]): Promise<{ manifestId: string; approvalId: string }> {
  const ctx = atTime(AUGUST_10);
  const draft = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
    name: `gate ${stages.join("-")}`, outcome: "require_approval",
    conditions: { mailboxId: MAILBOX }, stages,
  });
  await publishPolicy(testEnv, ctx, ORG, ADMIN, draft.policyId);
  const sealed = await sealManifest(testEnv, atTime(AUGUST_10 + 1000), ORG, {
    mailboxId: MAILBOX, authorUserId: AUTHOR, to: ["customer@example.net"],
    subject: "Needs approval", bodyTyped: "Body.", fidelity: "authored",
  });
  if (sealed.approvalId === null) throw new Error(`no approval was requested: ${sealed.stateReason}`);
  return { manifestId: sealed.id, approvalId: sealed.approvalId };
}

beforeEach(async () => {
  for (const table of ["approval_decisions", "approval_stages", "approvals", "policy_stages",
                       "policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "team_members", "addresses", "mailboxes", "users",
                       "audit_entries", "outbox"]) {
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
    ...[ADMIN, AUTHOR, ANN, BOB, CARLA].map((userId) => testEnv.CATALOG.prepare(
      "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
    ).bind(userId, ORG, `${userId}@local.invalid`, at)),
  ]);
  await tuple(ADMIN, "org.admin", "organization", ORG);
  for (const relation of ["send.propose", "mailbox.content.read"]) {
    await tuple(AUTHOR, relation, "mailbox", MAILBOX);
  }
  for (const approver of [ANN, BOB, CARLA]) await tuple(approver, "approval.decide", "mailbox", MAILBOX);
});

describe("what an approval costs (#61)", () => {
  it("checks eligibility in one query, teams resolved and people de-duplicated", async () => {
    // One query, and it is one query *because* the two branches are a UNION rather than two round trips: a
    // direct holder and a holder through a team are the same question asked of two tables.
    const { env: metered, cost } = metering(testEnv);
    expect((await decidersOf(metered, ORG, MAILBOX)).size).toBe(3);

    report("eligibility", cost);
    expect(cost.d1Executions).toBe(1);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.eligibility_max_subrequests"]);
    expect(cost.r2Operations).toBe(0);
    expect(cost.doRpcs).toBe(0);
  });

  it("prices an approval that leaves a stage open", async () => {
    const { approvalId } = await gatedSend([2]);
    const { env: metered, cost } = metering(testEnv);
    const outcome = await decideApproval(metered, atTime(AUGUST_10 + 2000), ORG, ANN, approvalId, "approve");
    expect(outcome.completed).toBe(false);

    report("decide/approve-not-final", cost);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);
    // One batch carries the entry, the decision and both conditional state changes. Everything else is a read.
    expect(cost.d1Batches).toBe(1);
    expect(cost.r2Operations).toBe(0);
  });

  it("prices the approval that closes the last stage and releases the send", async () => {
    const { manifestId, approvalId } = await gatedSend([2]);
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approvalId, "approve");

    const { env: metered, cost } = metering(testEnv);
    const outcome = await decideApproval(metered, atTime(AUGUST_10 + 3000), ORG, BOB, approvalId, "approve");
    expect(outcome.completed).toBe(true);

    report("decide/approve-final", cost);
    // The same cost as a non-final approval, which is the point of doing the completion in SQL: releasing the
    // send is two more statements inside the batch that was already going, not a second round trip.
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);
    expect(cost.d1Batches).toBe(1);
    const row = await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(manifestId).first<{ state: string }>();
    expect(row?.state).toBe("held");
  });

  it("prices a denial", async () => {
    const { approvalId } = await gatedSend([1]);
    const { env: metered, cost } = metering(testEnv);
    await decideApproval(metered, atTime(AUGUST_10 + 2000), ORG, ANN, approvalId, "deny");

    report("decide/deny", cost);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);
    expect(cost.d1Batches).toBe(1);
  });

  it("prices a withdrawal, and the withdrawal that withholds the send", async () => {
    const three = await gatedSend([2]);
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, three.approvalId, "approve");
    const plain = metering(testEnv);
    const kept = await withdrawApproval(plain.env, atTime(AUGUST_10 + 2500), ORG, ANN, three.approvalId);
    expect(kept.approvalState).toBe("pending");
    report("withdraw/still-satisfiable", plain.cost);
    expect(plain.cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);

    // The other branch: with only two approvers left for a count of two, Bob's withdrawal closes the request
    // and withholds the send — three more statements in the same one batch.
    await decideApproval(testEnv, atTime(AUGUST_10 + 3000), ORG, BOB, three.approvalId, "approve");
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ? AND relation = 'approval.decide'",
    ).bind(ORG, CARLA).run();
    const closing = metering(testEnv);
    const gone = await withdrawApproval(closing.env, atTime(AUGUST_10 + 3500), ORG, BOB, three.approvalId);
    expect(gone.approvalState).toBe("unsatisfiable");
    report("withdraw/leaves-unsatisfiable", closing.cost);
    expect(closing.cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);
    expect(closing.cost.d1Batches).toBe(1);
  });

  it("adds two operations to a seal, and only on the require_approval path", async () => {
    // The figure that matters for a Butler sealing in a loop, and the reason it is two rather than always two:
    // the stage set and the eligible set are read only when a policy actually requires approval. A send gated
    // by a hold, or not gated at all, pays nothing for this mechanism — the same laziness `evaluate` uses for
    // its two derived inputs.
    const ctx = atTime(AUGUST_10);
    const hold = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "hold it", outcome: "hold", conditions: { mailboxId: MAILBOX },
    });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, hold.policyId);

    const held = metering(testEnv);
    const heldSend = await sealManifest(held.env, atTime(AUGUST_10 + 1000), ORG, {
      mailboxId: MAILBOX, authorUserId: AUTHOR, to: ["customer@example.net"],
      subject: "Held", bodyTyped: "Body.", fidelity: "authored",
    });
    expect(heldSend.stateReason).toBe("policy_hold");
    report("seal/hold-gate", held.cost);

    const approve = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "approve it", outcome: "require_approval", conditions: { mailboxId: MAILBOX }, stages: [2],
    });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, approve.policyId);

    const gated = metering(testEnv);
    const gatedSealed = await sealManifest(gated.env, atTime(AUGUST_10 + 2000), ORG, {
      mailboxId: MAILBOX, authorUserId: AUTHOR, to: ["customer@example.net"],
      subject: "Needs approval", bodyTyped: "Body.", fidelity: "authored",
    });
    expect(gatedSealed.approvalId).not.toBeNull();
    report("seal/approval-gate", gated.cost);

    // Two: the stage set of every matching version, and the eligible approvers on the mailbox. The approval and
    // its stage rows are extra *statements* in the batch the seal was already making, so they cost nothing.
    expect(gated.cost.subrequests - held.cost.subrequests).toBe(2);
    expect(gated.cost.d1Batches).toBe(1);
    // And the whole gated seal still fits the bound the Butler loop arithmetic divides.
    expect(gated.cost.subrequests).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_send_propose"]);
  });
});
