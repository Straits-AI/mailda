import type { Ctx } from "@mailda/runtime";

import { type AuditEvent, type AuditGate, auditedBatchMany } from "./audit.ts";
import { rostersOf } from "./deciders.ts";
import { conflict, notFound } from "./errors.ts";
import { noticeOwedByGrant } from "./notifications.ts";
import { COMPLETING_EFFECT } from "./approval-effects.ts";
import { ACTOR_DID, ACTOR_FIX, type ApprovalState, type ApprovalSubjectKind, type Decision, SCOPE_OF, approversOf, stagesOfApproval } from "./approval-plan.ts";
import { type ApprovalRow, type DecisionRow, decisionsOf, openStage, readApproval, standingByStage } from "./approval-rows.ts";

export interface DecisionOutcome {
  approvalId: string;
  subjectKind: ApprovalSubjectKind;
  subjectId: string;
  decision: Decision;
  /** The stage this decision was taken against. */
  stageOrdinal: number;
  approvalState: ApprovalState;
  /**
   * What the send is now. `held` once the last stage closes, `withheld` on a denial.
   *
   * Absent for every other subject kind rather than filled with a word that would not be true of it: a hold
   * lift has no manifest, and a field named `manifestState` reading `awaiting` on one would be the kind of
   * name AGENTS.md calls a landmine.
   */
  manifestState?: "awaiting" | "held" | "withheld";
  /** For a `hold_lift` subject: true when this decision was the one that applied the lift. */
  holdLifted?: boolean;
  /** For a `supervised_read` subject: true when this decision was the one that made the grant live. */
  supervisedGranted?: boolean;
  /**
   * For an `ediscovery_export` subject: true when this decision was the one that authorized the export.
   *
   * `exportApproved`, not `exportStarted` and not `exportRunning`: completing the approval authorizes the
   * copy and copies nothing. Somebody still has to run it, and until they do nothing has left the Node.
   */
  exportApproved?: boolean;
  /**
   * `domainPaused`, and it says what actually happened: the completing decision set `placed_at`, so mail
   * from that domain stops at the next seal and the next dispatch. Not `pauseApproved` — an approval that
   * authorized something to happen later is what `exportApproved` above means, and this one takes effect in
   * its own transaction.
   */
  domainPaused?: boolean;
  /** True when this decision closed the last stage and had its subject's effect. */
  completed: boolean;
  /**
   * Set when this decision was *expected* to close the last stage and did not, which means exactly one thing:
   * somebody withdrew theirs between this call's read and its write. See the conditional UPDATE below.
   */
  conflict?: "withdrawn";
  /** The stage still open, when one is. */
  openStage: number | null;
}

/**
 * Approves or denies, as one of the eligible people.
 *
 * ## The conditional UPDATE, and what `changes = 0` really means
 *
 * The completion transition is *"every stage satisfied AND nothing withdrawn"*, evaluated **inside the
 * database at the moment of the write**, because the eligible set and the standing decisions this function read
 * a few milliseconds ago can both have moved. That is the house pattern — the same compare-and-swap carrying
 * the claim protocol, the audit sequence, the migration ledger and provider event ids: the conflict is the
 * signal (#9).
 *
 * **`changes = 0` alone does not mean "somebody withdrew"**, and writing that down would be a claim this code
 * contradicts on its most ordinary path: every non-final approval leaves that UPDATE at 0, because the stage set
 * is still legitimately short. The signal is *"this decision should have closed the last stage and did not"* —
 * `expectedToComplete && !completed` — and **that** means a withdrawal, for a reason worth being precise about:
 *
 *   - The decision row landed, so the approval was still `pending` inside this transaction.
 *   - D1 runs the batch as one transaction, so the completion predicate saw this decision plus whatever else had
 *     committed — nothing partial.
 *   - A *competing finalisation* cannot produce it: every statement here shares the `pending` predicate, so a
 *     decision arriving after somebody else completed the approval is refused as `E_APPROVAL_SETTLED` below
 *     rather than recorded and reported as a conflict.
 *
 * So the only thing that turns an expected completion into a shortfall is a standing decision disappearing.
 *
 * Reported rather than retried. A retry would decide again on somebody's behalf, and the decision is already
 * recorded — what changed is only whether it was the last one needed.
 *
 * ## Why every statement shares one predicate
 *
 * The audit entry, the decision row and both state changes all carry *"the approval is still pending"*. Without
 * it on the INSERT, a decision could be recorded against a settled approval with the audit entry skipped by its
 * own gate — an act with no record, which is the exact hole `auditedBatch` exists to close. Same reasoning
 * `publishPolicy` records for putting its gate on the supersede as well as on the promotion.
 *
 * ## The one decision that is refused rather than recorded, and why the asymmetry is deliberate
 *
 * A decision that **completes a `hold_lift`** carries a stronger predicate than `pending`: *the approval is
 * pending, this decision closes every stage, and the hold is not lifted already*. Two entries ride in that
 * transaction — `approval.decided` and `hold.lifted` — and they share one gate, because `auditedBatchMany`
 * gates a batch rather than an entry. Under the weak predicate the withdrawal race that #61 documents would
 * insert a `hold.lifted` entry for a lift that did not happen: a false statement in the one place that is
 * supposed to be checkable, which is worse than any refusal.
 *
 * So in that single case a lost race records **nothing** and answers `E_HOLD_LIFT_RACED`, telling the decider
 * to read the request and decide again. A send in the same position keeps its decision and reports
 * `conflict: "withdrawn"`, and that difference is not an inconsistency: a send's decision still counts toward
 * its stage whatever else happened, while the lift's completing decision and the lift itself are one act that
 * must either both be true or both be absent.
 */
