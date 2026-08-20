import type { Ctx } from "@mailda/runtime";
import { BUDGETS, BUDGET_ORIGINS, type BudgetName } from "@mailda/budgets";

/**
 * Send circuit breakers: three windowed rates and one latched domain pause (#66, §18, Layer 5).
 *
 * ## Two kinds of breaker, and the split runs down the middle of every other question
 *
 * A **rate** breaker is not a latch, it is a question re-asked per send — *too much, too fast, and the mail
 * is still wanted*. So it gates to `awaiting` with a reason and goes when the window clears. An **abuse**
 * breaker means *this must not be sent at all*, so it refuses to `withheld`. Collapsing them either discards
 * mail somebody still wants or queues mail that must never leave: an all-hold design lets a runaway build a
 * backlog somebody eventually releases in bulk, which is how a loop finally sends its thousands, and an
 * all-refuse design throws away perfectly good invoices on a busy afternoon with no remedy but composing them
 * again into the same breaker.
 *
 * **The classification is per breaker and explicit in code**, and it is explicit as a *mechanism* rather than
 * as a field: a gate is declared in `RATE_BREAKERS` below and mints a reason in `BREAKER_REASONS`; a refusal
 * is declared in `WITHHOLDING` in `src/outbound/recheck.ts` and mints one there. **The two vocabularies are
 * disjoint**, which `test/breakers.test.ts` asserts over the two lists themselves, so a breaker cannot be both
 * and a fourth one cannot arrive without choosing. Not inferred from a severity, not from a threshold — that
 * is the one place this design could rot into "whatever the last person assumed".
 *
 * A `kind: "gate"` field on each entry below was written first and removed: nothing would have read it, its
 * type admitted one value, and a declared field nothing consumes is this repository's most-repeated defect
 * wearing the clothes of a classification.
 *
 * ## The counter is a windowed COUNT(*) over rows that already exist
 *
 * The only working rate limiter in this repository is not a counter: `login` at `src/auth/session.ts:164`
 * counts append-only rows inside a window. Nothing to increment, so nothing to contend on, no CAS, and no cell
 * that can drift from the events it claims to summarise — **the number is derived, not maintained**.
 *
 * A Durable Object was rejected despite §12 explicitly permitting one for *"presence, counters, rate state"*:
 * it adds a subrequest to every send, it is opaque to `doctor` in a way a table is not, and any timer-based
 * reset would inherit the DO alarm's absorbing failure state — stop re-arming and nothing external notices,
 * ever — inside the one component whose job is to notice things.
 *
 * ## Nothing resets, because nothing is armed
 *
 * There is no open/half-open/closed state machine, no timer and no cron dependency. Recovery happens because
 * failures **age out of the window**. `retryAfterSeconds` is derived from the oldest row still inside it, so
 * the refusal tells somebody when it clears rather than leaving them to poll — which is AGENTS.md's
 * requirement that a developer sees the limit before they hit it, satisfied at the moment they hit it and
 * again, before, at `GET /api/breakers`.
 *
 * Manual-reset-only was rejected on its second-order effect rather than its first: a bounce spike at 2am
 * becomes an outage waiting for somebody to wake up, and the realistic response after that happens twice is
 * that the limits get raised until the breaker never fires — the muted-check failure `DELIVERY_SILENCE_MS`
 * already names in `doctor.ts`.
 *
 * **Two costs, accepted and named.** A windowed breaker can **flap** at the boundary: a send refused at
 * 09:59:59 goes at 10:00:00. That is tolerable for a gate whose whole effect is a short delay and intolerable
 * for a refusal, which is exactly why refusals latch instead. And because nothing persists, **the trip leaves
 * no row** — so it is audited explicitly (`send.rate_limited`) or it never happened.
 *
 * ## Every rate counts attributed events only
 *
 * `send_recipient_events` has a second writer. `recordDeliveryReport` (`src/outbound/delivery-report.ts`)
 * inserts `event_type = "inbound.delivery_report"` with `terminal = 1` and `manifest_id` **NULL** for delivery
 * reports about **other systems' mail** — its own header says so. A naive `COUNT(*)` would trip this Node's
 * breaker on somebody else's bounces, which is the read-a-wrong-number inversion the breaker exists to
 * prevent. So `manifest_id IS NOT NULL` is on every rate, in the SQL, next to the counting — and Layer 4
 * already applied exactly this split for `doctor`'s blindness check.
 *
 * **There are two kinds of foreign row and each is excluded by a different predicate**, which was established
 * by deleting the attribution clause and watching what still passed rather than by reasoning about it:
 *
 *   `inbound.delivery_report`, NULL manifest_id — `recordDeliveryReport`'s. Excluded by the **event-type**
 *   filter, because it is not one of Cloudflare's type strings. The attribution clause is not what stops this
 *   one, and a test built only from these rows passes against a breaker that has no attribution clause at all.
 *
 *   `cf.email.sending.message.bounced`, NULL manifest_id — `applySendingEvent`'s, written when an event
 *   arrives that this Node cannot tie to anything it sent (*"a bounce nobody can attribute is still a bounce,
 *   and it must be visible"*). `doctor` reports these as `delivery_attribution`, and its fix names the usual
 *   cause: a subscription covering a domain sent from elsewhere. **This** is the row the attribution clause
 *   is load-bearing for, and without it those bounces are counted into this Node's rate.
 *
 * So both predicates are written, they answer different questions — *is this a delivery outcome of the kind
 * this rate is about* and *is this outcome about mail this Node sent* — and `test/breakers.test.ts` builds
 * both foreign corpora rather than the one the ticket named.
 *
 * ## One statement, and that is a design property rather than a small number
 *
 * Every question below — the volume count, both bounce counts, both complaint counts, whether *this* domain
 * is paused, and how many domains are paused at all — is a scalar sub-select inside a **single** `SELECT`,
 * the shape `checkDeliveryVisibility` already uses in `doctor.ts`. Measured at **1** subrequest in
 * `docs/receipts/send-breakers.md`; four statements would have cost four, on the seal path *and* on both
 * dispatch paths, and the unapproved dispatch bound has four subrequests of headroom in total.
 *
 * The last of those is asked for `doctor` rather than for a send, and it is what keeps `doctor` at one new
 * subrequest rather than two: the pause **listing** is a second statement, issued only on a Node that has one
 * to describe. Briefly it was issued unconditionally while the comment beside it claimed otherwise, which the
 * measured delta caught — the reason cost figures in this repository are measured before and after rather
 * than reasoned about.
 *
 * ## This file is on the doctor path
 *
 * `doctor.ts` imports it, so `test/node/doctor-meter-honesty.test.ts` inspects it: **no `batch()`, and no
 * prepared statement bound to a name.** Both hold here — this module writes nothing at all, and each of its
 * two `prepare` calls is chained straight into one execution. Placing the pause's *write* path in
 * `src/domain-pause.ts` rather than here is for that reason and not for tidiness: placing a pause needs
 * `auditedBatch`, and a `batch()` anywhere in this file would make `doctor.max_subrequests_per_run` stop
 * meaning what its receipt says it means.
 */

