import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { revoke } from "../src/access.ts";
import { verifyChain } from "../src/audit.ts";
import {
  APPROVAL_REASONS, decideApproval, openStage, pendingApprovals, shortfallFor,
  stageOf, stagesOfApproval, withdrawApproval, type Decision, type Stages,
} from "../src/approvals.ts";
import { decidersOf } from "../src/deciders.ts";
import { hashPassword } from "../src/auth/password.ts";
import { ACCESS_COOKIE, login } from "../src/auth/session.ts";
import deliveryScript from "../src/client/delivery.client.js";
import { cancelSend, dispatchDue, type SendState } from "../src/outbound/dispatch.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import worker from "../src/index.ts";
import { createPolicyDraft, editPolicyDraft, publishPolicy, requiredStages } from "../src/policy.ts";
import type { SubmitOutcome, TransportAdapter } from "../src/outbound/transport.ts";

/**
 * Approvals (#61): ordered stages, distinctness on the person, and the two checks.
 *
 * ## The test this whole file exists for
 *
 * *"One person in two teams cannot satisfy a count of 2."* `readableSubjects` authorizes a principal as
 * `[userId, ...teamIds]`, so a relation can be held through a team, and the holder set is therefore a set of
 * **tuples** while a decider is a **person**. Measuring distinctness at the tuple layer would let one human
 * being provide dual control — and it would look like working code, pass every ordinary test, and be discovered
 * by an auditor rather than by us. So the fixture below builds exactly that person: `DUAL` is in two teams,
 * both teams hold `approval.decide`, and nobody else holds it at all.
 *
 * ## Non-vacuity
 *
 * Every assertion here was verified by breaking the source it guards and watching it fail. The observed
 * messages are recorded in the ticket's report; the two that are worth keeping beside the code are noted
 * inline, because they are the ones whose failure mode is *silence* rather than an error.
 */

const testEnv = env as unknown as Env;
const ORG = "org_approvals";
const MAILBOX = "mbx_appr";
const OTHER_MAILBOX = "mbx_appr_other";
const ADDRESS = "support@acme.example";

const ADMIN = "usr_appr_admin";
const AUTHOR = "usr_appr_author";
const ANN = "usr_appr_ann";
const BOB = "usr_appr_bob";
/** In two teams, each of which holds `approval.decide`. One person, two tuples. */
const DUAL = "usr_appr_dual";
const TEAM_A = "tm_appr_a";
const TEAM_B = "tm_appr_b";