export async function decideApproval(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  approvalId: string,
  decision: Decision,
): Promise<DecisionOutcome> {
  const approval = await readApproval(env, orgId, approvalId);
  // §5C: an approval the caller may not decide and one that does not exist answer alike, because the id
  // discloses that a send is waiting in a mailbox they may hold nothing on. The fix still names the relation,
  // which is what keeps this a refusal somebody can act on rather than a dead end.
  const unknown = () => notFound("E_NO_APPROVAL", {
    what: `${approvalId} is not an approval you may decide`,
    why: "deciding takes approval.decide on the approval's mailbox — the one a send is from, or the one a "
      + "legal hold is over (§21 makes it the sole decision permission) — and §5C keeps an invisible thing "
      + "and an absent one answering alike",
    fix: "ask an administrator for approval.decide on that mailbox, or check the approval id",
  });
  if (approval === null) throw unknown();

  const deciders = await approversOf(env, orgId, approval.subjectKind, approval.scopeId);
  if (!deciders.has(actorUserId)) throw unknown();

  if (approval.actorUserId === actorUserId) {
    // §18: separation-of-duty policies prevent self-approval. Refused even for a denial — an author who wants
    // to stop their own send cancels it, which is their own authority and does not put their name in the trail
    // as somebody else's reviewer. The same exclusion is what stops one administrator lifting a hold alone:
    // they may request it, and after that they are the one person who cannot be either of its two approvers.
    throw conflict("E_APPROVER_IS_ACTOR", {
      what: ACTOR_DID[approval.subjectKind],
      why: "§18 requires separation of duty: an approval by the person whose act it is is not a second pair "
        + "of eyes",
      fix: ACTOR_FIX[approval.subjectKind],
    });
  }

  if (approval.state !== "pending") throw settled(approval);

  const stages = await stagesOfApproval(env, approvalId);
  const decisions = await decisionsOf(env, approvalId);

  if (decisions.some((row) => row.decider_user_id === actorUserId)) {
    // Enforced by `apd_one_per_person` as well; this is the message. A withdrawn decision still counts, which
    // is what makes withdrawal terminal for the withdrawer and stops one person filling two slots.
    throw conflict("E_ALREADY_DECIDED", {
      what: "you have already decided this approval",
      why: "each stage takes decisions from distinct people, and a withdrawal does not restore your turn — "
        + "otherwise one person could fill two slots by withdrawing and deciding again",
      fix: "another eligible approver has to take the remaining stage",
    });
  }

  const stage = openStage(stages, decisions);
  if (stage === null) {
    // Every stage satisfied while the row still says pending. Not reachable through this module — the
    // completing decision closes it in the same transaction — so it is a corrupted state rather than a race,
    // and deciding into it would record a decision nothing asked for.
    throw conflict("E_APPROVAL_COMPLETE", {
      what: `approval ${approvalId} has every stage satisfied but is still pending`,
      why: "the decision that satisfies the last stage closes the approval in the same transaction, so this "
        + "state is not produced by any path in this Node",
      fix: "investigate; a decision recorded here would be an approval nobody asked for",
    });
  }

  /*
   * The open stage's **team**, re-checked live (#73).
   *
   * This is the evaluation half of *"checked twice"*, applied to the stage constraint rather than to the
   * count. Publication verified the team exists; the seal verified enough of its members hold the relation;
   * and this verifies, at the instant of the decision, that **this** person is still in it — because
   * membership is authority and §7 makes authority live. A team somebody left has to stop letting them decide
   * on the next request, exactly as a revoked tuple does, and the frozen stage set deliberately freezes the
   * team's *id* and never its members.
   *
   * One extra query, and **only when the open stage names a team**: a stage set with no team constraint pays
   * nothing, which is what keeps every decision this Node has ever taken exactly as expensive as it was
   * (receipt: `approval-decision-cost.md`).
   *
   * The refusal is `E_APPROVER_NOT_IN_TEAM` rather than the §5C not-found above, and the asymmetry is
   * deliberate: this caller has already been shown that the approval exists — they hold `approval.decide` on
   * its scope and it is in their queue — so hiding the reason would leave them with a decision that silently
   * does nothing, and a refusal that names the team is the one they can act on.
   */
  const constrained = stages[stage - 1]?.teamId ?? null;
  if (constrained !== null) {
    const roster = (await rostersOf(env, orgId, [constrained])).get(constrained);
    if (roster === undefined || !roster.members.has(actorUserId)) {
      throw conflict("E_APPROVER_NOT_IN_TEAM", {
        what: `stage ${stage} of approval ${approvalId} may only be decided by a member of team `
          + `${roster === undefined ? constrained : `${roster.name} (${constrained})`}, and you are not in it`,
        why: "§18's separation of *duty* is a rule about which part of the organization reviews, not only "
          + "about how many people do — so a stage naming a team is satisfied by its members and by nobody "
          + "else. Membership is re-read here rather than frozen with the request, because authority is live",
        fix: "another member of that team has to take this stage, or an administrator can add you to it — "
          + "POST /api/teams/:id/members",
      });
    }
  }

  const at = new Date(ctx.now()).toISOString();

  // Would this decision close the last stage? Computed from what was read, so the conflict below is
  // "we expected to complete and the database disagreed" rather than a bare zero.
  const standing = standingByStage(decisions);
  const expectedToComplete = decision === "approve"
    && stages.every((each, index) => {
      const have = (standing.get(index + 1) ?? 0) + (index + 1 === stage ? 1 : 0);
      return have >= each.count;
    });

  /**
   * The subject-specific half of a **completing** decision, or null.
   *
   * Null for every non-completing decision and for every `send_manifest`, whose completion has no second
   * fact that must be true of the world. A completing `hold_lift` or `supervised_read` has one, and it is
   * read here — not in `approveStatements` — because the entry that rides with it has to name what was agreed
   * to, and an investigator reading the trail must not have to join two tables to learn it. One extra query,
   * on an act that happens at most twice per subject.
   */
  const effect = COMPLETING_EFFECT[approval.subjectKind];
  const completing = expectedToComplete && effect !== null ? effect : null;
  /*
   * Who the approvers are, this decision included. Recorded in the effect's entry because dual control is only
   * evidence if the trail says who the two were, and the eligible set is live — it cannot be reconstructed
   * from the tuples as they stand later.
   */
  const approvedBy = [
    ...decisions
      .filter((row) => row.decision === "approve" && row.withdrawn_at === null)
      .map((row) => row.decider_user_id),
    actorUserId,
  ];
  const effectEvent = completing === null
    ? null
    : await completing.event(env, orgId, approval, actorUserId, approvedBy);
  if (completing !== null && effectEvent === null) {
    // The subject of an approval cannot be missing: the request writes both rows in one transaction behind
    // one predicate. So this is a corrupted state rather than a race, and completing into it would perform the
    // subject's effect with no record of what was asked for.
    throw conflict(completing.missing.code, {
      what: completing.missing.what(approval),
      why: "the request row and its approval are written in one transaction, so neither can exist alone",
      fix: completing.missing.fix,
    });
  }

  /**
   * The predicate every statement in this batch carries.
   *
   * `pending` for every decision except one that completes a subject with an effect, which additionally
   * requires that this decision really does close every stage **and** that the effect has not already
   * happened. See the header for why those cases refuse rather than record.
   *
   * The `+ CASE` is this decision counted before its row exists: the entries are placed first in the batch,
   * so the predicate is evaluated against the decisions that had committed **before** this one.
   */
  const pending = "SELECT 1 FROM approvals WHERE id = ? AND org_id = ? AND state = 'pending'";
  const gate: AuditGate = completing === null
    ? { sql: pending, params: [approvalId, orgId] }
    : {
      sql: `SELECT 1 FROM approvals a
              WHERE a.id = ? AND a.org_id = ? AND a.state = 'pending'
                AND NOT EXISTS (
                  SELECT 1 FROM approval_stages s
                   WHERE s.approval_id = a.id
                     AND (SELECT COUNT(DISTINCT d.decider_user_id) FROM approval_decisions d
                           WHERE d.approval_id = s.approval_id AND d.stage_ordinal = s.ordinal
                             AND d.decision = 'approve' AND d.withdrawn_at IS NULL)
                         + (CASE WHEN s.ordinal = ? THEN 1 ELSE 0 END) < s.required_count)
                AND EXISTS (${completing.undone})`,
      // No parameters of its own: every `undone` clause below correlates on `a.subject_id` and `a.org_id`
      // rather than binding the subject again, so the placeholder count cannot drift from the clause.
      params: [approvalId, orgId, stage],
    };

  const decisionInsert = env.CATALOG.prepare(
    `INSERT INTO approval_decisions
       (id, org_id, approval_id, stage_ordinal, decider_user_id, decision, decided_at, withdrawn_at)
     SELECT ?,?,?,?,?,?,?,NULL WHERE EXISTS (${gate.sql})`,
  ).bind(ctx.id("apd"), orgId, approvalId, stage, actorUserId, decision, at, ...gate.params);

  const events: AuditEvent[] = [{
    action: "approval.decided",
    // A denial is a refusal of the act, and the trail should filter as one. An approval is `ok`.
    outcome: decision === "approve" ? "ok" : "refused",
    actorUserId,
    subject: approvalId,
    detail: {
      subjectKind: approval.subjectKind,
      subjectId: approval.subjectId,
      // Named for what it is rather than for what four of the five kinds happen to be: a mailbox for those
      // four, the organization for a domain pause. `scope` says which, so a reader of the trail never has to
      // guess what an id in this field is an id of.
      scope: SCOPE_OF[approval.subjectKind],
      scopeId: approval.scopeId,
      decision,
      stage,
      stages,
      actorUserId: approval.actorUserId,
    },
  }];

  if (effectEvent !== null) events.push(effectEvent);

  const statements = decision === "approve"
    ? approveStatements(env, ctx, orgId, approval, at)
    : denyStatements(env, orgId, approval, at);

  const { results } = await auditedBatchMany<never>(
    env, ctx, orgId, events,
    // The entries first: everything after them clears the predicate they are gated on.
    (entries) => [...entries, decisionInsert, ...statements],
    gate,
  );

  // Indexed off the number of entries rather than a literal, because a completing lift carries two and
  // everything else carries one. A hardcoded `results[1]` read the second *entry* on the lift path.
  const decisionResult = results[events.length]?.meta.changes ?? 0;
  const settledChanges = results[events.length + 1]?.meta.changes ?? 0;

  if (decisionResult === 0) {
    // The predicate failed for every statement, so nothing was recorded and nothing changed.
    const now = await readApproval(env, orgId, approvalId);
    if (completing === null || now === null || now.state !== "pending") throw settled(now ?? approval);
    // Still pending, so the part of the predicate that failed was the stronger half: a standing approval was
    // withdrawn, or the subject's effect had already happened. Either way nothing was recorded, and saying
    // which of the two it was would need a read whose answer could change again before it was rendered.
    throw conflict(completing.raced.code, {
      what: completing.raced.what(approval),
      why: completing.raced.why,
      fix: "read the approval again — GET /api/approvals — and decide again if it is still open",
    });
  }

  const completed = decision === "approve" ? settledChanges > 0 : true;

  // No extra read: see the header. Given that the decision itself landed, an expected completion that did not
  // happen has exactly one cause.
  const conflictKind: DecisionOutcome["conflict"] | undefined =
    expectedToComplete && !completed ? "withdrawn" : undefined;

  /*
   * The state afterwards is **computed from what this call read plus its own decision**, not re-read. Two
   * queries per decision to restate what the batch just did would be the cost of a courtesy, and the honest
   * caveat is cheaper than the queries: a concurrent withdrawal can make `openStage` below stale, and
   * `conflict` is the field that says so rather than a fresh read that would be stale a millisecond later
   * anyway.
   */
  const afterDecisions: DecisionRow[] = [
    ...decisions,
    { stage_ordinal: stage, decider_user_id: actorUserId, decision, withdrawn_at: null },
  ];
  const approvalState: ApprovalState = decision === "deny" ? "denied" : completed ? "approved" : "pending";

  return {
    approvalId,
    subjectKind: approval.subjectKind,
    subjectId: approval.subjectId,
    decision,
    stageOrdinal: stage,
    approvalState,
    // One field per subject kind, and never a field belonging to another one. A `manifestState` reading
    // `awaiting` on a supervised read would be the kind of name AGENTS.md calls a landmine.
    ...outcomeFieldFor(approval.subjectKind, decision, completed),
    completed,
    ...(conflictKind === undefined ? {} : { conflict: conflictKind }),
    openStage: decision === "deny" ? stage : openStage(stages, afterDecisions),
  };
}

