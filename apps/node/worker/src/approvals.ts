import type { Ctx } from "@mailda/runtime";

import { type AuditEvent, auditedBatch } from "./audit.ts";
import { conflict, notFound } from "./errors.ts";

/**
 * Approvals: ordered stages with a count, decided by distinct people (#61, §18, Layer 5).
 *
 * ## One mechanism for §18's three review shapes
 *
 * §18 requires *"sequential/parallel/dual review"*. They are counts and ordinals over one structure:
 *
 *     parallel    [2]      one stage, two distinct decisions
 *     sequential  [1, 1]   two stages, one each, in order
 *     dual        either, depending on whether the order matters
 *
 * The order is on the **stages**, not on the people. That is what dissolves the doubt this ticket opened with —
 * a set defined by a relation has no natural sequence, and naming people in a policy would widen authority —
 * because each stage's membership stays derived from relations while only the stages are ordered.
 *
 * ## The eligible set
 *
 *     eligible(approval) = approval.decide holders on the manifest's mailbox
 *                        − the manifest's author
 *                        − everybody who has already decided in this approval
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
 * relation is not re-checked. Nothing sweeps `awaiting` — it is never dispatched, so #62's dispatch-time
 * recheck cannot see it either — and the drain that exists is the author's own cancel. The one live case this
 * module does close is a **withdrawal** that leaves too few eligible people, because that path is already
 * holding the eligible set when it happens (`withdrawApproval`). Closing the revoke case needs a pass over
 * `awaiting` sends, which is a cron branch of the kind #63's notification obligation is already shaped for.
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
 * ## Named absent
 *
 * - **A team constraint on a stage.** #61 wanted one narrowing constraint, *"a member of team T"*, and there is
 *   no `team_id` column. `team_members` is read-only in the product — three SELECTs in `src/authz-read.ts`,
 *   nothing writes it — and there is **no `teams` table at all**, so a team has no name and no existence of its
 *   own. A team-scoped stage would be expressible and unusable, and publication could not verify a named team
 *   exists, only that it currently has members, which is a different question. `migrations/0020_approvals.sql`
 *   carries the argument in full, and #73 tracks what would have to exist first — team creation, membership
 *   management, and a decision about whether a team is a first-class object or stays an implicit id. Ordered stages of count 1 still give
 *   sequential review by two distinct people in a fixed order, which is §18's sequential shape minus the team
 *   labels.
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
 * - **Expiry.** #62 owns `approval_expired`, and an expiry column nothing sweeps would be a deadline that never
 *   passes.
 */

/* ---- the reason tokens this module writes ---------------------------------------------------- */

/**
 * The `send_manifests.state_reason` tokens an approval produces, with the **words** in
 * `src/client/delivery.client.js`.
 *
 * Not in `STATE_FOR`, and that is a boundary rather than an inconsistency. `STATE_FOR` maps a policy *outcome*
 * to the state a seal produces, and neither of these is produced by an outcome: `approval_denied` is what a
 * person decided afterwards, and `approval_unsatisfiable` is an override of the mapping's own answer — the
 * outcome really is `require_approval`, and what makes the send `withheld` is that nobody can clear it. Adding
 * them to a `Record<Outcome, …>` would need two fake outcomes to hang them on.
 *
 * The reason words live in `delivery.client.js` by design, for the reason its own header gives: one place owns
 * the prose, and it is the module a test can evaluate as the exact bytes a browser is served.
 */
export const APPROVAL_REASONS = ["approval_denied", "approval_unsatisfiable"] as const;

export type ApprovalState = "pending" | "approved" | "denied" | "unsatisfiable" | "cancelled";
export type Decision = "approve" | "deny";

/* ---- stages, and the arithmetic of a shortfall ----------------------------------------------- */

