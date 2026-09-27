import { DurableObject } from "cloudflare:workers";

import type { Ctx } from "@mailda/runtime";

import { log } from "./audit.ts";


/**
 * Outbox publisher (§22, ADR 31).
 *
 * ## One publisher, and it starts at once
 *
 * Every event is published by this Durable Object's alarm and by nothing else. Accepting a message arms the alarm
 * for **now** (`schedule`), and a row that has never been tried is claimable the moment it commits, so a new
 * event is claimed as soon as the object runs.
 *
 * That replaced a fast path which was described and never built. From Layer 1 (b578a3e) to 27 September 2026
 * this header said the fast path "attempts publication in the same request that committed the row, via
 * `waitUntil`", and the email handler said "fast-path publication, with the DO alarm as the safety net". The
 * handler only ever armed the alarm, five seconds out, and the sweeper refused any row younger than five seconds
 * so as not to race the fast path. Every message therefore waited at least five seconds for a race with nothing
 * (the live Node measured 7.0 to 25.3 s, in `docs/receipts/doctor-check-cost.md`), and the same cutoff let the
 * alarm lapse: a message accepted just before an alarm armed by a page load was too young for that sweep to
 * claim, the sweep found nothing and did not re-arm, and the message stayed accepted and out of the inbox until
 * something unrelated woke the Node.
 *
 * Building the fast path as described was the other way to make the prose true, and it is worse on each count:
 *
 * - **Correctness.** Two publishers need a claim protocol between them and give up the serialised drain this
 *   object exists for. One publisher needs neither.
 * - **Latency.** It would save one Durable Object round trip, milliseconds, against §23's 60-second objective.
 * - **Cost.** The email handler would still have to arm the alarm as its safety net, so each message would cost
 *   the same RPC and alarm it costs here, plus the publication work in a second place.
 * - **Limits.** The work is parsing and sealing a message of up to 25 MiB (`cloudflare-email-service-limits.md`).
 *   In the email handler it would run in `waitUntil`, which the platform cuts short after the response, and a
 *   cut-short run is a duplicate later.
 *
 * Arming for now gives up a batching the five-second arm did as a side effect, and under steady traffic that has
 * a price. Every message costs one `schedule` RPC in either design. The old alarm added at most one pass per five
 * seconds however busy the Node was, and two for an isolated message (the drain, then an empty follow-up); this
 * one adds a pass per arrival, and no more than one per pass-duration, because arrivals during a pass share the
 * next (`wakeBy`). Below about one message per five seconds that is cheaper. At a steady one a second it is
 * 86,400 passes a day instead of 17,280, five times the alarms and the five D1 queries even an empty pass runs,
 * and about 5.2 million Durable Object requests a month instead of 3.1 million (the RPCs are 2.6 million of
 * each). A coalescing delay on `schedule` would buy the batching back for up to that delay per message; it is
 * not taken, because it would be a new production value and no busy Node has been measured to size it.
 *
 * ## A failed event waits; nothing else does
 *
 * Each claim writes `attempts + 1` and `retry_at` (0069) **before** the handler runs. A handler that throws
 * leaves the row unpublished with `retry_at` as its backoff, and later passes claim around it. A pass killed
 * outright (CPU, memory) never reaches a `catch` and leaves only that lease, which can expire before the next
 * pass starts, so the claim also orders by `attempts` before age: a retried event is claimed after every event
 * with fewer claims, an event that kills its pass is reached only once the events ahead of it in the next pass
 * are published, and each kill sinks it further. Ordered by age alone it would have headed every pass until its
 * lease outgrew the kill, and the old claim (the 25 oldest unpublished rows) let 25 bad events hold up all mail.
 * A killed pass also skips the outbound sweep and the re-arm that follow the drain; the platform's retry of the
 * alarm and the cron backstop below cover both. What the order cannot help is a handler that stalls rather than
 * fails: the platform runs one alarm at a time, so a stalled pass holds every event until the platform ends it,
 * and the order only makes sure the next pass publishes the others before reaching it again.
 *
 * The backoff doubles from `RETRY_BASE_MS` and is capped at `RETRY_CAP_MS`. There is no dead-letter state that
 * stops retrying: nothing would redrive it, and a fix deployed later (a handler bug, a restored evidence object)
 * should take effect without an operator's act. The cap is what that costs. A permanently failing event is
 * claimed 288 times a day, each claim one alarm invocation and six to eight D1 queries on an otherwise idle Node,
 * so about 8,700 Durable Object requests a month; the Workers Paid plan includes 1,000,000 and bills alarm
 * invocations as requests (Cloudflare's Durable Objects pricing page, read 27 September 2026). The five-second
 * retry it replaces cost 17,280 claims a day, half that allowance, for each such event. `doctor`'s
 * `outbox_draining` counts the failing events, and the log records the failure at the 1st, 2nd, 4th, 8th…
 * attempt (`outbox.handler_failed`).
 *
 * ## Why an alarm and not a cron trigger
 *
 * Cron granularity is one minute, and §23 targets accepted inbound becoming visible within 60 seconds at 99.9%;
 * a one-minute publisher would consume the entire budget on its own (#9). The minute cron is the backstop
 * instead (`scheduled` in `src/index.ts`): it arms the alarm whenever an event is due and unclaimed, so an alarm
 * lost to an arming RPC that failed, or to an alarm handler the platform stopped retrying, costs about a minute
 * (one cron interval plus the cron's own lateness, `docs/receipts/cron-lateness.md`) rather than waiting for
 * somebody to load a page.
 *
 * ## Duplicate publication is expected and fine
 *
 * A handler can finish while the published-flag write fails, a pass can be killed after a handler finished, and
 * a handler that outlives its lease can be claimed again. At-least-once is the model, and no per-consumer
 * `(consumer, event_id)` record exists yet (§22 asks for one), so each handler must be idempotent on its own
 * terms. `mail.ingress.accepted`, the only topic, is: `materialiseReceipt` finds the message by
 * `messages.ingress_receipt_id` (unique index `msg_by_receipt`) and answers `already_present`, and the Butler
 * trigger's Workflow instance id refuses a second run (`src/pipeline.ts`).
 */