/**
 * The one field a decision reports about its **subject**, per kind — and the exhaustiveness is real.
 *
 * It was a ternary chain, which is the shape that let #63's third kind be handed the send's advice: a chain's
 * final arm accepts every kind that reaches it, so a fifth would land in whichever branch was written last
 * and report an export's outcome for a connector write. A `switch` with a `never` binding at the foot cannot
 * do that — adding a member to `ApprovalSubjectKind` fails to compile here until it decides what it reports.
 *
 * Written as an assertion rather than a comment claiming exhaustiveness, because a claim nothing enforces is
 * exactly the defect this module's history is made of.
 */
function outcomeFieldFor(
  kind: ApprovalSubjectKind,
  decision: Decision,
  completed: boolean,
): Partial<DecisionOutcome> {
  switch (kind) {
    case "send_manifest":
      return { manifestState: decision === "deny" ? "withheld" : completed ? "held" : "awaiting" };
    case "hold_lift":
      return { holdLifted: decision === "approve" && completed };
    case "supervised_read":
      return { supervisedGranted: decision === "approve" && completed };
    case "ediscovery_export":
      return { exportApproved: decision === "approve" && completed };
    case "domain_pause":
      return { domainPaused: decision === "approve" && completed };
    default: {
      const unhandled: never = kind;
      throw new Error(`E_APPROVAL_SUBJECT_UNHANDLED  ${String(unhandled)} reports no outcome field`);
    }
  }
}

