import type { Ctx } from "@mailda/runtime";

import { auditedBatch, log } from "../audit.ts";
import { stopClockForConversation } from "../response-clock.ts";
import { maySend } from "../authz-read.ts";
import { getEvidence, putEvidence } from "../evidence-store.ts";
import { renderRfc822 } from "./manifest.ts";
import { BREAKER_REASONS } from "../breakers.ts";
import {
  authorityLost, type BreakerRecheck, type EffectEnvelope, ENVELOPE_COLUMNS, type EnvelopeRow,
  envelopeRecord, recheckApproved, recheckBreakers, requiresApproval, type Withholding,
} from "./recheck.ts";
import { cloudflareTransport, type SubmitOutcome, type TransportAdapter } from "./transport.ts";

/**
 * Dispatch: the hold window, the state machine, and the retry rule (ADR 39, ADR 40).
 *
 * ## Nine states, and two of them are forbidden
 *
 *   held             sealed, undispatched, still cancellable
 *   awaiting         a policy gate somebody can clear; `state_reason` says which gate (#60)
 *   cancelled        stopped during the hold window by a person
 *   withheld         this Node declined; `state_reason` says why — `policy_denied`, `approval_denied` and
 *                    `approval_unsatisfiable` from the seal and the approval, and the six a dispatch can
 *                    write, which are `DISPATCH_REASONS` in `./recheck.ts`
 *   throttled        rate-limited — provably never left
 *   refused          rejected at the API boundary — provably never left
 *   suppressed       on the suppression list — will never arrive, and that is knowable now
 *   handed_over      the transport accepted it; whether it arrived is unknown
 *   outcome_unknown  we do not know whether it left
 *
 * `sent` and `delivered` do not exist here and must never be added. §5C forbids claiming an outcome
 * nobody observed, and the transport reports acceptance rather than arrival.
 *
 * ## `awaiting` is dispatched for exactly one reason family, and that is a check now rather than an omission
 *
 * This used to read *"`awaiting` is never dispatched, and it is never dispatched by omission rather than by a
 * check"* — the sweep and the claim admitted `held`-and-due or `throttled`, and `awaiting` was neither, so a
 * gated send could not leave because the predicate never admitted it. **#66 changed that and the change is
 * deliberate**, so the header changes with it rather than leaving a sentence that is no longer true.
 *
 * A rate breaker gates an over-rate send to `awaiting` and promises it *"goes when the window clears"*. Nothing
 * else sweeps `awaiting`, so that promise needed a drain, and the drain is one arm on the predicate:
 * `state = 'awaiting' AND state_reason IN (BREAKER_REASONS)`. Every predicate that lets a send move is now
 * built by `movableNow` — one function, three call sites, so the widening could not reach two of them and miss
 * the third.
 *
 * **The policy gates stay closed, twice over.** `BREAKER_REASONS` is derived from `RATE_BREAKERS` in
 * `src/breakers.ts`, so `policy_hold` and `policy_approval_required` are not in it and could only get there by
 * somebody declaring a policy outcome to be a rate breaker; and `sealManifest` will not write a breaker reason
 * over a policy gate at all. `test/policy.test.ts` asserts a policy-gated send still cannot leave, and
 * `test/breakers.test.ts` asserts a rate-gated one can once the window clears — the two halves of the same
 * statement, which is what stops the guard being widened by accident later.
 *
 * **How an `awaiting` send drains, and which half is still missing.** An approval-gated send is released by
 * `decideApproval` in `src/approvals.ts` (#61): the decision that closes the last stage puts the manifest back
 * to `held` in the same transaction, and from there the ordinary hold window and this sweep take it. A denial
 * puts it in `withheld` with `approval_denied`, and a withdrawal that leaves too few eligible approvers puts it
 * in `withheld` with `approval_unsatisfiable`.
 *
 * **A `policy_hold` still has no release act.** #60 gave it to any `send.propose` holder and nobody built it,
 * so a held-by-policy send drains in exactly one way: its author **cancels** it, which `cancelSend` permits for
 * that reason. Said plainly rather than left to be discovered, because a queue with no drain is the failure
 * `deny` was kept out of `awaiting` to avoid — and it is now one gate rather than two.
 *
 * ## The recheck of an approved send, and the asymmetry a future reader must not tidy away
 *
 * An **approved** send gets the full §18 recheck before the transport is asked — approval valid and unrevoked,
 * current actor authority, approver still eligible, policy re-evaluated, and both pre-existing body hashes
 * re-verified. An **unapproved** send gets ADR 39's authority re-read and nothing else (#62).
 *
 * The two paths differ deliberately. `./recheck.ts` carries the argument and the measured figures; what
 * belongs here is the shape: `dispatchOne` reads one widened manifest row, runs the authority check on both
 * paths, and enters the expensive path only when `requiresApproval` says so — which is a column already in
 * hand, not a query. One branch, one withholding writer, six reasons.
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
  | "held" | "awaiting" | "cancelled" | "withheld" | "throttled" | "refused" | "suppressed"
  | "handed_over" | "outcome_unknown";

/**
 * The two states a person may still stop.
 *
 * `awaiting` belongs here for a reason sharper than convenience: a `policy_hold` has no release act in this
 * build, so without cancellation a held-by-policy send would be **unstoppable** — accumulating in a state that
 * reads as pending with no act that resolves it. That is precisely the argument #60's `deny` mapping uses
 * against parking denials in `awaiting`. #61 gave the *approval* gate its release, and left the hold's alone.
 *
 * It also stays here for the approval gate, and that is a decision rather than an oversight: an author may
 * cancel their own send while an approval is pending, because it is their message and cancelling is their own
 * authority (`send.propose`, the same relation sealing took). What they may not do is decide it — see
 * `decideApproval`'s refusal of an author. The pending request goes with the send, in the same transaction:
 * see `cancelSend`.
 */
