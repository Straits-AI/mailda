import type { Ctx } from "@mailda/runtime";

import {
  describeShortfall, planApproval, teamsNamedBy,
  type ApprovalSubjectKind, type Shortfall,
} from "./approvals.ts";
import type { AuditEvent } from "./audit.ts";
import { decidersOf, rostersOf } from "./deciders.ts";
import {
  evaluate, requiredStages, STATE_FOR, type MatchedPolicy, type Outcome, type SendFacts,
} from "./policy.ts";

/**
 * The gate an act passes through to be governed: policy, then the approval a policy demanded (#160).
 *
 * ## Why this is a module and not six lines inside `sealManifest`
 *
 * It was six lines inside `sealManifest`, and #160's audit found the consequence: **`requiredStages` had
 * exactly one caller.** So policy was not a plane that acts pass through, it was a step inside one act's
 * sealing — which is correct while sends are the only governed act, and is the whole problem the moment there
 * is a second one. That second act would either call `evaluate`, `requiredStages`, `decidersOf`, `rostersOf`
 * and `planApproval` in the right order itself — five functions and an order that must agree with this one,
 * which is the correspondence #160 asks not to create — or the orchestration has to be lifted. This is the
 * lift, and it removes a future correspondence rather than adding one now.
 *
 * Nothing about #60's policy object, #61's separation of duty or #62's exact-effect binding changes. What
 * changes is where the sequence is invoked from.
 *
 * ## What it deliberately does **not** generalise
 *
 * **The conditions.** `evaluate` takes `SendFacts`, and the `when_*` columns on `policy_versions` are
 * send-shaped: a mailbox, an actor, whether a recipient is external, whether it is a reply, the day's volume.
 * A second governed act either fits those facts — a mailbox-scoped act plausibly does — or #60's policy object
 * needs new conditions, which is a decision about what a policy can say and not something to pre-build here.
 * So the facts stay typed as they are, and this gate takes them rather than inventing a union nothing asked
 * for.
 *
 * **The breakers.** The domain pause, the rate gate and #50's Butler release fold in *after* this, in a total
 * order `sealManifest` documents at length. They are properties of a send rather than of governance — a
 * label has no recipient domain to pause and no dispatch to rate-limit — so putting them here would make
 * every future act carry three gates that cannot apply to it.
 *
 * **The subject's row.** `0021_hold_lift.sql` settled this: the approval's target is
 * `(subject_kind, subject_id)` and *"every subject is a row in a table of its own"*. This gate takes that
 * pair; it does not offer to store an act for you. A generic row that any act could stage into is the
 * generic *subject* that migration rejected, for the reason #60 refused a condition blob.
 */

/** The act being governed, as the approval needs to name it. */
export interface GovernedAct {
  /**
   * The approval's subject kind, written rather than derived from the id's prefix.
   *
   * 0021's reason, kept verbatim because it is the kind of thing that erodes: a kind the writer leaves out
   * falls back on a column default, and a default is not a classification.
   *
   * **`ApprovalSubjectKind`, not `string`**, and that is the point of the type rather than a nicety. The
   * union is a closed world — `supervised_read`, `send_manifest`, `hold_lift`, `ediscovery_export`,
   * `domain_pause` — with a scope and an actor verb declared per member. So governing a new act *requires
   * declaring it there*, beside the four that exist, which is exactly the discipline #160's audit concluded
   * this repository already has and should keep. Widening this to `string` would let an act be governed
   * without ever being classified, which is the generic subject 0021 refused.
   */
  subjectKind: ApprovalSubjectKind;
  subjectId: string;
  /** What the approval is decided within — a mailbox today, because that is what deciders are scoped by. */
  scopeId: string;
  actorUserId: string;
}