/**
 * The first retry of a failed event, and the lease a claim holds while its handler runs. A policy value,
 * provisional, not a measurement: short enough that an event failing transiently is attempted four times within
 * §23's 60-second visibility objective (at 0, 5, 15 and 35 s), long enough that an event failing at once is not
 * a busy loop. It was `CLAIM_STALE_MS`, the same five seconds, when it meant "leave the fast path alone".
 */
const RETRY_BASE_MS = 5_000;

/**
 * The longest wait between two attempts at a failing event. A policy value, provisional: it bounds both what a
 * permanently failing event costs (86,400 / 300 = 288 claims a day, the arithmetic is in the module note) and how
 * long an event that failed during an outage waits after the outage ends. It stays below `doctor`'s
 * stalled-outbox threshold (`STALLED_OUTBOX_MS`, from `doctor.stalled_outbox_seconds`), so an event that
 * `outbox_draining` reports as tried and failing is still being tried, at least once in every window of that
 * length; `test/outbox.test.ts` holds the relation.
 */
const RETRY_CAP_MS = 300_000;

/** How long an event waits after its `attempts`-th claim before it may be claimed again. */
export function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_CAP_MS);
}

export interface OutboxEvent {
  id: string;
  orgId: string;
  topic: string;
  payload: string;
}

/** A row that may be claimed now, with the claims already spent on it. */
interface Claimable extends OutboxEvent {
  attempts: number;
}

/**
 * Up to `limit` events claimable now (never tried, or past their `retry_at`), fewest claims first, then oldest.
 * The order is what keeps an event that kills its pass from heading the next one (the module note).
 */
export async function pendingEvents(env: Env, ctx: Ctx, limit = 25): Promise<Claimable[]> {
  const now = new Date(ctx.now()).toISOString();
  const rows = await env.CATALOG.prepare(
    `SELECT id, org_id, topic, payload, attempts FROM outbox
      WHERE published_at IS NULL AND (retry_at IS NULL OR retry_at <= ?)
      ORDER BY attempts, created_at LIMIT ?`,
  )
    .bind(now, limit)
    .all<{ id: string; org_id: string; topic: string; payload: string; attempts: number }>();

  return rows.results.map((r) => ({
    id: r.id, orgId: r.org_id, topic: r.topic, payload: r.payload, attempts: r.attempts,
  }));
}

