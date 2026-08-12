import type { Ctx } from "@mailda/runtime";

/**
 * The first-response clock (#41, decided in migration 0017).
 *
 * Runs from the oldest inbound message nobody has answered to the first outbound hand-over. No pause, no
 * `waiting-on-customer`, and **no default target** — a mailbox with `first_response_minutes` NULL promises
 * nothing and its cases carry no clock at all.
 *
 * ## Why a scan and never "fire once per breach"
 *
 * #41 chose cron over a Durable Object alarm, and the reasoning only holds if this stays a scan. Cron has
 * **no documented retry**: a dropped invocation is repaired by the next minute's, which is true of a query
 * over due rows and false of anything that marks work as handled and then only looks at new work. The
 * tempting refactor — a cursor, or "only cases changed since last run" — quietly reintroduces the dependence
 * on the last run having succeeded, which is the absorbing failure state a DO alarm was rejected for.
 *
 * So: `WHERE response_due_at <= now AND first_response_at IS NULL AND response_breached_at IS NULL`. Running
 * it twice changes nothing; skipping a run costs a minute.
 */

/** Starts or restarts the clock when a message arrives. Returns the statement, for the caller's batch. */
export function clockOnInbound(
  env: Env,
  orgId: string,
  caseId: string,
  arrivedAt: string,
): D1PreparedStatement {
  return env.CATALOG.prepare(
    // `response_due_at IS NULL` is what makes this "the *oldest* unanswered inbound": the second message in
    // an unanswered thread does not push the deadline out, because the customer has been waiting since the
    // first one. Only an answered case starts a fresh clock, and `first_response_at` being cleared is what
    // marks that.
    //
    // The target comes from the mailbox, so a mailbox promising nothing leaves this NULL and the case never
    // appears in the sweep.
    `UPDATE cases
        SET response_due_at = CASE
              WHEN response_due_at IS NOT NULL AND first_response_at IS NULL THEN response_due_at
              ELSE (
                -- strftime, not datetime. datetime() returns 'YYYY-MM-DD HH:MM:SS' with a SPACE, and the
                -- sweep compares this column against toISOString(), which has a 'T'. Space is 0x20 and 'T'
                -- is 0x54, so every same-day deadline sorted as already past and a case was reported
                -- breached up to 24 hours early. Both sides of a string comparison must be the same shape.
                --
                -- No backticks in this string: it is a TypeScript template literal, so one in a comment ends
                -- it. That is the second time this hazard has bitten in this codebase, the first being the
                -- CSS in ui.ts, which now says so at the top of its stylesheet.
                SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || m.first_response_minutes || ' minutes')
                  FROM mailboxes m
                 WHERE m.id = cases.mailbox_id AND m.first_response_minutes IS NOT NULL
              )
            END,
            first_response_at = CASE
              WHEN response_due_at IS NOT NULL AND first_response_at IS NULL THEN first_response_at
              ELSE NULL
            END,
            response_breached_at = CASE
              WHEN response_due_at IS NOT NULL AND first_response_at IS NULL THEN response_breached_at
              ELSE NULL
            END
      WHERE org_id = ? AND id = ?`,
  ).bind(arrivedAt, orgId, caseId);
}

/**
 * Stops the clock when a reply is handed over.
 *
 * Hand-over, not sealing. A sealed send sits in the hold window and can still be cancelled, so treating it as
 * the answer would record a response that never left — the same distinction ADR 39 draws between
 * `handed_over` and anything more optimistic, applied to a clock.
 *
 * Only the *first* response stops it, which is what the column is called. A second reply changes nothing.
 */
export async function stopClockForConversation(
  env: Env,
  orgId: string,
  conversationId: string,
  at: string,
): Promise<number> {
  const result = await env.CATALOG.prepare(
    `UPDATE cases SET first_response_at = ?
      WHERE org_id = ? AND conversation_id = ? AND first_response_at IS NULL
        AND response_due_at IS NOT NULL`,
  ).bind(at, orgId, conversationId).run();
  return result.meta.changes ?? 0;
}

export interface SweepOutcome {
  /** Cases whose due time passed unanswered, newly recorded. */
  breached: string[];
}

/**
 * The cron sweep. Idempotent, and safe to run as often as the schedule fires.
 *
 * Bounded per run, because an unbounded UPDATE over a table that has been unswept for a week is one query
 * whose cost nobody chose. Anything left over is picked up by the next minute — which is the property that
 * makes a bound safe here and would not be safe for a fire-once design.
 */
export async function sweepResponseClocks(
  env: Env,
  ctx: Ctx,
  orgId: string,
  limit = 200,
): Promise<SweepOutcome> {
  const now = new Date(ctx.now()).toISOString();

  const { results } = await env.CATALOG.prepare(
    `SELECT id FROM cases
      WHERE org_id = ? AND response_due_at IS NOT NULL AND response_due_at <= ?
        AND first_response_at IS NULL AND response_breached_at IS NULL
      ORDER BY response_due_at LIMIT ?`,
  ).bind(orgId, now, limit).all<{ id: string }>();

  if (results.length === 0) return { breached: [] };

  // One statement, conditional on the same predicate the select used — so a case answered between the read
  // and the write is not recorded as breached. The conflict is the signal, again.
  await env.CATALOG.batch(
    results.map((row) =>
      env.CATALOG.prepare(
        `UPDATE cases SET response_breached_at = ?
          WHERE org_id = ? AND id = ? AND first_response_at IS NULL AND response_breached_at IS NULL`,
      ).bind(now, orgId, row.id)),
  );

  return { breached: results.map((row) => row.id) };
}
