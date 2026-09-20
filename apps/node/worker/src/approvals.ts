/**
 * Approvals: ordered stages with a count, decided by distinct people (#61, §18, Layer 5).
 *
 * ## An approval decides on a **subject**, and there are five kinds
 *
 * This module shipped manifest-shaped: `approvals.manifest_id TEXT NOT NULL` with `UNIQUE (manifest_id)`.
 * The legal-hold lift (#64) is the second caller and it is not a manifest, so migration 0021 generalised the
 * target to `(subject_kind, subject_id)` — see that file for why a nullable second id column and a second
 * approvals table were both refused. §18 names connector writes, forwarding, export and domain/routing
 * changes as further subjects, and every one of them since has arrived without a second approval path.
 *
 *     send_manifest      a send_manifests row. Completion releases the send to `held`.
 *     hold_lift          a hold_lifts row. Completion applies the lift: one conditional `UPDATE holds`.
 *     supervised_read    a supervised_grants row. Completion sets `granted_at` and owes §7's notice.
 *     ediscovery_export  an exports row. Completion makes the run permissible.
 *     domain_pause       a domain_pauses row (#66). Completion sets `placed_at` and **stops a domain's mail**.
 *
 * Two columns carry across every kind, and both were checked rather than assumed:
 *
 *   `scope_id`        was `mailbox_id` until #66, and the rename is the point rather than tidying. It always
 *                     meant *the object whose relation-holders are eligible to decide* — for a send the
 *                     mailbox the message is from, for a lift the **held** mailbox, for a supervised read
 *                     and an export the mailbox being reached into. A domain pause has **no mailbox**: it
 *                     stops every mailbox sending from a domain, so no single mailbox's holders have
 *                     authority over it, and its eligible set comes from `org.admin` on the organization.
 *                     Migration 0021 named that case and deferred it — *"that kind either names a mailbox or
 *                     brings a second source for its eligible set, and that is its ticket's work"* — and this
 *                     is that ticket. **`SCOPE_OF` decides which relation on which object, per kind**, so a
 *                     sixth kind is a compile error until it says where its approvers come from. A column
 *                     named `mailbox_id` holding an organization id would be the overclaiming name AGENTS.md
 *                     calls a landmine: the join to `mailboxes` returns nothing, and a join that returns
 *                     nothing is the one nobody notices.
 *   `actor_user_id`   was `author_user_id`, renamed because a lift has no author. It always meant *the
 *                     person whose act this approval gates, and therefore the one person who may never
 *                     decide it*: the author of the send, the requester of the lift. §18's separation of
 *                     duty is a rule about that person, and it is the same rule in both cases — which is
 *                     why the lift uses this exclusion rather than writing a second one.
 *
 * What every kind shares beyond that: the fold, the eligible set, the completion predicate in SQL, and the
 * conditional UPDATE. **All three of #61's defects were in that race logic**, which is the argument against
 * ever giving a subject kind its own copy of it.
 *
 * ## One mechanism for §18's three review shapes
 *
 * §18 requires *"sequential/parallel/dual review"*. They are counts and ordinals over one structure:
 *
 *     parallel    [2]                        one stage, two distinct decisions
 *     sequential  [1, 1]                     two stages, one each, in order
 *     dual        either, depending on whether the order matters
 *     duty        [1 of finance, 1 of legal] the same two stages, each narrowed to a team (#73)
 *
 * The order is on the **stages**, not on the people. That is what dissolves the doubt this ticket opened with —
 * a set defined by a relation has no natural sequence, and naming people in a policy would widen authority —
 * because each stage's membership stays derived from relations while only the stages are ordered.
 *
 * ## The eligible set
 *
 *     eligible(stage)    = approval.decide holders on the manifest's mailbox
 *                        ∩ members of stage.team_id, if one is named (#73)
 *                        − the manifest's author
 *                        − everybody who has already decided in this approval
 *
 * The intersection is what makes the team constraint expressible without widening anything: it can only ever
 * remove people. See the section below on what #73 built and what it deliberately did not freeze.
 *
 * **Distinctness is on `user_id`, not on tuples, and this is the subtle part.** `readableSubjects`
 * (src/authz-read.ts:104) returns `[userId, ...teamIds]`, so a relation can be held *through a team*. The
 * holder set is a set of tuples; a decider is a person. One person in two teams that both hold
 * `approval.decide` would satisfy a count of 2 if distinctness were measured at the tuple layer — dual control
 * defeated by something that looks like working code. `decidersByMailbox` resolves tuples to people and
 * de-duplicates, and `apd_one_per_person` is the database's half of the same guarantee, which is the half that
 * holds when two decisions race.
 *
 * ## Checked twice, and the second check is the point
 *
 * A policy whose stages cannot be filled is refused at **publication**, where the shortfall is knowable
 * (`publishPolicy`). It is checked again at **evaluation** — the seal — and an unsatisfiable one yields
 * `withheld` with `approval_unsatisfiable`, naming which stage and how many short.
 *
 * Publication-only was tempting and wrong: revoking `approval.decide` from somebody would then make a live
 * policy unsatisfiable **silently**, and gated sends would collect in `awaiting` with nothing having failed —
 * the shape of a `stale_when` that named the right condition and which nothing checked.
 *
 * **What the second check still does not cover, stated because a half-closed world described as closed is what
 * this repository keeps finding defects in:** a send *already* `awaiting` when the last approver loses the
 * relation is not re-checked. Nothing sweeps `awaiting` — it is never dispatched, so the dispatch-time recheck
 * cannot see it either — and the drain that exists is the author's own cancel. The one live case this
 * module does close is a **withdrawal** that leaves too few eligible people, because that path is already
 * holding the eligible set when it happens (`withdrawApproval`). Closing the revoke case needs a pass over
 * `awaiting` sends, which is a cron branch of the kind #63's notification obligation is already shaped for.
 *
 * **What #62 did close is the other end of the same window.** An eligibility loss between the *approval* and the
 * hand-over is caught: `src/outbound/recheck.ts` re-reads the holders before the transport is asked and withholds
 * with `approver_ineligible`. So the uncovered case is now precisely one — a send still waiting to be decided —
 * rather than the whole span from seal to hand-over.
 *
 * ## The one thing that settles an approval from outside this module
 *
 * `cancelSend` (src/outbound/dispatch.ts) sets a pending approval to `cancelled` in the same transaction as the
 * manifest, because cancelling is the drain `awaiting` has and the author may use it while people are being
 * asked. Every refusal here keys on `approvals.state`, so that is also what makes the manifest states this
 * module *reports* true: without it, approving a cancelled send closed the request, moved nothing — the manifest
 * update requires `awaiting` — and still answered `manifestState: "held"`.
 *
 * ## Withdrawal is asymmetric with denial, deliberately
 *
 * An approver may withdraw their own approval while the request is incomplete; a denial is terminal. Without
 * withdrawal, an approver who learns something has only one remedy — persuading a colleague to deny — which
 * records **somebody else's judgement** as the reason a message was stopped, in a trail whose entire value is
 * that it does not do that. A denial needs no counterpart: re-sealing mints a new manifest and a fresh
 * approval, which is the invalidation mechanism Layer 5's answer 1 already rests on.
 *
 * Withdrawal is terminal for the withdrawer (`apd_one_per_person`): they cannot decide again. So the eligible
 * set only ever shrinks within one approval, and no amount of oscillation lets one person fill two slots.
 *
 * ## The team constraint, which #61 wanted and #73 built the substrate for
 *
 * A stage may require **a member of a named team**, and that was named absent here until migration 0032
 * because the substrate was not there: `team_members` had no writer, and there was no `teams` table at all, so
 * a team had no name and no existence of its own. A team-scoped stage would have been expressible and
 * unusable — nobody could create the team it named, and publication could not verify the team *exists*, only
 * that it currently has members, which is a different question.
 *
 * Both halves landed together, and three properties are what make the constraint safe to have at all:
 *
 * - **Strictly narrowing.** `eligibleFor` intersects, so naming a team can only reduce the eligible set.
 *   #61's may-narrow-never-widen rule survives whole, and an unknown team resolves to nobody rather than to
 *   everybody — the restrictive answer for the unclassified input.
 * - **Verified at publication.** `publishPolicy` refuses a stage naming a team that does not exist
 *   (`E_NO_SUCH_TEAM`), which is the check that was impossible before a `teams` row existed, and refuses one
 *   whose team is already too small to fill it.
 * - **Re-checked at evaluation, twice over.** The seal recomputes the eligible set against live membership,
 *   and `decideApproval` re-reads the open stage's roster at the instant of the decision. The stage freezes
 *   the team's **id**; it deliberately does not freeze its members, because membership is authority and §7
 *   makes authority live.
 *
 * A team that is **emptied** under a live policy therefore reaches the same answer as `approval.decide` being
 * revoked from its last holder, which is #61's own precedent: the send is `withheld` with
 * `approval_unsatisfiable`, naming which stage, which team and how many short. It does not park in `awaiting`,
 * and the membership change is not refused — see `src/teams.ts` for why the refusal would have been the wrong
 * direction.
 *
 * ## Named absent
 *
 * - **Notification.** Every act here is something a person is waiting on, and there is no notification
 *   mechanism in this product. #63 owns the harder version of the same problem — §7 requires a notice the
 *   investigator cannot switch off — and its resolution already chose the shape: the obligation is a row, an
 *   existing cron delivers it. Inventing a second mechanism here would be the thing to undo later.
 * - **The approval evidence snapshot** (§18, §21): the *"immutable, minimum-necessary snapshot containing the
 *   exact proposed effect, policy explanation and only those source excerpts the requester may disclose"*.
 *   `approval.decide` is not a read relation, so an approver who holds nothing else on the mailbox can decide
 *   without being able to open the bytes — which is §21's rule about approval not granting ambient access, and
 *   also means this build does not yet give them what §18 says they must see. Naming it here rather than
 *   granting a read as a shortcut, which is what §21 explicitly forbids.
 *
 * ## Expiry, added by #62, and the two things it deliberately is not
 *
 * `approvals.expires_at` (migration 0022) is written at request time from `approval.send_expiry_seconds`, and
 * it is compared in exactly one place: the dispatch-time recheck in `src/outbound/recheck.ts`. Two properties
 * of that are decisions rather than accidents.
 *
 * **It is not per-policy.** #60's policy object has no expiry column, and adding one now would invent a
 * governance dimension no ticket has decided — which is #60's own governing failure, a condition backed by no
 * interface. A constant with a receipt is honest and reversible. If somebody asks for per-policy deadlines,
 * the refinement is a `policy_versions` column folded the way the stages already are (`max` per ordinal
 * becomes `min` over the deadline, because narrowing has to run one way), and the constant becomes the
 * default.
 *
 * **It is not swept.** Nothing here moves a lapsed request out of `pending`, so an approver can still decide
 * one, and their decision lands: the send returns to `held` and the recheck then withholds it with
 * `approval_expired`. That is one enforcement point rather than two, which is the same argument #62 makes for
 * the reason vocabulary — and a second one here would need its own release act and its own state. What it
 * costs is a decision somebody takes on a request that will not send, so `expires_at` travels on
 * `GET /api/approvals` and on every `ApprovalRow`: the deadline is visible to the person being asked, before
 * they answer, rather than discoverable afterwards.
 *
 * A `hold_lift` approval gets **no** deadline, and `EXPIRES_AFTER_SECONDS` below makes that a total map over
 * the subject kinds so a third kind has to decide rather than inherit. Nothing rechecks a lift, so a deadline
 * on one would be a limit no code compares — the defect this file's other absences exist to avoid.
 */

