import type { Ctx } from "@mailda/runtime";

import { auditedBatch, log } from "../audit.ts";
import { stopClockForConversation } from "../response-clock.ts";
import { maySend } from "../authz-read.ts";
import { getEvidence, putEvidence } from "../evidence-store.ts";
import { renderRfc822 } from "./manifest.ts";
import { cloudflareTransport, type SubmitOutcome, type TransportAdapter } from "./transport.ts";

/**
 * Dispatch: the hold window, the state machine, and the retry rule (ADR 39, ADR 40).
 *
 * ## Seven states, and two of them are forbidden
 *
 *   held             sealed, undispatched, still cancellable
 *   cancelled        stopped during the hold window by a person
 *   withheld         the author's authority to send as this mailbox was withdrawn before hand-over
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
  | "held" | "cancelled" | "withheld" | "throttled" | "refused" | "suppressed"
  | "handed_over" | "outcome_unknown";

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
  // Conditional, so the record is conditional on the same predicate and in the same transaction.
  // The entry is placed *first* deliberately: the update clears `state = 'held'`, so an entry gated on
  // it and running afterwards would never insert, and a cancellation would go unrecorded.
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "send.cancelled", outcome: "ok", subject: manifestId,
      detail: { stoppedBeforeDispatch: true },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `UPDATE send_manifests SET state = 'cancelled', state_at = ?
          WHERE id = ? AND org_id = ? AND state = 'held'`,
      ).bind(new Date(ctx.now()).toISOString(), manifestId, orgId),
      // Recipients follow the manifest. Unconditional here because the batch only commits when the gate
      // above found the manifest still held, so this cannot cancel recipients of a send that went out.
      env.CATALOG.prepare(
        `UPDATE send_recipients SET submission_state = 'cancelled', submission_state_at = ?
          WHERE org_id = ? AND manifest_id = ?`,
      ).bind(new Date(ctx.now()).toISOString(), orgId, manifestId),
    ],
    {
      sql: "SELECT 1 FROM send_manifests WHERE id = ? AND org_id = ? AND state = 'held'",
      params: [manifestId, orgId],
    },
  );

  if ((results[1]?.meta.changes ?? 0) > 0) return { cancelled: true };

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
  /**
   * Restricts the sweep to these mailboxes. **Undefined means every mailbox in the organization**, which
   * is what the sweeper needs and what a request must never get by default.
   *
   * The distinction exists because there are two callers with different standing. `OutboxSweeper`'s alarm
   * has no principal — it is the Node acting on its own behalf, and a send it skipped would simply never
   * leave. `POST /api/sends/dispatch` has a principal, and org-wide was wrong there for a reason sharper
   * than disclosure: a held send past its `release_at` is *still* `held`, so it is still cancellable, and
   * forcing it out ends somebody else's window to stop their own mail.
   *
   * An empty array is not the same as undefined and is honoured as "nothing" — a caller who holds no
   * mailbox dispatches nothing, and that must not silently widen to everything.
   */
  mailboxIds?: readonly string[],
): Promise<DispatchResult[]> {
  const now = new Date(ctx.now()).toISOString();

  if (mailboxIds !== undefined && mailboxIds.length === 0) return [];
  const restriction = mailboxIds === undefined
    ? ""
    : ` AND mailbox_id IN (${mailboxIds.map(() => "?").join(", ")})`;

  const due = await env.CATALOG.prepare(
    `SELECT id FROM send_manifests
      WHERE org_id = ? AND ((state = 'held' AND release_at <= ?) OR state = 'throttled')${restriction}
      ORDER BY release_at LIMIT ?`,
  )
    .bind(orgId, now, ...(mailboxIds ?? []), limit)
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

  // Authority is re-read here, *before* the claim, and this is the window Layer 2 would otherwise leave
  // open. Sealing checks that the author may send as the mailbox; hand-over happens up to
  // `send.hold_window_default_seconds` later, from a sweeper alarm with no principal in scope. §7 and §28
  // require withdrawn authority to stop working immediately, and "immediately" has to include those
  // seconds — otherwise revoking someone mid-hold still sends their message.
  //
  // Before the claim rather than after, deliberately: the claim increments `attempts` and moves the
  // manifest to `outcome_unknown`, so checking afterwards would spend an attempt and park a
  // never-submitted message in the one state that means "we do not know whether it left". It did not
  // leave, and we do know. Blurring those is precisely what this layer must not do.
  const author = await env.CATALOG.prepare(
    "SELECT author_user_id, mailbox_id FROM send_manifests WHERE id = ? AND org_id = ? LIMIT 1",
  )
    .bind(manifestId, orgId)
    .first<{ author_user_id: string; mailbox_id: string }>();

  if (author !== null && !(await maySend(env, { orgId, userId: author.author_user_id }, author.mailbox_id))) {
    // Conditional on still being held, for the same reason cancellation is: a dispatcher that already
    // claimed this must not have its work overwritten.
    const { results } = await auditedBatch<never>(
      env, ctx, orgId,
      {
        action: "send.withheld", outcome: "refused", subject: manifestId,
        detail: { authorUserId: author.author_user_id, mailboxId: author.mailbox_id },
      },
      (entry) => [
        entry,
        env.CATALOG.prepare(
          `UPDATE send_manifests SET state = 'withheld', state_at = ?, last_error = ?
            WHERE id = ? AND org_id = ? AND ((state = 'held' AND release_at <= ?) OR state = 'throttled')`,
        ).bind(at, "The author's authority to send as this mailbox was withdrawn before hand-over.",
          manifestId, orgId, at),
        // The recipients follow, in the same transaction. A withheld send whose recipients still read
        // `held` would show a person a message that is simultaneously stopped and pending.
        env.CATALOG.prepare(
          `UPDATE send_recipients SET submission_state = 'withheld', submission_state_at = ?
            WHERE org_id = ? AND manifest_id = ?`,
        ).bind(at, orgId, manifestId),
      ],
      {
        sql: `SELECT 1 FROM send_manifests WHERE id = ? AND org_id = ?
                AND ((state = 'held' AND release_at <= ?) OR state = 'throttled')`,
        params: [manifestId, orgId, at],
      },
    );
    if ((results[1]?.meta.changes ?? 0) > 0) {
      return {
        manifestId,
        state: "withheld",
        detail: "This message was not sent: the author's authority to send as this mailbox was withdrawn.",
      };
    }
    // Somebody else moved it first; fall through and report what it actually is.
  }

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
  //
  // From here on the manifest is *already* in a terminal state that nothing will retry, so anything that
  // throws before `applyOutcome` writes a real one leaves a send nobody will look at again. That is what
  // this try exists for — not to recover, but to make sure the send carries a reason.
  try {
    return await submitClaimed(env, ctx, orgId, manifestId, transport, at);
  } catch (error) {
    await recordUnexplainedDispatch(env, ctx, orgId, manifestId, error);
    // Rethrown, always. The caller decides — a queue or an alarm should still see the failure, and
    // swallowing it here would turn a broken Node into a quiet one.
    throw error;
  }
}

