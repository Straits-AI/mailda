import type { ApprovalState, ApprovalSubjectKind, Decision, Stages } from "./approval-plan.ts";

export interface ApprovalRow {
  id: string;
  subjectKind: ApprovalSubjectKind;
  subjectId: string;
  /** The object whose relation-holders may decide this. See `SCOPE_OF` for which relation, per kind. */
  scopeId: string;
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

export interface RawApproval {
  id: string;
  subject_kind: ApprovalSubjectKind;
  subject_id: string;
  scope_id: string;
  actor_user_id: string;
  state: ApprovalState;
  requested_at: string;
  resolved_at: string | null;
  expires_at: string | null;
}

export function approvalOf(row: RawApproval): ApprovalRow {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    scopeId: row.scope_id,
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
export const APPROVAL_COLUMNS =
  "id, subject_kind, subject_id, scope_id, actor_user_id, state, requested_at, resolved_at, expires_at";

export async function readApproval(env: Env, orgId: string, approvalId: string): Promise<ApprovalRow | null> {
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

export interface DecisionRow {
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
export async function decisionsOf(env: Env, approvalId: string): Promise<DecisionRow[]> {
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
export function standingByStage(decisions: readonly DecisionRow[]): Map<number, number> {
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
  for (const [index, stage] of stages.entries()) {
    if ((standing.get(index + 1) ?? 0) < stage.count) return index + 1;
  }
  return null;
}

/* ---- deciding -------------------------------------------------------------------------------- */
