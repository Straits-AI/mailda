import type { Ctx } from "@mailda/runtime";

import { putEvidence } from "../evidence-store.ts";
import { renderRfc822 } from "./manifest.ts";
import { cloudflareTransport, type SubmitOutcome, type TransportAdapter } from "./transport.ts";

/**
 * Dispatch: the hold window, the state machine, and the retry rule (ADR 39, ADR 40).
 *
 * ## Seven states, and two of them are forbidden
 *
 *   held             sealed, undispatched, still cancellable
 *   cancelled        stopped during the hold window
 *   throttled        rate-limited — provably never left
 *   refused          rejected at the API boundary — provably never left
 *   suppressed       on the suppression list — will never arrive, and that is knowable now
 *   handed_over      the transport accepted it; whether it arrived is unknown
 *   outcome_unknown  we do not know whether it left
 *
 * `sent` and `delivered` do not exist here and must never be added. §5C forbids claiming an outcome
 * nobody observed, and the transport reports acceptance rather than arrival.
 *
 * ## Retry is permitted only where the send provably never left
 *
 * ADR 9's effect key — which ADR 35 made the manifest id — prevents Mailda issuing a duplicate
 * *send*. It cannot prevent a duplicate *delivery*: if the transport accepted the first attempt and
 * the acknowledgement was lost, a retry produces a second message the recipient keeps forever, and
 * **Cloudflare offers no idempotency key** to deduplicate against.
 *
 * So `throttled` and `refused`-retryable are retried automatically, because both are boundary
 * rejections. `outcome_unknown` is **never** retried by the system; only a human, and only after being
 * told a duplicate is possible.
 */

export type SendState =
  | "held" | "cancelled" | "throttled" | "refused" | "suppressed" | "handed_over" | "outcome_unknown";

/** Which states the system may retry on its own. Everything absent here needs a human, or nothing. */
const AUTO_RETRYABLE: ReadonlySet<SendState> = new Set<SendState>(["throttled"]);

export interface DispatchResult {
  manifestId: string;
  state: SendState;
  detail: string;
}

/**
 * Cancels a held manifest.
 *
 * Conditional on still being `held`, which is what makes the race safe without a transaction D1 does
 * not offer (#10): a cancel arriving as the dispatcher releases loses at the database rather than
 * producing a cancelled-but-sent message.
 */
export async function cancelSend(
  env: Env,
  ctx: Ctx,
  orgId: string,
  manifestId: string,
): Promise<{ cancelled: boolean; reason?: string }> {
  const result = await env.CATALOG.prepare(
    `UPDATE send_manifests SET state = 'cancelled', state_at = ?
      WHERE id = ? AND org_id = ? AND state = 'held'`,
  )
    .bind(new Date(ctx.now()).toISOString(), manifestId, orgId)
    .run();

  if ((result.meta.changes ?? 0) > 0) return { cancelled: true };

  const current = await env.CATALOG.prepare(
    "SELECT state FROM send_manifests WHERE id = ? AND org_id = ? LIMIT 1",
  )
    .bind(manifestId, orgId)
    .first<{ state: SendState }>();

  if (current === null) return { cancelled: false, reason: "no such send" };
  return {
    cancelled: false,
    // Honest about *why* it could not be stopped. "Cancel failed" would leave a user unsure whether
    // their message went out, which is the state §5C exists to prevent.
    reason:
      current.state === "handed_over"
        ? "This message was already handed to the mail service and cannot be recalled."
        : `This message is no longer held; it is ${current.state}.`,
  };
}

/**
 * Releases everything whose hold window has closed, plus anything automatically retryable.
 *
 * Called by the outbox sweeper's alarm, so a Node that was asleep when a window expired still sends —
 * the same machinery #9 built for inbound publication.
 */
export async function dispatchDue(
  env: Env,
  ctx: Ctx,
  orgId: string,
  transport: TransportAdapter = cloudflareTransport,
  limit = 20,
): Promise<DispatchResult[]> {
  const now = new Date(ctx.now()).toISOString();

  const due = await env.CATALOG.prepare(
    `SELECT id FROM send_manifests
      WHERE org_id = ? AND ((state = 'held' AND release_at <= ?) OR state = 'throttled')
      ORDER BY release_at LIMIT ?`,
  )
    .bind(orgId, now, limit)
    .all<{ id: string }>();

  const results: DispatchResult[] = [];
  for (const row of due.results) {
    results.push(await dispatchOne(env, ctx, orgId, row.id, transport));
  }
  return results;
}