/**
 * Everything between the claim and the terminal state, which is the part that can throw.
 *
 * Split out so `dispatchOne` can guarantee a reason is recorded whatever happens in here, without a
 * sixty-line `try` whose extent a reader has to measure by eye.
 */
async function submitClaimed(
  env: Env,
  ctx: Ctx,
  orgId: string,
  manifestId: string,
  transport: TransportAdapter,
  at: string,
): Promise<DispatchResult> {
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
  /**
   * How many recipients *this pass* handed over, which is what `send_counters` must add.
   *
   * Returned by the submission loop rather than recovered from the database afterwards. The first version
   * matched `submission_state_at` against the dispatch's timestamp, which is exactly the kind of coupling
   * that works in a test with a frozen clock and fails on a Worker whose clock advances across I/O — and it
   * did, silently counting a three-recipient send as one. A number the code already has needs no join.
   *
   * 1 for a manifest with no recipient rows, which is every send sealed before migration 0010 and is
   * exactly one message.
   */
  let handedOverCount = 1;
  if (fidelity === "authored") {
    const rendered = await renderRfc822(env, manifestId);
    // §12 invariant 2: a materialized provider-submission representation *is* immutable evidence.
    // Stored before submitting, so the record exists even if the submission's outcome never does.
    //
    // **One object, however many recipients.** The same bytes go to each, so this stays one evidence pair
    // per manifest and §12's invariant is untouched by the loop below.
    const stored = await putEvidence(env, `${orgId}/sent/${manifestId}/submitted.eml`, rendered.raw);
    await env.CATALOG.prepare(
      "UPDATE send_manifests SET submitted_key = ?, submitted_sha256 = ? WHERE id = ?",
    )
      .bind(stored.blobKey, stored.plaintextSha256, manifestId)
      .run();

    const perRecipient = await submitPerRecipient(env, orgId, manifestId, transport, at, {
      from: manifest.envelope_from!, subject: manifest.subject!, raw: rendered.raw,
    });
    outcome = perRecipient.outcome;
    handedOverCount = perRecipient.handedOverNow;
  } else {
    // The normalized body, not an empty string. The first version passed `text: ""`, which would have
    // sent a blank message — it never fired because ADR 33 routes all customer mail through
    // `authored`, so the bug sat behind a path nothing used. Found by exercising it deliberately.
    const body = new TextDecoder().decode(await getEvidence(env, manifest.body_normalized_key!));
    outcome = await transport.submit(
      env,
      { from: manifest.envelope_from!, to, cc, bcc, subject: manifest.subject!, text: body },
      "reconstructed",
    );
  }

  return applyOutcome(env, ctx, orgId, manifestId, outcome, handedOverCount);
}