const STOPPABLE: ReadonlySet<SendState> = new Set<SendState>(["held", "awaiting"]);

/** Which states the system may retry on its own. Everything absent here needs a human, or nothing. */
const AUTO_RETRYABLE: ReadonlySet<SendState> = new Set<SendState>(["throttled"]);

/**
 * What the sweep, the claim and the refusal all mean by *"this manifest may move now"*, spelled **once**.
 *
 * Three places used to write this predicate out, identically, and #66 had to widen all three at once — which
 * is exactly the correspondence problem that lets one of them be missed. So it is one function, and the
 * parameters it needs are one instant and one column prefix.
 *
 * ## The third arm is #66's, and it is the narrowest widening that makes the design true
 *
 * `awaiting` has always been unreachable by the dispatcher **by omission rather than by a check** — the
 * predicate that lets a send out simply never admitted it — and that is what makes a policy gate a real gate.
 * A rate breaker breaks the premise: #66 gates an over-rate send to `awaiting`, and says it *"goes when the
 * window clears"*. Nothing sweeps `awaiting`, so without this arm that sentence would have been false and the
 * gate would have been a queue with no drain — the exact failure #60 kept `deny` out of `awaiting` to avoid,
 * arriving through the other door.
 *
 * So the sweep admits `awaiting` **only** for a `state_reason` in `BREAKER_REASONS`: the rate gates, which are
 * the one family of reasons that clears with no act by anybody. `policy_hold` and `policy_approval_required`
 * are not in that list and never can be — `BREAKER_REASONS` is derived from `RATE_BREAKERS`, so a policy
 * reason could only get in by somebody declaring a policy outcome as a rate breaker — and
 * `sealManifest` will not write a breaker reason over a policy gate in the first place. Two independent
 * reasons the policy gates stay closed, which is what this deserves: a rate limiter that could release
 * policy-gated mail is a governance bypass with a benign-looking name.
 */
function movableNow(prefix: string): string {
  const reasons = BREAKER_REASONS.map(() => "?").join(", ");
  return `((${prefix}state = 'held' AND ${prefix}release_at <= ?) OR ${prefix}state = 'throttled'`
    + ` OR (${prefix}state = 'awaiting' AND ${prefix}state_reason IN (${reasons})))`;
}

