import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { type AuditEvent, type AuditGate, auditedBatch, auditedBatchMany } from "./audit.ts";
import { decidersByMailbox, decidersOf } from "./deciders.ts";
import { conflict, notFound } from "./errors.ts";

/**
 * Approvals: ordered stages with a count, decided by distinct people (#61, §18, Layer 5).
 *
 * ## An approval decides on a **subject**, and there are two kinds
 *
 * This module shipped manifest-shaped: `approvals.manifest_id TEXT NOT NULL` with `UNIQUE (manifest_id)`.
 * The legal-hold lift (#64) is the second caller and it is not a manifest, so migration 0021 generalised the
 * target to `(subject_kind, subject_id)` — see that file for why a nullable second id column and a second
 * approvals table were both refused. §18 names connector writes, forwarding, export and domain/routing
 * changes as further subjects, and #65's eDiscovery export is already charted as one, so the third caller is
 * known rather than imagined.
 *
 *     send_manifest   the subject is a send_manifests row. Completion releases the send to `held`.
 *     hold_lift       the subject is a hold_lifts row. Completion applies the lift: one conditional
 *                     `UPDATE holds` setting `lifted_at`, `lifted_reason` and `lift_id`.
 *
 * Two columns carry across both kinds, and both were checked rather than assumed:
 *
 *   `mailbox_id`      keeps its name and meaning. For a send it is the mailbox the message is from; for a
 *                     lift it is the **held** mailbox. In both cases it answers exactly one question — who
 *                     holds `approval.decide` here, and is therefore eligible.
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

/**
 * The subject kinds an approval may decide on.
 *
 * The declared set, and **the only place it is declared**. `approvals.subject_kind` carries no CHECK
 * constraint — SQLite cannot add one with `ALTER TABLE`, and a trigger cannot exist in this tree because
 * `src/migrate.ts` splits migrations on semicolons (`test/node/migrations.test.ts`). So this union is the
 * constraint, and `test/node/content-deletion-world.test.ts` is what makes it one rather than a convention:
 * it requires every subject-kind literal in `src/` to appear here and requires `approvals` to have exactly
 * one writer, because a kind that slipped past would be an approval nothing knows how to complete.
 */
export const APPROVAL_SUBJECT_KINDS = ["send_manifest", "hold_lift"] as const;

export type ApprovalSubjectKind = (typeof APPROVAL_SUBJECT_KINDS)[number];

/**
 * The word each kind uses for the act it gates, in the second person, for the refusal an actor reads when
 * they try to decide their own.
 *
 * A `Record` keyed on the type, so a new subject kind is a compile error here rather than a refusal that
 * says "you composed this send" to somebody who requested a hold lift.
 */
const ACTOR_DID: Record<ApprovalSubjectKind, string> = {
  send_manifest: "you composed this send, so you cannot decide its approval",
  hold_lift: "you requested this hold lift, so you cannot be one of the two people who approve it",
};

/**
 * How long each kind of approval is good for, in seconds, or `null` for a kind with no deadline (#62).
 *
 * A `Record` keyed on the type, like `ACTOR_DID` above, so a third subject kind is a compile error here rather
 * than a row that silently inherits a deadline nothing compares.
 *
 * `send_manifest` gets the constant; `hold_lift` gets `null` and stores NULL. The asymmetry is not a gap: the
 * only code that reads `expires_at` is the recheck in `dispatchOne`, which dispatches sends. A deadline on a
 * lift would be a limit written into a column with no reader, and this repository's most-repeated defect is a
 * bound field nothing populates — its mirror image is a populated field nothing reads.
 */
const EXPIRES_AFTER_SECONDS: Record<ApprovalSubjectKind, number | null> = {
  send_manifest: BUDGETS["approval.send_expiry_seconds"],
  hold_lift: null,
};

/**
 * The deadline an approval of this kind requested now would carry, or null when the kind has none.
 *
 * Exported so the recheck's own tests and `docs/receipts/dispatch-recheck-cost.md` can state the same
 * arithmetic this module writes, rather than a second copy of `requested_at + constant` that could disagree
 * with it. The deadline is **stored**, not derived at read time, for the reason 0022 gives: changing the
 * constant must not move the deadline of a request somebody is already deciding.
 */