/**
 * Records *why* a dispatch has no outcome, for a send the claim already parked in `outcome_unknown`.
 *
 * ## The gap this closes
 *
 * The claim writes `state` and bumps `attempts` and nothing else, on purpose. Every other route to a
 * terminal state goes through `applyOutcome`, which writes `last_error` **and** an audit entry in one
 * transaction. So a throw anywhere in between produced the only terminal state reachable with no reason
 * attached: `outcome_unknown`, `last_error` NULL, no audit entry, no log line — and never retried, by
 * design. An operator saw "we do not know whether it left" and could not find out why not.
 *
 * It is the state that most needs a reason, because it is the one a person has to decide about.
 *
 * ## What this deliberately does not claim
 *
 * It does not decide whether the message left, and must not: the throw may have happened after the bytes
 * were handed over — `applyOutcome` itself can fail, and `auditedBatch` throws by contract — in which case
 * the send really did go and only the record of it failed. `outcome_unknown` is already the honest state
 * for that. This adds the cause of the ignorance, not a verdict about the mail.
 *
 * It also leaves `attempts` alone. An attempt genuinely occurred and may have reached the transport;
 * decrementing it to "give the send another go" is exactly the duplicate ADR 40 exists to prevent.
 *
 * ## What it cannot cover, stated so nobody reads more into it
 *
 * A killed isolate runs no `catch`. If the runtime drops the invocation mid-dispatch there is still no
 * reason recorded, and there cannot be — the pre-claim is the design for *that* case and remains the
 * reason the state is pessimistic. This covers the thrown exception, which is the common case and the
 * one that was silently losing information.
 */
