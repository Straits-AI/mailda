import type { Ctx } from "@mailda/runtime";

import { log } from "./audit.ts";

/**
 * Kept forwards (ADR 47, 3 October 2026): an address taken over from an Email Routing forward rule whose destination
 * keeps receiving each message, forwarded by this Worker with `message.forward()` after the message is stored.
 *
 * Measured on mailda.site on 2 October 2026 (`docs/receipts/email-worker-forward.md`): forward() works after
 * `message.raw` has been read to the end, up to a 24,400,483-byte message; the copy keeps the original From, body
 * and Message-ID (the sender's DKIM still passes); only `X-` headers survive its headers argument; a destination
 * that is not verified throws at once, "destination address not verified"; and a handler that catches that and
 * returns leaves the sender with nothing, no bounce. So the sender is never told about a failed forward, and this
 * Node must be: every call leaves the row `acceptInbound` wrote, settled here.
 */

/** The header that marks a message this Node forwarded, so one that comes back is stored and not forwarded again. */
export const FORWARDED_BY_HEADER = "X-Mailda-Forwarded-By";

/**
 * Whether `value` (the inbound message's `X-Mailda-Forwarded-By`, as `Headers.get` joins repeats) carries this Node's
 * marker. A substring test: the marker is this Node's claim id, a ULID no other Node shares, and how Cloudflare
 * joins a repeated header was never measured.
 */
export function forwardedBy(value: string | null, marker: string): boolean {
  return value !== null && marker !== "" && value.includes(marker);
}

/**
 * The call and its settlement. Called only on `accepted`, after the receipt and its attempt row committed, with the
 * destination the address row held (organization state, never anything from the message or a request).
 *
 * It never throws and never rejects the message: the message is stored, and a forward that failed is shown on
 * People and counted by doctor, not bounced, because the sender's message did arrive. A settlement that cannot be
 * written is logged, and the row it leaves is `outcome_unknown`, which doctor counts, so the failure stays visible.
 */
export async function forwardKept(
  env: Env, ctx: Ctx, message: Pick<ForwardableEmailMessage, "forward">,
  orgId: string, receiptId: string, destination: string, marker: string,
): Promise<void> {
  let settled: { state: "handed_over" | "refused"; error: string | null };
  try {
    await message.forward(destination, new Headers({ [FORWARDED_BY_HEADER]: marker }));
    settled = { state: "handed_over", error: null };
  } catch (error) {
    // Cloudflare's words, verbatim: the measured ones are "destination address not verified" and "message already
    // forwarded to this destination".
    settled = { state: "refused", error: error instanceof Error ? error.message : String(error) };
  }
  await env.CATALOG.prepare(
    "UPDATE kept_forward_attempts SET state = ?, error = ?, settled_at = ? WHERE receipt_id = ? AND state = 'outcome_unknown'",
  ).bind(settled.state, settled.error, new Date(ctx.now()).toISOString(), receiptId).run()
    .catch(async (unrecorded: Error) => await log(env, ctx, {
      level: "error", event: "kept_forward.unrecorded", orgId, message: unrecorded.message,
      detail: { receiptId, state: settled.state },
    }));
}

/** One address keeping a forward, and what its latest attempt says. The People and Setup line. */
export interface KeptForward {
  address: string;
  mailboxId: string;
  to: string;
  /** The latest read of the account's destination list: null when none has answered since the forward was kept. */
  verified: "verified" | "waiting" | "absent" | null;
  checkedAt: string | null;
  /** The latest attempt, or null when nothing has arrived since. */
  last: { state: "outcome_unknown" | "handed_over" | "refused" | "withheld"; at: string; error: string | null } | null;
  /** When a forward was last handed over, which may be older than `last`. */
  lastHandedOverAt: string | null;
}

/** Every address on this Node keeping a forward. Reads D1 only, no Cloudflare call. */
export async function keptForwards(env: Env, orgId: string): Promise<KeptForward[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT a.address, a.mailbox_id, a.kept_forward_to, a.kept_forward_verified, a.kept_forward_checked_at,
            l.state, l.attempted_at, l.error,
            (SELECT MAX(h.attempted_at) FROM kept_forward_attempts h
              WHERE h.org_id = a.org_id AND h.address = a.address AND h.state = 'handed_over') AS handed_over_at
       FROM addresses a
       LEFT JOIN kept_forward_attempts l ON l.receipt_id = (
         SELECT x.receipt_id FROM kept_forward_attempts x WHERE x.org_id = a.org_id AND x.address = a.address
          ORDER BY x.attempted_at DESC, x.receipt_id DESC LIMIT 1)
      WHERE a.org_id = ? AND a.kept_forward_to IS NOT NULL
      ORDER BY a.address`,
  ).bind(orgId).all<{
    address: string; mailbox_id: string; kept_forward_to: string; kept_forward_verified: KeptForward["verified"];
    kept_forward_checked_at: string | null; state: NonNullable<KeptForward["last"]>["state"] | null;
    attempted_at: string | null; error: string | null; handed_over_at: string | null;
  }>();
  return results.map((row) => ({
    address: row.address, mailboxId: row.mailbox_id, to: row.kept_forward_to,
    verified: row.kept_forward_verified, checkedAt: row.kept_forward_checked_at,
    last: row.state === null || row.attempted_at === null ? null : { state: row.state, at: row.attempted_at, error: row.error },
    lastHandedOverAt: row.handed_over_at,
  }));
}
