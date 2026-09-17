import type { Ctx } from "@mailda/runtime";

import { assertAdmin } from "./access.ts";
import { auditedBatch } from "./audit.ts";
import { unprocessable } from "./errors.ts";

/**
 * Recipients this Node will not send to again, derived from what the provider said (0058).
 *
 * ## Derived, not kept
 *
 * `send_recipient_events` holds every `email.sending` event verbatim (`email-sending-events.md`). An
 * address whose most recent terminal word was a **hard** bounce or a **complaint** is suppressed; a soft
 * bounce is retries exhausted on an address that exists, and suppressing it loses mail (0010's own note).
 * Nothing writes a suppression row, so nothing can be out of step with the events.
 *
 * ## One exception, and it is an act
 *
 * `suppression_lifts` is an administrator saying the address is good again, with a reason, audited. The
 * lift covers events **before** it: an address that bounces again after somebody vouched for it is
 * suppressed again, by the same derivation, and the trail shows both.
 *
 * ## Consulted at the seal, and refused there
 *
 * `sealManifest` asks once for every recipient of a composition and refuses the whole send if any is
 * suppressed — the refusal names each address and why, and the fix is to drop it or lift it. Not a
 * silent drop: Cloudflare's own `drop_suppressed_recipients` exists and whether it keeps the same list is
 * unmeasured; a Node that removed a recipient without saying so would be sending a different message from
 * the one the author sealed.
 *
 * It costs the seal **nothing**: the question rides as one more sub-select in the breaker statement
 * `sealManifest` already issues (`breakers.ts`), because `butler-step-cost.md` has the seal at its bound
 * with zero headroom and says what to do when the next operation arrives — make it free, or re-measure and
 * redo the loop arithmetic. The lift path and the listing issue their own statement; they are not the seal.
 */
export type SuppressionCause = "hard_bounce" | "complaint";

export interface Suppression {
  address: string;
  cause: SuppressionCause;
  /** The provider's own words, when it gave any. */
  detail: string | null;
  observedAt: string;
  eventId: string;
}

/**
 * The derivation, as a sub-select the breaker statement embeds: a JSON array of the suppressed addresses among
 * `n` bound recipients, with the cause. `first` is the 1-based index of the first recipient placeholder, and
 * the org is `?1` — the breaker statement's own convention.
 */
export function suppressedSubselect(first: number, n: number): string {
  const placeholders = Array.from({ length: n }, (_, i) => `?${first + i}`).join(", ");
  return `(SELECT json_group_array(json_object('address', lower(e.recipient), 'type', e.event_type,
             'payload', e.payload, 'at', e.received_at, 'id', e.event_id))
      FROM send_recipient_events e
     WHERE e.org_id = ?1 AND lower(e.recipient) IN (${placeholders})
       AND (e.event_type = 'cf.email.sending.message.complained'
            OR (e.event_type = 'cf.email.sending.message.bounced'
                AND json_extract(e.payload, '$.payload.bounce.type') = 'hard'))
       AND NOT EXISTS (
         SELECT 1 FROM suppression_lifts l
          WHERE l.org_id = e.org_id AND l.address = lower(e.recipient) AND l.lifted_at >= e.received_at)
     ORDER BY e.received_at DESC)`;
}

/** Reads the sub-select's JSON back into suppressions, newest event per address. */
export function suppressionsFromJson(json: string | null): Suppression[] {
  if (json === null) return [];
  const rows = JSON.parse(json) as Array<{ address: string; type: string; payload: string; at: string; id: string }>;
  const seen = new Map<string, Suppression>();
  for (const row of rows) {
    const one = rowToSuppression({ address: row.address, event_type: row.type, payload: row.payload, received_at: row.at, event_id: row.id });
    if (!seen.has(one.address)) seen.set(one.address, one);
  }
  return [...seen.values()];
}

const CAUSE_SQL = `
  SELECT e.recipient AS address, e.event_type, e.payload, e.received_at, e.event_id
    FROM send_recipient_events e
   WHERE e.org_id = ?1
     AND (e.event_type = 'cf.email.sending.message.complained'
          OR (e.event_type = 'cf.email.sending.message.bounced'
              AND json_extract(e.payload, '$.payload.bounce.type') = 'hard'))
     AND NOT EXISTS (
       SELECT 1 FROM suppression_lifts l
        WHERE l.org_id = e.org_id AND l.address = lower(e.recipient) AND l.lifted_at >= e.received_at)`;