/* ---- the three rates, and what each one is a rate of ------------------------------------------ */

/**
 * Cloudflare's event type strings, spelled once.
 *
 * Named here rather than imported from `src/outbound/events.ts` because that module's `DELIVERY_STATE` map is
 * a `Record<string, string | null>` — its `keyof` is `string`, so importing it would buy no constraint at all
 * and would couple a rate definition to a rendering decision. What these are is the **denominator and
 * numerator vocabulary of a rate**, which is this module's question.
 */
const EVENT = {
  delivered: "cf.email.sending.message.delivered",
  bounced: "cf.email.sending.message.bounced",
  complained: "cf.email.sending.message.complained",
} as const;

/**
 * The three rate breakers, in evaluation order, each with the budgets that size it.
 *
 * `as const satisfies` rather than an annotation, so `keyof` is the three literal keys and `RateBreaker` is a
 * closed set rather than `string`. Annotated as `Record<string, …>` this object would have typed every lookup
 * as accepting any string — the mistake AGENTS.md's own house rule names, and the one `WITHHOLDING` already
 * records having made.
 *
 * **Everything in this map gates**, and that is what being in this map means. A breaker that must *refuse* is
 * a different mechanism rather than a different value: it goes in `WITHHOLDING` one module over, which is
 * where `state = 'withheld'` and its sentence come from. The two reason lists are asserted disjoint, so a
 * fourth breaker cannot be quietly both.
 */