/**
 * One manifest. Claims it first, so two concurrent dispatchers cannot both submit it — the same
 * conditional-update pattern the claim flow and the ingress receipt use.
 */
export async function dispatchOne(
  env: Env,
  ctx: Ctx,
  orgId: string,
  manifestId: string,
  transport: TransportAdapter = cloudflareTransport,
): Promise<DispatchResult> {
  const at = new Date(ctx.now()).toISOString();

  // Claim: only a held-and-due or auto-retryable manifest may move. A concurrent cancel wins here.
  const claimed = await env.CATALOG.prepare(
    `UPDATE send_manifests
        SET state = 'outcome_unknown', state_at = ?, attempts = attempts + 1
      WHERE id = ? AND org_id = ?
        AND ((state = 'held' AND release_at <= ?) OR state = 'throttled')`,
  )
    .bind(at, manifestId, orgId, at)
    .run();

  if ((claimed.meta.changes ?? 0) === 0) {
    const current = await env.CATALOG.prepare(
      "SELECT state FROM send_manifests WHERE id = ? AND org_id = ? LIMIT 1",
    )
      .bind(manifestId, orgId)
      .first<{ state: SendState }>();
    return {
      manifestId,
      state: current?.state ?? "cancelled",
      detail: "Not due, or already moved by another dispatcher.",
    };
  }

  // Claimed as `outcome_unknown` **deliberately**, before submitting. If this invocation dies between
  // the submit and the state write, the manifest is left in the one state that forbids automatic
  // retry — which is exactly right, because that is precisely the case where we do not know whether
  // it left. Claiming it as anything more optimistic would invite the duplicate ADR 40 cannot prevent.

  const manifest = await env.CATALOG.prepare(
    `SELECT envelope_from, envelope_to, envelope_cc, envelope_bcc, subject, fidelity,
            body_normalized_key
       FROM send_manifests WHERE id = ? LIMIT 1`,
  )
    .bind(manifestId)
    .first<Record<string, string | null>>();

  if (manifest === null) {
    return { manifestId, state: "outcome_unknown", detail: "The manifest vanished mid-dispatch." };
  }

  const fidelity = manifest.fidelity as "authored" | "reconstructed";
  const to = JSON.parse(manifest.envelope_to ?? "[]") as string[];
  const cc = manifest.envelope_cc == null ? undefined : (JSON.parse(manifest.envelope_cc) as string[]);
  const bcc = manifest.envelope_bcc == null ? undefined : (JSON.parse(manifest.envelope_bcc) as string[]);

  let outcome: SubmitOutcome;
  if (fidelity === "authored") {
    const rendered = await renderRfc822(env, manifestId);
    // §12 invariant 2: a materialized provider-submission representation *is* immutable evidence.
    // Stored before submitting, so the record exists even if the submission's outcome never does.
    const stored = await putEvidence(env, `${orgId}/sent/${manifestId}/submitted.eml`, rendered.raw);
    await env.CATALOG.prepare(
      "UPDATE send_manifests SET submitted_key = ?, submitted_sha256 = ? WHERE id = ?",
    )
      .bind(stored.blobKey, stored.plaintextSha256, manifestId)
      .run();

    outcome = await transport.submit(
      env,
      { from: manifest.envelope_from!, to, cc, bcc, subject: manifest.subject!, raw: rendered.raw },
      "authored",
    );
  } else {
    outcome = await transport.submit(
      env,
      { from: manifest.envelope_from!, to, cc, bcc, subject: manifest.subject!, text: "" },
      "reconstructed",
    );
  }

  return applyOutcome(env, ctx, orgId, manifestId, outcome);
}