export function expiryFor(kind: ApprovalSubjectKind, requestedAtMillis: number): string | null {
  const seconds = EXPIRES_AFTER_SECONDS[kind];
  return seconds === null ? null : new Date(requestedAtMillis + seconds * 1000).toISOString();
}

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

/*
 * `decidersByMailbox` and `decidersOf` live in `src/deciders.ts`.
 *
 * They moved there rather than being re-exported from here, so there is one import path and not two. That
 * file's header carries the reason: `doctor` now asks the same question for `legal_hold_unliftable`, and its
 * cost meter's honesty guard pins a property over every file `doctor.ts` imports that this module cannot
 * satisfy — it prepares statements it binds to names, in functions `runDoctor` never calls.
 */
/* ---- requesting ------------------------------------------------------------------------------ */

export interface ApprovalRequestFacts {
  subjectKind: ApprovalSubjectKind;
  /** The row being decided on: a manifest id for a send, a `hold_lifts` id for a lift. */
  subjectId: string;
  mailboxId: string;
  /** The person whose act this gates, and therefore the one person excluded from deciding it. */
  actorUserId: string;
  /**
   * How many distinct decisions, per stage, in order.
   *
   * For a send: the fold over every matching `require_approval` version — see `requiredStages` in
   * `src/policy.ts`. For a lift: `LIFT_STAGES`, which is #64's decision rather than a policy's.
   */
  stages: Stages;
  /** Extra fields for the `approval.requested` detail — a lift's reason is the first. */
  detail?: Record<string, unknown>;
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
 * The actor is removed here rather than by the caller, because *"minus the person whose act this is"* is a rule
 * about approvals and not about sealing: §18 requires separation-of-duty policies to prevent self-approval, and
 * a caller that had to remember to subtract would be a caller that could forget. The lift gets that rule by
 * calling this rather than by restating it.
 *
 * ## The optional gate, and which caller needs it
 *
 * A send's subject is a manifest minted a moment ago in the same transaction, so its rows are unconditional.
 * A lift's subject is a **hold**, which somebody else may have lifted between this caller's read and its write
 * — so `requestHoldLift` passes a gate, and every statement built here becomes
 * `INSERT ... SELECT ... WHERE EXISTS (<gate>)`. That is the same compare-and-swap the rest of this module
 * runs on (#9, the conflict is the signal); without it the eligible-set read and the "no lift is pending yet"
 * read would be a check somebody could race past, and the loser would open a second question about one hold.
 */
export function planApproval(
  env: Env,
  ctx: Ctx,
  orgId: string,
  facts: ApprovalRequestFacts,
  deciders: ReadonlySet<string>,
  gate?: AuditGate,
): ApprovalPlanned {
  const eligible = [...deciders].filter((userId) => userId !== facts.actorUserId).length;
  const shortfall = shortfallFor(facts.stages, eligible);
  if (shortfall !== null) return { satisfiable: false, shortfall, eligible };

  const approvalId = ctx.id("apr");
  const at = new Date(ctx.now()).toISOString();

  /**
   * One insert, gated or not, with the placeholders counted from the values so the two forms cannot drift.
   *
   * The `INSERT INTO <table>` head is passed in **written out** rather than assembled from a table name,
   * because `test/node/content-deletion-world.test.ts` scans this source for literal table names and states
   * that dynamically built SQL is its blind spot. A table name in a template hole would have made the one
   * `INSERT INTO approvals` in this product invisible to the test that requires there to be exactly one.
   */
  const gated = (head: string, values: unknown[]): D1PreparedStatement => {
    const holes = values.map(() => "?").join(",");
    return gate === undefined
      ? env.CATALOG.prepare(`${head} VALUES (${holes})`).bind(...values)
      : env.CATALOG.prepare(`${head} SELECT ${holes} WHERE EXISTS (${gate.sql})`)
        .bind(...values, ...gate.params);
  };

  const statements = [
    gated(
      `INSERT INTO approvals
         (id, org_id, subject_kind, subject_id, mailbox_id, actor_user_id, state, requested_at, resolved_at,
          expires_at)`,
      [approvalId, orgId, facts.subjectKind, facts.subjectId, facts.mailboxId, facts.actorUserId,
        "pending", at, null,
        // Derived from `at` rather than from a second `ctx.now()`, so the deadline is exactly
        // `requested_at` plus the constant. A Worker's clock advances across I/O and `ctx.now()` is not
        // required to be stable, so two calls would put the deadline a few milliseconds off the request it
        // belongs to — the same defect `submitPerRecipient` records for `submission_state_at`, where it
        // silently counted a three-recipient send as one.
        expiryFor(facts.subjectKind, Date.parse(at))],
    ),
    ...facts.stages.map((required, index) => gated(
      "INSERT INTO approval_stages (id, org_id, approval_id, ordinal, required_count)",
      [ctx.id("ast"), orgId, approvalId, index + 1, required],
    )),
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
        // The Node asked, not the actor: for a send a policy required it, and for a lift the request and the
        // asking are one act by one person, recorded below rather than as the entry's actor. `actorKind`
        // follows from a null actor.
        actorUserId: null,
        subject: approvalId,
        detail: {
          subjectKind: facts.subjectKind,
          subjectId: facts.subjectId,
          mailboxId: facts.mailboxId,
          actorUserId: facts.actorUserId,
          stages: [...facts.stages],
          // How many people could have been asked, at the moment of asking. Recorded because the eligible set
          // is live — it is not reconstructable from the trail later, and "who could have decided this" is a
          // question an investigation asks about a decision that took a suspiciously long time to arrive.
          eligible,
          ...facts.detail,
        },
      },
    },
  };
}