const SETTLED_WHY: Record<Exclude<ApprovalState, "pending">, string> = {
  denied:
    "a denial is terminal: there is no act that reverses one, because asking again mints a new subject — a "
    + "re-sealed manifest, or a second lift request — and with it a fresh approval (Layer 5's answer 1)",
  approved: "an approval is decided once; a second decision would be a second answer to the same question",
  unsatisfiable:
    "a withdrawal left fewer eligible approvers than the stages need, so there is no decision left that could "
    + "complete this request",
  /*
   * **Not "the author", and not "their own message".** `send.cancel` is bounded by `send.propose` on the
   * *mailbox*, so on a shared mailbox anyone holding it can stop somebody else's send — which
   * `capability.ts` states plainly: *"it stops somebody else's message leaving."* And the route is tier
   * `act`, so a delegated agent may take it. The entry now names who did, so this sentence points at that
   * rather than assuming.
   */
  cancelled:
    "the send was cancelled while this request was open, so there is nothing left to decide — anyone holding "
    + "`send.propose` on the mailbox may stop it, and the audit entry names who did (`cancelSend`)",
};

const SETTLED_FIX: Record<Exclude<ApprovalState, "pending">, string> = {
  denied: "ask again — a re-sealed send, or a fresh lift request, gets its own approval",
  approved: "read the send's state; it has already moved",
  unsatisfiable: "ask an administrator to grant approval.decide more widely, then compose again",
  cancelled: "nothing to do; the send is cancelled",
};