async function applyOutcome(
  env: Env,
  ctx: Ctx,
  orgId: string,
  manifestId: string,
  outcome: SubmitOutcome,
): Promise<DispatchResult> {
  const at = new Date(ctx.now()).toISOString();
  const day = at.slice(0, 10);

  const statements = [];
  let state: SendState;
  let detail: string;

  switch (outcome.kind) {
    case "handed_over":
      state = "handed_over";
      detail = "The mail service accepted this message. Whether it arrived is not something this Node can know.";
      statements.push(
        env.CATALOG.prepare(
          "UPDATE send_manifests SET state = 'handed_over', state_at = ?, transport_message_id = ?, last_error = NULL WHERE id = ?",
        ).bind(at, outcome.transportMessageId, manifestId),
        // ADR 34: the daily count is how an unpublished limit becomes an observed one.
        env.CATALOG.prepare(
          `INSERT INTO send_counters (org_id, day, handed_over) VALUES (?,?,1)
           ON CONFLICT (org_id, day) DO UPDATE SET handed_over = handed_over + 1`,
        ).bind(orgId, day),
      );
      break;

    case "throttled":
      state = "throttled";
      detail = "Rate-limited by the mail service. This message has not left and will be retried.";
      statements.push(
        env.CATALOG.prepare(
          "UPDATE send_manifests SET state = 'throttled', state_at = ?, last_error = ? WHERE id = ?",
        ).bind(at, outcome.reason, manifestId),
        // The count at which throttling first happened **is** the account's daily limit, measured.
        // Cloudflare publishes no number, so this is the only form of it that can exist (ADR 34).
        env.CATALOG.prepare(
          `INSERT INTO send_counters (org_id, day, handed_over, first_throttled_at, throttled_at_count)
             VALUES (?,?,0,?,0)
           ON CONFLICT (org_id, day) DO UPDATE SET
             first_throttled_at = COALESCE(first_throttled_at, ?),
             throttled_at_count = COALESCE(throttled_at_count, handed_over)`,
        ).bind(orgId, day, at, at),
      );
      break;

    case "refused":
      state = "refused";
      detail = outcome.reason;
      statements.push(
        env.CATALOG.prepare(
          "UPDATE send_manifests SET state = 'refused', state_at = ?, last_error = ? WHERE id = ?",
        ).bind(at, outcome.reason, manifestId),
      );
      break;

    case "suppressed":
      state = "suppressed";
      detail = "The mail service will never deliver to this recipient. This is not a bounce and not an unknown outcome.";
      statements.push(
        env.CATALOG.prepare(
          "UPDATE send_manifests SET state = 'suppressed', state_at = ?, last_error = ? WHERE id = ?",
        ).bind(at, outcome.reason, manifestId),
      );
      break;

    default:
      state = "outcome_unknown";
      detail =
        "This Node does not know whether the message left. It will not retry automatically, because " +
        "a retry could deliver a second copy that cannot be recalled.";
      statements.push(
        env.CATALOG.prepare(
          "UPDATE send_manifests SET state = 'outcome_unknown', state_at = ?, last_error = ? WHERE id = ?",
        ).bind(at, outcome.reason, manifestId),
      );
  }

  await env.CATALOG.batch(statements);
  return { manifestId, state, detail };
}

/** Whether the system may retry this state on its own. A human may always ask; the system may not. */
export function isAutoRetryable(state: SendState): boolean {
  return AUTO_RETRYABLE.has(state);
}

/**
 * The observed daily limit, for `doctor` and the UI.
 *
 * `throttledAtCount` is the measurement ADR 34 promised: Cloudflare publishes no daily quota, so the
 * number of sends this account completed before it was first throttled is the only version of that
 * limit which exists.
 */
export async function dailySendState(
  env: Env,
  ctx: Ctx,
  orgId: string,
): Promise<{ day: string; handedOver: number; throttledAtCount: number | null; firstThrottledAt: string | null }> {
  const day = new Date(ctx.now()).toISOString().slice(0, 10);
  const row = await env.CATALOG.prepare(
    "SELECT handed_over, throttled_at_count, first_throttled_at FROM send_counters WHERE org_id = ? AND day = ?",
  )
    .bind(orgId, day)
    .first<{ handed_over: number; throttled_at_count: number | null; first_throttled_at: string | null }>();

  return {
    day,
    handedOver: row?.handed_over ?? 0,
    throttledAtCount: row?.throttled_at_count ?? null,
    firstThrottledAt: row?.first_throttled_at ?? null,
  };
}