/* ---- reading an approval --------------------------------------------------------------------- */

export interface ApprovalRow {
  id: string;
  subjectKind: ApprovalSubjectKind;
  subjectId: string;
  mailboxId: string;
  /** The person whose act this gates. Never eligible to decide it. */
  actorUserId: string;
  state: ApprovalState;
  requestedAt: string;
  resolvedAt: string | null;
  /**
   * When this approval stops being good enough to dispatch on (#62), or null when no deadline is recorded.
   *
   * Null means one of exactly two things, both of them answers rather than gaps: the request predates
   * migration 0022, or its subject kind is one no recheck reads — see `EXPIRES_AFTER_SECONDS` and 0022's
   * column comment. Neither is treated as expired, because a deadline nobody set has not passed.
   */
  expiresAt: string | null;
}

interface RawApproval {
  id: string;
  subject_kind: ApprovalSubjectKind;
  subject_id: string;
  mailbox_id: string;
  actor_user_id: string;
  state: ApprovalState;
  requested_at: string;
  resolved_at: string | null;
  expires_at: string | null;
}

function approvalOf(row: RawApproval): ApprovalRow {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    mailboxId: row.mailbox_id,
    actorUserId: row.actor_user_id,
    state: row.state,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Every column every reader of this table needs, in one list.
 *
 * `expires_at` joined it with #62 and costs nothing: a column added to a `SELECT` that was already being
 * issued is free, which is the distinction `docs/receipts/approval-decision-cost.md`'s *"the approvals tables
 * gain a column a decision has to read"* clause exists to have checked rather than assumed. It was re-measured
 * when that clause fired.
 */
const APPROVAL_COLUMNS =
  "id, subject_kind, subject_id, mailbox_id, actor_user_id, state, requested_at, resolved_at, expires_at";

async function readApproval(env: Env, orgId: string, approvalId: string): Promise<ApprovalRow | null> {
  const row = await env.CATALOG.prepare(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, approvalId).first<RawApproval>();
  return row === null ? null : approvalOf(row);
}

/**
 * The approval of one manifest, which is the lookup #62's recheck needs. One query, through `apr_subject`.
 *
 * Named for the manifest rather than for the subject, because that is the question it answers and the caller
 * that asks it holds a manifest. `subject_kind` is pinned rather than left to the id's prefix: a `snd_` id and
 * an `hlf_` id can never collide, but a lookup that relied on that would be relying on a convention this
 * schema does not enforce, and the unique index wants both columns anyway.
 */
export async function approvalOfManifest(
  env: Env,
  orgId: string,
  manifestId: string,
): Promise<ApprovalRow | null> {
  const row = await env.CATALOG.prepare(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals
      WHERE org_id = ? AND subject_kind = 'send_manifest' AND subject_id = ? LIMIT 1`,
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

/**
 * Who approved this, and who took it back — the two questions #62's recheck asks of one read.
 *
 * Exported so the recheck does not write its own `SELECT` over `approval_decisions`. That is the instruction
 * this module's header leaves for #62: the recheck re-reads live state, and it must re-read it *through the
 * definitions that wrote it*, or there are two spellings of "whose approval still stands" and the one that
 * counts is whichever file the reader opened.
 *
 * `withdrawn` is what makes revocation visible. On a `pending` approval a withdrawal is ordinary and is
 * already accounted for by the stage counts; on an **approved** one it cannot be produced by any path in this
 * Node — `withdrawApproval` refuses a settled request, which is exactly what is supposed to make an approved
 * send safe to dispatch — so a non-empty `withdrawn` there means the row moved outside the product. The
 * recheck treats it as `approval_revoked` rather than trusting the state column, because the whole point of
 * re-reading is to not trust what the manifest's own state implies.
 *
 * One query, shared: the eligibility check needs the same rows to know who to re-check.
 */
export async function decisionsOfApproval(
  env: Env,
  approvalId: string,
): Promise<{ approvers: string[]; withdrawn: string[]; denied: string[] }> {
  const rows = await decisionsOf(env, approvalId);
  return {
    approvers: rows
      .filter((row) => row.decision === "approve" && row.withdrawn_at === null)
      .map((row) => row.decider_user_id),
    withdrawn: rows
      .filter((row) => row.decision === "approve" && row.withdrawn_at !== null)
      .map((row) => row.decider_user_id),
    denied: rows.filter((row) => row.decision === "deny").map((row) => row.decider_user_id),
  };
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

  const deciders = await decidersOf(env, orgId, approval.mailboxId);
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
      fix: approval.subjectKind === "hold_lift"
        ? "two other people holding approval.decide on the held mailbox have to approve it"
        : "cancel the send if you want to stop it, or ask another approver to decide",
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

  // Would this decision close the last stage? Computed from what was read, so the conflict below is
  // "we expected to complete and the database disagreed" rather than a bare zero.
  const standing = standingByStage(decisions);
  const expectedToComplete = decision === "approve"
    && stages.every((required, index) => {
      const have = (standing.get(index + 1) ?? 0) + (index + 1 === stage ? 1 : 0);
      return have >= required;
    });

  /**
   * The lift this decision is about to apply, or null for every other decision in this Node.
   *
   * Read only on the completing decision of a `hold_lift`, because that is the only path with something to
   * say about it: the `hold.lifted` entry has to carry the hold and the reason it was requested for, and an
   * investigator reading the trail must not have to join two tables to learn why destruction was re-permitted.
   * One extra query, on an act that happens twice per lift at most.
   */
  const lift = approval.subjectKind === "hold_lift" && expectedToComplete
    ? await readHoldLift(env, orgId, approval.subjectId)
    : null;
  if (approval.subjectKind === "hold_lift" && expectedToComplete && lift === null) {
    // The subject of an approval cannot be missing: `requestHoldLift` writes both rows in one transaction
    // behind one predicate. So this is a corrupted state rather than a race, and completing into it would
    // lift a hold with no record of what was asked for.
    throw conflict("E_NO_HOLD_LIFT", {
      what: `approval ${approvalId} names hold lift ${approval.subjectId}, which does not exist`,
      why: "the request row and its approval are written in one transaction, so neither can exist alone",
      fix: "investigate; completing this would lift a hold with no record of the reason it was lifted for",
    });
  }

  /**
   * The predicate every statement in this batch carries.
   *
   * `pending` for every decision except the one that completes a lift, which additionally requires that this
   * decision really does close every stage and that the hold has not already been lifted. See the header for
   * why that one case refuses rather than records.
   *
   * The `+ CASE` is this decision counted before its row exists: the entries are placed first in the batch,
   * so the predicate is evaluated against the decisions that had committed **before** this one.
   */
  const pending = "SELECT 1 FROM approvals WHERE id = ? AND org_id = ? AND state = 'pending'";
  const gate: AuditGate = lift === null
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
                AND EXISTS (SELECT 1 FROM hold_lifts l
                              JOIN holds h ON h.org_id = l.org_id AND h.id = l.hold_id
                             WHERE l.id = a.subject_id AND h.lifted_at IS NULL)`,
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
      mailboxId: approval.mailboxId,
      decision,
      stage,
      stages,
      actorUserId: approval.actorUserId,
    },
  }];

  if (lift !== null) {
    events.push({
      action: "hold.lifted",
      outcome: "ok",
      actorUserId,
      // The hold, not the approval: an auditor filtering `hold.lifted` is asking which holds were released,
      // and `hold.placed` already keys on the same subject so the two entries about one hold line up.
      subject: lift.holdId,
      detail: {
        holdId: lift.holdId,
        liftId: lift.id,
        approvalId,
        mailboxId: approval.mailboxId,
        // The reason, in the trail as well as on the hold: this is the entry an investigation reaches for
        // when it asks why preservation stopped.
        reason: lift.reason,
        requestedBy: approval.actorUserId,
        // Both names. Dual control is only evidence if the trail says who the two were, and the eligible set
        // is live — it cannot be reconstructed from the tuples as they stand later.
        approvedBy: [
          ...decisions
            .filter((row) => row.decision === "approve" && row.withdrawn_at === null)
            .map((row) => row.decider_user_id),
          actorUserId,
        ],
      },
    });
  }

  const statements = decision === "approve"
    ? approveStatements(env, orgId, approval, at)
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
    if (lift === null || now === null || now.state !== "pending") throw settled(now ?? approval);
    // Still pending, so the part of the predicate that failed was the stronger half: a standing approval was
    // withdrawn, or the hold went out from under this request. Either way nothing was recorded, and saying
    // which of the two it was would need a read whose answer could change again before it was rendered.
    throw conflict("E_HOLD_LIFT_RACED", {
      what: `approval ${approvalId} was not the decision that lifted this hold, so nothing was recorded`,
      why: "the decision that completes a lift is refused rather than recorded when the state moves under it: "
        + "either somebody withdrew their approval, or the hold was already lifted. Recording it would put a "
        + "hold.lifted entry in the trail for a lift that did not happen",
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
    ...(approval.subjectKind === "send_manifest"
      ? { manifestState: decision === "deny" ? "withheld" : completed ? "held" : "awaiting" } as const
      : { holdLifted: decision === "approve" && completed }),
    completed,
    ...(conflictKind === undefined ? {} : { conflict: conflictKind }),
    openStage: decision === "deny" ? stage : openStage(stages, afterDecisions),
  };
}