export const RATE_BREAKERS = {
  volume: {
    reason: "breaker_volume",
    windowBudget: "breaker.volume_window_seconds",
    limitBudget: "breaker.volume_max_recipients",
    /** A count, not a percentage: there is no denominator, and inventing one would be a rate of nothing. */
    minObservationsBudget: null,
    sentence: "This Node has handed over more mail in the last hour than its own volume breaker allows.",
  },
  bounce_rate: {
    reason: "breaker_bounce_rate",
    windowBudget: "breaker.bounce_window_seconds",
    limitBudget: "breaker.bounce_max_percent",
    minObservationsBudget: "breaker.bounce_min_observations",
    sentence: "Too many of the addresses this Node sent to are being refused by their own mail servers.",
  },
  complaint_rate: {
    reason: "breaker_complaint_rate",
    windowBudget: "breaker.complaint_window_seconds",
    limitBudget: "breaker.complaint_max_percent",
    minObservationsBudget: "breaker.complaint_min_observations",
    sentence: "Too many recipients marked this Node's mail as spam.",
  },
} as const satisfies Record<string, {
  reason: string;
  windowBudget: BudgetName;
  limitBudget: BudgetName;
  minObservationsBudget: BudgetName | null;
  sentence: string;
}>;

/** The three, as a type. A fourth has to be declared above before it can be written anywhere. */
export type RateBreaker = keyof typeof RATE_BREAKERS;

/** The order they are evaluated and reported in. Declaration order, so the source is the answer. */
export const RATE_BREAKER_NAMES = Object.keys(RATE_BREAKERS) as RateBreaker[];

/**
 * The tokens `send_manifests.state_reason` can carry from a rate gate, derived from the map that writes them.
 *
 * Derived rather than written out for the reason `POLICY_REASONS` gives one module over: a second literal list
 * of the same three tokens is a claim nothing keeps true. The **words** for them live in
 * `src/client/delivery.client.js`, which owns every send-state sentence, and
 * `test/outbound-recheck.test.ts` reads this against the exact bytes a browser is served.
 */
export const BREAKER_REASONS: readonly string[] =
  RATE_BREAKER_NAMES.map((name) => RATE_BREAKERS[name].reason);

/** Is this `state_reason` a rate gate — the one `awaiting` reason that clears without anybody acting? */
export function isBreakerReason(reason: string | null): boolean {
  return reason !== null && BREAKER_REASONS.includes(reason);
}

/* ---- what one evaluation answers ------------------------------------------------------------- */

export interface RateReading {
  breaker: RateBreaker;
  /**
   * Rows inside the window this rate is computed **over**: hand-overs for volume, answered outcomes for
   * bounce, accepted messages for complaint. Zero means there is nothing to read, not that the rate is 0%.
   */
  observations: number;
  /** The numerator: recipients handed over, addresses refused, complaints raised. */
  observed: number;
  /**
   * Whole percent, or `null` — and `null` means two different things that are the same answer here.
   *
   * Volume has no denominator, so it has no percentage at all. **An unarmed rate has no *trustworthy* one**,
   * and this field is blank rather than `0` for the reason AGENTS.md gives in as many words: *an unverified
   * number is worse than a blank, because a blank prompts a question and a wrong number ends one*. A rate
   * with three observations behind it is that number. `armed` beside this says which of the two it is.
   *
   * It was `0` here first, while the comment on `armed` below claimed the reading *"never reports a
   * reassuring 0%"* — true of `doctor`, which does not print one, and false of `GET /api/breakers`, which
   * served the field. A claim nothing enforces is the defect; this is the enforcement.
   */
  percent: number | null;
  limit: number;
  windowSeconds: number;
  /**
   * False when there are too few observations for the rate to mean anything.
   *
   * **An unarmed breaker never trips**, and it never reports a reassuring 0% either. A bounce-rate breaker
   * reading 0% because the delivery channel is dead is the silent failure this whole mechanism exists to
   * prevent, and `doctor` already computes that predicate. Failing *closed* on no observations was rejected:
   * a Node that has never sent would refuse to send.
   */
  armed: boolean;
  /** Why not armed, when it is not. One value today, and it is a closed set rather than a free string. */
  unarmedReason: "no_observations" | null;
  tripped: boolean;
  /**
   * Seconds until the oldest row that could change this answer leaves the window, or `null` when nothing is
   * inside it.
   */
  retryAfterSeconds: number | null;
  /**
   * Is `retryAfterSeconds` when it **clears**, or the earliest it **can**?
   *
   * Exact for volume: the count is the thing compared, so the instant the oldest hand-over ages out the count
   * is strictly lower. **Not exact for a rate**, and this field exists rather than a comment because the
   * difference is a claim a caller would otherwise make wrongly: the oldest *bounce* leaving the window drops
   * the numerator, but the denominator moves too, so the rate may still be over. It is a lower bound on when
   * the answer can change, which is the strongest true statement available.
   */
  retryAfterExact: boolean;
}