/* ---- the reason tokens this module writes ---------------------------------------------------- */


/*
 * Split on 20 September 2026 so each part changes for one reason. This file is the seam every importer
 * uses; the parts are `approval-plan.ts` (vocabulary, scope, stages, the plan), `approval-rows.ts` (an
 * approval and its decisions as rows), `approval-decide.ts` (deciding one), `approval-effects.ts` (what a
 * completing decision additionally guarantees, per subject kind), `approval-withdraw.ts` and
 * `approval-pending.ts`.
 */

export { APPROVAL_REASONS, type ApprovalState, type Decision, APPROVAL_SUBJECT_KINDS, type ApprovalSubjectKind, type ApprovalScope, SCOPE_OF, approversOf, expiryFor, type Stage, type Stages, stageOf, IMPLICIT_STAGES, NO_TEAM_ROSTERS, teamsNamedBy, type Shortfall, shortfallFor, describeShortfall, stagesOfApproval, type ApprovalRequestFacts, type ApprovalPlan, type ApprovalPlanned, planApproval } from "./approval-plan.ts";
export { type ApprovalRow, approvalOfManifest, decisionsOfApproval, openStage } from "./approval-rows.ts";
export { type DecisionOutcome, decideApproval } from "./approval-decide.ts";
export { type HoldLiftRow } from "./approval-effects.ts";
export { type WithdrawOutcome, withdrawApproval } from "./approval-withdraw.ts";
export { type PendingApproval, pendingApprovals } from "./approval-pending.ts";
