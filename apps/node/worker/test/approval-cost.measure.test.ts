import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { decideApproval, stageOf, withdrawApproval } from "../src/approvals.ts";
import { rostersOf } from "../src/deciders.ts";
import { addTeamMember, createTeam } from "../src/teams.ts";
import { placeHold, requestHoldLift } from "../src/holds.ts";
import { decidersOf } from "../src/deciders.ts";
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
 * ## The hold lift is measured here too, and that is not scope creep
 *
 * A lift (#64) is an approval whose subject is a `hold_lifts` row rather than a manifest, so it spends this
 * receipt's budget and the same `stale_when` clauses govern it — *"the approvals tables gain a column a
 * decision has to read"* fired the moment `subject_kind` existed. Measuring it in a second file would have put
 * two sets of figures for one mechanism in two places, which is how the three-names-for-one-ceiling defect in
 * `doctor-check-cost.md` came about.
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
async function gatedSend(counts: number[]): Promise<{ manifestId: string; approvalId: string }> {
  const ctx = atTime(AUGUST_10);
  const draft = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
    name: `gate ${counts.join("-")}`, outcome: "require_approval",
    conditions: { mailboxId: MAILBOX }, stages: counts.map((count) => stageOf(count)),
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
  for (const table of ["approval_decisions", "approval_stages", "approvals", "hold_lifts", "holds",
                       "policy_stages",
                       "policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "team_members", "teams", "addresses", "mailboxes", "users",
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
      name: "approve it", outcome: "require_approval", conditions: { mailboxId: MAILBOX }, stages: [stageOf(2)],
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

describe("what a hold lift costs (#64)", () => {
  /** A hold placed by the administrator, ready to be asked about. */
  async function heldMailbox(): Promise<string> {
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: MAILBOX });
    return hold.id;
  }

  it("prices the request: the hold, the eligible set, the chain tip and one batch", async () => {
    const holdId = await heldMailbox();
    const { env: metered, cost } = metering(testEnv);
    const asked = await requestHoldLift(metered, atTime(AUGUST_10 + 1000), ORG, ADMIN, holdId, "matter closed");
    expect(asked.stages).toEqual([stageOf(2)]);

    report("hold-lift/request", cost);
    // One batch carries the `approval.requested` entry, the request row, the approval and its stage. The rest
    // are reads: the administrator check, the hold, the eligible set, and the audit tip.
    expect(cost.d1Batches).toBe(1);
    expect(cost.r2Operations).toBe(0);
    expect(cost.doRpcs).toBe(0);
    // Bounded against the decision budget rather than a new key: a lift request is an approval request, and
    // inventing a second number for it would be a number with no separate measurement behind it.
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);
  });

  it("prices the first approval, which changes nothing about the hold", async () => {
    const holdId = await heldMailbox();
    const asked = await requestHoldLift(testEnv, atTime(AUGUST_10 + 1000), ORG, ADMIN, holdId, "matter closed");

    const { env: metered, cost } = metering(testEnv);
    const first = await decideApproval(metered, atTime(AUGUST_10 + 2000), ORG, ANN, asked.approvalId, "approve");
    expect(first.holdLifted).toBe(false);

    report("hold-lift/approve-not-final", cost);
    expect(cost.d1Batches).toBe(1);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);
  });

  it("prices the approval that applies the lift, one read more than a send's", async () => {
    const holdId = await heldMailbox();
    const asked = await requestHoldLift(testEnv, atTime(AUGUST_10 + 1000), ORG, ADMIN, holdId, "matter closed");
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, asked.approvalId, "approve");

    const { env: metered, cost } = metering(testEnv);
    const closing = await decideApproval(metered, atTime(AUGUST_10 + 3000), ORG, BOB, asked.approvalId, "approve");
    expect(closing.holdLifted).toBe(true);

    report("hold-lift/approve-final", cost);
    // Still **one** batch: the audit entries, the decision, the completion and the `UPDATE holds` all ride in
    // it, which is what makes "the lift and its record are one act" a property of the transaction rather than
    // a claim. The extra read against a send's figure is the request row, whose reason the `hold.lifted`
    // entry has to name.
    expect(cost.d1Batches).toBe(1);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);
    expect(cost.r2Operations).toBe(0);
    expect(cost.doRpcs).toBe(0);
  });

  it("costs the coverage check nothing extra now that it tests lifted_at", async () => {
    // `coveringHolds` grew a clause, not a query. Measured because the hold check sits on the deletion path
    // and a second read there would be paid by every discard in a held mailbox.
    const holdId = await heldMailbox();
    const { env: metered, cost } = metering(testEnv);
    const { coveringHolds } = await import("../src/holds.ts");
    expect(await coveringHolds(metered, ORG, MAILBOX, new Date(AUGUST_10).toISOString())).toHaveLength(1);
    report("hold-lift/coverage-check", cost);
    expect(cost.d1Executions).toBe(1);
    expect(holdId.startsWith("hld_")).toBe(true);
  });
});

/**
 * What #73's team-scoped stage costs, which is what `approval-decision-cost.md`'s own `stale_when` demanded.
 *
 * That clause names it outright — *"the eligible set gains a narrowing constraint — a team-scoped stage is the
 * one #61 named absent, and it would add a query or a join to every eligibility check"* — and the prediction
 * is half right, which is exactly why it had to be measured rather than reasoned about. It adds a query, and
 * it adds it only to the checks that name a team. A send gated by an ordinary policy pays nothing.
 */