async function recordUnexplainedDispatch(
  env: Env,
  ctx: Ctx,
  orgId: string,
  manifestId: string,
  cause: unknown,
): Promise<void> {
  // No `state_at` here, deliberately: the state did not change, only the account of why it is what it is.
  // Restamping it would move the send's clock to the moment somebody explained it rather than the moment
  // it entered the state, which is the timestamp an operator is reading it for.
  const message = cause instanceof Error ? cause.message : String(cause);
  const reason =
    `This Node does not know whether the message left: the dispatch failed before an outcome was ` +
    `recorded. ${message}`.slice(0, 500);

  try {
    await auditedBatch(
      env, ctx, orgId,
      {
        action: "send.outcome_unknown",
        outcome: "failed",
        subject: manifestId,
        // The state vocabulary stays as it is (§16) — the manifest really is in `outcome_unknown` — and
        // the fact that a throw put it there lives here, where a reader can tell this apart from a
        // transport that returned an unclassifiable answer.
        detail: { cause: "exception", error: message.slice(0, 300) },
      },
      (entry) => [
        entry,
        env.CATALOG.prepare(
          // Conditional on the send still being unexplained. Another dispatcher may have written a real
          // outcome in the meantime, and overwriting a recorded fact with "something went wrong" would
          // lose the better answer. `last_error IS NULL` also makes this idempotent across retries.
          `UPDATE send_manifests SET last_error = ?
            WHERE id = ? AND org_id = ? AND state = 'outcome_unknown' AND last_error IS NULL`,
        ).bind(reason, manifestId, orgId),
      ],
      {
        // Gate and statement share the predicate, so the entry is appended only when there is something
        // to explain. It precedes the UPDATE, because the UPDATE is what makes the predicate false.
        sql: `SELECT 1 FROM send_manifests
                WHERE id = ? AND org_id = ? AND state = 'outcome_unknown' AND last_error IS NULL`,
        params: [manifestId, orgId],
      },
    );
  } catch (recordingFailure) {
    // The original cause is the more useful one, so it is never replaced by a failure to write about it.
    // Dropped to the operational log instead, which is the one level down that `audit` itself falls back
    // to and that `doctor` can see.
    await log(env, ctx, {
      level: "error",
      event: "send.unexplained_dispatch_unrecorded",
      message: "A dispatch failed and the reason could not be recorded against the send.",
      orgId,
      detail: {
        manifestId,
        dispatchError: message.slice(0, 300),
        recordingError: recordingFailure instanceof Error ? recordingFailure.message : String(recordingFailure),
      },
    });
  }
}

/**
 * Writes the terminal state, mirrors it, counts it and records it — in one transaction.
 *
 * `handedOverCount` is passed in rather than recovered, because it is the number of recipients *this pass*
 * handed over and only the caller knows it. Recovering it from the database meant matching a timestamp,
 * which worked under a frozen test clock and failed on a Worker whose clock advances across I/O.
 */
