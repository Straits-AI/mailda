import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { rostersOf } from "./deciders.ts";
import { conflict, notFound } from "./errors.ts";
import { HAS_AWAITING_MANIFEST, settled } from "./approval-decide.ts";
import { type ApprovalState, type Shortfall, type Stages, approversOf, describeShortfall, shortfallFor, stageOf, stagesOfApproval, teamsNamedBy } from "./approval-plan.ts";
import { decisionsOf, readApproval, standingByStage } from "./approval-rows.ts";

export interface WithdrawOutcome {
  approvalId: string;
  approvalState: ApprovalState;
  /** The stage the withdrawn decision had satisfied, which is now open again. */
  stageOrdinal: number;
  /** Set when the withdrawal left too few eligible people, in which case the subject was closed out. */
  shortfall?: Shortfall;
  /** Present for a `send_manifest` subject only, for the reason `DecisionOutcome` gives. */
  manifestState?: "awaiting" | "withheld";
}

/**
 * Takes back your own approval while the request is still incomplete.
 *
 * Refused once the approval is settled, which is what makes an approved send safe to dispatch: after
 * completion there is nothing to withdraw *from*, and #62's recheck would otherwise be verifying a decision
 * that could still evaporate.
 *
 * ## A withdrawal can leave the request unsatisfiable, and that is not left to be discovered
 *
 * Withdrawal is terminal for the withdrawer, so the eligible set shrinks by one every time. If what remains
 * cannot fill the stages, the request is closed as `unsatisfiable` and the send is **withheld** with
 * `approval_unsatisfiable` — in the same transaction as the withdrawal. Leaving it `pending` would be a request
 * nobody can decide, sitting in a state that reads as waiting for somebody: the shape #60 kept `deny` out of
 * `awaiting` to avoid, arriving through a different door.
 *
 * This is the one *live* unsatisfiable case this build closes. A revoked relation is the other, and it is not
 * closed — see this module's header, which says so rather than implying the world is sealed.
 *
 * ## Every statement shares one predicate, and the shortfall is part of what it guards
 *
 * The same discipline `decideApproval` records, and it is load-bearing here for an extra reason: the shortfall
 * above is computed in TypeScript from decisions read a few milliseconds ago, so it is only true if the decision
 * set has not moved by the time it is written. The guard therefore pins the **decision counts** as well as the
 * request being open, which makes every concurrent change to `approval_decisions` a conflict rather than a
 * silently stale answer:
 *
 *   - another approval arrives — the standing count and the total both move;
 *   - somebody else withdraws — the standing count moves;
 *   - both at once — the standing count comes back to where it was, which is why the **total** is pinned too;
 *   - a denial arrives — the request stops being pending.
 *
 * Two withdrawals landing together would otherwise each read a satisfiable request and leave an unsatisfiable
 * one **pending**, which is exactly the state the section above says it closes. A claim in a comment that
 * nothing enforces is the defect this repository keeps finding, so the predicate enforces it and the loser is
 * told `E_WITHDRAW_RACED` rather than a message about a state the request is not in.
 *
 * The three statements that close an unsatisfiable request run *after* the withdrawal has changed that count, so
 * they cannot share the same predicate. They are gated on **this transaction's withdrawal having landed** —
 * `withdrawn_at` equal to this call's timestamp — which is the same shape `approveStatements` uses to make its
 * state changes conditional on the approval having become approved. Without a gate they were unconditional, and
 * a withdrawal that lost to a completing approval rewrote the recipients of a released send to `withheld`.
 */