describe("what a team-scoped stage costs (#73)", () => {
  async function team(name: string, members: readonly string[]): Promise<string> {
    const created = await createTeam(testEnv, atTime(AUGUST_10), ORG, ADMIN, name);
    for (const userId of members) {
      await addTeamMember(testEnv, atTime(AUGUST_10), ORG, ADMIN, created.id, userId);
    }
    return created.id;
  }

  async function teamGatedSend(teamId: string): Promise<{ manifestId: string; approvalId: string }> {
    const ctx = atTime(AUGUST_10);
    const draft = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: `gate team ${teamId}`, outcome: "require_approval",
      conditions: { mailboxId: MAILBOX }, stages: [stageOf(1, teamId)],
    });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, draft.policyId);
    const sealed = await sealManifest(testEnv, atTime(AUGUST_10 + 1000), ORG, {
      mailboxId: MAILBOX, authorUserId: AUTHOR, to: ["customer@example.net"],
      subject: "Needs approval", bodyTyped: "Body.", fidelity: "authored",
    });
    if (sealed.approvalId === null) throw new Error(`no approval was requested: ${sealed.stateReason}`);
    return { manifestId: sealed.id, approvalId: sealed.approvalId };
  }

  it("resolves a roster in one query, and asks nothing when no stage names a team", async () => {
    const legal = await team("Legal", [ANN, BOB]);

    const asked = metering(testEnv);
    const rosters = await rostersOf(asked.env, ORG, [legal]);
    expect(rosters.get(legal)?.members.size).toBe(2);
    report("roster/one-team", asked.cost);
    expect(asked.cost.d1Executions).toBe(1);

    // The laziness the seal's figure rests on: an empty request short-circuits before it prepares anything.
    const none = metering(testEnv);
    expect(await rostersOf(none.env, ORG, [])).toEqual(new Map());
    report("roster/no-team", none.cost);
    expect(none.cost.d1Executions).toBe(0);
    expect(none.cost.subrequests).toBe(0);
  });

  it("costs a team-scoped seal exactly one operation more than a team-less one", async () => {
    const legal = await team("Legal", [ANN, BOB]);
    const ctx = atTime(AUGUST_10);
    const compose = {
      mailboxId: MAILBOX, authorUserId: AUTHOR, to: ["customer@example.net"],
      subject: "Needs approval", bodyTyped: "Body.", fidelity: "authored" as const,
    };

    // The control: the same send, gated by a policy that names no team. Measured in this test rather than
    // read off the table above, so the two figures come from one run and the difference means something.
    const plain = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "any approver", outcome: "require_approval",
      conditions: { mailboxId: MAILBOX }, stages: [stageOf(1)],
    });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, plain.policyId);
    const teamless = metering(testEnv);
    expect((await sealManifest(teamless.env, atTime(AUGUST_10 + 1000), ORG, compose)).state).toBe("awaiting");
    report("seal/approval-team-less", teamless.cost);

    const scoped = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
      name: "legal reviews", outcome: "require_approval",
      conditions: { mailboxId: MAILBOX }, stages: [stageOf(1, legal)],
    });
    await publishPolicy(testEnv, ctx, ORG, ADMIN, scoped.policyId);
    const withTeam = metering(testEnv);
    expect((await sealManifest(withTeam.env, atTime(AUGUST_10 + 2000), ORG, compose)).state).toBe("awaiting");
    report("seal/approval-team-scoped", withTeam.cost);

    // Exactly one, and it is `rostersOf`. Everything else is what a gated seal already spent — the approval
    // row and its stage rows ride in the batch the seal was already making.
    expect(withTeam.cost.subrequests - teamless.cost.subrequests).toBe(1);
    expect(withTeam.cost.d1Batches).toBe(1);
    // And the whole gated seal still fits the bound the Butler loop arithmetic divides.
    expect(withTeam.cost.subrequests).toBeLessThanOrEqual(BUDGETS["butler.step_cost_max_send_propose"]);
  });

  it("costs a team-scoped decision one read more, spent only on the stage that names a team", async () => {
    const legal = await team("Legal", [ANN, BOB]);
    const { approvalId } = await teamGatedSend(legal);

    const { env: metered, cost } = metering(testEnv);
    const outcome = await decideApproval(metered, atTime(AUGUST_10 + 2000), ORG, ANN, approvalId, "approve");
    expect(outcome.completed).toBe(true);

    report("decide/team-scoped", cost);
    // Still one batch — the roster read is a read, and the decision, the entry and the state changes ride in
    // the transaction that was already going.
    expect(cost.d1Batches).toBe(1);
    expect(cost.subrequests).toBeLessThanOrEqual(BUDGETS["approval.decision_max_subrequests"]);
    expect(cost.r2Operations).toBe(0);
  });

  it("prices the publication check, which is where the team's existence is verified", async () => {
    const legal = await team("Legal", [ANN, BOB]);
    const draft = await createPolicyDraft(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      name: "legal reviews", outcome: "require_approval",
      conditions: { mailboxId: MAILBOX }, stages: [stageOf(1, legal)],
    });

    const { env: metered, cost } = metering(testEnv);
    await publishPolicy(metered, atTime(AUGUST_10), ORG, ADMIN, draft.policyId);
    report("publish/team-scoped", cost);
    // Bounded rather than pinned, for `butler-step-cost.md`'s reason: an equality on an I/O count fails on
    // every harmless refactor and gets deleted. Publication happens when an administrator writes a rule.
    expect(cost.d1Batches).toBe(1);
    expect(cost.r2Operations).toBe(0);
  });
});
