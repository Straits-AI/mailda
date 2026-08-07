import type { Ctx } from "@mailda/runtime";

/**
 * Provider events become per-recipient delivery state (Layer 2's proof line).
 *
 * ## Why a queue and not a DSN parser
 *
 * A Node cannot receive its own bounces. The `cf-bounce` MX points at Cloudflare and its records are
 * service-managed for the lifetime of the domain configuration, so there is no delivery-status message
 * arriving anywhere a Worker can read (receipt: `cloudflare-email-sending.md`, corrected — it previously
 * asserted the opposite, and that sentence would have produced an RFC 3464 parser that could never fire).
 *
 * The channel that exists is Queues event subscriptions on source `email.sending`, and it is better:
 * Cloudflare emits **one event per recipient**, so per-recipient outcome is observable without splitting
 * submission per recipient (receipt: `email-sending-events.md`).
 *
 * ## Attribution is a key, and that was measured rather than assumed
 *
 * `payload.messageId` is byte-identical to what `env.EMAIL.send()` returned — angle brackets included.
 * Every documented example shows an opaque `0101018f7d0c4d9a-msg-bounced`, which is evidently
 * illustrative; the real value is the RFC-5322-shaped id this Node already stores as
 * `send_manifests.transport_message_id`. So events join to manifests by key, and the weaker fallback the
 * design was prepared for — sender + recipient + subject inside a time window, which cannot tell two
 * identical-subject sends apart — is not needed. **The brackets are part of the value; stripping them
 * breaks the join.**
 *
 * ## Nothing is discarded, including what cannot be attributed
 *
 * An event whose message id matches no manifest is stored with a NULL `manifest_id` rather than dropped.
 * A bounce nobody can attribute is still a bounce, and dropping it turns a fact into silence — which is
 * the failure this whole layer exists to remove. `sre_unattributed` indexes exactly those, because they
 * are the ones a person has to go and look at.
 */

/** What Cloudflare publishes. Only the fields this Node reads are named; the rest is kept verbatim. */
export interface SendingEvent {
  type: string;
  payload?: {
    eventId?: string;
    messageId?: string;
    recipient?: string;
    sender?: string;
    subject?: string;
    terminal?: boolean;
    delivery?: { status?: string; smtpStatusCode?: string; smtpResponse?: string };
    bounce?: { type?: string; classification?: string; reason?: string };
  };
}

/**
 * Event type to the word this Node will show a person.
 *
 * `message.delivered` becomes **accepted**, and that is a deliberate departure from the reflex that §5C
 * forbids representing success. §5C forbids claiming an outcome *nobody observed*; here the receiving mail
 * server returned 250 and Cloudflare reports the code. That is what "accepted" means in mail, it is
 * strictly stronger than `handed_over` — which only says Cloudflare took the bytes — and it is the
 * ladder's own first word. Refusing to record an observation is as dishonest as inventing one.
 *
 * What it must never be called is *delivered to a person*. Nothing in the payload knows whether a human
 * saw it.
 *
 * `failed` and `rejected` keep their own words rather than collapsing into `bounced`. A bounce is the
 * receiving server refusing; an internal error is not, and telling a user their recipient bounced when
 * Cloudflare had an internal problem is a false statement about somebody else's mail server.
 *
 * `complained` sets **no** delivery state: it is a fact about reputation, not about arrival, and the
 * message did arrive. The event is still stored.
 */
const DELIVERY_STATE: Record<string, string | null> = {
  "cf.email.sending.message.delivered": "accepted",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.deferred": "deferred",
  "cf.email.sending.message.complained": null,
};

/**
 * States a later event may overwrite.
 *
 * Queues deliver at least once and in no guaranteed order, so a `deferred` event can arrive *after* the
 * `bounced` that superseded it. Without this, a retry of an old deferral would erase a terminal outcome
 * and the Node would report "still trying" about a message that is definitively dead.
 *
 * NULL is here because unobserved is not an outcome. `deferred` is here because it is explicitly
 * non-terminal. Nothing else is: a terminal state, once observed, is the answer.
 */
const OVERWRITABLE: ReadonlySet<string | null> = new Set([null, "deferred"]);