function rowToSuppression(row: { address: string; event_type: string; payload: string; received_at: string; event_id: string }): Suppression {
  let detail: string | null = null;
  try {
    // `payload` is the whole event as the consumer stored it (receipt: email-sending-events.md).
    const data = (JSON.parse(row.payload) as { payload?: { bounce?: { reason?: string }; complaint?: { feedbackType?: string } } }).payload;
    detail = data?.bounce?.reason ?? data?.complaint?.feedbackType ?? null;
  } catch {
    // The payload is stored verbatim from the provider; an unreadable one is still an event that happened.
  }
  return {
    address: row.address.toLowerCase(),
    cause: row.event_type.endsWith(".complained") ? "complaint" : "hard_bounce",
    detail, observedAt: row.received_at, eventId: row.event_id,
  };
}

/** Which of `addresses` are suppressed right now, one statement. Case-insensitive on the address. */
export async function suppressedAmong(env: Env, orgId: string, addresses: readonly string[]): Promise<Suppression[]> {
  if (addresses.length === 0) return [];
  const wanted = [...new Set(addresses.map((one) => one.toLowerCase()))];
  const rows = await env.CATALOG.prepare(
    `${CAUSE_SQL} AND lower(e.recipient) IN (${wanted.map(() => "?").join(", ")}) ORDER BY e.received_at DESC`,
  ).bind(orgId, ...wanted).all<{ address: string; event_type: string; payload: string; received_at: string; event_id: string }>();
  // Newest event per address: the one that decides.
  const seen = new Map<string, Suppression>();
  for (const row of rows.results) {
    const one = rowToSuppression(row);
    if (!seen.has(one.address)) seen.set(one.address, one);
  }
  return [...seen.values()];
}

/** Every suppressed address on this Node, newest first. Administrators only. */
export async function listSuppressions(env: Env, orgId: string, actorUserId: string): Promise<Suppression[]> {
  await assertAdmin(env, orgId, actorUserId);
  const rows = await env.CATALOG.prepare(`${CAUSE_SQL} ORDER BY e.received_at DESC LIMIT 500`)
    .bind(orgId).all<{ address: string; event_type: string; payload: string; received_at: string; event_id: string }>();
  const seen = new Map<string, Suppression>();
  for (const row of rows.results) {
    const one = rowToSuppression(row);
    if (!seen.has(one.address)) seen.set(one.address, one);
  }
  return [...seen.values()];
}

/** The refusal `sealManifest` throws. Names every address, so the author fixes the send once. */
export function recipientsSuppressed(found: readonly Suppression[]) {
  const named = found.map((one) =>
    `${one.address} (${one.cause === "complaint" ? "marked as spam" : "hard bounce"}`
    + `${one.detail === null ? "" : `: ${one.detail}`}, ${one.observedAt})`).join("; ");
  return unprocessable("E_RECIPIENT_SUPPRESSED", {
    what: `this Node will not send to ${named}`,
    why: "the provider's last word on each was a hard bounce or a complaint, and sending again to such an "
      + "address costs the domain's reputation for nothing",
    fix: "remove the address, or have an administrator lift the suppression (POST /api/suppressions/lift) "
      + "with a reason if the address is known to be good again",
  });
}

export async function liftSuppression(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, address: string, reason: string,
): Promise<{ lifted: true; address: string; liftId: string }> {
  await assertAdmin(env, orgId, actorUserId);
  const normalized = address.trim().toLowerCase();
  if (normalized === "" || !normalized.includes("@")) {
    throw unprocessable("E_NOT_AN_ADDRESS", {
      what: `"${address}" is not an address`, why: "a lift names one recipient", fix: "give the address as it was sent to",
    });
  }
  if (reason.trim() === "") {
    throw unprocessable("E_REASON_REQUIRED", {
      what: "no reason was given", why: "the next reader of the trail needs to know why this address was vouched for",
      fix: "say what changed — the mailbox was full, the complaint was a mis-click",
    });
  }
  const held = await suppressedAmong(env, orgId, [normalized]);
  if (held.length === 0) {
    throw unprocessable("E_NOT_SUPPRESSED", {
      what: `${normalized} is not suppressed`, why: "a lift of nothing would record an act that changed nothing",
      fix: "GET /api/suppressions lists what is",
    });
  }
  const liftId = ctx.id("spl");
  const at = new Date(ctx.now()).toISOString();
  await auditedBatch<never>(env, ctx, orgId, {
    action: "suppression.lifted", outcome: "ok", actorUserId, subject: normalized,
    detail: { liftId, reason: reason.trim(), cause: held[0]!.cause, eventId: held[0]!.eventId },
  }, (entry) => [
    entry,
    env.CATALOG.prepare(
      "INSERT INTO suppression_lifts (id, org_id, address, reason, lifted_by, lifted_at) VALUES (?,?,?,?,?,?)",
    ).bind(liftId, orgId, normalized, reason.trim(), actorUserId, at),
  ]);
  return { lifted: true, address: normalized, liftId };
}