export interface GovernedDecision {
  outcome: Outcome;
  /** Every version that matched, so the act's own row can record which ones decided it. */
  matched: MatchedPolicy[];
  /** `STATE_FOR`'s mapping, before any act-specific gate folds over it. */
  state: "held" | "awaiting" | "withheld";
  reason: string | null;
  /** Null unless a policy required an approval **and** one can be satisfied. */
  approvalId: string | null;
  /**
   * The approval's rows, for the caller's transaction.
   *
   * Returned rather than written, for `planApproval`'s reason: the approval and the act it gates are one
   * act, so a gate that wrote its own rows would make a half-gated act representable.
   */
  statements: D1PreparedStatement[];
  event: AuditEvent | null;
  /** Why no approval could be satisfied, when that is why the state is `withheld`. */
  shortfall: Shortfall | null;
}

/**
 * Evaluates policy for an act and plans the approval a policy demanded.
 *
 * **The laziness is load-bearing, and this docstring used to claim it was measured when it was not.**
 * `requiredStages`, `decidersOf` and `rostersOf` run only on the `require_approval` path, so an act no policy
 * gated pays nothing for a mechanism it does not touch. The sentence that stood here said moving one of them
 * above the branch "would be invisible in behaviour and visible in that measurement, which is the only reason
 * it is safe to move this code at all" — and a mutation doing exactly that **passed every assertion**. The
 * measurement was an equality on the *difference* between a gated and an ungated seal, and a call above the
 * branch lifts both sides by one.
 *
 * So the justification for this whole module's existence rested on a tripwire that could not fire. It can now:
 * `approval.ungated_seal_max_subrequests` bounds the ungated path absolutely, with no headroom, and
 * `docs/receipts/approval-decision-cost.md` carries why the missing measurement was worse than a missing
 * figure — three readers had already relied on the claim.
 */
export async function stagePolicy(
  env: Env,
  ctx: Ctx,
  orgId: string,
  act: GovernedAct,
  facts: SendFacts,
): Promise<GovernedDecision> {
  const decision = await evaluate(env, ctx, orgId, facts);
  const mapped = STATE_FOR[decision.outcome];

  const staged: GovernedDecision = {
    outcome: decision.outcome,
    matched: decision.matched,
    state: mapped.state,
    reason: mapped.reason,
    approvalId: null,
    statements: [],
    event: null,
    shortfall: null,
  };

  if (decision.outcome !== "require_approval") return staged;

  /*
   * The stage set is folded over every matching `require_approval` version — `max` per ordinal, which is
   * #60's own conflict resolution rather than a second rule — because two policies requiring approval of one
   * act are both in force.
   */
  const stages = await requiredStages(
    env,
    decision.matched.filter((match) => match.outcome === "require_approval").map((match) => match.versionId),
  );
  const deciders = await decidersOf(env, orgId, act.scopeId);
  /*
   * The rosters of every team the folded stage set names (#73), and **only** when it names one.
   * `teamsNamedBy` returns nothing for a stage set with no team constraint, and `rostersOf` short-circuits on
   * an empty request with no query at all.
   *
   * Read here rather than inside `planApproval` because that function is pure and returns statements for the
   * caller's transaction to carry; making it do I/O would put a read inside the thing whose whole shape is
   * "decide, then hand back the rows".
   */
  const rosters = await rostersOf(env, orgId, teamsNamedBy(stages));
  const planned = planApproval(env, ctx, orgId, {
    subjectKind: act.subjectKind,
    subjectId: act.subjectId,
    scopeId: act.scopeId,
    actorUserId: act.actorUserId,
    stages,
  }, deciders, rosters);

  if (planned.satisfiable) {
    return {
      ...staged,
      approvalId: planned.plan.approvalId,
      statements: planned.plan.statements,
      event: planned.plan.event,
    };
  }

  /*
   * Withheld rather than parked. The gate exists and nobody can clear it, so `awaiting` would be a state that
   * reads as pending forever — the argument #60 made for keeping `deny` out of it, reached from the other
   * side. Terminal, and the remedy is an administrator's grant plus a re-staging of the act.
   */
  return { ...staged, state: "withheld", reason: "approval_unsatisfiable", shortfall: planned.shortfall };
}

/** Re-exported so a caller that renders a shortfall does not need a second import to do it. */
export { describeShortfall };