/**
 * The refusal every settled state answers with, one sentence per state rather than one branch for `denied` and
 * a default for everything else — which is how `unsatisfiable` came to be explained as "an approval is decided
 * once". A `Record` keyed on the type means a new state is a compile error here rather than a wrong sentence.
 */
export function settled(approval: ApprovalRow): Error {
  const state = approval.state;
  if (state === "pending") {
    // Refusing a pending request as settled would say "is pending, not pending", which is what this function
    // did until the withdrawal race got its own answer. Kept as a distinct refusal rather than deleted: it is
    // the one sentence that tells whoever reaches it that the *caller's* premise was wrong, not the request.
    return conflict("E_APPROVAL_PENDING", {
      what: `approval ${approval.id} is still pending`,
      why: "a refusal built for a settled request was raised against an open one, which no path in this Node "
        + "produces — every caller checks the state or carries the predicate that pins it",
      fix: "investigate; the request is open and whatever refused you did so for a reason it did not name",
    });
  }
  return conflict("E_APPROVAL_SETTLED", {
    what: `approval ${approval.id} is ${state}, not pending`,
    why: SETTLED_WHY[state],
    fix: SETTLED_FIX[state],
  });
}

/**
 * Approving: close the approval if this decision satisfies every stage, then let the subject's own effect run.
 *
 * The completion predicate is the SQL twin of `openStage` — *no stage whose standing, non-withdrawn, distinct
 * approvers fall short of its count*. `COUNT(DISTINCT decider_user_id)` rather than `COUNT(*)`, which is
 * belt-and-braces beside `apd_one_per_person` and is the layer that would still hold if that index were ever
 * relaxed to allow a second decision after a withdrawal.
 *
 * **The first statement is the same for every subject kind, and it is `results[events.length + 1]`** — the one
 * `decideApproval` reads to learn whether this decision completed the approval. Anything a kind adds goes after
 * it, conditional on the approval **having become approved** rather than on this function's expectation: a
 * decision that did not complete must leave its subject exactly where it was. Those statements run after the
 * UPDATE in the same `batch()`, which D1 executes in order inside one transaction, so they see it.
 */