/**
 * A stage set: the count required at each stage, in review order. `[2]` is parallel dual control, `[1, 1]` is
 * sequential.
 *
 * An array rather than objects with an ordinal, because the position **is** the ordinal — a separate field
 * would be a second representation of the same fact, and the failure mode is two stages numbered 2.
 */
export type Stages = readonly number[];

/**
 * What one stage set means when a policy version names none: one decision, by somebody other than the author.
 *
 * The minimum the words *"requires approval"* can mean, and it is also what every `require_approval` version
 * published before migration 0020 means — so absence is a defined answer rather than a missing one.
 */
export const IMPLICIT_STAGES: Stages = [1];

export interface Shortfall {
  /** The first stage that cannot be filled, 1-based. */
  ordinal: number;
  /** How many distinct decisions that stage asks for. */
  required: number;
  /** How many eligible people are left for it once the earlier stages have taken theirs. */
  available: number;
  /** `required - available`. Always at least 1 when this object exists. */
  short: number;
  /** Distinct eligible people in total, and what the whole chain would need. For the message. */
  eligible: number;
  needed: number;
}

/**
 * Can this stage set be satisfied by `eligible` distinct people, and if not, where does it fail?
 *
 * Nobody decides twice in one approval (`apd_one_per_person`), so the chain needs `sum(stages)` distinct
 * people, and the shortfall lands on the **first** stage whose cumulative demand outruns the supply. Reported
 * per stage rather than as a total because *"stage 2 needs 1 more approver than exist"* tells an administrator
 * what to change, and *"3 needed, 2 available"* makes them do the arithmetic themselves.
 *
 * Pure, and exhaustively testable: this is the whole of the satisfiability rule, and both checks — publication
 * and evaluation — go through it rather than each computing it.
 */
export function shortfallFor(stages: Stages, eligible: number): Shortfall | null {
  const needed = stages.reduce((total, count) => total + count, 0);
  let taken = 0;
  for (const [index, required] of stages.entries()) {
    const available = Math.max(0, eligible - taken);
    if (required > available) {
      return {
        ordinal: index + 1, required, available, short: required - available, eligible, needed,
      };
    }
    taken += required;
  }
  return null;
}

/** The shortfall as a sentence, so publication, the seal and the audit detail all say it the same way. */
export function describeShortfall(shortfall: Shortfall, mailboxId: string): string {
  return `stage ${shortfall.ordinal} needs ${shortfall.required} distinct approver(s) holding `
    + `approval.decide on mailbox ${mailboxId}, and ${shortfall.available} remain after the earlier stages `
    + `take theirs — ${shortfall.short} short. The stages need ${shortfall.needed} distinct people in total; `
    + `${shortfall.eligible} are eligible.`;
}

/**
 * The stage set of one approval, in ordinal order.
 *
 * Ordered by the column rather than trusted to arrive in order, and read from the approval's own frozen copy
 * rather than from the policy: publishing a new version must not change what an approver already deciding was
 * asked for, which is the same reason #60 refused to re-evaluate in-flight sends on publication.
 */
export async function stagesOfApproval(env: Env, approvalId: string): Promise<number[]> {
  const { results } = await env.CATALOG.prepare(
    "SELECT required_count FROM approval_stages WHERE approval_id = ? ORDER BY ordinal",
  ).bind(approvalId).all<{ required_count: number }>();
  return results.map((row) => row.required_count);
}

/* ---- who may decide -------------------------------------------------------------------------- */