export interface DomainPauseInForce {
  pauseId: string;
  domain: string;
  placedAt: string;
  reason: string;
}

export interface BreakerDecision {
  /** In force on the sending domain, so this send must not go at all. Null when it is not paused. */
  pause: DomainPauseInForce | null;
  /** Every rate, tripped or not. `doctor` shows all three; a send reads `gate`. */
  rates: RateReading[];
  /** The first tripped rate in declaration order, or null. */
  gate: RateReading | null;
  /**
   * How many domains are paused anywhere in this organization — not just the one asked about.
   *
   * For `doctor`, which uses it to decide whether the second statement (`pausesInForce`) is worth issuing at
   * all. A send never reads it: `pause` above is the answer to *this* send's question.
   */
  pausedDomains: number;
}

/* ---- the one statement ------------------------------------------------------------------------ */

/**
 * The attribution clause, spelled once and interpolated into every counting sub-select below.
 *
 * A constant rather than six copies, because six copies is six chances for one of them to be dropped — and
 * the one dropped would count another system's bounces into this Node's rate, which is the exact inversion
 * the clause exists to prevent. Interpolated rather than bound because it contains no value.
 */
const ATTRIBUTED = "manifest_id IS NOT NULL";

/**
 * Every question one evaluation asks, as scalar sub-selects in one statement.
 *
 * **The bounce denominator is `delivered + bounced`**, not every event: a rate over *outcomes a receiving
 * server answered with* is the question "how many of the addresses we tried are being refused". `failed` and
 * `rejected` are excluded from both halves deliberately — `src/outbound/events.ts` keeps them as their own
 * words precisely because they are not a receiving server refusing, and telling somebody their recipients are
 * bouncing when Cloudflare had an internal problem is a false statement about a third party's mail server.
 *
 * **The complaint denominator is `delivered`**, because a complaint can only follow a delivery: a person
 * cannot mark as spam a message that never arrived. Dividing complaints by attempts instead would understate
 * the rate on a Node with a bad list, which is the permissive direction.
 *
 * `MIN(...)` over an ISO-8601 UTC string is chronological because that encoding sorts lexicographically —
 * the same property `dispatchDue`'s `release_at <= ?` comparison already rests on.
 *
 * The pause sub-selects bind the sending domain, and **binding NULL is how `doctor` asks the rate questions
 * without asking the pause one**: `domain = NULL` is never true in SQL, so a null parameter answers "no
 * domain, therefore no pause" without a second statement or a sentinel value that could collide with a real
 * domain.
 */
const BREAKER_SQL = `
SELECT
  (SELECT COUNT(*) FROM send_recipients
    WHERE org_id = ?1 AND submission_state = 'handed_over' AND submission_state_at > ?2) AS volume_n,
  (SELECT MIN(submission_state_at) FROM send_recipients
    WHERE org_id = ?1 AND submission_state = 'handed_over' AND submission_state_at > ?2) AS volume_oldest,

  (SELECT COUNT(*) FROM send_recipient_events
    WHERE org_id = ?1 AND ${ATTRIBUTED} AND received_at > ?3
      AND event_type IN ('${EVENT.delivered}', '${EVENT.bounced}')) AS bounce_obs,
  (SELECT COUNT(*) FROM send_recipient_events
    WHERE org_id = ?1 AND ${ATTRIBUTED} AND received_at > ?3
      AND event_type = '${EVENT.bounced}') AS bounce_n,
  (SELECT MIN(received_at) FROM send_recipient_events
    WHERE org_id = ?1 AND ${ATTRIBUTED} AND received_at > ?3
      AND event_type = '${EVENT.bounced}') AS bounce_oldest,

  (SELECT COUNT(*) FROM send_recipient_events
    WHERE org_id = ?1 AND ${ATTRIBUTED} AND received_at > ?4
      AND event_type = '${EVENT.delivered}') AS complaint_obs,
  (SELECT COUNT(*) FROM send_recipient_events
    WHERE org_id = ?1 AND ${ATTRIBUTED} AND received_at > ?4
      AND event_type = '${EVENT.complained}') AS complaint_n,
  (SELECT MIN(received_at) FROM send_recipient_events
    WHERE org_id = ?1 AND ${ATTRIBUTED} AND received_at > ?4
      AND event_type = '${EVENT.complained}') AS complaint_oldest,

  (SELECT id FROM domain_pauses
    WHERE org_id = ?1 AND domain = ?5 AND placed_at IS NOT NULL AND lifted_at IS NULL) AS pause_id,
  (SELECT placed_at FROM domain_pauses
    WHERE org_id = ?1 AND domain = ?5 AND placed_at IS NOT NULL AND lifted_at IS NULL) AS pause_at,
  (SELECT reason FROM domain_pauses
    WHERE org_id = ?1 AND domain = ?5 AND placed_at IS NOT NULL AND lifted_at IS NULL) AS pause_reason,

  -- How many domains are paused ANYWHERE in this organization, which is a different question from the three
  -- above and is asked for doctor rather than for the send.
  --
  -- A seventh sub-select in a statement that was already being issued, so it costs nothing -- and what it
  -- buys is that doctor lists the pauses only when there are some. Without it the listing would run on every
  -- claimed run to report nothing on almost all of them: a second subrequest spent on every Node so that a
  -- minority can be told something.
  --
  -- No backticks in this comment: it sits inside a TypeScript template literal, so one would end it. That
  -- hazard has now bitten five times in this codebase (ui.ts, response-clock.ts, doctor.ts, and here twice).
  (SELECT COUNT(*) FROM domain_pauses
    WHERE org_id = ?1 AND placed_at IS NOT NULL AND lifted_at IS NULL) AS pauses_in_force`;