function approveStatements(
  env: Env,
  ctx: Ctx,
  orgId: string,
  approval: ApprovalRow,
  at: string,
): D1PreparedStatement[] {
  const approvalId = approval.id;
  const approved = "SELECT 1 FROM approvals WHERE id = ? AND org_id = ? AND state = 'approved'";
  const completion = env.CATALOG.prepare(
    `UPDATE approvals SET state = 'approved', resolved_at = ?
      WHERE id = ? AND org_id = ? AND state = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM approval_stages s
           WHERE s.approval_id = approvals.id
             AND (SELECT COUNT(DISTINCT d.decider_user_id) FROM approval_decisions d
                   WHERE d.approval_id = s.approval_id AND d.stage_ordinal = s.ordinal
                     AND d.decision = 'approve' AND d.withdrawn_at IS NULL) < s.required_count)`,
  ).bind(at, approvalId, orgId);

  if (approval.subjectKind === "hold_lift") {
    return [
      completion,
      /*
       * **The one UPDATE holds in this product**, and every clause on it is load-bearing.
       *
       * `test/node/content-deletion-world.test.ts` fails on a second one, because narrowing a hold's window
       * (`UPDATE holds SET to_date = …`) is a lift with no reason, no second approver and no audit action —
       * the silent lift that test was written to catch while there was no loud one.
       *
       *   EXISTS (approved)   #64's dual control, at the database. The approval became `approved` one
       *                       statement ago in this same transaction, which means two distinct people
       *                       approved it and neither was the requester.
       *   lifted_at IS NULL   nothing lifts a hold twice. Unreachable through the product — a second
       *                       request is refused while one is pending and refused once the hold is lifted —
       *                       and kept as the layer that holds if that ever stops being true, the same way
       *                       `COUNT(DISTINCT …)` sits beside `apd_one_per_person`.
       *   lifted_reason       copied from the request rather than joined to it, so a reader of a hold meets
       *                       the reason without a join and the words cannot change afterwards (§13).
       */
      env.CATALOG.prepare(
        `UPDATE holds
            SET lifted_at = ?,
                lifted_reason = (SELECT l.reason FROM hold_lifts l WHERE l.id = ?),
                lift_id = ?
          WHERE org_id = ? AND lifted_at IS NULL
            AND id = (SELECT l.hold_id FROM hold_lifts l WHERE l.id = ? AND l.org_id = ?)
            AND EXISTS (${approved})`,
      ).bind(at, approval.subjectId, approval.subjectId, orgId, approval.subjectId, orgId,
        approvalId, orgId),
    ];
  }

  if (approval.subjectKind === "supervised_read") {
    return [
      completion,
      /*
       * **The one UPDATE supervised_grants in this product**, and this is what makes a grant live.
       *
       * Every clause is load-bearing, and they are the same three the lift carries one table over:
       *
       *   EXISTS (approved)     #63's dual control, at the database. The approval became `approved` one
       *                         statement ago in this same transaction, which means two distinct people
       *                         approved it and neither was the person who will read.
       *   granted_at IS NULL    nothing grants one grant twice. Unreachable through the product — a second
       *                         request is refused while one is pending, and a settled approval cannot be
       *                         decided again — and kept as the layer that holds if that stops being true.
       *
       * There is deliberately **no** `expires_at` in the SET list. The deadline was fixed at request time and
       * is exactly what the two approvers were shown; recomputing it from the approval's own instant would
       * silently extend every grant by however long the decision took, which is the widening §7 says needs a
       * fresh approval of its own.
       */
      env.CATALOG.prepare(
        `UPDATE supervised_grants SET granted_at = ?
          WHERE org_id = ? AND id = ? AND granted_at IS NULL AND EXISTS (${approved})`,
      ).bind(at, orgId, approval.subjectId, approvalId, orgId),
      /*
       * §7's notice to the person whose mail is about to be read, **in the same transaction as the grant**
       * (#63 part B).
       *
       * This placement is the whole property: D1 runs a batch as one transaction, so a live grant with no
       * notice owed is not a state this Node can reach. Not "unlikely" — unrepresentable. Suppressing the
       * notice therefore means deleting a row whose creation rode with an audit entry in a hash-linked
       * chain, and `doctor`'s `supervision_notice_missing` compares the two counts.
       *
       * It carries the same `EXISTS (approved)` gate as the UPDATE above, so a decision that did not
       * complete the approval writes neither, and it is ordered **after** the UPDATE deliberately: the
       * notice's `due_at` reads the grant, and the grant is what this transaction is making live.
       */
      noticeOwedByGrant(env, ctx, orgId, approval.subjectId, approval.scopeId, at,
        { sql: approved, params: [approvalId, orgId] }),
    ];
  }

  if (approval.subjectKind === "ediscovery_export") {
    /*
     * **The completion itself is the whole effect, and there is deliberately no `UPDATE exports` here.**
     *
     * The two kinds above each have a second fact to write — a hold becomes lifted, a grant becomes live —
     * because in both cases the authority *is* a column. An export's authority is the approval, and
     * `runExport` reads it live on every page. An `exports.approved_at` beside it would be a second answer
     * to "may this run", and the one that counted would be whichever the reader opened: the copy on the row
     * would still say yes after a withdrawal, which is exactly the state §7 requires the run to stop in.
     *
     * So the export row is untouched by the decision, and the `supervised.export_requested` entry rides in
     * this transaction with the `UPDATE approvals` above it — which is what makes an authorized export with
     * nothing in the trail unrepresentable, the same property the lift and the grant get from their own
     * writes.
     */
    return [completion];
  }

  if (approval.subjectKind === "domain_pause") {
    return [
      completion,
      /*
       * **The one UPDATE domain_pauses that places a pause**, and the clauses are the lift's and the grant's
       * one table over — which is the whole return on not giving this kind its own approval path.
       *
       *   EXISTS (approved)   #66's dual control, at the database. The approval became `approved` one
       *                       statement ago in this same transaction, so two distinct administrators
       *                       approved it and neither was the one who asked.
       *   placed_at IS NULL   nothing places one pause twice. A second decision on a settled approval is
       *                       already refused, so this is the layer that holds if that stops being true —
       *                       and a second `domain_pause.placed` entry would claim a second act on one row.
       *
       * `dpz_in_force` is what stops two *different* rows pausing one domain: the UNIQUE partial index makes
       * the second UPDATE fail rather than produce two pauses an administrator would have to lift twice.
       */
      env.CATALOG.prepare(
        `UPDATE domain_pauses SET placed_at = ?
          WHERE org_id = ? AND id = ? AND placed_at IS NULL AND lifted_at IS NULL
            AND EXISTS (${approved})`,
      ).bind(at, orgId, approval.subjectId, approvalId, orgId),
    ];
  }

  return [
    completion,
    // Back to `held`, so the ordinary hold window and the ordinary dispatcher take it from here. `state_reason`
    // returns to NULL because the gate is cleared and the reason column answers "why is it in this state" --
    // the record that this send was gated and approved lives in `policy_outcome`, in the approval, and in the
    // trail, not in a stale reason on a released row.
    env.CATALOG.prepare(
      `UPDATE send_manifests SET state = 'held', state_at = ?, state_reason = NULL
        WHERE id = ? AND org_id = ? AND state = 'awaiting' AND EXISTS (${approved})`,
    ).bind(at, approval.subjectId, orgId, approvalId, orgId),
    // The recipients follow the manifest in the same transaction, for the reason the cancel and withhold paths
    // already record: a send whose recipients disagree with it shows a person a message that is two things at
    // once.
    env.CATALOG.prepare(
      `UPDATE send_recipients SET submission_state = 'held', submission_state_at = ?
        WHERE org_id = ? AND manifest_id = ? AND EXISTS (${approved})`,
    ).bind(at, orgId, approval.subjectId, approvalId, orgId),
  ];
}