/**
 * Every person holding `approval.decide` on a mailbox, resolved through teams and de-duplicated.
 *
 * One query for the whole organization, or for one mailbox when `mailboxId` is given — publication needs the
 * first (a policy with no mailbox condition applies to every mailbox) and a decision needs the second.
 *
 * ## Three things this SQL does deliberately
 *
 * **It resolves teams.** A tuple's subject may be a user or a team, because `readableSubjects` authorizes as
 * both. The second branch expands a team-held tuple into its members, which is what makes a team grant work at
 * all.
 *
 * **It de-duplicates on the person.** `UNION` (not `UNION ALL`) collapses `(mailbox, user)` pairs, so somebody
 * who holds the relation directly *and* through two teams is one decider. This is the property dual control
 * rests on and it is asserted in `test/approvals.test.ts` by constructing exactly that person.
 *
 * **It requires a row in `users`.** `grant` does not verify that a subject is a person — it cannot, since the
 * same call grants to teams — so a tuple whose subject is a team id would otherwise be counted as one
 * "decider" *and* expanded into its members. Counting a subject nothing identifies as a person is how a stale
 * team id would satisfy dual control on its own.
 */
export async function decidersByMailbox(
  env: Env,
  orgId: string,
  mailboxId?: string,
): Promise<Map<string, Set<string>>> {
  const only = mailboxId === undefined ? "" : " AND t.object_id = ?";
  const params = mailboxId === undefined ? [orgId] : [orgId, mailboxId];
  const { results } = await env.CATALOG.prepare(
    `SELECT t.object_id AS mailbox_id, t.subject_id AS user_id
       FROM relationship_tuples t
       JOIN users u ON u.org_id = t.org_id AND u.id = t.subject_id
      WHERE t.org_id = ? AND t.object_type = 'mailbox' AND t.relation = 'approval.decide'${only}
     UNION
     SELECT t.object_id AS mailbox_id, m.user_id AS user_id
       FROM relationship_tuples t
       JOIN team_members m ON m.org_id = t.org_id AND m.team_id = t.subject_id
       JOIN users u ON u.org_id = m.org_id AND u.id = m.user_id
      WHERE t.org_id = ? AND t.object_type = 'mailbox' AND t.relation = 'approval.decide'${only}`,
  ).bind(...params, ...params).all<{ mailbox_id: string; user_id: string }>();

  const byMailbox = new Map<string, Set<string>>();
  for (const row of results) {
    const people = byMailbox.get(row.mailbox_id) ?? new Set<string>();
    people.add(row.user_id);
    byMailbox.set(row.mailbox_id, people);
  }
  return byMailbox;
}

/** The people who could decide on one mailbox, before the author and the already-decided are taken out. */
export async function decidersOf(env: Env, orgId: string, mailboxId: string): Promise<Set<string>> {
  return (await decidersByMailbox(env, orgId, mailboxId)).get(mailboxId) ?? new Set<string>();
}

/* ---- requesting ------------------------------------------------------------------------------ */

export interface ApprovalRequestFacts {
  manifestId: string;
  mailboxId: string;
  authorUserId: string;
  /** The fold over every matching `require_approval` version — see `requiredStages` in `src/policy.ts`. */
  stages: Stages;
}

export interface ApprovalPlan {
  approvalId: string;
  stages: Stages;
  /** Distinct people who could decide, the author already removed. */
  eligible: number;
  /** The rows to place in the caller's transaction, and the entry that records the request. */
  statements: D1PreparedStatement[];
  event: AuditEvent;
}

export type ApprovalPlanned =
  | { satisfiable: true; plan: ApprovalPlan }
  | { satisfiable: false; shortfall: Shortfall; eligible: number };

/**
 * Plans the approval a gated seal needs, or reports why it cannot be satisfied.
 *
 * Returns **statements rather than writing them**, because the approval and the manifest are one act: a gated
 * manifest with no request to decide would be a send waiting on something nobody can clear, which is precisely
 * the state #60 refused to let `deny` occupy. `sealManifest` places these in its own `batch()`, and
 * `auditedBatchMany` carries both audit entries in the same transaction.
 *
 * The author is removed here rather than by the caller, because *"minus the author"* is a rule about approvals
 * and not about sealing: §18 requires separation-of-duty policies to prevent self-approval, and a caller that
 * had to remember to subtract would be a caller that could forget.
 */