async function applyOutcome(
  env: Env,
  ctx: Ctx,
  orgId: string,
  manifestId: string,
  outcome: SubmitOutcome,
  handedOverCount: number,
): Promise<DispatchResult> {
  const at = new Date(ctx.now()).toISOString();
  const day = at.slice(0, 10);

  const statements: D1PreparedStatement[] = [];
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
          // Counts **recipients**, not sends, because that is the unit Cloudflare bills and throttles:
          // measured, one structured send to three recipients moved its count from 0 to 3
          // (`cloudflare-email-sending.md`). This column is shown to a user as their observed daily limit,
          // so counting manifests against a per-recipient allowance would understate it by exactly the
          // average recipient count — invisibly, because every send this Node made before today had one
          // recipient and the two agreed.
          //
          // Scoped to `submission_state_at = ?` so a retry counts only what it newly handed over. Falls
          // back to 1 for a manifest with no recipient rows, which is every send sealed before migration
          // 0010 and is exactly one message.
          `INSERT INTO send_counters (org_id, day, handed_over) VALUES (?,?,?)
           ON CONFLICT (org_id, day) DO UPDATE SET handed_over = handed_over + ?`,
        ).bind(orgId, day, handedOverCount, handedOverCount),
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

  // Hand-over stops the first-response clock, and only hand-over: a sealed send sits in the hold window and
  // can still be cancelled, so treating sealing as the answer would record a response that never left. Same
  // distinction ADR 39 draws between `handed_over` and anything more optimistic, applied to a clock.
  //
  // Outside the batch deliberately. A failure to stop a clock must not roll back a hand-over that has already
  // happened — the bytes are gone, and the state that records them leaving is the more important write. The
  // consequence is a clock that may be recorded as breached despite an answer having left, which the next
  // reply or a person can correct; the reverse — an unrecorded hand-over — cannot be corrected at all.
  if (state === "handed_over") {
    const conversation = await env.CATALOG.prepare(
      `SELECT m.conversation_id FROM send_manifests s
        LEFT JOIN messages m ON m.rfc_message_id = s.in_reply_to_message_id AND m.org_id = s.org_id
       WHERE s.id = ? AND s.org_id = ? LIMIT 1`,
    ).bind(manifestId, orgId).first<{ conversation_id: string | null }>();
    if (conversation?.conversation_id != null) {
      await stopClockForConversation(env, orgId, conversation.conversation_id, at)
        // Logged, not thrown: see above. A clock is worth less than the record of the send.
        .catch(() => 0);
    }
  }

  // Recorded for every terminal state, not only failures. "Nothing went wrong" is a fact an audit has
  // to be able to show, or its silence is ambiguous.
  //
  // In the same transaction as the state it describes. The bytes may already have left by the time
  // this runs — that cannot be undone by a rollback — but "what this Node believes happened" and
  // "what this Node recorded happening" must not be able to disagree, which is what a separate write
  // permits. A rolled-back batch is retried by the next sweep from a state that still describes the
  // send, rather than leaving a hand-over nothing accounts for.
  await auditedBatch(env, ctx, orgId, {
    action: `send.${state}`,
    outcome: state === "handed_over" ? "ok" : state === "outcome_unknown" ? "failed" : "refused",
    subject: manifestId,
    detail: {
      transportMessageId: outcome.kind === "handed_over" ? outcome.transportMessageId : null,
      reason: "reason" in outcome ? outcome.reason.slice(0, 300) : null,
    },
  }, (entry) => [
    ...statements,
    // Mirrors the aggregate onto any recipient still undecided — and **only** those.
    //
    // `submission_state = 'held'` is load-bearing now that submission is per recipient: the loop above
    // has already written each recipient's own outcome, and a blanket update would overwrite three
    // different truths with one summary. This clause is what leaves them alone.
    //
    // It still matters for the paths that have no loop: a reconstructed send, a cancellation, a
    // withholding, and a manifest sealed before recipient rows existed. There the aggregate *is* each
    // recipient's outcome, and without this they would sit at `held` forever while the send was long gone.
    //
    // In the same transaction as the manifest update, so "the send says handed_over but its recipients say
    // held" is not a reachable state. `delivery_state` is untouched: hand-over says nothing about what a
    // receiving server did, and overwriting an observed outcome would destroy the only record of it.
    env.CATALOG.prepare(
      `UPDATE send_recipients SET submission_state = ?, submission_state_at = ?
        WHERE org_id = ? AND manifest_id = ? AND submission_state = 'held'`,
    ).bind(state, at, orgId, manifestId),
    entry,
  ]);

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

/**
 * Submits the same bytes once per recipient, and records each outcome on its own row.
 *
 * ## Why a loop rather than one call
 *
 * `new EmailMessage(from, to, raw)` takes **one** address, so a single call can only ever reach one
 * recipient — joining them produced a malformed address and had never worked. The alternative, the
 * structured API, builds its own MIME and therefore cannot carry `authored` fidelity, which ADR 33
 * requires for customer mail because its record must prove exactly what was sent.
 *
 * Measured before choosing: one structured send to three recipients moved Cloudflare's own count from 0 to
 * 3, so submitting N times costs nothing extra. The usage was already per recipient; only Mailda's counter
 * disagreed.
 *
 * ## What this makes correct rather than merely possible
 *
 * **Bcc.** `Bcc` is absent from the emitted headers while present in the manifest, and a correct Bcc needs
 * a separate envelope per recipient. The previous single-envelope shape could not have delivered one
 * properly even if the API had accepted it.
 *
 * **Retry.** ADR 40 forbids making a duplicate *delivery* reachable. Recipients already `handed_over` are
 * skipped, so a retry after a partial failure reaches only the ones that never left — which is the thing
 * per-recipient state exists to permit and a per-manifest state could not express.
 *
 * ## The manifest's own state, once recipients can disagree
 *
 * Returned as an aggregate, and the rule is deliberate: if **any** recipient was handed over, the message
 * has left this Node and `handed_over` is true of the envelope. If none did, the manifest takes the first
 * failure, because that is the reason a person needs. The per-recipient rows carry the detail and the
 * outbox shows a second chip whenever they disagree, so the aggregate never has to stand in for them.
 */
