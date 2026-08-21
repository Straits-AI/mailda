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
 * The sweeper's unit of work, kept separate from any transport so it is testable without one — and
 * as of #25 there deliberately is no transport. The outbox row *is* the durability: this only marks
 * an event published after its handler returns, so a failing handler leaves it pending and the alarm
 * retries. That is at-least-once with retry, which is what Cloudflare Queues would have provided.
 * Queues arrives when a handler needs to be slow enough that it should not hold this alarm.
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
    const { createSystemCtx } = await import("@mailda/runtime");
    const wanted = createSystemCtx().now() + delayMs;
    const existing = await this.ctx.storage.getAlarm();
    /*
     * The **earlier** of the two, not "only when none is pending".
     *
     * That was sound while every alarm was five seconds out, and stopped being sound the moment the sweep
     * began parking itself on a send's `release_at` below: a Node holding a message for an hour has an alarm
     * an hour away, and under the old rule an arrival thirty seconds later found an alarm pending and set
     * nothing — so inbound publication waited for the outbound hold window. Taking the minimum keeps the
     * idempotence the header claims (arming repeatedly still costs nothing) without letting a distant alarm
     * absorb a near one.
     */
    if (existing === null || wanted < existing) {
      await this.ctx.storage.setAlarm(wanted);
    }
  }

  override async alarm(): Promise<void> {
    const { createSystemCtx } = await import("@mailda/runtime");
    const clock = createSystemCtx();
    // The consumer (#25). An unregistered topic throws, which leaves its event unpublished rather
    // than silently marked done — so a topic added without deciding what consumes it shows up in
    // `doctor` as a stalled outbox instead of vanishing.
    const { dispatch } = await import("./pipeline.ts");
    const { drained } = await drainOutbox(this.env, clock, (event) => dispatch(this.env, clock, event));

    // Outbound too (ADR 39). The hold window closes on a wall clock, so a Node that was asleep when
    // it expired still sends — the same alarm machinery #9 built for inbound publication, rather than
    // a second scheduler with its own failure modes.
    let outboundNext: number | null = null;
    try {
      const { dispatchDue, nextDispatchAt } = await import("./outbound/dispatch.ts");
      const claimed = await this.env.CATALOG.prepare(
        "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
      ).first<{ org_id: string }>();
      if (claimed?.org_id != null) {
        await dispatchDue(this.env, clock, claimed.org_id);
        // **After** the sweep, not before: what is still waiting once this pass has done what it can is the
        // thing the next alarm is for. Asked before, a send dispatched in this very pass would have re-armed
        // the alarm to chase itself.
        outboundNext = await nextDispatchAt(this.env, clock, claimed.org_id);
      }
    } catch {
      // A dispatch failure must not stop the inbound sweep. Every send stays in a state that
      // describes it, and the next alarm tries again.
    }

    /*
     * Re-arm while work remains, so a backlog drains rather than waiting for the next write.
     *
     * **`outboundNext` is the half that was missing**, and the sentence eleven lines above was false without
     * it. The re-arm consulted `pendingEvents` alone — the *inbound* outbox — so a Node with nothing arriving
     * let its alarm lapse while a sealed send sat inside its hold window, and nothing ever woke to send it.
     * What actually moved such a send was an unrelated poke: `armSweeper` runs on inbound acceptance and on
     * serving a page, so the mail left when somebody happened to look at the screen. Measured on the live
     * Node before this changed — `held`, `attempts = 0`, `release_at` long past, until a page load.
     *
     * The two arms are combined by taking the **earlier**, because they are answers to different questions
     * and the alarm can only be one instant: inbound work wants a short retry, an outbound hold window wants
     * a wake at its end, and whichever comes first is when there is something to do. Sleeping exactly until
     * `release_at` rather than polling is what keeps a long hold window free.
     */
    const remaining = await pendingEvents(this.env, clock, 1);
    const inboundNext = remaining.length > 0 || drained > 0 ? clock.now() + CLAIM_STALE_MS : null;
    const next = inboundNext === null ? outboundNext
      : outboundNext === null ? inboundNext
        : Math.min(inboundNext, outboundNext);
    // Never in the past: a due-now send reports `at`, and an alarm set behind the clock is a busy loop.
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, clock.now() + CLAIM_STALE_MS));
  }
}