interface BreakerRow {
  volume_n: number;
  volume_oldest: string | null;
  bounce_obs: number;
  bounce_n: number;
  bounce_oldest: string | null;
  complaint_obs: number;
  complaint_n: number;
  complaint_oldest: string | null;
  pause_id: string | null;
  pause_at: string | null;
  pause_reason: string | null;
  pauses_in_force: number;
}

function windowStart(now: number, seconds: number): string {
  return new Date(now - seconds * 1000).toISOString();
}

/** Seconds until `oldest` leaves a window of `seconds`, floored at 1 so a caller never reads "retry in 0". */
function retryAfter(now: number, oldest: string | null, seconds: number): number | null {
  if (oldest === null) return null;
  const parsed = Date.parse(oldest);
  if (Number.isNaN(parsed)) return null;
  return Math.max(1, Math.ceil((parsed + seconds * 1000 - now) / 1000));
}

function reading(
  breaker: RateBreaker,
  now: number,
  observed: number,
  observations: number,
  oldest: string | null,
): RateReading {
  const spec = RATE_BREAKERS[breaker];
  const windowSeconds = BUDGETS[spec.windowBudget];
  const limit = BUDGETS[spec.limitBudget];
  const floor = spec.minObservationsBudget === null ? 0 : BUDGETS[spec.minObservationsBudget];

  // A count breaker has no denominator, so it is armed as soon as it exists; a rate breaker needs enough
  // observations for a percentage to mean anything. One bounce out of two is 50% and says nothing.
  const armed = spec.minObservationsBudget === null || observations >= floor;
  // Null for a count breaker (no denominator) and null for an unarmed rate (no trustworthy one). `0` here
  // would be the reassuring figure this whole mechanism exists to refuse: a Node whose delivery channel is
  // dead reads zero bounces, and a client reading `percent` without reading `armed` would be told it is fine.
  const percent = spec.minObservationsBudget === null || !armed
    ? null
    : Math.round((observed / observations) * 100);

  return {
    breaker,
    observations,
    observed,
    percent,
    limit,
    windowSeconds,
    armed,
    unarmedReason: armed ? null : "no_observations",
    // The comparison, and it is `>` rather than `>=` for the count and `>` for the percentage alike: the
    // budget is what is allowed, so reaching it is not exceeding it. `assertWithinBudget` uses the same test.
    tripped: armed && (percent === null ? observed > limit : percent > limit),
    retryAfterSeconds: retryAfter(now, oldest, windowSeconds),
    retryAfterExact: spec.minObservationsBudget === null,
  };
}

/**
 * Asks every breaker about one send. One D1 statement, no writes.
 *
 * `senderDomain` is the domain of the envelope From — the domain this Node is sending *as*, which is the
 * domain a pause can stop. Pass `null` to ask only the rate questions, which is what `doctor` does.
 */