/** The parameters `movableNow` binds, in order: the instant, then the breaker reasons. */
function movableParams(at: string): unknown[] {
  return [at, ...BREAKER_REASONS];
}

export interface DispatchResult {
  manifestId: string;
  state: SendState;
  detail: string;
}

/**
 * Cancels a manifest nothing has handed over: `held`, or `awaiting` a policy gate.
 *
 * Conditional on still being stoppable, which is what makes the race safe without a transaction D1 does
 * not offer (#10): a cancel arriving as the dispatcher releases loses at the database rather than
 * producing a cancelled-but-sent message.
 *
 * The predicate is built from `STOPPABLE` rather than written out, so the set and the SQL cannot disagree —
 * a second literal list is how `awaiting` would have been added to one and not the other.
 *
 * **A pending approval is settled in the same transaction** (#61). Cancelling is the drain `awaiting` has, so a
 * send gated on an approval can be cancelled out from under the people asked to decide it, and the request has
 * to go with it for two reasons rather than for tidiness:
 *
 *   - it is the whole of what stops `decideApproval` reporting a released send that is in fact cancelled. That
 *     function's completion transition is conditional on the approval being `pending`, and its manifest update
 *     is conditional on the send being `awaiting` — so without this, approving a cancelled send closed the
 *     approval, moved nothing, and returned `manifestState: "held"` for a manifest that says `cancelled`;
 *   - `apr_pending` is described as holding exactly the outstanding set, and an approver's queue is built from
 *     it. A request whose send no longer exists is dead work nobody can clear, which is the state
 *     `src/approvals.ts` refuses to create at the seal and must therefore not create here either.
 */