export async function withdrawApproval(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  approvalId: string,
): Promise<WithdrawOutcome> {
  const approval = await readApproval(env, orgId, approvalId);
  if (approval === null) {
    throw notFound("E_NO_APPROVAL", {
      what: `${approvalId} is not an approval you may withdraw from`,
      why: "only the person who gave an approval may take it back, and §5C keeps an invisible thing and an "
        + "absent one answering alike",
      fix: "check the approval id",
    });
  }
  if (approval.state !== "pending") throw settled(approval);

  const decisions = await decisionsOf(env, approvalId);
  const mine = decisions.find(
    (row) => row.decider_user_id === actorUserId && row.decision === "approve" && row.withdrawn_at === null,
  );
  if (mine === undefined) {
    throw conflict("E_NOTHING_TO_WITHDRAW", {
      what: "you have no standing approval on this request",
      why: "a withdrawal takes back your own decision; nobody may withdraw somebody else's, because that "
        + "would put your judgement in the trail under their name",
      fix: "if you meant to stop this, deny it — a denial is terminal and is recorded as yours",
    });
  }

  // What the eligible set becomes: the holders, minus the person whose act this is, minus everybody who has
  // decided — the withdrawer included, because `apd_one_per_person` makes their withdrawal terminal for them.
  const deciders = await approversOf(env, orgId, approval.subjectKind, approval.scopeId);
  const decided = new Set(decisions.map((row) => row.decider_user_id));
  const stages = await stagesOfApproval(env, approvalId);
  const remaining = new Set([...deciders].filter(
    (userId) => userId !== approval.actorUserId && !decided.has(userId),
  ));
  // Counted against what is still needed, not against the whole chain: the stages the withdrawal does not
  // touch keep the decisions that already stand. The standing set is recomputed with this decision removed.
  const standing = standingByStage(decisions.filter((row) => row !== mine));
  // The outstanding demand keeps each stage's **team**, because a stage half-filled by Finance still needs
  // the rest of it from Finance. Dropping the constraint here would report a withdrawal as survivable on the
  // strength of people who could never take the slot — the permissive answer, in the one place that decides
  // whether a send is withheld.
  const outstanding: Stages = stages.map((each, index) =>
    stageOf(Math.max(0, each.count - (standing.get(index + 1) ?? 0)), each.teamId));
  // Only the teams still outstanding, so a withdrawal from an unconstrained stage set costs no extra query.
  const rosters = await rostersOf(
    env, orgId, teamsNamedBy(outstanding.filter((each) => each.count > 0)),
  );
  const shortfall = shortfallFor(outstanding, remaining, rosters);

  const at = new Date(ctx.now()).toISOString();
  // The counts the shortfall above was computed against, pinned into the predicate. See the header: the
  // standing count catches one change and the total catches two that would cancel out in the standing one.
  const standingCount = decisions.filter((row) => row.withdrawn_at === null).length;
  const totalCount = decisions.length;
  const guard =
    `SELECT 1 FROM approvals a WHERE a.id = ? AND a.org_id = ? AND a.state = 'pending'
       AND EXISTS (SELECT 1 FROM approval_decisions d WHERE d.approval_id = a.id
                     AND d.decider_user_id = ? AND d.withdrawn_at IS NULL)
       AND (SELECT COUNT(*) FROM approval_decisions d WHERE d.approval_id = a.id) = ?
       AND (SELECT COUNT(*) FROM approval_decisions d WHERE d.approval_id = a.id
              AND d.withdrawn_at IS NULL) = ?`;
  const guardParams = [approvalId, orgId, actorUserId, totalCount, standingCount];

  const withdrawal = env.CATALOG.prepare(
    `UPDATE approval_decisions SET withdrawn_at = ?
      WHERE approval_id = ? AND decider_user_id = ? AND withdrawn_at IS NULL
        AND EXISTS (${guard})`,
  ).bind(at, approvalId, actorUserId, ...guardParams);

  // Conditional on this call's own withdrawal having landed, not on this function's expectation of it: the
  // gate above may have failed, in which case nothing here may change anything at all.
  const withdrew =
    "SELECT 1 FROM approval_decisions WHERE approval_id = ? AND decider_user_id = ? AND withdrawn_at = ?";
  const withdrewParams = [approvalId, actorUserId, at];

  const closesRequest = shortfall === null ? [] : [
    env.CATALOG.prepare(
      `UPDATE approvals SET state = 'unsatisfiable', resolved_at = ?
        WHERE id = ? AND org_id = ? AND state = 'pending' AND EXISTS (${withdrew})`,
    ).bind(at, approvalId, orgId, ...withdrewParams),
  ];
  /*
   * A lift adds nothing here, and that is the honest end state rather than a gap.
   *
   * An unsatisfiable lift request leaves the **hold standing** — the safe direction, since a lift nobody can
   * complete is a hold that keeps preserving — and `doctor`'s `legal_hold_unliftable` finding is what stops
   * that being invisible: it reports a held mailbox with too few eligible approvers, which is exactly the
   * state a withdrawal can leave behind. Asking again means a fresh request, which is a new subject.
   *
   * A supervised read is the same: `granted_at` stays NULL, so the read was never authorized and the row
   * stays as the record that somebody asked. Asked through `HAS_AWAITING_MANIFEST` rather than by naming a
   * kind, because this test was `=== "hold_lift"` and therefore sent #63's third kind down the send path.
   */
  const unsatisfiable = shortfall === null || !HAS_AWAITING_MANIFEST[approval.subjectKind] ? closesRequest : [
    ...closesRequest,
    env.CATALOG.prepare(
      `UPDATE send_manifests SET state = 'withheld', state_at = ?,
              state_reason = 'approval_unsatisfiable', last_error = ?
        WHERE id = ? AND org_id = ? AND state = 'awaiting' AND EXISTS (${withdrew})`,
    ).bind(at, describeShortfall(shortfall, approval.scopeId), approval.subjectId, orgId,
      ...withdrewParams),
    env.CATALOG.prepare(
      `UPDATE send_recipients SET submission_state = 'withheld', submission_state_at = ?
        WHERE org_id = ? AND manifest_id = ? AND EXISTS (${withdrew})`,
    ).bind(at, orgId, approval.subjectId, ...withdrewParams),
  ];

  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "approval.withdrawn",
      outcome: "ok",
      actorUserId,
      subject: approvalId,
      detail: {
        subjectKind: approval.subjectKind,
        subjectId: approval.subjectId,
        stage: mine.stage_ordinal,
        // Named in the entry, because the consequence of this act is not otherwise attributable to it: the
        // send went to `withheld` and the only thing that says why is this.
        leftUnsatisfiable: shortfall !== null,
        ...(shortfall === null ? {} : { shortfall }),
      },
    },
    (entry) => [entry, withdrawal, ...unsatisfiable],
    // The whole predicate, so a withdrawal that lost a race records nothing rather than an entry claiming an
    // act that did not happen.
    { sql: guard, params: guardParams },
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // Nothing committed — every statement carried the guard. Two reasons, and they are different answers:
    // the request was settled by somebody else, or it is still open and the decisions moved underneath.
    const now = await readApproval(env, orgId, approvalId);
    if (now === null || now.state !== "pending") throw settled(now ?? approval);
    throw conflict("E_WITHDRAW_RACED", {
      what: `approval ${approvalId} was decided on by somebody else while this withdrawal was being prepared`,
      why: "a withdrawal has to know what it leaves behind — whether enough eligible people remain to finish "
        + "the stages — so it is refused rather than applied against a decision set that moved, which could "
        + "leave a request nobody can complete reading as pending",
      fix: "read the approval again and withdraw again if you still want to",
    });
  }

  return {
    approvalId,
    approvalState: shortfall === null ? "pending" : "unsatisfiable",
    stageOrdinal: mine.stage_ordinal,
    ...(shortfall === null ? {} : { shortfall }),
    ...(approval.subjectKind === "send_manifest"
      ? { manifestState: shortfall === null ? "awaiting" : "withheld" } as const
      : {}),
  };
}

/* ---- what an approver is waiting on ---------------------------------------------------------- */