export function planApproval(
  env: Env,
  ctx: Ctx,
  orgId: string,
  facts: ApprovalRequestFacts,
  deciders: ReadonlySet<string>,
): ApprovalPlanned {
  const eligible = [...deciders].filter((userId) => userId !== facts.authorUserId).length;
  const shortfall = shortfallFor(facts.stages, eligible);
  if (shortfall !== null) return { satisfiable: false, shortfall, eligible };

  const approvalId = ctx.id("apr");
  const at = new Date(ctx.now()).toISOString();

  const statements = [
    env.CATALOG.prepare(
      `INSERT INTO approvals
         (id, org_id, manifest_id, mailbox_id, author_user_id, state, requested_at, resolved_at)
       VALUES (?,?,?,?,?,'pending',?,NULL)`,
    ).bind(approvalId, orgId, facts.manifestId, facts.mailboxId, facts.authorUserId, at),
    ...facts.stages.map((required, index) => env.CATALOG.prepare(
      `INSERT INTO approval_stages (id, org_id, approval_id, ordinal, required_count)
       VALUES (?,?,?,?,?)`,
    ).bind(ctx.id("ast"), orgId, approvalId, index + 1, required)),
  ];

  return {
    satisfiable: true,
    plan: {
      approvalId,
      stages: facts.stages,
      eligible,
      statements,
      event: {
        action: "approval.requested",
        outcome: "ok",
        // The Node asked, not the author: the policy required it. `actorKind` follows from a null actor.
        actorUserId: null,
        subject: approvalId,
        detail: {
          manifestId: facts.manifestId,
          mailboxId: facts.mailboxId,
          authorUserId: facts.authorUserId,
          stages: [...facts.stages],
          // How many people could have been asked, at the moment of asking. Recorded because the eligible set
          // is live — it is not reconstructable from the trail later, and "who could have decided this" is a
          // question an investigation asks about a decision that took a suspiciously long time to arrive.
          eligible,
        },
      },
    },
  };
}

/* ---- reading an approval --------------------------------------------------------------------- */

export interface ApprovalRow {
  id: string;
  manifestId: string;
  mailboxId: string;
  authorUserId: string;
  state: ApprovalState;
  requestedAt: string;
  resolvedAt: string | null;
}

interface RawApproval {
  id: string;
  manifest_id: string;
  mailbox_id: string;
  author_user_id: string;
  state: ApprovalState;
  requested_at: string;
  resolved_at: string | null;
}

function approvalOf(row: RawApproval): ApprovalRow {
  return {
    id: row.id,
    manifestId: row.manifest_id,
    mailboxId: row.mailbox_id,
    authorUserId: row.author_user_id,
    state: row.state,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
  };
}

const APPROVAL_COLUMNS =
  "id, manifest_id, mailbox_id, author_user_id, state, requested_at, resolved_at";

async function readApproval(env: Env, orgId: string, approvalId: string): Promise<ApprovalRow | null> {
  const row = await env.CATALOG.prepare(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, approvalId).first<RawApproval>();
  return row === null ? null : approvalOf(row);
}

/** The approval of one manifest, which is the lookup #62's recheck needs. One query, through `apr_manifest`. */
export async function approvalOfManifest(
  env: Env,
  orgId: string,
  manifestId: string,
): Promise<ApprovalRow | null> {
  const row = await env.CATALOG.prepare(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE org_id = ? AND manifest_id = ? LIMIT 1`,
  ).bind(orgId, manifestId).first<RawApproval>();
  return row === null ? null : approvalOf(row);
}

interface DecisionRow {
  stage_ordinal: number;
  decider_user_id: string;
  decision: Decision;
  withdrawn_at: string | null;
}

/**
 * Every decision ever taken on this approval, withdrawn ones included.
 *
 * Withdrawn rows are read because they still exclude their decider: withdrawal is terminal for the withdrawer,
 * so the *already-decided* set is every row, while the *satisfied* count is only the standing ones. Two
 * different questions over one read.
 */
async function decisionsOf(env: Env, approvalId: string): Promise<DecisionRow[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT stage_ordinal, decider_user_id, decision, withdrawn_at
       FROM approval_decisions WHERE approval_id = ? ORDER BY decided_at, id`,
  ).bind(approvalId).all<DecisionRow>();
  return results;
}