export async function cancelSend(
  env: Env,
  ctx: Ctx,
  orgId: string,
  manifestId: string,
): Promise<{ cancelled: boolean; reason?: string }> {
  // Conditional, so the record is conditional on the same predicate and in the same transaction.
  // The entry is placed *first* deliberately: the update clears the stoppable state, so an entry gated on
  // it and running afterwards would never insert, and a cancellation would go unrecorded.
  const stoppable = [...STOPPABLE];
  const stoppablePredicate = `state IN (${stoppable.map(() => "?").join(", ")})`;
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
          WHERE id = ? AND org_id = ? AND ${stoppablePredicate}`,
      ).bind(new Date(ctx.now()).toISOString(), manifestId, orgId, ...stoppable),
      // Recipients follow the manifest. Unconditional here because the batch only commits when the gate
      // above found the manifest still stoppable, so this cannot cancel recipients of a send that went out.
      env.CATALOG.prepare(
        `UPDATE send_recipients SET submission_state = 'cancelled', submission_state_at = ?
          WHERE org_id = ? AND manifest_id = ?`,
      ).bind(new Date(ctx.now()).toISOString(), orgId, manifestId),
      // The approval of a cancelled send, settled with it (#61). Unconditional for the same reason as the
      // recipients above, and free: one more statement in a `batch()` this call was already making. `state`
      // rather than a deletion, because "somebody was asked and then the send was withdrawn" is a fact the
      // trail's `send.cancelled` entry points at and `approval_decisions` still holds the answers to.
      env.CATALOG.prepare(
        `UPDATE approvals SET state = 'cancelled', resolved_at = ?
          WHERE org_id = ? AND subject_kind = 'send_manifest' AND subject_id = ? AND state = 'pending'`,
      ).bind(new Date(ctx.now()).toISOString(), orgId, manifestId),
    ],
    {
      sql: `SELECT 1 FROM send_manifests WHERE id = ? AND org_id = ? AND ${stoppablePredicate}`,
      params: [manifestId, orgId, ...stoppable],
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
        : `This message can no longer be stopped; it is ${current.state}.`,
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
      WHERE org_id = ? AND ${movableNow("")}${restriction}
      ORDER BY release_at LIMIT ?`,
  )
    .bind(orgId, ...movableParams(now), ...(mailboxIds ?? []), limit)
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
  // One widened read, both paths. `ENVELOPE_COLUMNS` is what `./recheck.ts` needs and this is the row ADR 39
  // already had to fetch, so the approved path's envelope costs no extra read of `send_manifests` — and the
  // unapproved path pays nothing for columns it does not look at, because widening a `SELECT` already being
  // issued is free while a second read of the same row would not be.
  const manifest = await env.CATALOG.prepare(
    `SELECT ${ENVELOPE_COLUMNS} FROM send_manifests WHERE id = ? AND org_id = ? LIMIT 1`,
  )
    .bind(manifestId, orgId)
    .first<EnvelopeRow>();

  /**
   * The two paths, in one place, so the asymmetry is visible rather than incidental (#62).
   *
   * **Both:** ADR 39's authority re-read. It is the cheapest check and the one every send needs, so it runs
   * first and short-circuits the rest — an unauthorized send must not pay for five more checks to be refused.
   *
   * **Approved only:** the §18 recheck. `requiresApproval` is a column comparison on the row above, so
   * deciding which path a send is on costs nothing at all.
   *
   * If you are here to simplify this into one path: don't. The measured figures are in
   * `docs/receipts/dispatch-recheck-cost.md` — making the recheck universal takes a dispatch from a measured 16
   * subrequests to 24, half again, on every send instead of on the ones somebody asked for assurance about. The
   * bound that catches that is on **this** path, `send.dispatch_unapproved_max_subrequests`, because the cheap
   * path is the one a tidying refactor makes expensive.
   */
  let withholding: Withholding | null = null;
  let envelope: EffectEnvelope | null = null;
  let breaker: BreakerRecheck = null;
  if (manifest !== null) {
    if (!(await maySend(env, { orgId, userId: manifest.author_user_id }, manifest.mailbox_id))) {
      withholding = authorityLost(manifest.author_user_id, manifest.mailbox_id);
    } else {
      /*
       * The breakers (#66), on **both** paths, second — after the free-ish authority read and before the
       * eight the approved path pays for.
       *
       * Both paths, because a breaker is a fact about this Node's own rate and this Node's own domain and has
       * nothing to do with whether anybody asked for assurance about this particular send. A breaker that
       * fired only on approved sends would be a governance control that a Node with no `require_approval`
       * policy never had — which is the asymmetry #62 built, applied where it does not belong.
       *
       * One D1 statement, measured (`send-breakers.md`), so the unapproved path goes 16 → 17 against its bound
       * of 20 and the approved path 24 → 25 against 28. Second in the order for the reason the recheck's own
       * checks are ordered cheapest-first: a send the breakers stop never pays for the hashes.
       */
      breaker = await recheckBreakers(env, ctx, orgId, manifest.envelope_from);
      if (breaker?.kind === "withhold") {
        withholding = breaker.withholding;
      } else if (breaker === null && requiresApproval(manifest)) {
        const rechecked = await recheckApproved(env, ctx, orgId, manifestId, manifest, transport);
        envelope = rechecked.envelope;
        withholding = rechecked.withholding;
      }
    }
  }

  /*
   * A rate is over: gate to `awaiting` and stop. Not `withheld` — the mail is still wanted (#66).
   *
   * **The gate is conditional on this not already being the state**, and that is what keeps the trail
   * bounded rather than a matter of care: the sweeper revisits a rate-gated send every tick, and an
   * unconditional write would file one `send.rate_limited` entry per tick — sixty an hour behind one human
   * action, falsifying `audit-and-log-retention.md`'s "a handful per message" as a side effect. The
   * `NOT (state = 'awaiting' AND state_reason = ?)` clause is inside the shared gate, so the entry and the
   * update commit together or neither does, and a re-visit that changes nothing records nothing.
   *
   * Placed **before the claim**, like every other refusal here and for the same reason: the claim increments
   * `attempts` and moves the manifest to `outcome_unknown`, so gating afterwards would spend an attempt and
   * park a never-submitted message in the one state that means "we do not know whether it left".
   */
  if (breaker?.kind === "gate") {
    const unchanged = `NOT (state = 'awaiting' AND state_reason = ?)`;
    const gateSql = `SELECT 1 FROM send_manifests WHERE id = ? AND org_id = ? AND ${movableNow("")}
                       AND ${unchanged}`;
    const gateParams = [manifestId, orgId, ...movableParams(at), breaker.reason];
    const { results } = await auditedBatch<never>(
      env, ctx, orgId,
      {
        action: "send.rate_limited",
        // Not `refused`: nothing was refused, and the trail's other gates record `ok`. See `AUDIT_ACTIONS`.
        outcome: "ok",
        subject: manifestId,
        detail: {
          breaker: breaker.rate.breaker,
          reason: breaker.reason,
          limit: breaker.rate.limit,
          observed: breaker.rate.observed,
          observations: breaker.rate.observations,
          percent: breaker.rate.percent,
          windowSeconds: breaker.rate.windowSeconds,
          retryAfterSeconds: breaker.rate.retryAfterSeconds,
          retryAfterExact: breaker.rate.retryAfterExact,
          mailboxId: manifest?.mailbox_id ?? null,
          // Which of #66's two evaluation points produced this. The seal's entry says `seal`; a send gated
          // here was clear when it was composed and is over now, which is the fail-closed half.
          at: "dispatch",
        },
      },
      (entry) => [
        entry,
        env.CATALOG.prepare(
          `UPDATE send_manifests SET state = 'awaiting', state_at = ?, last_error = ?, state_reason = ?
            WHERE id = ? AND org_id = ? AND ${movableNow("")} AND ${unchanged}`,
        ).bind(at, breaker.lastError, breaker.reason, manifestId, orgId, ...movableParams(at),
          breaker.reason),
        // The recipients follow the manifest, as they do on every other state change here: a gated send
        // whose recipients still read `held` shows a person a message that is simultaneously stopped and
        // pending.
        env.CATALOG.prepare(
          `UPDATE send_recipients SET submission_state = 'awaiting', submission_state_at = ?
            WHERE org_id = ? AND manifest_id = ?`,
        ).bind(at, orgId, manifestId),
      ],
      { sql: gateSql, params: gateParams },
    );
    if ((results[1]?.meta.changes ?? 0) > 0) {
      return { manifestId, state: "awaiting", detail: breaker.lastError };
    }
    /*
     * The gate matched nothing, so neither the entry nor the state was written — and **the two ways that
     * happens need different answers**, which is why this is a read rather than the unconditional
     * `state: "awaiting"` that stood here first.
     *
     * A **re-visit** is the ordinary one: the sweeper met a send already `awaiting` for this same reason, the
     * `unchanged` clause held, nothing was recorded, and `awaiting` is exactly what it still is. A **lost
     * race** is the other: somebody cancelled it, or another dispatcher claimed it, between the sweep's
     * `SELECT` and this write. Reporting `awaiting` there would tell a caller their send is waiting for a
     * window when it is `cancelled` — the blurred state §5C exists to prevent, in the one path that had no
     * fall-through while the withhold path three lines down has had one all along.
     *
     * One read, and only on the branch that wrote nothing: a send actually gated pays for none of it.
     */
    const current = await env.CATALOG.prepare(
      "SELECT state FROM send_manifests WHERE id = ? AND org_id = ? LIMIT 1",
    ).bind(manifestId, orgId).first<{ state: SendState }>();
    return {
      manifestId,
      // Absent means the row is gone, which `cancelled` is this module's word for everywhere else it reads a
      // state back — see the claim below.
      state: current?.state ?? "cancelled",
      detail: current?.state === "awaiting"
        ? breaker.lastError
        : "Moved by another dispatcher, or cancelled, before the rate gate could be written.",
    };
  }

  if (withholding !== null) {
    // Conditional on still being held, for the same reason cancellation is: a dispatcher that already
    // claimed this must not have its work overwritten.
    const { results } = await auditedBatch<never>(
      env, ctx, orgId,
      {
        action: "send.withheld", outcome: "refused", subject: manifestId,
        detail: {
          // The machine token first, because it is what a filter over the trail keys on.
          reason: withholding.reason,
          ...withholding.evidence,
          // The envelope §18 says every approval binds, on the record of the act that refused it. Absent on
          // the unapproved path because there is no approval there to bind one — an envelope built for a send
          // nobody asked for assurance about would be a record of a recheck that did not happen.
          ...(envelope === null ? {} : { envelope: envelopeRecord(envelope) }),
        },
      },
      (entry) => [
        entry,
        env.CATALOG.prepare(
          // `state_reason` is set here as well as `last_error`, and the two are not redundant: `last_error`
          // is prose for a person and this is the machine token the reason vocabulary is built from. Bound
          // rather than interpolated, so no reason can reach this SQL as text.
          `UPDATE send_manifests SET state = 'withheld', state_at = ?, last_error = ?, state_reason = ?
            WHERE id = ? AND org_id = ? AND ${movableNow("")}`,
        ).bind(at, withholding.lastError, withholding.reason, manifestId, orgId, ...movableParams(at)),
        // The recipients follow, in the same transaction. A withheld send whose recipients still read
        // `held` would show a person a message that is simultaneously stopped and pending.
        env.CATALOG.prepare(
          `UPDATE send_recipients SET submission_state = 'withheld', submission_state_at = ?
            WHERE org_id = ? AND manifest_id = ?`,
        ).bind(at, orgId, manifestId),
      ],
      {
        sql: `SELECT 1 FROM send_manifests WHERE id = ? AND org_id = ? AND ${movableNow("")}`,
        params: [manifestId, orgId, ...movableParams(at)],
      },
    );
    if ((results[1]?.meta.changes ?? 0) > 0) {
      /*
       * `evidence_changed` is the one reason that also raises, and it is the one member of the six that is not
       * the system working: every other reason is a decision or a deadline, while a hash mismatch means the
       * archive differs from its own record — corruption, or tampering.
       *
       * So it gets an operational log line here as well as the outbox row and the audit entry, and
       * `doctor`'s `send_evidence_changed` finding reads the manifests the state left behind. Written *after*
       * the state, and outside its transaction, deliberately: `log` swallows its own failure by contract
       * (it is the last resort and cannot log a failure to log), so putting it in the batch would let a
       * logging failure roll back a refusal that has already been decided. The state is the important write;
       * this is the alarm beside it.
       */
      if (withholding.raises) {
        await log(env, ctx, {
          level: "error",
          event: "send.evidence_changed",
          message:
            "A send was withheld because stored evidence no longer matches the hash its manifest recorded. "
            + "This is corruption or tampering rather than a policy decision.",
          orgId,
          detail: { manifestId, ...withholding.evidence },
        });
      }
      return { manifestId, state: "withheld", detail: withholding.lastError };
    }
    // Somebody else moved it first; fall through and report what it actually is.
  }

  // Claim: only a movable manifest may move. A concurrent cancel wins here.
  const claimed = await env.CATALOG.prepare(
    `UPDATE send_manifests
        SET state = 'outcome_unknown', state_at = ?, attempts = attempts + 1
      WHERE id = ? AND org_id = ? AND ${movableNow("")}`,
  )
    .bind(at, manifestId, orgId, ...movableParams(at))
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
    // `m.id`, not `m.rfc_message_id`. Those columns hold different kinds of value and their own schema
    // comments say so: `send_manifests.in_reply_to_message_id` is "our own msg_ id, NULL for a new thread"
    // (0007_outbound.sql:20), while `messages.rfc_message_id` is "the provider/sender Message-ID header"
    // (0002_message_metadata.sql:12). The first version compared `msg_01J…` against `<…@domain>`, so it
    // could never match: the clock never stopped, and every case in a mailbox with a response target was
    // swept to breached an hour later however fast the reply left. `renderRfc822` resolves the same column
    // correctly, by id, twenty lines below — the two readings of one column sat in one file.
    //
    // Eighteen tests passed over it, because every one called `stopClockForConversation` directly with a
    // conversation id it already knew. This is the only caller, and it is the only code that has to *find*
    // the conversation. `test/clock-stops-on-reply.test.ts` now drives the whole path instead.
    const conversation = await env.CATALOG.prepare(
      `SELECT m.conversation_id FROM send_manifests s
        LEFT JOIN messages m ON m.id = s.in_reply_to_message_id AND m.org_id = s.org_id
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