export interface EventOutcome {
  eventId: string;
  /** False when this exact event was already applied — Queues delivers at least once. */
  applied: boolean;
  /** Null when no manifest matched. Stored anyway; see the header. */
  manifestId: string | null;
  deliveryState: string | null;
}

/**
 * Applies one event. Idempotent, and safe to call for an event that matches nothing.
 *
 * Never throws for data reasons — a malformed event must not poison a batch, because a queue retries the
 * whole batch and one bad message would block every good one behind it. It throws only if the database is
 * unreachable, which is a condition a retry can actually fix.
 */
export async function applySendingEvent(
  env: Env,
  ctx: Ctx,
  orgId: string,
  event: SendingEvent,
): Promise<EventOutcome> {
  const payload = event.payload ?? {};
  // No eventId means no idempotency key, so a redelivery would apply twice. Synthesising one from the
  // content would be worse: two genuinely different events could collide and one would vanish.
  const eventId = payload.eventId ?? null;
  const recipient = payload.recipient ?? null;
  const transportMessageId = payload.messageId ?? null;

  if (eventId === null || recipient === null) {
    return { eventId: eventId ?? "(none)", applied: false, manifestId: null, deliveryState: null };
  }

  const at = new Date(ctx.now()).toISOString();
  const deliveryState = event.type in DELIVERY_STATE ? DELIVERY_STATE[event.type]! : null;

  // The join. `transport_message_id` is stored with its angle brackets and the event carries them too, so
  // this is an equality match on a value neither side reformats.
  const manifest = transportMessageId === null
    ? null
    : await env.CATALOG.prepare(
        "SELECT id FROM send_manifests WHERE org_id = ? AND transport_message_id = ? LIMIT 1",
      ).bind(orgId, transportMessageId).first<{ id: string }>();

  const manifestId = manifest?.id ?? null;

  // The event row is the idempotency gate: `event_id` is the primary key, so a redelivery loses here.
  // Same shape as the audit chain and the inbound receipt — the conflict *is* the signal (#9).
  const inserted = await env.CATALOG.prepare(
    `INSERT OR IGNORE INTO send_recipient_events
       (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload, received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(eventId, orgId, manifestId, recipient, event.type, transportMessageId,
      payload.terminal === true ? 1 : 0, JSON.stringify(event), at)
    .run();

  if ((inserted.meta.changes ?? 0) === 0) {
    return { eventId, applied: false, manifestId, deliveryState };
  }

  if (manifestId !== null && deliveryState !== null) {
    // Guarded so an out-of-order redelivery cannot demote a terminal outcome back to "still trying".
    // Expressed in SQL rather than read-then-write, because two events for the same recipient can be in
    // flight at once and a check in JavaScript would be a race.
    const overwritable = [...OVERWRITABLE].filter((s): s is string => s !== null);
    await env.CATALOG.prepare(
      `UPDATE send_recipients
          SET delivery_state = ?, delivery_state_at = ?, bounce_type = ?, last_error = ?, last_event_id = ?
        WHERE org_id = ? AND manifest_id = ? AND lower(address) = lower(?)
          AND (delivery_state IS NULL OR delivery_state IN (${overwritable.map(() => "?").join(", ")}))`,
    )
      .bind(
        deliveryState, at,
        payload.bounce?.type ?? null,
        // The provider's own words, not a paraphrase: a paraphrase of "550 5.1.1 User unknown" is a guess
        // about somebody else's mail server.
        payload.bounce?.reason ?? payload.delivery?.smtpResponse ?? null,
        eventId,
        orgId, manifestId, recipient, ...overwritable,
      )
      .run();
  }

  return { eventId, applied: true, manifestId, deliveryState };
}

/** The org this Node belongs to. A Node has exactly one; events carry no organisation of their own. */
export async function claimedOrg(env: Env): Promise<string | null> {
  const row = await env.CATALOG.prepare(
    "SELECT org_id FROM node_claim WHERE claimed_at IS NOT NULL LIMIT 1",
  ).first<{ org_id: string }>().catch(() => null);
  return row?.org_id ?? null;
}