export async function evaluateBreakers(
  env: Env,
  ctx: Ctx,
  orgId: string,
  senderDomain: string | null,
): Promise<BreakerDecision> {
  const now = ctx.now();
  const row = await env.CATALOG.prepare(BREAKER_SQL)
    .bind(
      orgId,
      windowStart(now, BUDGETS["breaker.volume_window_seconds"]),
      windowStart(now, BUDGETS["breaker.bounce_window_seconds"]),
      windowStart(now, BUDGETS["breaker.complaint_window_seconds"]),
      senderDomain,
    )
    .first<BreakerRow>();

  // A Node whose tables cannot be read is not a Node whose breakers are clear, but it is also not one that
  // should refuse every send on a missing row: `first()` returns null only when the statement matched
  // nothing, and a statement of scalar sub-selects always produces exactly one row. Treated as zeros with
  // the reason stated rather than thrown, because throwing here would leave a seal with no manifest at all.
  const counts: BreakerRow = row ?? {
    volume_n: 0, volume_oldest: null,
    bounce_obs: 0, bounce_n: 0, bounce_oldest: null,
    complaint_obs: 0, complaint_n: 0, complaint_oldest: null,
    pause_id: null, pause_at: null, pause_reason: null, pauses_in_force: 0,
  };

  const rates = [
    reading("volume", now, counts.volume_n, counts.volume_n, counts.volume_oldest),
    reading("bounce_rate", now, counts.bounce_n, counts.bounce_obs, counts.bounce_oldest),
    reading("complaint_rate", now, counts.complaint_n, counts.complaint_obs, counts.complaint_oldest),
  ];

  return {
    pause: counts.pause_id === null || counts.pause_at === null || counts.pause_reason === null
      // Every field or none. A half-populated pause would let a caller render "paused since null", and the
      // reason is the field the person reading the refusal actually needs.
      ? null
      : {
        pauseId: counts.pause_id,
        domain: senderDomain ?? "",
        placedAt: counts.pause_at,
        reason: counts.pause_reason,
      },
    rates,
    gate: rates.find((rate) => rate.tripped) ?? null,
    pausedDomains: counts.pauses_in_force,
  };
}

/** Every domain pause in force, for `doctor` and for the lift path's refusals. One statement, no writes. */
export async function pausesInForce(env: Env, orgId: string): Promise<DomainPauseInForce[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT id, domain, placed_at, reason FROM domain_pauses
      WHERE org_id = ? AND placed_at IS NOT NULL AND lifted_at IS NULL ORDER BY domain`,
  ).bind(orgId).all<{ id: string; domain: string; placed_at: string; reason: string }>();
  return results.map((paused) => ({
    pauseId: paused.id,
    domain: paused.domain,
    placedAt: paused.placed_at,
    reason: paused.reason,
  }));
}

/* ---- what a person is told -------------------------------------------------------------------- */

/**
 * The four parts AGENTS.md requires of every budget failure: the named budget with its number, the ask, the
 * identifiers, and the exact way to change the limit.
 *
 * Built here rather than thrown as a `BudgetExceededError` because a breaker trip is **not an exception** —
 * the send is gated, the row is written, and this text goes into `send_manifests.last_error` where the sender
 * reads it. Same four parts, same receipt line, delivered as a state rather than as a stack.
 *
 * The raise command is `pnpm receipts` rather than a `mailda policy set`, and that is the honest one: these
 * numbers are generated from `docs/receipts/*.md` and `packages/budgets` is never hand-edited, so editing the
 * receipt **is** how the limit changes. Pointing at a command that does not exist would be worse than
 * pointing at none.
 */
export function describeTrip(rate: RateReading): string {
  const spec = RATE_BREAKERS[rate.breaker];
  const origin = BUDGET_ORIGINS[spec.limitBudget];
  const ask = rate.percent === null ? `${rate.observed}` : `${rate.percent}% of ${rate.observations}`;
  const clears = rate.retryAfterSeconds === null
    ? "as soon as the window clears"
    : `${rate.retryAfterExact ? "in" : "no sooner than"} ${rate.retryAfterSeconds}s`;
  return `${spec.sentence} E_SEND_RATE_BREAKER ${spec.limitBudget}=${rate.limit}, this Node is at ${ask} `
    + `over the last ${Math.round(rate.windowSeconds / 60)} minutes. It has not left and it is not lost: it `
    + `goes when the window clears, ${clears}. receipt ${origin.receipt}; raise it by editing that receipt `
    + "and re-running pnpm receipts.";
}
