import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

/**
 * Hash-linked audit (§23, Layer 5's shape).
 *
 * Built before Layer 5 because an audit log added later has a hole exactly where the past should be.
 * Everything already shipped produces events an administrator would need — sign-in, lockout, key
 * rotation, sealing, dispatch, cancellation, re-sealing, reconciliation — and none of them were
 * recorded anywhere a person could read.
 *
 * ## Why hash-linked rather than timestamped
 *
 * A timestamped log is a claim. A hash-linked one is a claim that can be **checked**: each entry
 * carries the hash of its predecessor, so deleting an entry, reordering two, or editing a field all
 * break verification at a nameable point.
 *
 * This does **not** stop a determined operator with database access from rewriting the whole chain, and
 * nothing in a self-hosted system can — the customer owns the database, which is the entire premise
 * (ADR 2). What it stops is a *quiet* edit, which is the realistic case: the chain turns "trust this
 * log" into "verify this log", and `verifyChain` reports the first entry where it breaks rather than a
 * bare pass/fail, because an investigation needs the bad link, not the news that one exists.
 *
 * ## Appending is a race, and the database settles it
 *
 * `UNIQUE(org_id, seq)` means two concurrent writers cannot both take a slot: one loses at the database
 * and retries against the new tip. That is #9's shape — the conflict *is* the signal — and it avoids a
 * Durable Object on a path that every state change touches.
 */

const MAX_DETAIL = BUDGETS["audit.max_detail_bytes"];
const VERIFY_BATCH = BUDGETS["audit.verify_batch"];

/** The genesis predecessor. A chain has to start somewhere, and it starts somewhere stated. */
const GENESIS = "0".repeat(64);

export type ActorKind = "user" | "node" | "installer";
export type Outcome = "ok" | "refused" | "failed";

