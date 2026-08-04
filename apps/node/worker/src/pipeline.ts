import type { Ctx } from "@mailda/runtime";

import type { OutboxEvent } from "./outbox.ts";

/**
 * The asynchronous processing pipeline (#25).
 *
 * §13 accepts a message synchronously and defers everything else — parsing, scanning, threading,
 * Butler events — to an outbox event. The outbox and its sweeper have existed since Layer 1; what
 * did not exist was anything that *consumes* the events, so the sweeper marked them published and
 * nothing happened. This is the consumer.
 *
 * ## Cloudflare Queues is not here yet, deliberately
 *
 * #9 decided the delivery mechanics — inline `waitUntil` enqueue with a Durable Object alarm as the
 * safety net — and assumed Cloudflare Queues as the transport. **Partially reversed:** the transport
 * is not needed yet, and adding it now would cost more than it buys.
 *
 * The outbox row already provides what Queues would: **the row is the durability**, and the sweeper
 * only marks it published after its handler returns, so a failing handler leaves the event pending
 * and the alarm retries it. That is at-least-once delivery with retry, which is the property that
 * matters. What Queues adds on top is *decoupling* — a handler that is slow or that fans out widely
 * should not hold the sweeper's alarm.
 *
 * So the trigger is explicit rather than a matter of taste: **Queues arrives when a handler needs to
 * be slow.** Content scanning, an LLM call, a webhook to a third party. Until one exists, a queue
 * would mean provisioning, a mandatory dead-letter queue nobody reads, and an explicit retention
 * setting (#9 established the 24-hour default deletes mail) — infrastructure for a pipeline with one
 * event type and no slow work in it. §22's amendment is recorded on the ticket.
 *
 * ## Every topic must be registered, including the ones with nothing to do
 *
 * An unregistered topic **throws**, which leaves its event unpublished and surfaces in `doctor` as a
 * stalled outbox. That is the whole point of the registry: adding a topic without deciding what
 * consumes it fails loudly rather than being silently marked done.
 *
 * A topic that genuinely needs no work at this layer says so *explicitly*, by registering
 * `nothingToDoYet`. The distinction between "handled" and "forgotten" is then visible in one place,
 * which is what makes it safe to add topics later.
 */

export type Handler = (env: Env, ctx: Ctx, event: OutboxEvent) => Promise<void>;

/**
 * Registered and intentionally inert.
 *
 * Named rather than `async () => {}` so the registry reads as a decision. Anything using this is
 * carrying a note about what will replace it.
 */
const nothingToDoYet: Handler = async () => {};

export const HANDLERS: Record<string, Handler> = {
  /**
   * A message was accepted and its evidence is stored (§13).
   *
   * Nothing consumes it yet. What will: parsing MIME into `messages` and `mailbox_items` so the
   * ledger reads from message metadata rather than from ingress receipts, threading, and the Butler
   * events at Layer 4. Those are Layer 2 work and each is a separate decision, so this stays
   * explicitly inert rather than growing a half-implementation nobody chose.
   */
  "mail.ingress.accepted": nothingToDoYet,
};

export interface DispatchOutcome {
  handled: number;
  unknown: string[];
}

/**
 * Dispatches one event. Throws on an unregistered topic, so the sweeper leaves it pending.
 *
 * Handlers must be **idempotent**. #9's model is at-least-once — the enqueue can succeed while the
 * published-flag write fails — so a handler will see the same event twice and must not care.
 */
export async function dispatch(env: Env, ctx: Ctx, event: OutboxEvent): Promise<void> {
  const handler = HANDLERS[event.topic];
  if (handler === undefined) {
    throw new Error(
      `E_NO_HANDLER  outbox topic ${event.topic} has no registered handler\n` +
        `  why      the event stays unpublished rather than being marked done, so nothing is lost — ` +
        `\`doctor\` reports it as a stalled outbox\n` +
        `  fix      register it in HANDLERS in pipeline.ts, using nothingToDoYet if it genuinely ` +
        `needs no processing at this layer`,
    );
  }
  await handler(env, ctx, event);
}

/** The topics this Node knows how to consume, for `doctor` and for a CLI. */
export function registeredTopics(): string[] {
  return Object.keys(HANDLERS);
}