/** Standing approvals per stage. The only count any predicate here is built on. */
function standingByStage(decisions: readonly DecisionRow[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const row of decisions) {
    if (row.decision !== "approve" || row.withdrawn_at !== null) continue;
    counts.set(row.stage_ordinal, (counts.get(row.stage_ordinal) ?? 0) + 1);
  }
  return counts;
}

/**
 * Which stage is open: the first whose standing approvals fall short. `null` means every stage is satisfied.
 *
 * The completeness predicate, in one place. The SQL in `decideApproval` is the same predicate expressed against
 * the database — it has to be, because only the database can evaluate it at the instant of the write — and
 * `test/approvals.test.ts` holds the two to each other by making a decision that this function says completes
 * an approval and asserting the row really moved.
 */
export function openStage(stages: Stages, decisions: readonly DecisionRow[]): number | null {
  const standing = standingByStage(decisions);
  for (const [index, required] of stages.entries()) {
    if ((standing.get(index + 1) ?? 0) < required) return index + 1;
  }
  return null;
}

/* ---- deciding -------------------------------------------------------------------------------- */

export interface DecisionOutcome {
  approvalId: string;
  manifestId: string;
  decision: Decision;
  /** The stage this decision was taken against. */
  stageOrdinal: number;
  approvalState: ApprovalState;
  /** What the send is now. `held` once the last stage closes, `withheld` on a denial. */
  manifestState: "awaiting" | "held" | "withheld";
  /** True when this decision closed the last stage and released the send. */
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
    why: "deciding takes approval.decide on the mailbox the send is from (§21 makes it the sole decision "
      + "permission), and §5C keeps an invisible thing and an absent one answering alike",
    fix: "ask an administrator for approval.decide on that mailbox, or check the approval id",
  });
  if (approval === null) throw unknown();

  const deciders = await decidersOf(env, orgId, approval.mailboxId);
  if (!deciders.has(actorUserId)) throw unknown();

  if (approval.authorUserId === actorUserId) {
    // §18: separation-of-duty policies prevent self-approval. Refused even for a denial — an author who wants
    // to stop their own send cancels it, which is their own authority and does not put their name in the trail
    // as somebody else's reviewer.
    throw conflict("E_APPROVER_IS_AUTHOR", {
      what: "you composed this send, so you cannot decide its approval",
      why: "§18 requires separation of duty: an approval by its own author is not a second pair of eyes",
      fix: "cancel the send if you want to stop it, or ask another approver to decide",
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

  const at = new Date(ctx.now()).toISOString();
  const pending = "SELECT 1 FROM approvals WHERE id = ? AND org_id = ? AND state = 'pending'";
  const gate = { sql: pending, params: [approvalId, orgId] };

  // Would this decision close the last stage? Computed from what was read, so the conflict below is
  // "we expected to complete and the database disagreed" rather than a bare zero.
  const standing = standingByStage(decisions);
  const expectedToComplete = decision === "approve"
    && stages.every((required, index) => {
      const have = (standing.get(index + 1) ?? 0) + (index + 1 === stage ? 1 : 0);
      return have >= required;
    });

  const decisionInsert = env.CATALOG.prepare(
    `INSERT INTO approval_decisions
       (id, org_id, approval_id, stage_ordinal, decider_user_id, decision, decided_at, withdrawn_at)
     SELECT ?,?,?,?,?,?,?,NULL WHERE EXISTS (${pending})`,
  ).bind(ctx.id("apd"), orgId, approvalId, stage, actorUserId, decision, at, approvalId, orgId);

  const event: AuditEvent = {
    action: "approval.decided",
    // A denial is a refusal of the send, and the trail should filter as one. An approval is `ok`.
    outcome: decision === "approve" ? "ok" : "refused",
    actorUserId,
    subject: approvalId,
    detail: {
      manifestId: approval.manifestId,
      mailboxId: approval.mailboxId,
      decision,
      stage,
      stages,
      authorUserId: approval.authorUserId,
    },
  };

  const statements = decision === "approve"
    ? approveStatements(env, orgId, approvalId, approval.manifestId, at)
    : denyStatements(env, orgId, approvalId, approval.manifestId, at);

  const { results } = await auditedBatch<never>(
    env, ctx, orgId, event,
    // The entry first: everything after it clears the predicate it is gated on.
    (entry) => [entry, decisionInsert, ...statements],
    gate,
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // The predicate failed for every statement, so nothing was recorded and nothing changed.
    const now = await readApproval(env, orgId, approvalId);
    throw settled(now ?? approval);
  }

  const settledChanges = results[2]?.meta.changes ?? 0;
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
    manifestId: approval.manifestId,
    decision,
    stageOrdinal: stage,
    approvalState,
    manifestState: decision === "deny" ? "withheld" : completed ? "held" : "awaiting",
    completed,
    ...(conflictKind === undefined ? {} : { conflict: conflictKind }),
    openStage: decision === "deny" ? stage : openStage(stages, afterDecisions),
  };
}

const SETTLED_WHY: Record<Exclude<ApprovalState, "pending">, string> = {
  denied:
    "a denial is terminal: there is no act that reverses one, because re-sealing mints a new manifest and a "
    + "fresh approval (Layer 5's answer 1)",
  approved: "an approval is decided once; a second decision would be a second answer to the same question",
  unsatisfiable:
    "a withdrawal left fewer eligible approvers than the stages need, so there is no decision left that could "
    + "release this send",
  cancelled:
    "the author cancelled the send while this request was open, so there is nothing left to decide — cancelling "
    + "is their own authority over their own message (`cancelSend`)",
};

const SETTLED_FIX: Record<Exclude<ApprovalState, "pending">, string> = {
  denied: "compose again — the new manifest gets its own approval",
  approved: "read the send's state; it has already moved",
  unsatisfiable: "ask an administrator to grant approval.decide more widely, then compose again",
  cancelled: "nothing to do; the send is cancelled",
};

/**
 * The refusal every settled state answers with, one sentence per state rather than one branch for `denied` and
 * a default for everything else — which is how `unsatisfiable` came to be explained as "an approval is decided
 * once". A `Record` keyed on the type means a new state is a compile error here rather than a wrong sentence.
 */
function settled(approval: ApprovalRow): Error {
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
 * Approving: close the approval if this decision satisfies every stage, and release the send if it did.
 *
 * The completion predicate is the SQL twin of `openStage` — *no stage whose standing, non-withdrawn, distinct
 * approvers fall short of its count*. `COUNT(DISTINCT decider_user_id)` rather than `COUNT(*)`, which is
 * belt-and-braces beside `apd_one_per_person` and is the layer that would still hold if that index were ever
 * relaxed to allow a second decision after a withdrawal.
 *
 * The two statements after it are conditional on the approval **having become approved**, not on this
 * function's own expectation: a decision that did not complete the approval must leave the send exactly where
 * it was. They run after the UPDATE in the same `batch()`, which D1 executes in order inside one transaction,
 * so they see it.
 */
function approveStatements(
  env: Env,
  orgId: string,
  approvalId: string,
  manifestId: string,
  at: string,
): D1PreparedStatement[] {
  const approved = "SELECT 1 FROM approvals WHERE id = ? AND org_id = ? AND state = 'approved'";
  return [
    env.CATALOG.prepare(
      `UPDATE approvals SET state = 'approved', resolved_at = ?
        WHERE id = ? AND org_id = ? AND state = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM approval_stages s
             WHERE s.approval_id = approvals.id
               AND (SELECT COUNT(DISTINCT d.decider_user_id) FROM approval_decisions d
                     WHERE d.approval_id = s.approval_id AND d.stage_ordinal = s.ordinal
                       AND d.decision = 'approve' AND d.withdrawn_at IS NULL) < s.required_count)`,
    ).bind(at, approvalId, orgId),
    // Back to `held`, so the ordinary hold window and the ordinary dispatcher take it from here. `state_reason`
    // returns to NULL because the gate is cleared and the reason column answers "why is it in this state" --
    // the record that this send was gated and approved lives in `policy_outcome`, in the approval, and in the
    // trail, not in a stale reason on a released row.
    env.CATALOG.prepare(
      `UPDATE send_manifests SET state = 'held', state_at = ?, state_reason = NULL
        WHERE id = ? AND org_id = ? AND state = 'awaiting' AND EXISTS (${approved})`,
    ).bind(at, manifestId, orgId, approvalId, orgId),
    // The recipients follow the manifest in the same transaction, for the reason the cancel and withhold paths
    // already record: a send whose recipients disagree with it shows a person a message that is two things at
    // once.
    env.CATALOG.prepare(
      `UPDATE send_recipients SET submission_state = 'held', submission_state_at = ?
        WHERE org_id = ? AND manifest_id = ? AND EXISTS (${approved})`,
    ).bind(at, orgId, manifestId, approvalId, orgId),
  ];
}

/** Denying: terminal, and the send is `withheld` with `approval_denied`. */
function denyStatements(
  env: Env,
  orgId: string,
  approvalId: string,
  manifestId: string,
  at: string,
): D1PreparedStatement[] {
  const denied = "SELECT 1 FROM approvals WHERE id = ? AND org_id = ? AND state = 'denied'";
  return [
    env.CATALOG.prepare(
      `UPDATE approvals SET state = 'denied', resolved_at = ?
        WHERE id = ? AND org_id = ? AND state = 'pending'`,
    ).bind(at, approvalId, orgId),
    env.CATALOG.prepare(
      `UPDATE send_manifests SET state = 'withheld', state_at = ?, state_reason = 'approval_denied',
              last_error = ?
        WHERE id = ? AND org_id = ? AND state = 'awaiting' AND EXISTS (${denied})`,
    ).bind(at, "An approver denied this send. Compose again if it still needs to go.",
      manifestId, orgId, approvalId, orgId),
    env.CATALOG.prepare(
      `UPDATE send_recipients SET submission_state = 'withheld', submission_state_at = ?
        WHERE org_id = ? AND manifest_id = ? AND EXISTS (${denied})`,
    ).bind(at, orgId, manifestId, approvalId, orgId),
  ];
}

/* ---- withdrawing ----------------------------------------------------------------------------- */

export interface WithdrawOutcome {
  approvalId: string;
  approvalState: ApprovalState;
  /** The stage the withdrawn decision had satisfied, which is now open again. */
  stageOrdinal: number;
  /** Set when the withdrawal left too few eligible people, in which case the send was withheld. */
  shortfall?: Shortfall;
  manifestState: "awaiting" | "withheld";
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
      fix: "if you meant to stop this send, deny it — a denial is terminal and is recorded as yours",
    });
  }

  // What the eligible set becomes: the holders, minus the author, minus everybody who has decided — the
  // withdrawer included, because `apd_one_per_person` makes their withdrawal terminal for them.
  const deciders = await decidersOf(env, orgId, approval.mailboxId);
  const decided = new Set(decisions.map((row) => row.decider_user_id));
  const stages = await stagesOfApproval(env, approvalId);
  const remaining = [...deciders].filter(
    (userId) => userId !== approval.authorUserId && !decided.has(userId),
  ).length;
  // Counted against what is still needed, not against the whole chain: the stages the withdrawal does not
  // touch keep the decisions that already stand. The standing set is recomputed with this decision removed.
  const standing = standingByStage(decisions.filter((row) => row !== mine));
  const outstanding = stages.map((required, index) =>
    Math.max(0, required - (standing.get(index + 1) ?? 0)));
  const shortfall = shortfallFor(outstanding, remaining);

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

  const unsatisfiable = shortfall === null ? [] : [
    env.CATALOG.prepare(
      `UPDATE approvals SET state = 'unsatisfiable', resolved_at = ?
        WHERE id = ? AND org_id = ? AND state = 'pending' AND EXISTS (${withdrew})`,
    ).bind(at, approvalId, orgId, ...withdrewParams),
    env.CATALOG.prepare(
      `UPDATE send_manifests SET state = 'withheld', state_at = ?,
              state_reason = 'approval_unsatisfiable', last_error = ?
        WHERE id = ? AND org_id = ? AND state = 'awaiting' AND EXISTS (${withdrew})`,
    ).bind(at, describeShortfall(shortfall, approval.mailboxId), approval.manifestId, orgId,
      ...withdrewParams),
    env.CATALOG.prepare(
      `UPDATE send_recipients SET submission_state = 'withheld', submission_state_at = ?
        WHERE org_id = ? AND manifest_id = ? AND EXISTS (${withdrew})`,
    ).bind(at, orgId, approval.manifestId, ...withdrewParams),
  ];

  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "approval.withdrawn",
      outcome: "ok",
      actorUserId,
      subject: approvalId,
      detail: {
        manifestId: approval.manifestId,
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
    manifestState: shortfall === null ? "awaiting" : "withheld",
  };
}