/**
 * Does this subject kind have a **manifest parked in `awaiting`** that a refusal has to move?
 *
 * A `Record` keyed on the union, and it exists because the two-way tests it replaces were the one place a
 * third subject kind was *not* a compile error. `withdrawApproval` asked `subjectKind === "hold_lift"` and so
 * ran the `UPDATE send_manifests` / `UPDATE send_recipients` pair for a **supervised read** — measured, not
 * reasoned: a `send_recipients` row whose `manifest_id` was the grant's id came back `withheld`. Real ids
 * cannot collide (`snd_` and `sgr_` are different prefixes on different tables), so what shipped was two
 * statements that could match nothing in a governance transaction, under a comment describing the other
 * branch. That is the landmine shape exactly — no symptom now, and a `send_recipients` update keyed on
 * `manifest_id` alone waiting for the day two id spaces meet.
 *
 * `false` for both non-send kinds for the same reason, said once here rather than twice below: nothing was
 * moved out of its resting state to be moved back. A lift leaves the hold standing; a supervised read leaves
 * `granted_at` NULL. In both cases closing the request **is** the whole refusal.
 */
export const HAS_AWAITING_MANIFEST: Record<ApprovalSubjectKind, boolean> = {
  send_manifest: true,
  hold_lift: false,
  supervised_read: false,
  // An export stays `requested` until somebody runs it, so a denial leaves it exactly where it was and a
  // withdrawal that makes the request unsatisfiable does too. Nothing was moved to be moved back.
  ediscovery_export: false,
  // A denied pause request leaves `placed_at` NULL, which is where it started: the domain was never stopped,
  // so nothing is restored. The row stays as the record that somebody asked to stop a domain's mail and two
  // administrators would not — which is the half of the trail a unilateral pause would not produce.
  domain_pause: false,
};