async function submitPerRecipient(
  env: Env,
  orgId: string,
  manifestId: string,
  transport: TransportAdapter,
  /**
   * The dispatching pass's own timestamp, handed down rather than read again.
   *
   * Not a tidiness: `send_counters` identifies what *this* pass handed over by matching
   * `submission_state_at`, and a Worker's clock advances across I/O — so calling `ctx.now()` again here
   * produced a different instant, the subquery matched nothing, and a three-recipient send counted as one.
   * Measured on the deployed Node, which is the only place the two timestamps could diverge.
   */
  at: string,
  message: { from: string; subject: string; raw: Uint8Array<ArrayBuffer> },
): Promise<{ outcome: SubmitOutcome; handedOverNow: number }> {
  const rows = await env.CATALOG.prepare(
    `SELECT id, address, submission_state FROM send_recipients
      WHERE org_id = ? AND manifest_id = ? ORDER BY kind, address`,
  )
    .bind(orgId, manifestId)
    .all<{ id: string; address: string; submission_state: string }>();

  // A manifest sealed before migration 0010 has no recipient rows. Falling back to one submission keeps
  // those sends dispatchable rather than stranding them, which matters because they are real mail.
  if (rows.results.length === 0) {
    const only = await transport.submit(env, { ...message, to: [] }, "authored");
    return { outcome: only, handedOverNow: only.kind === "handed_over" ? 1 : 0 };
  }

  const outcomes: SubmitOutcome[] = [];
  let handedOverNow = 0;

  for (const row of rows.results) {
    // Already gone. Re-submitting is the one thing ADR 40 forbids, because the transport cannot
    // deduplicate and the recipient keeps both copies forever.
    if (row.submission_state === "handed_over") {
      outcomes.push({ kind: "handed_over", transportMessageId: "(already submitted)" });
      continue;
    }

    const outcome = await transport.submit(env, { ...message, to: [row.address] }, "authored");
    outcomes.push(outcome);
    if (outcome.kind === "handed_over") handedOverNow += 1;

    await env.CATALOG.prepare(
      `UPDATE send_recipients
          SET submission_state = ?, submission_state_at = ?, transport_message_id = ?,
              attempts = attempts + 1, last_error = COALESCE(?, last_error)
        WHERE id = ?`,
    )
      .bind(
        outcome.kind === "handed_over" ? "handed_over"
          : outcome.kind === "throttled" ? "throttled"
          : outcome.kind === "suppressed" ? "suppressed"
          : outcome.kind === "refused" ? "refused" : "outcome_unknown",
        at,
        outcome.kind === "handed_over" ? outcome.transportMessageId : null,
        "reason" in outcome ? outcome.reason.slice(0, 300) : null,
        row.id,
      )
      .run();
  }

  // The aggregate, and the order of these three clauses is load-bearing.
  //
  // **Retryable first.** If any recipient is still throttled, the manifest must report throttled so
  // `dispatchDue` picks it up again — the sweeper selects on the manifest, not on recipients. Reporting a
  // hand-over here because *some other* recipient succeeded would leave the throttled one unsent forever,
  // with the send looking complete. Found by a partial-failure test rather than by reading the code.
  //
  // Then hand-over: the bytes left this Node for somebody, which is what an envelope-level state is about.
  // Then the first failure, because that is the reason a person needs.
  //
  // The per-recipient rows carry the truth in every case, and the outbox shows a second chip whenever they
  // disagree, so this aggregate never has to stand in for them.
  const retryable = outcomes.find((o) => o.kind === "throttled");
  const handedOver = outcomes.find((o) => o.kind === "handed_over");
  const outcome = retryable
    ?? handedOver
    ?? outcomes[0]
    ?? { kind: "outcome_unknown" as const, reason: "no recipients to submit to" };
  return { outcome, handedOverNow };
}