/* ---- what an approver is waiting on ---------------------------------------------------------- */

export interface PendingApproval extends ApprovalRow {
  stages: number[];
  openStage: number | null;
  /** True when the caller has already decided, so the row is theirs to withdraw rather than to decide. */
  decidedByMe: boolean;
}

/**
 * The pending approvals this person could act on: on a mailbox where they hold `approval.decide`, and not
 * their own send.
 *
 * Their own authored sends are excluded rather than shown as undecidable, because a queue that lists work
 * somebody cannot do is a queue they learn to ignore. They see those in their own outbox, where the state and
 * its reason already are.
 *
 * The rows they have already decided **are** included, with `decidedByMe`, because withdrawal is an act on
 * exactly those and a person cannot withdraw from something they cannot find.
 *
 * Two queries per pending approval, which is stated rather than hidden: it is bounded by the outstanding set —
 * approvals nobody has finished deciding — and if that ever stops being small, the two reads collapse into one
 * grouped query over both tables. Bounded by what people have left undone is the right kind of bound for a
 * queue; it is the same shape as the outbox's own list.
 */
export async function pendingApprovals(
  env: Env,
  orgId: string,
  userId: string,
): Promise<PendingApproval[]> {
  const byMailbox = await decidersByMailbox(env, orgId);
  const mailboxes = [...byMailbox.entries()]
    .filter(([, people]) => people.has(userId))
    .map(([mailboxId]) => mailboxId);
  if (mailboxes.length === 0) return [];

  const placeholders = mailboxes.map(() => "?").join(", ");
  const { results } = await env.CATALOG.prepare(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals
      WHERE org_id = ? AND state = 'pending' AND mailbox_id IN (${placeholders})
        AND author_user_id != ?
      ORDER BY requested_at, id`,
  ).bind(orgId, ...mailboxes, userId).all<RawApproval>();

  const out: PendingApproval[] = [];
  for (const row of results) {
    const approval = approvalOf(row);
    const stages = await stagesOfApproval(env, approval.id);
    const decisions = await decisionsOf(env, approval.id);
    out.push({
      ...approval,
      stages,
      openStage: openStage(stages, decisions),
      decidedByMe: decisions.some((decision) => decision.decider_user_id === userId),
    });
  }
  return out;
}