/**
 * Denying: terminal, and the send is `withheld` with `approval_denied`.
 *
 * A denied **lift** adds nothing beyond closing the request: the hold stays exactly as it was, which is the
 * whole point of refusing a lift, and the `hold_lifts` row stays as the record that somebody asked and was
 * told no. Nothing there needs a state column of its own — the approval carries it (0021).
 *
 * A denied **supervised read** is the same shape and the same argument (#63): `granted_at` stays NULL, so the
 * grant confers nothing and never did, and the row stays as the record that somebody asked to read somebody
 * else's mail and was refused. That record is the point — it is the half of §7's trail that a self-grant does
 * not produce. Asking again mints a new row, which is why the approval's subject is a request rather than a
 * person-and-mailbox pair.
 */
function denyStatements(
  env: Env,
  orgId: string,
  approval: ApprovalRow,
  at: string,
): D1PreparedStatement[] {
  const approvalId = approval.id;
  const denied = "SELECT 1 FROM approvals WHERE id = ? AND org_id = ? AND state = 'denied'";
  const closed = env.CATALOG.prepare(
    `UPDATE approvals SET state = 'denied', resolved_at = ?
      WHERE id = ? AND org_id = ? AND state = 'pending'`,
  ).bind(at, approvalId, orgId);

  // Everything except a send: closing the request *is* the denial, because nothing was moved to move back.
  if (!HAS_AWAITING_MANIFEST[approval.subjectKind]) return [closed];

  return [
    closed,
    env.CATALOG.prepare(
      `UPDATE send_manifests SET state = 'withheld', state_at = ?, state_reason = 'approval_denied',
              last_error = ?
        WHERE id = ? AND org_id = ? AND state = 'awaiting' AND EXISTS (${denied})`,
    ).bind(at, "An approver denied this send. Compose again if it still needs to go.",
      approval.subjectId, orgId, approvalId, orgId),
    env.CATALOG.prepare(
      `UPDATE send_recipients SET submission_state = 'withheld', submission_state_at = ?
        WHERE org_id = ? AND manifest_id = ? AND EXISTS (${denied})`,
    ).bind(at, orgId, approval.subjectId, approvalId, orgId),
  ];
}

/* ---- what a completing decision additionally guarantees, per subject kind --------------------- */