const PASSWORD = "fixture-password-not-a-real-secret";
const AUGUST_10 = Date.parse("2026-08-10T09:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

/** A stage set of plain counts, which is what every pre-#73 case in this file asks for. */
function counts(...required: number[]): Stages {
  return required.map((count) => stageOf(count));
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

async function teamMember(teamId: string, userId: string): Promise<void> {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    "INSERT OR IGNORE INTO team_members (id, org_id, team_id, user_id, created_at) VALUES (?,?,?,?,?)",
  ).bind(ctx.id("tmm"), ORG, teamId, userId, new Date(ctx.now()).toISOString()).run();
}

/** A published policy requiring approval, with the stage counts given. */
async function requireApproval(
  name: string,
  stages?: Stages,
  conditions: Record<string, unknown> = { mailboxId: MAILBOX },
): Promise<{ policyId: string; versionId: string }> {
  const ctx = atTime(AUGUST_10);
  const draft = await createPolicyDraft(testEnv, ctx, ORG, ADMIN, {
    name, outcome: "require_approval", conditions, stages,
  });
  const live = await publishPolicy(testEnv, ctx, ORG, ADMIN, draft.policyId);
  return { policyId: live.policyId, versionId: live.versionId };
}

async function seal(overrides?: Partial<Parameters<typeof sealManifest>[3]>) {
  return sealManifest(testEnv, atTime(AUGUST_10 + 1000), ORG, {
    mailboxId: MAILBOX,
    authorUserId: AUTHOR,
    to: ["customer@example.net"],
    subject: "Needs approval",
    bodyTyped: "Body.",
    fidelity: "authored",
    ...overrides,
  });
}

async function manifestRow(id: string) {
  return testEnv.CATALOG.prepare(
    "SELECT state, state_reason, last_error, release_at FROM send_manifests WHERE org_id = ? AND id = ?",
  ).bind(ORG, id).first<{
    state: SendState; state_reason: string | null; last_error: string | null; release_at: string;
  }>();
}

async function approvalRow(manifestId: string) {
  // `subject_kind` is pinned rather than left to the id's prefix, exactly as `approvalOfManifest` does: a
  // query that found a send's approval by id alone would keep passing if the column stopped being written.
  return testEnv.CATALOG.prepare(
    `SELECT id, state, resolved_at FROM approvals
      WHERE org_id = ? AND subject_kind = 'send_manifest' AND subject_id = ?`,
  ).bind(ORG, manifestId).first<{ id: string; state: string; resolved_at: string | null }>();
}

async function decisionRows(approvalId: string) {
  const { results } = await testEnv.CATALOG.prepare(
    `SELECT stage_ordinal, decider_user_id, decision, withdrawn_at FROM approval_decisions
      WHERE approval_id = ? ORDER BY decided_at, id`,
  ).bind(approvalId).all<{
    stage_ordinal: number; decider_user_id: string; decision: Decision; withdrawn_at: string | null;
  }>();
  return results;
}

beforeEach(async () => {
  for (const table of ["approval_decisions", "approval_stages", "approvals", "policy_stages",
                       "policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "team_members", "addresses", "mailboxes", "users",
                       "node_claim", "login_attempts", "sessions", "refresh_tokens", "audit_entries",
                       "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_appr", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(OTHER_MAILBOX, ORG, "Billing", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...[ADMIN, AUTHOR, ANN, BOB, DUAL].map((userId) => testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at)),
  ]);

  await tuple(ADMIN, "org.admin", "organization", ORG);
  for (const relation of ["send.propose", "mailbox.content.read"]) {
    await tuple(AUTHOR, relation, "mailbox", MAILBOX);
  }
  await teamMember(TEAM_A, DUAL);
  await teamMember(TEAM_B, DUAL);
});

async function sessionFor(userId: string): Promise<string> {
  const outcome = await login(testEnv, createSystemCtx(), ORG, `${userId}@acme.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

/* ------------------------------------------------------------------ the arithmetic -------------- */

describe("the satisfiability rule (shortfallFor)", () => {
  /** `n` distinct people, as the eligible set the rule is now expressed over. */
  const people = (n: number): Set<string> =>
    new Set(Array.from({ length: n }, (_, index) => `usr_p${index}`));

  it("is exhaustively decidable, and blames the first stage that cannot be filled", () => {
    // The whole rule, in one table. Both checks — publication and the seal — go through this function, so a
    // wrong cell here is wrong in both places, which is the argument for having one function rather than two
    // predicates that agree today.
    //
    // Unchanged cell for cell by #73's rewrite from subtraction to a matching, which is the point of keeping
    // the table: with no team named, every stage draws from one set and the matching *is* the subtraction.
    expect(shortfallFor(counts(1), people(1))).toBeNull();
    expect(shortfallFor(counts(2), people(2))).toBeNull();
    expect(shortfallFor(counts(1, 1), people(2))).toBeNull();
    expect(shortfallFor(counts(2, 1), people(3))).toBeNull();

    // Nobody decides twice in one approval, so a chain needs the *sum* of its counts in distinct people.
    expect(shortfallFor(counts(1, 1), people(1))).toEqual({
      ordinal: 2, required: 1, available: 0, short: 1, eligible: 1, needed: 2, team: null,
    });
    expect(shortfallFor(counts(2), people(1))).toEqual({
      ordinal: 1, required: 2, available: 1, short: 1, eligible: 1, needed: 2, team: null,
    });
    // The blame lands on the first stage that outruns the supply, not on the last one: stage 1 is fillable
    // here and stage 2 is not.
    expect(shortfallFor(counts(1, 2), people(2))).toEqual({
      ordinal: 2, required: 2, available: 1, short: 1, eligible: 2, needed: 3, team: null,
    });
    expect(shortfallFor(counts(1), people(0))?.ordinal).toBe(1);
  });

  it("re-assigns rather than blaming a later stage for an earlier one's choice (#73)", () => {
    /*
     * The case a greedy fold gets wrong, and the reason the rule is a matching now.
     *
     * Ann is in both teams; Bob is only in Legal. Stage 1 wants a member of Legal and stage 2 wants a member
     * of Finance, and the *only* member of Finance is Ann — so stage 1 has to take Bob. A greedy pass that
     * gave stage 1 whichever Legal member it saw first would take Ann and then report stage 2 as one member
     * of Finance short, sending an administrator to grow a team that was never the problem.
     */
    const finance = { id: "tm_fin", name: "Finance", members: new Set(["usr_ann"]) };
    const legal = { id: "tm_leg", name: "Legal", members: new Set(["usr_ann", "usr_bob"]) };
    const rosters = new Map([[finance.id, finance], [legal.id, legal]]);
    const eligible = new Set(["usr_ann", "usr_bob"]);

    expect(shortfallFor([stageOf(1, legal.id), stageOf(1, finance.id)], eligible, rosters)).toBeNull();
    // And it still refuses what is genuinely impossible: two from Finance, which has one member.
    expect(shortfallFor([stageOf(2, finance.id)], eligible, rosters)).toEqual({
      ordinal: 1, required: 2, available: 1, short: 1, eligible: 1, needed: 2,
      team: { id: "tm_fin", name: "Finance" },
    });
  });

  it("treats a team it has never heard of as nobody, which is the restrictive answer (#73)", () => {
    // The house rule about unclassified inputs, at the one place it decides whether a send goes out. A roster
    // map with no entry for the named team must not read as "unconstrained".
    const shortfall = shortfallFor([stageOf(1, "tm_ghost")], new Set(["usr_ann", "usr_bob"]), new Map());
    expect(shortfall?.available).toBe(0);
    expect(shortfall?.team).toEqual({ id: "tm_ghost", name: null });
  });

  it("gives every reason token it writes words in the module a browser is served", () => {
    // The same split #60 established: this module mints the tokens, `delivery.client.js` owns the prose, and
    // the assertion is against the exact bytes `ui.ts` serves rather than an imported map — because that file
    // is a Text module and cannot be imported as a namespace inside workerd.
    for (const reason of APPROVAL_REASONS) {
      expect(deliveryScript, `no words for ${reason}`).toContain(`\n  ${reason}: {`);
    }
  });
});

/* ------------------------------------------------------------------ distinctness ---------------- */

describe("distinctness is measured on the person, not on the tuple", () => {
  it("counts one human being in two approval.decide teams as ONE decider", async () => {
    await tuple(TEAM_A, "approval.decide", "mailbox", MAILBOX);
    await tuple(TEAM_B, "approval.decide", "mailbox", MAILBOX);

    // Two tuples grant it. One person holds it.
    const tuples = await testEnv.CATALOG.prepare(
      `SELECT COUNT(*) AS n FROM relationship_tuples
        WHERE org_id = ? AND relation = 'approval.decide' AND object_id = ?`,
    ).bind(ORG, MAILBOX).first<{ n: number }>();
    expect(tuples?.n).toBe(2);
    expect([...await decidersOf(testEnv, ORG, MAILBOX)]).toEqual([DUAL]);
  });

  it("refuses to publish a count of 2 that one person in two teams would otherwise satisfy", async () => {
    await tuple(TEAM_A, "approval.decide", "mailbox", MAILBOX);
    await tuple(TEAM_B, "approval.decide", "mailbox", MAILBOX);

    // This is the failure the whole design turns on. At the tuple layer there are two holders, so a naive
    // count says the stage is satisfiable — and it would then be *satisfied* by one person deciding twice.
    await expect(requireApproval("dual control", counts(2))).rejects.toThrow(/E_APPROVAL_UNSATISFIABLE/);
    // A second name, because the refused publish leaves its policy and draft behind — publication is what is
    // refused, not authoring, and #60 keeps the draft so an administrator can fix it rather than retype it.
    await expect(requireApproval("dual control again", counts(2)))
      .rejects.toThrow(/stage 1 needs 2 distinct approver/);
  });

  it("lets that one person take only one slot when a second real person exists", async () => {
    await tuple(TEAM_A, "approval.decide", "mailbox", MAILBOX);
    await tuple(TEAM_B, "approval.decide", "mailbox", MAILBOX);
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("dual control", counts(2));

    const sealed = await seal();
    expect(sealed.state).toBe("awaiting");
    expect(sealed.stateReason).toBe("policy_approval_required");
    const approval = (await approvalRow(sealed.id))!;
    expect(await stagesOfApproval(testEnv, approval.id)).toEqual(counts(2));

    // The person with two team hats decides once...
    const first = await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, DUAL, approval.id, "approve");
    expect(first.completed).toBe(false);
    expect(first.openStage).toBe(1);
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");

    // ...and cannot decide again wearing the other one. This is the assertion that would pass silently if
    // distinctness were on the tuple: the count would reach 2 with one human being.
    await expect(
      decideApproval(testEnv, atTime(AUGUST_10 + 3000), ORG, DUAL, approval.id, "approve"),
    ).rejects.toThrow(/E_ALREADY_DECIDED/);
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");

    // A second person closes it, and only then does the send move.
    const second = await decideApproval(testEnv, atTime(AUGUST_10 + 4000), ORG, ANN, approval.id, "approve");
    expect(second.completed).toBe(true);
    expect(second.openStage).toBeNull();
    expect((await manifestRow(sealed.id))?.state).toBe("held");
    expect((await manifestRow(sealed.id))?.state_reason).toBeNull();
  });

  it("resolves a team-held relation without reading a table, and without a new index", async () => {
    // The claim 0020 makes after writing the obvious index and then reading the plan: `tm_unique`'s `org_id`
    // prefix already covers the reverse lookup, and an index on (org_id, team_id, user_id) changed only which
    // covering index the planner named. Measured by dropping it and re-planning — the plans were identical
    // except for the index name — so it was not shipped. #11's lesson: a plan looked fine right up until
    // somebody printed it, and this one looked *necessary* until somebody printed it.
    const plan = await testEnv.CATALOG.prepare(
      `EXPLAIN QUERY PLAN
       SELECT t.object_id, m.user_id FROM relationship_tuples t
         JOIN team_members m ON m.org_id = t.org_id AND m.team_id = t.subject_id
        WHERE t.org_id = ? AND t.object_type = 'mailbox' AND t.relation = 'approval.decide'`,
    ).bind(ORG).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    for (const detail of details) console.log(`PLAN team_members  ${detail}`);
    // A covering index either way, so an eligibility check reads no table row. What it does do is range over
    // this organization's membership inside that index, which is bounded by headcount rather than by mail
    // volume — the figure 0020 says to watch, and the reason the fix would be rt_unique's column order rather
    // than a second membership index.
    expect(details.some((detail) => detail.includes("COVERING INDEX tm_unique"))).toBe(true);
    expect(details.some((detail) => /SCAN\s+(m|team_members)\b/.test(detail)),
      "reading team_members rows rather than an index").toBe(false);
  });
});

/* ------------------------------------------------------------------ the author ------------------ */

describe("the author is never eligible", () => {
  it("passes publication and fails at the seal when the only holder is the author", async () => {
    // The case that proves the second check is not redundant. Publication cannot know who will write the
    // message, so it checks the weaker condition — somebody holds the relation — and passes. The seal knows,
    // subtracts them, and finds nobody left.
    await tuple(AUTHOR, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("needs a second pair of eyes");

    const sealed = await seal();
    expect(sealed.state).toBe("withheld");
    expect(sealed.stateReason).toBe("approval_unsatisfiable");
    expect(sealed.approvalId).toBeNull();
    expect(sealed.approvalShortfall?.ordinal).toBe(1);
    // No approval row at all: there is nothing to decide, so a pending request would be dead work in a queue.
    expect(await approvalRow(sealed.id)).toBeNull();
    // And the prose says which stage, beside the machine token.
    expect((await manifestRow(sealed.id))?.last_error).toContain("stage 1 needs 1 distinct approver");
  });

  it("refuses a decision by the author even when somebody else could have decided", async () => {
    await tuple(AUTHOR, "approval.decide", "mailbox", MAILBOX);
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("needs a second pair of eyes");

    const sealed = await seal();
    expect(sealed.state).toBe("awaiting");
    const approval = (await approvalRow(sealed.id))!;

    await expect(
      decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, AUTHOR, approval.id, "approve"),
    ).rejects.toThrow(/E_APPROVER_IS_ACTOR/);
    // Denying your own send is refused too: cancelling is the author's own act and does not put their name in
    // the trail as somebody else's reviewer.
    await expect(
      decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, AUTHOR, approval.id, "deny"),
    ).rejects.toThrow(/E_APPROVER_IS_ACTOR/);
    expect(await decisionRows(approval.id)).toEqual([]);
  });

  it("excludes a caller who holds nothing on the mailbox, with the answer an absent approval gives", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate");
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;

    // §5C: BOB holds nothing here, and the refusal must not confirm that this approval exists.
    await expect(
      decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, BOB, approval.id, "approve"),
    ).rejects.toThrow(/E_NO_APPROVAL/);
  });
});

/* ------------------------------------------------------------------ ordered stages -------------- */

describe("ordered stages give sequential review by distinct people", () => {
  it("takes two people in order for [1, 1], and the same person cannot take both", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("two stages", counts(1, 1));

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    expect(await stagesOfApproval(testEnv, approval.id)).toEqual(counts(1, 1));

    const first = await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");
    expect(first.stageOrdinal).toBe(1);
    expect(first.completed).toBe(false);
    // Stage 2 is open, and the person who took stage 1 may not take it. Ordered stages of count 1 are §18's
    // sequential shape, minus the team labels a team constraint would have added.
    expect(first.openStage).toBe(2);
    await expect(
      decideApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, ANN, approval.id, "approve"),
    ).rejects.toThrow(/E_ALREADY_DECIDED/);

    const second = await decideApproval(testEnv, atTime(AUGUST_10 + 3000), ORG, BOB, approval.id, "approve");
    expect(second.stageOrdinal).toBe(2);
    expect(second.completed).toBe(true);
    expect((await approvalRow(sealed.id))?.state).toBe("approved");
    expect((await manifestRow(sealed.id))?.state).toBe("held");
  });

  it("folds two matching policies by taking the maximum count per stage", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await tuple(DUAL, "approval.decide", "mailbox", MAILBOX);
    const one = await requireApproval("one approver", counts(1));
    const chain = await requireApproval("two then one", counts(2, 1));

    // #60's conflict resolution reused rather than a second rule invented for stages: both policies are in
    // force, so the demand at each ordinal is the greater of the two, and the chain is as long as the longest.
    expect(await requiredStages(testEnv, [one.versionId, chain.versionId])).toEqual(counts(2, 1));

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    expect(await stagesOfApproval(testEnv, approval.id)).toEqual(counts(2, 1));
    expect(sealed.state).toBe("awaiting");
  });

  it("stores one stage set per rule, so the implicit and explicit single stage are the same rule", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    const implicit = await requireApproval("implicit");
    // No rows for the default, which is what makes `[1]` and "unspecified" one rule rather than two.
    const rows = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM policy_stages WHERE policy_version_id = ?",
    ).bind(implicit.versionId).first<{ n: number }>();
    expect(rows?.n).toBe(0);

    // And an edit that spells the default out changes nothing, so publishing it is refused as a no-op.
    await editPolicyDraft(testEnv, atTime(AUGUST_10), ORG, ADMIN, implicit.policyId, {
      outcome: "require_approval", conditions: { mailboxId: MAILBOX }, stages: counts(1),
    });
    await expect(publishPolicy(testEnv, atTime(AUGUST_10), ORG, ADMIN, implicit.policyId))
      .rejects.toThrow(/E_POLICY_UNCHANGED/);

    // A real change to the counts is a real change, which is what makes the stage set part of the content.
    await editPolicyDraft(testEnv, atTime(AUGUST_10), ORG, ADMIN, implicit.policyId, {
      outcome: "require_approval", conditions: { mailboxId: MAILBOX }, stages: counts(1, 1),
    });
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    expect((await publishPolicy(testEnv, atTime(AUGUST_10), ORG, ADMIN, implicit.policyId)).version).toBe(2);
  });

  it("refuses stages on an outcome that never reads them, and a stage of zero", async () => {
    await expect(createPolicyDraft(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      name: "hold with stages", outcome: "hold", stages: counts(2),
    })).rejects.toThrow(/E_STAGES_WITHOUT_APPROVAL/);
    await expect(createPolicyDraft(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      name: "nobody has to", outcome: "require_approval", stages: counts(0),
    })).rejects.toThrow(/E_BAD_APPROVAL_STAGE/);
  });
});

/* ------------------------------------------------------------------ publication ----------------- */

describe("publication refuses what nobody could satisfy, and a live policy is re-checked", () => {
  it("refuses a policy on a mailbox with no approvers, naming the mailbox and the shortfall", async () => {
    await expect(requireApproval("gate")).rejects.toThrow(/E_APPROVAL_UNSATISFIABLE/);
    await expect(requireApproval("gate two")).rejects.toThrow(new RegExp(`mailbox ${MAILBOX}`));
    // Nothing was published, so the refusal did not leave a live rule behind.
    const live = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM policy_versions WHERE org_id = ? AND state = 'published'",
    ).bind(ORG).first<{ n: number }>();
    expect(live?.n).toBe(0);
  });

  it("checks every mailbox when the policy names none, because it applies to all of them", async () => {
    // MAILBOX has an approver and OTHER_MAILBOX does not. An unconditional policy gates sends from both, so
    // publishing it would park every send from the second one — which is exactly the silent failure this check
    // exists to prevent, and being lenient here is how it would have arrived.
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await expect(requireApproval("org wide", undefined, {})).rejects.toThrow(
      new RegExp(`mailbox ${OTHER_MAILBOX}`),
    );

    await tuple(BOB, "approval.decide", "mailbox", OTHER_MAILBOX);
    await expect(requireApproval("org wide, second try", undefined, {})).resolves.toBeTruthy();
  });

  it("re-checks at the seal, so revoking approval.decide cannot make a live policy silently unsatisfiable", async () => {
    // The live case, and the reason publication-only was rejected. The policy was satisfiable when it was
    // published; the grant that made it so is then withdrawn.
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate");
    expect((await seal()).state, "before the revoke").toBe("awaiting");

    await revoke(testEnv, atTime(AUGUST_10 + 500), ORG, ADMIN, {
      subjectId: ANN, relation: "approval.decide", objectId: MAILBOX,
    });

    const after = await seal();
    // Not `awaiting` with nothing having failed — which is what publication-only would have produced, and is
    // the shape of a `stale_when` that named the right condition and which nothing checked.
    expect(after.state).toBe("withheld");
    expect(after.stateReason).toBe("approval_unsatisfiable");
    expect(after.approvalShortfall?.short).toBe(1);
  });
});

/* ------------------------------------------------------------------ denial ---------------------- */

describe("a denial is terminal", () => {
  it("withholds the send with approval_denied, and nothing reopens it", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));

    const sealed = await seal({ to: ["a@example.net"], cc: ["b@example.net"] });
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    const denied = await decideApproval(testEnv, atTime(AUGUST_10 + 3000), ORG, BOB, approval.id, "deny");
    expect(denied.completed).toBe(true);
    expect(denied.manifestState).toBe("withheld");
    expect((await approvalRow(sealed.id))?.state).toBe("denied");
    expect((await manifestRow(sealed.id))?.state_reason).toBe("approval_denied");

    // Every recipient follows the manifest, so nothing reads as simultaneously stopped and pending.
    const recipients = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE org_id = ? AND manifest_id = ?",
    ).bind(ORG, sealed.id).all<{ submission_state: string }>();
    expect(recipients.results).toHaveLength(2);
    expect(recipients.results.every((row) => row.submission_state === "withheld")).toBe(true);

    // No act reverses it: not a further decision, not a withdrawal, not a cancel — `withheld` is terminal.
    await expect(
      decideApproval(testEnv, atTime(AUGUST_10 + 4000), ORG, ANN, approval.id, "approve"),
    ).rejects.toThrow(/E_APPROVAL_SETTLED/);
    await expect(withdrawApproval(testEnv, atTime(AUGUST_10 + 4000), ORG, ANN, approval.id))
      .rejects.toThrow(/E_APPROVAL_SETTLED/);
    const cancelled = await cancelSend(testEnv, atTime(AUGUST_10 + 5000), ORG, sealed.id);
    expect(cancelled.cancelled).toBe(false);
  });
});

/* ------------------------------------------------------------------ withdrawal ------------------ */

describe("withdrawal is allowed while incomplete and refused once complete", () => {
  it("takes back a standing approval, reopens the stage, and does not restore the withdrawer's turn", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await tuple(DUAL, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    const withdrawn = await withdrawApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, ANN, approval.id);
    expect(withdrawn.approvalState).toBe("pending");
    expect(withdrawn.manifestState).toBe("awaiting");
    expect(withdrawn.shortfall).toBeUndefined();

    // The row survives with a withdrawal time. "I approved and then withdrew" is a fact an investigation asks
    // about, and a deletion would answer it with silence.
    const rows = await decisionRows(approval.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.withdrawn_at).not.toBeNull();
    expect(openStage(await stagesOfApproval(testEnv, approval.id), rows)).toBe(1);

    // And the withdrawer cannot decide again, which is what stops one person filling two slots by oscillating.
    await expect(
      decideApproval(testEnv, atTime(AUGUST_10 + 3000), ORG, ANN, approval.id, "approve"),
    ).rejects.toThrow(/E_ALREADY_DECIDED/);

    // Two other people can still finish it.
    await decideApproval(testEnv, atTime(AUGUST_10 + 3100), ORG, BOB, approval.id, "approve");
    const last = await decideApproval(testEnv, atTime(AUGUST_10 + 3200), ORG, DUAL, approval.id, "approve");
    expect(last.completed).toBe(true);
    expect((await manifestRow(sealed.id))?.state).toBe("held");
  });

  it("refuses a withdrawal once the approval is complete, which is what makes an approved send safe", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate");
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    await expect(withdrawApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, ANN, approval.id))
      .rejects.toThrow(/E_APPROVAL_SETTLED/);
    expect((await manifestRow(sealed.id))?.state).toBe("held");
  });

  it("refuses a withdrawal by somebody who never approved", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    await expect(withdrawApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, BOB, approval.id))
      .rejects.toThrow(/E_NOTHING_TO_WITHDRAW/);
  });

  it("withholds the send when the withdrawal leaves too few people to finish", async () => {
    // The live unsatisfiable case this build does close. Two approvers, a count of 2: Ann approves and then
    // withdraws, which removes her from the eligible set for good — so one person remains for a stage needing
    // two, and the request is closed rather than left reading as pending.
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    const withdrawn = await withdrawApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, ANN, approval.id);
    expect(withdrawn.approvalState).toBe("unsatisfiable");
    expect(withdrawn.manifestState).toBe("withheld");
    expect(withdrawn.shortfall?.short).toBe(1);
    expect((await manifestRow(sealed.id))?.state_reason).toBe("approval_unsatisfiable");
    // And it is settled, so the one remaining approver cannot decide a request nobody can complete.
    await expect(
      decideApproval(testEnv, atTime(AUGUST_10 + 3000), ORG, BOB, approval.id, "approve"),
    ).rejects.toThrow(/E_APPROVAL_SETTLED/);
  });
});

/* ------------------------------------------------------------------ the races ------------------- */

describe("the conflict is the signal", () => {
  it("lets exactly one of two concurrent finalisations win", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await tuple(DUAL, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    // One approval standing, so either of the remaining two would close it.
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    // Interleaved at the point that matters: BOB's decision commits inside the window between DUAL's read and
    // DUAL's write. A proxy over the binding rather than a seam in `src/`, the way `policy.test.ts` and
    // `cost-meter.ts` do it — a production branch that exists only to be taken by a test is a branch nothing
    // else exercises.
    let raced = false;
    const racing = envWhoseFirstBatchAlsoRuns(async () => {
      if (raced) return;
      raced = true;
      await decideApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, BOB, approval.id, "approve");
    });

    // The loser is refused rather than recorded: every statement in a decision shares the "still pending"
    // predicate, so a decision arriving after somebody else closed the approval writes nothing at all.
    await expect(decideApproval(racing, atTime(AUGUST_10 + 3000), ORG, DUAL, approval.id, "approve"))
      .rejects.toThrow(/E_APPROVAL_SETTLED/);

    expect(raced).toBe(true);
    expect((await approvalRow(sealed.id))?.state).toBe("approved");
    // Two decisions, not three. The send was released once.
    expect(await decisionRows(approval.id)).toHaveLength(2);
    expect((await manifestRow(sealed.id))?.state).toBe("held");
  });

  it("reads a withdrawal racing the final approval as the conflict it is", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await tuple(DUAL, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    // BOB is about to cast what he read as the closing approval. Ann withdraws in the window.
    let raced = false;
    const racing = envWhoseFirstBatchAlsoRuns(async () => {
      if (raced) return;
      raced = true;
      await withdrawApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, ANN, approval.id);
    });

    const outcome = await decideApproval(racing, atTime(AUGUST_10 + 3000), ORG, BOB, approval.id, "approve");
    expect(raced).toBe(true);
    // His decision is recorded — it was a real decision — and it did not complete the approval. `changes = 0`
    // on the completion UPDATE, where completion was expected, means exactly this.
    expect(outcome.completed).toBe(false);
    expect(outcome.conflict).toBe("withdrawn");
    expect((await approvalRow(sealed.id))?.state).toBe("pending");
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");
    // The send did not leave, which is the property the conditional UPDATE exists to protect.
    expect((await manifestRow(sealed.id))?.state_reason).toBe("policy_approval_required");
  });

  it("refuses a withdrawal whose shortfall the decisions moved out from under", async () => {
    // A withdrawal is the one act that has to know what it *leaves behind*, and the shortfall it acts on is
    // computed from decisions read a moment earlier. So its predicate pins the decision counts: two
    // withdrawals landing together would each read a satisfiable request and leave an unsatisfiable one
    // reading as `pending`, which is the exact state this design exists to close.
    for (const person of [ANN, BOB, DUAL]) await tuple(person, "approval.decide", "mailbox", MAILBOX);
    await tuple(ADMIN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("three", counts(3));

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");
    await decideApproval(testEnv, atTime(AUGUST_10 + 2100), ORG, BOB, approval.id, "approve");

    let raced = false;
    const racing = envWhoseFirstBatchAlsoRuns(async () => {
      if (raced) return;
      raced = true;
      await withdrawApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, BOB, approval.id);
    });
    await expect(withdrawApproval(racing, atTime(AUGUST_10 + 3000), ORG, ANN, approval.id))
      .rejects.toThrow(/E_WITHDRAW_RACED/);
    expect(raced).toBe(true);

    // Bob's withdrawal stands; Ann's wrote nothing, entry included.
    const rows = await decisionRows(approval.id);
    expect(rows.filter((row) => row.withdrawn_at !== null).map((row) => row.decider_user_id)).toEqual([BOB]);
    const entries = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ? AND action = 'approval.withdrawn'",
    ).bind(ORG).first<{ n: number }>();
    expect(entries?.n).toBe(1);

    // And withdrawing again against the counts as they now are reaches the right answer: two approvers remain
    // for a stage of three, so the request is closed rather than left reading as open.
    const again = await withdrawApproval(testEnv, atTime(AUGUST_10 + 3500), ORG, ANN, approval.id);
    expect(again.approvalState).toBe("unsatisfiable");
    expect((await manifestRow(sealed.id))?.state_reason).toBe("approval_unsatisfiable");
  });

  it("changes nothing when a withdrawal loses to the approval that completed the request", async () => {
    // The statements that close an unsatisfiable request are gated on *this call's own withdrawal* having
    // landed. Ungated they were unconditional, and this interleaving left a released send whose every
    // recipient said `withheld` — a send that is two things at once, which is what the gate on every other
    // recipient update in this Node exists to prevent.
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));

    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    let raced = false;
    const racing = envWhoseFirstBatchAlsoRuns(async () => {
      if (raced) return;
      raced = true;
      await decideApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, BOB, approval.id, "approve");
    });
    await expect(withdrawApproval(racing, atTime(AUGUST_10 + 3000), ORG, ANN, approval.id))
      .rejects.toThrow(/E_APPROVAL_SETTLED/);
    expect(raced).toBe(true);

    expect((await approvalRow(sealed.id))?.state).toBe("approved");
    expect((await manifestRow(sealed.id))?.state).toBe("held");
    const recipients = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE org_id = ? AND manifest_id = ?",
    ).bind(ORG, sealed.id).all<{ submission_state: string }>();
    expect(recipients.results.every((row) => row.submission_state === "held")).toBe(true);
  });
});

/* ------------------------------------------------------------------ the cancel drain ------------ */

describe("cancelling the send settles the request it was waiting on", () => {
  it("closes the approval, empties the queue, and refuses a decision on a cancelled send", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate");
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    expect(await pendingApprovals(testEnv, ORG, ANN)).toHaveLength(1);

    expect(await cancelSend(testEnv, atTime(AUGUST_10 + 1500), ORG, sealed.id))
      .toEqual({ cancelled: true });
    // The request goes with the send. Without this the queue kept dead work, and — the sharper half —
    // approving it closed the approval, moved nothing, and reported the send as released.
    expect((await approvalRow(sealed.id))?.state).toBe("cancelled");
    expect((await approvalRow(sealed.id))?.resolved_at).not.toBeNull();
    expect(await pendingApprovals(testEnv, ORG, ANN)).toEqual([]);

    await expect(decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve"))
      .rejects.toThrow(/E_APPROVAL_SETTLED/);
    await expect(decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve"))
      .rejects.toThrow(/the author cancelled the send/);
    const row = await manifestRow(sealed.id);
    expect(row?.state).toBe("cancelled");
    const recipients = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE org_id = ? AND manifest_id = ?",
    ).bind(ORG, sealed.id).all<{ submission_state: string }>();
    expect(recipients.results.every((one) => one.submission_state === "cancelled")).toBe(true);
    // Nothing was recorded as a decision, so the trail does not claim anybody decided a cancelled send.
    expect(await decisionRows(approval.id)).toEqual([]);
  });

  it("leaves an already-decided approval alone, because cancelling only reaches an open request", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate");
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    // The send is `held` now, which is still stoppable — so this cancel succeeds, and it must not rewrite the
    // approval that was already answered.
    expect((await cancelSend(testEnv, atTime(AUGUST_10 + 2500), ORG, sealed.id)).cancelled).toBe(true);
    expect((await approvalRow(sealed.id))?.state).toBe("approved");
  });
});

/* ------------------------------------------------------------------ the trail ------------------- */

describe("the trail", () => {
  it("records the request beside the seal, in one transaction, with the chain intact", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(1));
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;

    const entries = await testEnv.CATALOG.prepare(
      `SELECT action, subject, actor_user_id, detail FROM audit_entries
        WHERE org_id = ? AND action IN ('send.sealed', 'approval.requested') ORDER BY seq`,
    ).bind(ORG).all<{ action: string; subject: string; actor_user_id: string | null; detail: string }>();
    expect(entries.results.map((row) => row.action)).toEqual(["send.sealed", "approval.requested"]);
    expect(entries.results[1]!.subject).toBe(approval.id);
    // The Node asked, because the policy required it. Not the author: they did not choose to be reviewed.
    expect(entries.results[1]!.actor_user_id).toBeNull();
    const detail = JSON.parse(entries.results[1]!.detail) as Record<string, unknown>;
    expect(detail.stages).toEqual([{ count: 1, teamId: null }]);
    expect(detail.eligible).toBe(1);
    expect(detail.subjectKind).toBe("send_manifest");
    expect(detail.subjectId).toBe(sealed.id);

    // Two entries in one batch chain to each other rather than both to the tip, which verification is the
    // only real check of: two entries claiming one sequence number, or the second carrying the tip's hash,
    // would both break here.
    expect(await verifyChain(testEnv, ORG)).toMatchObject({ intact: true, brokenAt: null });
  });

  it("records a decision and a withdrawal against the person who took them", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    // Three approvers for a count of two, so Ann's withdrawal leaves the request satisfiable and Bob is
    // deciding an open question rather than a dead one.
    await tuple(DUAL, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));
    const sealed = await seal();
    const approval = (await approvalRow(sealed.id))!;

    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");
    await withdrawApproval(testEnv, atTime(AUGUST_10 + 2500), ORG, ANN, approval.id);
    await decideApproval(testEnv, atTime(AUGUST_10 + 3000), ORG, BOB, approval.id, "deny");

    const entries = await testEnv.CATALOG.prepare(
      `SELECT action, actor_user_id, outcome FROM audit_entries
        WHERE org_id = ? AND action IN ('approval.decided', 'approval.withdrawn') ORDER BY seq`,
    ).bind(ORG).all<{ action: string; actor_user_id: string; outcome: string }>();
    expect(entries.results.map((row) => [row.action, row.actor_user_id, row.outcome])).toEqual([
      ["approval.decided", ANN, "ok"],
      ["approval.withdrawn", ANN, "ok"],
      // A denial is a refusal of the send, and filters as one.
      ["approval.decided", BOB, "refused"],
    ]);
    expect(await verifyChain(testEnv, ORG)).toMatchObject({ intact: true });
  });
});

/* ------------------------------------------------------------------ what happens next ----------- */

describe("an approved send is an ordinary held send", () => {
  it("is dispatched once its hold window has passed, and not before the approval", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate");
    const sealed = await seal();

    // Well past the release time, and still nowhere: `awaiting` is neither `held` nor `throttled`, so the
    // predicate that lets a send out never admitted it.
    expect(await dispatchDue(testEnv, atTime(AUGUST_10 + 86_400_000), ORG, refusingTransport(), 20))
      .toEqual([]);

    const approval = (await approvalRow(sealed.id))!;
    await decideApproval(testEnv, atTime(AUGUST_10 + 2000), ORG, ANN, approval.id, "approve");

    const dispatched = await dispatchDue(
      testEnv, atTime(AUGUST_10 + 86_400_000), ORG, handingTransport(), 20,
    );
    expect(dispatched.map((result) => result.state)).toEqual(["handed_over"]);
  });
});

/* ------------------------------------------------------------------ the HTTP surface ------------ */

describe("an approver can reach this from outside the process", () => {
  it("lists what is waiting on them, decides it, and refuses a decision it cannot read", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await tuple(BOB, "approval.decide", "mailbox", MAILBOX);
    // Three, so the withdrawal below leaves the request open rather than closing it as unsatisfiable.
    await tuple(DUAL, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(2));
    const sealed = await seal();

    const annToken = await sessionFor(ANN);
    const listed = await SELF.fetch("https://node/api/approvals", {
      headers: { cookie: `${ACCESS_COOKIE}=${annToken}` },
    });
    expect(listed.status).toBe(200);
    const { approvals } = await listed.json() as {
      approvals: Array<{
        id: string; subjectKind: string; subjectId: string; reason: string | null;
        stages: Stages; openStage: number;
      }>;
    };
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.subjectKind).toBe("send_manifest");
    expect(approvals[0]!.subjectId).toBe(sealed.id);
    // A send carries no requester's reason: the reason it is being reviewed is the policy that matched, which
    // the outbox already shows beside the send. `null` here rather than an invented sentence.
    expect(approvals[0]!.reason).toBeNull();
    expect(approvals[0]!.stages).toEqual(counts(2));

    const approvalId = approvals[0]!.id;
    const post = (token: string, path: string, body?: unknown) => SELF.fetch(`https://node${path}`, {
      method: "POST",
      headers: { cookie: `${ACCESS_COOKIE}=${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    // An absent decision is refused rather than defaulted: either default would record a judgement nobody made.
    const vague = await post(annToken, `/api/approvals/${approvalId}/decide`, {});
    expect(vague.status).toBe(422);
    expect((await vague.json() as { error: string }).error).toBe("E_BAD_DECISION");

    const approved = await post(annToken, `/api/approvals/${approvalId}/decide`, { decision: "approve" });
    expect(approved.status).toBe(200);
    expect((await approved.json() as { decided: { completed: boolean } }).decided.completed).toBe(false);

    // Withdrawal through the surface too, since an approver who cannot find their own decision cannot take it
    // back.
    const withdrawn = await post(annToken, `/api/approvals/${approvalId}/withdraw`);
    expect(withdrawn.status).toBe(200);
    expect((await withdrawn.json() as { withdrawn: { approvalState: string } }).withdrawn.approvalState)
      .toBe("pending");

    // The author sees nothing to decide, which is what stops a queue listing work nobody can do.
    expect(await pendingApprovals(testEnv, ORG, AUTHOR)).toEqual([]);
    // And somebody holding no relation on the mailbox gets an empty list rather than a refusal.
    expect(await pendingApprovals(testEnv, ORG, ADMIN)).toEqual([]);
  });
});

/**
 * An env whose **first** `batch()` is preceded by somebody else's committed act.
 *
 * The only way to land inside the window between a decision's reads and its write. Same shape
 * `test/policy.test.ts` uses for the publish race.
 */
function envWhoseFirstBatchAlsoRuns(interleave: () => Promise<void>): Env {
  let done = false;
  const catalog = new Proxy(testEnv.CATALOG, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!done) {
            done = true;
            await interleave();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...testEnv, CATALOG: catalog } as Env;
}

/** A transport that would fail loudly if anything reached it. */
function refusingTransport(): TransportAdapter {
  return {
    capability: async () => ({ canSend: true as const, detail: "test" }),
    submit: async () => {
      throw new Error("the transport must not be reached: an unapproved send never leaves");
    },
  } as unknown as TransportAdapter;
}

/** A transport that accepts, so the released send has somewhere to go. */
function handingTransport(): TransportAdapter {
  return {
    capability: async () => ({ canSend: true as const, detail: "test" }),
    submit: async (): Promise<SubmitOutcome> => ({ kind: "handed_over", transportMessageId: "tm_test" }),
  } as unknown as TransportAdapter;
}

/* ------------------------------------------------------- the gate clears, and the mail leaves ------ */

describe("clearing a gate is not enough on its own; something has to sweep", () => {
  /**
   * An approved send has to actually go.
   *
   * `OutboxSweeper`'s alarm is the fast path, and it is armed by **sealing**. Clearing a gate arms nothing,
   * and three separate acts move a manifest from a gated state to `held`: an approval completing, a Butler
   * run's send being released, and a retry. So a send that a second approver had just cleared sat `held`
   * with `attempts = 0` until an unrelated request poked the Node — observed on a fixture Node, after
   * exactly this sequence.
   *
   * Arming from those three would be a list, and the fourth act to clear a gate would not be on it. The
   * backstop is one sweep on the cron that already runs every minute, which is what this test drives: the
   * exported `scheduled` handler, with the trigger `wrangler.jsonc` declares.
   *
   * `supervised-recording.test.ts` makes the same argument for §7's notices — a scan nothing calls is a row
   * that sits — and this is that shape for outbound.
   */
  it("dispatches an approved send from the cron, with nothing else touching the Node", async () => {
    await tuple(ANN, "approval.decide", "mailbox", MAILBOX);
    await requireApproval("gate", counts(1));
    /*
     * Sealed and decided on the **real** clock, because `scheduled` runs on one: every other test here uses
     * a fixed August instant, and a send held since then is refused at dispatch as `approval_expired` — the
     * recheck doing its job, and not the thing under test.
     */
    const now = createSystemCtx();
    // A zero hold window, so the send is due the instant its gate clears — otherwise the cron correctly
    // declines to dispatch something still inside its window, and the test would be asserting the wrong
    // refusal. Zero is a real configuration, not a test hack: `outbound.test.ts` covers it for the
    // password-reset mailbox that needs it.
    await testEnv.CATALOG.prepare("UPDATE mailboxes SET hold_window_seconds = 0 WHERE id = ?")
      .bind(MAILBOX).run();
    const sealed = await sealManifest(testEnv, now, ORG, {
      mailboxId: MAILBOX,
      authorUserId: AUTHOR,
      to: ["customer@example.net"],
      subject: "Needs approval",
      bodyTyped: "Body.",
      fidelity: "authored",
    });
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");

    const [approval] = await pendingApprovals(testEnv, ORG, ANN);
    await decideApproval(testEnv, now, ORG, ANN, approval!.id, "approve");
    // The gate is open and the message has still not moved: this is the state the defect left it in.
    expect((await manifestRow(sealed.id))?.state).toBe("held");

    const execution = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/1 * * * *", noRetry: () => undefined } as ScheduledController,
      testEnv,
      execution,
    );
    await waitOnExecutionContext(execution);

    const swept = await manifestRow(sealed.id);
    expect(swept?.state, JSON.stringify(swept)).toBe("handed_over");
  });
});