/**
 * When the sweeper next has inbound work: the earliest instant an unpublished event may be claimed (its
 * `retry_at`, or its `created_at` if it has never been tried), in epoch ms, or null when nothing is unpublished.
 * At or before now means something is claimable already. The alarm's re-arm and the cron's backstop both ask
 * this, so the question that decides whether the sweeper wakes is the one that decides what it claims; the
 * lapse came from asking a different one.
 */
export async function nextDue(env: Env): Promise<number | null> {
  const row = await env.CATALOG.prepare(
    "SELECT MIN(COALESCE(retry_at, created_at)) AS due FROM outbox WHERE published_at IS NULL",
  ).first<{ due: string | null }>();
  return row?.due == null ? null : Date.parse(row.due);
}

/**
 * When the sweeper should next wake for its inbound and outbound work (epoch ms, or null for neither): the
 * earlier of the two.
 *
 * Inbound is taken as it is, even when it is now: every event a pass claimed is published or has `retry_at` in
 * the future, so a pass always leaves less claimable than it found and cannot spin. Outbound is floored at
 * `RETRY_BASE_MS` from now: a due send a pass could not move (throttled, or past `dispatchDue`'s limit) reports
 * its own time, and an alarm set at it again is a busy loop.
 */
export function nextWake(inbound: number | null, outbound: number | null, now: number): number | null {
  const floored = outbound === null ? null : Math.max(outbound, now + RETRY_BASE_MS);
  if (inbound === null) return floored;
  return floored === null ? inbound : Math.min(inbound, floored);
}

/**
 * The sweeper's unit of work, kept separate from any transport so it is testable without one, and as of #25
 * there deliberately is no transport (ADR 31). The outbox row *is* the durability: an event is marked published
 * only after its handler returns, so a failing handler leaves it pending and a later pass retries it.
 *
 * Each event is claimed, handled and marked on its own, so progress survives a pass that dies part-way. The
 * claim is a conditional write rather than a read, so whoever's `UPDATE` changes the row owns the attempt, even
 * if a second caller ever drained at the same time. It owns it for as long as the lease (`retryDelay(attempts)`):
 * a handler that outlives that can be claimed again, which the module note's at-least-once model tolerates.
 */
export async function drainOutbox(
  env: Env,
  ctx: Ctx,
  handle: (event: OutboxEvent) => Promise<void>,
): Promise<{ drained: number; failed: number }> {
  let drained = 0;
  let failed = 0;

  for (const event of await pendingEvents(env, ctx)) {
    const now = ctx.now();
    const attempts = event.attempts + 1;
    const retryAt = new Date(now + retryDelay(attempts)).toISOString();
    const claimed = await env.CATALOG.prepare(
      `UPDATE outbox SET attempts = ?, retry_at = ?
        WHERE id = ? AND published_at IS NULL AND (retry_at IS NULL OR retry_at <= ?)`,
    ).bind(attempts, retryAt, event.id, new Date(now).toISOString()).run();
    // Somebody else's claim or publication landed between the read and this write. Theirs, not a failure.
    if ((claimed.meta.changes ?? 0) === 0) continue;

    try {
      await handle(event);
    } catch (error) {
      // Left unpublished deliberately: advancing the flag on a failed handler loses the event silently, the
      // failure §24 exists to prevent. The claim above already recorded the attempt and when to retry, which is
      // what `doctor` reads; the log carries the reason, at each doubling of `attempts` so a permanent failure
      // writes a line per doubling rather than one per retry.
      failed += 1;
      if ((attempts & (attempts - 1)) === 0) {
        await log(env, ctx, {
          level: "error",
          event: "outbox.handler_failed",
          message: (error as Error).message.split("\n")[0] ?? "unknown",
          orgId: event.orgId,
          detail: { eventId: event.id, topic: event.topic, attempts, retryAt },
        });
      }
      continue;
    }

    // `retry_at` cleared because nothing is owed on a published row, and a NULL costs no bytes on a row kept.
    await env.CATALOG.prepare("UPDATE outbox SET published_at = ?, retry_at = NULL WHERE id = ?")
      .bind(new Date(ctx.now()).toISOString(), event.id).run();
    drained += 1;
  }

  return { drained, failed };
}

