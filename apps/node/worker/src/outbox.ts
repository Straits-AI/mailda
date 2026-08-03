import { DurableObject } from "cloudflare:workers";

import type { Ctx } from "@mailda/runtime";


/**
 * Outbox publisher (§22, #9).
 *
 * The fast path attempts publication in the same request that committed the row, via
 * `waitUntil`. A Durable Object alarm sweeps anything still unpublished.
 *
 * The sweeper is an alarm rather than a cron trigger because cron granularity is one
 * minute, and §23 targets accepted inbound becoming visible within 60 seconds at 99.9% — a
 * one-minute safety net would consume the entire budget on its own (#9).
 *
 * Duplicate publication is expected and fine: the enqueue can succeed while the
 * published-flag write fails. At-least-once with idempotent consumers is the model, so the
 * consumer's `(consumer, event_id)` record is the guarantee, not this.
 */

/** How long an unpublished row waits before the sweeper is willing to retry it. */
const CLAIM_STALE_MS = 5_000;

export interface OutboxEvent {
  id: string;
  orgId: string;
  topic: string;
  payload: string;
}

export async function pendingEvents(env: Env, ctx: Ctx, limit = 25): Promise<OutboxEvent[]> {
  const cutoff = new Date(ctx.now() - CLAIM_STALE_MS).toISOString();
  const rows = await env.CATALOG.prepare(
    `SELECT id, org_id, topic, payload FROM outbox
      WHERE published_at IS NULL AND created_at <= ?
      ORDER BY created_at LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<{ id: string; org_id: string; topic: string; payload: string }>();

  return rows.results.map((r) => ({ id: r.id, orgId: r.org_id, topic: r.topic, payload: r.payload }));
}

export async function markPublished(env: Env, ctx: Ctx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const at = new Date(ctx.now()).toISOString();
  // D1 allows 100 bound parameters per query (receipt: d1-platform-limits), so chunk.
  // Not an optimisation — an unchunked update simply fails.
  for (let i = 0; i < ids.length; i += 99) {
    const chunk = ids.slice(i, i + 99);
    await env.CATALOG.prepare(
      `UPDATE outbox SET published_at = ? WHERE id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(at, ...chunk)
      .run();
  }
}

/**
 * The sweeper's unit of work, kept separate from any transport so it is testable without
 * one. Layer 1 has no queue consumer yet; the events are drained and marked, which is
 * enough to prove the mechanism and the retry-safety around it.
 */
export async function drainOutbox(
  env: Env,
  ctx: Ctx,
  handle: (event: OutboxEvent) => Promise<void>,
): Promise<{ drained: number }> {
  const events = await pendingEvents(env, ctx);
  const done: string[] = [];

  for (const event of events) {
    try {
      await handle(event);
      done.push(event.id);
    } catch {
      // Left unpublished deliberately. A failed handler must not advance the flag, or the
      // event is lost silently — the failure mode §24 exists to prevent. It will be retried
      // on the next sweep, and a permanently failing event stays visible as an unpublished
      // row rather than disappearing.
    }
  }

  await markPublished(env, ctx, done);
  return { drained: done.length };
}

/**
 * The Durable Object that owns the sweep. One instance per Node — the outbox is a single
 * ordered resource, so serialising its drain is the point rather than a limitation.
 */
export class OutboxSweeper extends DurableObject<Env> {
  /**
   * Called after a commit to guarantee a sweep happens even if the fast path died.
   * Idempotent: an alarm is set only when none is pending, so arming it on every request
   * costs nothing.
   */
  async schedule(delayMs = CLAIM_STALE_MS): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + delayMs);
    }
  }

  override async alarm(): Promise<void> {
    const { createSystemCtx } = await import("@mailda/runtime");
    const clock = createSystemCtx();
    const { drained } = await drainOutbox(this.env, clock, async () => {
      // Layer 1: no consumer yet. Draining proves the mechanism; the consumer arrives with
      // the async processing pipeline (§13) and its own idempotency record.
    });

    // Re-arm while work remains, so a backlog drains rather than waiting for the next write.
    const remaining = await pendingEvents(this.env, clock, 1);
    if (remaining.length > 0 || drained > 0) {
      await this.ctx.storage.setAlarm(Date.now() + CLAIM_STALE_MS);
    }
  }
}