export interface AuditEvent {
  action: string;
  outcome: Outcome;
  actorUserId?: string | null;
  actorKind?: ActorKind;
  subject?: string | null;
  detail?: Record<string, unknown>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The bytes that are hashed.
 *
 * Field order is fixed and explicit rather than derived from object iteration, because a hash whose
 * input depends on property order is a hash that changes when someone reorders an interface — and a
 * chain that breaks on a refactor teaches everyone to ignore it.
 */
function canonical(entry: {
  seq: number; at: string; actorUserId: string | null; actorKind: string;
  action: string; subject: string | null; outcome: string; detail: string | null;
}): string {
  return [
    entry.seq, entry.at, entry.actorUserId ?? "", entry.actorKind,
    entry.action, entry.subject ?? "", entry.outcome, entry.detail ?? "",
  ].join("");
}

/**
 * Bounded, and bounded for a disclosure reason rather than a storage one: this table is read by whoever
 * may audit, which is a wider set than whoever may read the mail. An unbounded detail invites a subject
 * line or a token into a table with different access rules than the content it came from.
 */
function boundedDetail(detail: Record<string, unknown> | undefined): string | null {
  if (detail === undefined) return null;
  const text = JSON.stringify(detail);
  return text.length <= MAX_DETAIL
    ? text
    : JSON.stringify({ truncated: true, bytes: text.length, head: text.slice(0, MAX_DETAIL - 120) });
}

export interface AppendedEntry {
  id: string;
  seq: number;
  hash: string;
}

/**
 * Appends one entry.
 *
 * Never throws. An audit write that can fail a request would make the log the most dangerous component
 * in the system — every action would gain a new way to fail, and the pressure would be to remove the
 * logging rather than fix it. A failure to record is itself recorded, in the operational log, where a
 * `doctor` check can see it.
 */
export async function audit(
  env: Env,
  ctx: Ctx,
  orgId: string,
  event: AuditEvent,
  attempt = 0,
): Promise<AppendedEntry | null> {
  try {
    const tip = await env.CATALOG.prepare(
      "SELECT seq, hash FROM audit_entries WHERE org_id = ? ORDER BY seq DESC LIMIT 1",
    )
      .bind(orgId)
      .first<{ seq: number; hash: string }>();

    const seq = (tip?.seq ?? 0) + 1;
    const prevHash = tip?.hash ?? GENESIS;
    const at = new Date(ctx.now()).toISOString();
    const actorKind: ActorKind = event.actorKind ?? (event.actorUserId != null ? "user" : "node");
    const detail = boundedDetail(event.detail);

    const fields = {
      seq, at,
      actorUserId: event.actorUserId ?? null,
      actorKind,
      action: event.action,
      subject: event.subject ?? null,
      outcome: event.outcome,
      detail,
    };
    const hash = await sha256Hex(prevHash + canonical(fields));
    const id = ctx.id("aud");

    await env.CATALOG.prepare(
      `INSERT INTO audit_entries
         (id, org_id, seq, at, actor_user_id, actor_kind, action, subject, outcome, detail, prev_hash, hash)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(id, orgId, seq, at, fields.actorUserId, actorKind, event.action, fields.subject,
        event.outcome, detail, prevHash, hash)
      .run();

    return { id, seq, hash };
  } catch (error) {
    // A UNIQUE violation means another writer took this slot. Retry against the new tip — bounded,
    // because an unbounded retry on a contended path is a way to spend a whole invocation.
    if (attempt < 4 && /UNIQUE constraint failed/i.test((error as Error).message)) {
      return audit(env, ctx, orgId, event, attempt + 1);
    }
    await log(env, ctx, {
      level: "error",
      event: "audit.append_failed",
      message: `Could not record ${event.action}: ${(error as Error).message.split("\n")[0]}`,
      orgId,
      detail: { action: event.action, subject: event.subject ?? null },
    });
    return null;
  }
}

export interface ChainVerdict {
  checked: number;
  from: number;
  intact: boolean;
  /** The first entry whose hash does not follow. An investigation needs the link, not the verdict. */
  brokenAt: { seq: number; id: string; reason: string } | null;
  /** Where a caller should resume. Verification is batched because re-hashing is linear. */
  resumeFrom: number | null;
}

export async function verifyChain(env: Env, orgId: string, from = 1): Promise<ChainVerdict> {
  const rows = await env.CATALOG.prepare(
    `SELECT id, seq, at, actor_user_id, actor_kind, action, subject, outcome, detail, prev_hash, hash
       FROM audit_entries WHERE org_id = ? AND seq >= ? ORDER BY seq LIMIT ?`,
  )
    .bind(orgId, from, VERIFY_BATCH)
    .all<Record<string, string | number | null>>();

  if (rows.results.length === 0) {
    return { checked: 0, from, intact: true, brokenAt: null, resumeFrom: null };
  }

  // The predecessor of the first row in this batch, so batching does not create a false break.
  const before = from <= 1
    ? null
    : await env.CATALOG.prepare("SELECT hash FROM audit_entries WHERE org_id = ? AND seq = ?")
        .bind(orgId, from - 1)
        .first<{ hash: string }>();

  let expectedPrev = from <= 1 ? GENESIS : (before?.hash ?? null);
  let expectedSeq = from;

  for (const row of rows.results) {
    const seq = Number(row.seq);
    const id = String(row.id);

    if (expectedPrev === null) {
      return {
        checked: 0, from, intact: false, resumeFrom: null,
        brokenAt: { seq, id, reason: `entry ${from - 1} is missing, so this batch has no predecessor` },
      };
    }
    if (seq !== expectedSeq) {
      // A gap is what a deletion looks like. Named as such, because "missing" is the finding.
      return {
        checked: seq - from, from, intact: false, resumeFrom: null,
        brokenAt: { seq, id, reason: `sequence jumped from ${expectedSeq} to ${seq}: ${seq - expectedSeq} entr(ies) missing` },
      };
    }
    if (String(row.prev_hash) !== expectedPrev) {
      return {
        checked: seq - from, from, intact: false, resumeFrom: null,
        brokenAt: { seq, id, reason: "recorded predecessor hash does not match the previous entry" },
      };
    }

    const recomputed = await sha256Hex(expectedPrev + canonical({
      seq, at: String(row.at),
      actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
      actorKind: String(row.actor_kind),
      action: String(row.action),
      subject: row.subject === null ? null : String(row.subject),
      outcome: String(row.outcome),
      detail: row.detail === null ? null : String(row.detail),
    }));
    if (recomputed !== String(row.hash)) {
      return {
        checked: seq - from, from, intact: false, resumeFrom: null,
        brokenAt: { seq, id, reason: "entry was altered after it was written: its contents do not produce its hash" },
      };
    }

    expectedPrev = String(row.hash);
    expectedSeq = seq + 1;
  }

  return {
    checked: rows.results.length,
    from,
    intact: true,
    brokenAt: null,
    resumeFrom: rows.results.length === VERIFY_BATCH ? expectedSeq : null,
  };
}

/* ------------------------------------------------------------------ operational logging --------- */

const LOG_MAX_DETAIL = BUDGETS["log.max_detail_bytes"];
const LOG_RETAINED = BUDGETS["log.retained_entries"];
const LOG_TRIM_BATCH = BUDGETS["log.trim_batch"];

export interface LogEvent {
  level: "error" | "warn" | "info";
  event: string;
  message: string;
  orgId?: string | null;
  requestId?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Records an operational event where the Node itself can read it.
 *
 * Before this, the only logging was `console.error` into Cloudflare's dashboard — so an operator had to
 * leave the product to find out why it misbehaved, and `doctor` could not see the Node's own failures
 * at all. §23 wants a trace; `requestId` is the smallest thing that is one.
 *
 * Never throws, for the same reason `audit` does not: logging that can fail a request is logging that
 * gets removed. A console line remains as the last resort, because a log write that fails still has to
 * go somewhere.
 */
export async function log(env: Env, ctx: Ctx, entry: LogEvent): Promise<void> {
  try {
    const text = entry.detail === undefined ? null : JSON.stringify(entry.detail);
    const detail = text === null || text.length <= LOG_MAX_DETAIL
      ? text
      : JSON.stringify({ truncated: true, head: text.slice(0, LOG_MAX_DETAIL - 60) });

    await env.CATALOG.prepare(
      `INSERT INTO log_entries (id, org_id, at, level, event, message, detail, request_id)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
      .bind(ctx.id("log"), entry.orgId ?? null, new Date(ctx.now()).toISOString(),
        entry.level, entry.event, entry.message.slice(0, 2000), detail, entry.requestId ?? null)
      .run();
  } catch (error) {
    // The last resort. A failure to write the log cannot itself be written to the log.
    console.error("E_LOG_WRITE_FAILED", entry.event, (error as Error).message);
  }
}

/**
 * Trims to the retained bound, opportunistically.
 *
 * Called from a path that is already writing rather than on a schedule: a scheduled job is a second
 * thing that can fail silently, and a bounded trim on an existing path cannot drift out of step with
 * the thing it trims. Audit entries are **never** trimmed — a chain with a hole is not a chain.
 */
export async function trimLogs(env: Env): Promise<number> {
  const total = await env.CATALOG.prepare("SELECT COUNT(*) AS n FROM log_entries").first<{ n: number }>();
  if ((total?.n ?? 0) <= LOG_RETAINED) return 0;

  const result = await env.CATALOG.prepare(
    `DELETE FROM log_entries WHERE id IN (
       SELECT id FROM log_entries ORDER BY at ASC LIMIT ?
     )`,
  )
    .bind(LOG_TRIM_BATCH)
    .run();
  return result.meta.changes ?? 0;
}