/**
 * The Durable Object that owns the sweep. One instance per Node: the outbox is a single ordered resource, so
 * serialising its drain is the point rather than a limitation. The platform runs one `alarm()` at a time per
 * object, which is what makes it the only publisher.
 */
export class OutboxSweeper extends DurableObject<Env> {
  /**
   * Wakes the sweeper now: called on accepting a message, on sealing a send, on serving the page, and by the
   * cron backstop. Arming repeatedly costs one alarm write at most, since an alarm already due stays.
   */
  async schedule(): Promise<void> {
    const { createSystemCtx } = await import("@mailda/runtime");
    await this.wakeBy(createSystemCtx().now());
  }

  /**
   * Sets the alarm to `at` unless one is already set earlier: the earlier of two wakes is the one with work.
   *
   * This is also what keeps an arrival during a pass from being lost. While `alarm()` runs, `getAlarm()` answers
   * null unless something set an alarm since the handler started, so an acceptance that arrives mid-pass sets
   * one for now, and the pass's own re-arm below, going through here, keeps it rather than overwriting it with
   * a later wake. A plain `setAlarm` there would have dropped that message's wake.
   */
  private async wakeBy(at: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || at < existing) await this.ctx.storage.setAlarm(at);
  }

  override async alarm(): Promise<void> {
    const { createSystemCtx } = await import("@mailda/runtime");
    const clock = createSystemCtx();
    // The consumer (#25). An unregistered topic throws, which leaves its event unpublished rather than silently
    // marked done, so a topic added without deciding what consumes it shows up in `doctor` as a stalled outbox.
    const { dispatch } = await import("./pipeline.ts");
    await drainOutbox(this.env, clock, (event) => dispatch(this.env, clock, event));

    // Outbound too (ADR 39). The hold window closes on a wall clock, so a Node that was asleep when it expired
    // still sends: the same alarm machinery #9 built for inbound publication, rather than a second scheduler.
    let outboundNext: number | null = null;
    let orgId: string | null = null;
    try {
      const { dispatchDue, nextDispatchAt } = await import("./outbound/dispatch.ts");
      const claimed = await this.env.CATALOG.prepare(
        "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
      ).first<{ org_id: string }>();
      orgId = claimed?.org_id ?? null;
      if (orgId !== null) {
        await dispatchDue(this.env, clock, orgId);
        // **After** the sweep, not before: what is still waiting once this pass has done what it can is the
        // thing the next alarm is for. Asked before, a send dispatched in this very pass would have re-armed
        // the alarm to chase itself.
        outboundNext = await nextDispatchAt(this.env, clock, orgId);
      }
    } catch (error) {
      // A dispatch failure must not stop the inbound re-arm below. Every send stays in a state that describes
      // it, and the cron's outbound sweep tries again within the minute; logged under the event that sweep
      // uses for the same failure, so one search finds both.
      await log(this.env, clock, {
        level: "error",
        event: "outbound.sweep_failed",
        message: (error as Error).message.split("\n")[0] ?? "unknown",
        orgId,
        detail: { via: "alarm" },
      });
    }

    /*
     * Re-arm while work remains, so a backlog drains rather than waiting for the next write.
     *
     * Two questions, because the alarm is one instant and the work has two clocks. Inbound: `nextDue`, which is
     * now while anything is claimable (a backlog past this pass's 25, an arrival during it) and otherwise the
     * earliest backoff. Outbound: the next hold window to close. The alarm used to consult the inbound outbox
     * alone, so a Node with nothing arriving let its alarm lapse while a sealed send sat in its hold window, and
     * the mail left when somebody happened to load a page. `nextWake` picks between them, and says why neither
     * can spin.
     */
    const next = nextWake(await nextDue(this.env), outboundNext, clock.now());
    if (next !== null) await this.wakeBy(next);
  }
}