const SETTLED_WHY: Record<Exclude<ApprovalState, "pending">, string> = {
  denied:
    "a denial is terminal: there is no act that reverses one, because asking again mints a new subject — a "
    + "re-sealed manifest, or a second lift request — and with it a fresh approval (Layer 5's answer 1)",
  approved: "an approval is decided once; a second decision would be a second answer to the same question",
  unsatisfiable:
    "a withdrawal left fewer eligible approvers than the stages need, so there is no decision left that could "
    + "complete this request",
  cancelled:
    "the author cancelled the send while this request was open, so there is nothing left to decide — cancelling "
    + "is their own authority over their own message (`cancelSend`)",
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
 * Denying: terminal, and the send is `withheld` with `approval_denied`.
 *
 * A denied **lift** adds nothing beyond closing the request: the hold stays exactly as it was, which is the
 * whole point of refusing a lift, and the `hold_lifts` row stays as the record that somebody asked and was
 * told no. Nothing there needs a state column of its own — the approval carries it (0021).
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

  if (approval.subjectKind === "hold_lift") return [closed];

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

/* ---- the lift subject, read from here so the audit entry can name it ------------------------- */

/** One lift request: what it asks to lift, and the reason it was asked for. */
export interface HoldLiftRow {
  id: string;
  holdId: string;
  reason: string;
}

/**
 * The lift request an approval names, or null if there is none.
 *
 * Lives here rather than in `src/holds.ts` because `decideApproval` is its only caller and a module that
 * imported holds would close a cycle: `holds.ts` calls `planApproval` to open the request. The SQL is three
 * columns of a four-column table, which is a smaller seam than a cycle.
 */
async function readHoldLift(env: Env, orgId: string, liftId: string): Promise<HoldLiftRow | null> {
  const row = await env.CATALOG.prepare(
    "SELECT id, hold_id, reason FROM hold_lifts WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, liftId).first<{ id: string; hold_id: string; reason: string }>();
  return row === null ? null : { id: row.id, holdId: row.hold_id, reason: row.reason };
}

/* ---- withdrawing ----------------------------------------------------------------------------- */

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
  const deciders = await decidersOf(env, orgId, approval.mailboxId);
  const decided = new Set(decisions.map((row) => row.decider_user_id));
  const stages = await stagesOfApproval(env, approvalId);
  const remaining = [...deciders].filter(
    (userId) => userId !== approval.actorUserId && !decided.has(userId),
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
   */
  const unsatisfiable = shortfall === null || approval.subjectKind === "hold_lift" ? closesRequest : [
    ...closesRequest,
    env.CATALOG.prepare(
      `UPDATE send_manifests SET state = 'withheld', state_at = ?,
              state_reason = 'approval_unsatisfiable', last_error = ?
        WHERE id = ? AND org_id = ? AND state = 'awaiting' AND EXISTS (${withdrew})`,
    ).bind(at, describeShortfall(shortfall, approval.mailboxId), approval.subjectId, orgId,
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

export interface PendingApproval extends ApprovalRow {
  stages: number[];
  openStage: number | null;
  /** True when the caller has already decided, so the row is theirs to withdraw rather than to decide. */
  decidedByMe: boolean;
  /**
   * The reason a `hold_lift` was requested for, and null for every other subject kind.
   *
   * In the queue, not only in the audit trail, because **this is where a reader meets it**: somebody being
   * asked to re-permit destruction has to be able to see what they are being asked for, and a trail is where
   * a decision is accounted for afterwards. `LEFT JOIN`, so it costs no extra query — the outer join is what
   * makes a send's null a null rather than a missing row.
   */
  reason: string | null;
}

/**
 * The pending approvals this person could act on: on a mailbox where they hold `approval.decide`, and never one
 * gating their own act.
 *
 * Their own sends and their own lift requests are excluded rather than shown as undecidable, because a queue
 * that lists work somebody cannot do is a queue they learn to ignore. They see a send in their own outbox,
 * where the state and its reason already are, and a lift in `doctor`, which reports a pending one beside the
 * hold it would release.
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
    `SELECT ${APPROVAL_COLUMNS.split(", ").map((column) => `a.${column}`).join(", ")}, l.reason AS reason
       FROM approvals a
       LEFT JOIN hold_lifts l ON a.subject_kind = 'hold_lift' AND l.id = a.subject_id AND l.org_id = a.org_id
      WHERE a.org_id = ? AND a.state = 'pending' AND a.mailbox_id IN (${placeholders})
        AND a.actor_user_id != ?
      ORDER BY a.requested_at, a.id`,
  ).bind(orgId, ...mailboxes, userId).all<RawApproval & { reason: string | null }>();

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
      reason: row.reason,
    });
  }
  return out;
}
