import { BUDGETS } from "@mailda/budgets";
import { butler as butlerSchema } from "@mailda/butler-ast";

/**
 * The Butler pause: #66's second abuse breaker, latched on the Butler, evaluated at trigger time (#75, §18).
 *
 * ## What kind of breaker this is, which decides everything else in this file
 *
 * #66 split breakers in two and the split runs down the middle of every question here. A **rate** breaker is
 * a question re-asked per act — *too much, too fast, and the thing is still wanted* — so it gates to
 * `awaiting` and clears when the window slides. An **abuse** breaker means *this must not happen at all*, so
 * it latches in a row and only a person removes it. `domain_pauses` is the first; this is the second.
 *
 * A paused Butler therefore **does not run**. Not a run that starts and refuses, not a queue of runs somebody
 * releases later: no run at all. That is what makes its observable **silence**, and silence is the one thing
 * `doctor` exists to distinguish from health — which is why `checkButlerPauses` in `src/doctor.ts` is part of
 * this feature rather than a nicety on top of it.
 *
 * ## Keyed on the Butler, never on a version
 *
 * Migration 0029 carries the argument in full. The short form: #49 froze a published version in both AST and
 * source, so auto-disabling cannot be a mutation of the version; and **republishing a fixed Butler must not
 * silently clear a pause the machine placed**, which a version-keyed pause would do the moment somebody
 * changed a comment. The cost — a fix needs an explicit resume as well as a publish — is accepted, because
 * that is the act somebody should have to perform.
 *
 * ## Two evaluation points, and both cost nothing
 *
 * `butler.pause_check_added_subrequests` is **0**, pinned as an equality rather than bounded, because it is a
 * count of the statements this check adds and the count is none:
 *
 *   trigger time      `PAUSE_AND_LOOP_COLUMNS` below are correlated sub-selects on the read of published
 *                     versions `triggerButlers` already issues. A paused Butler starts no run.
 *   per invocation    `PAUSE_COLUMNS_FOR_RUN` are scalar sub-selects on the read of
 *                     `butler_runs.subrequests_spent` the interpreter already issues once per invocation,
 *                     deliberately outside a `step.do` because it must not be cached. So a run that has been
 *                     asleep for thirty days re-asks the question when it wakes.
 *
 * **The second point is the answer to a real problem rather than symmetry for its own sake.** #50 measured
 * that a workflow outlives the Worker that declared it, and a `wait` node reaches 365 days. A pause that
 * stopped new triggers and let ten thousand parked instances wake up and act would be a pause in name only.
 * A run that finds its Butler paused ends `refused` with `butler_paused` **without touching its counts**
 * (`abandonRun`), because the effects it already performed are facts and this act does not know what they
 * were — only that the Butler is stopped.
 *
 * ## This module is read-only, and that is a constraint rather than a description
 *
 * `src/doctor.ts` imports it, so `test/node/doctor-meter-honesty.test.ts` inspects it: **no `batch()`, and no
 * prepared statement bound to a name**. Both hold — nothing here writes, and each `prepare` is chained
 * straight into one execution. Placing and resuming a pause are transactions, so they live in
 * `src/butler/pause-acts.ts`. That is the same seam `src/deciders.ts`, `src/notice-delivery.ts` and
 * `src/breakers.ts` were carved out along, for the same reason.
 */

/* ---- the vocabulary --------------------------------------------------------------------------- */

/**
 * Every reason a Butler pause can carry, as a closed list.
 *
 * One member today. A list rather than a bare constant for the reason `BREAKER_REASONS` and `BUTLER_REASONS`
 * are lists: a second detector has to join a vocabulary something reads, rather than inventing a string that
 * becomes a category of one.
 *
 * **Two things read it, which is what stops it being a declaration nothing consumes** — the defect this
 * repository has now recorded several times. `PauseReason` below is derived from it, so `placeButlerPause`
 * cannot be handed a string outside it; and `isPauseReason` is what `doctor` and the resume path use to decide
 * whether a *stored* reason is one this build knows about, which a type cannot answer about a row read back
 * from a database somebody else may have written to.
 */
export const PAUSE_REASONS = ["loop_detected"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/**
 * Is this stored reason one this build declares?
 *
 * Not a type guard for its own sake: a `butler_pauses` row is data, and data can be written by somebody with
 * direct database access — the same argument that makes `interpret` re-check a stored AST. A reason outside the
 * vocabulary is not a crash and it is not silently rendered as though it were understood; `doctor` says the
 * build does not know it, which is a state a person can act on.
 */
export function isPauseReason(reason: string): reason is PauseReason {
  return (PAUSE_REASONS as readonly string[]).includes(reason);
}

/** A pause in force. Every field or none — see `pausedFrom`. */
export interface ButlerPaused {
  pauseId: string;
  reason: string;
  placedAt: string;
}

/** A pause in force, with everything a person reading `doctor` or the listing needs. */
export interface ButlerPauseRow extends ButlerPaused {
  butlerId: string;
  butlerName: string;
  detail: string;
  trippedBy: string;
}

/**
 * What the loop detector read, for one Butler, at one trigger.
 *
 * `selfProvoked` is *how many links of a chain this Butler made itself*, inside the window, **counting the
 * delivery being decided**. See `docs/receipts/butler-pause.md` for what a self-provoked run is, exactly, and
 * for the two shapes this count cannot see.
 */
export interface LoopReading {
  /** Runs of this Butler inside the window whose trigger was a reply to a send this Butler made. */
  prior: number;
  /** Is the delivery in front of the trigger itself a reply to a send this Butler made? */
  thisOne: boolean;
  /** `prior` plus `thisOne`. The number compared against the limit. */
  selfProvoked: number;
  limit: number;
  windowSeconds: number;
  tripped: boolean;
}

/* ---- the causal link, spelled once ------------------------------------------------------------ */

/**
 * *"This message is a reply to a send **this Butler** made."*
 *
 * The join #66 said did not exist and #75 asked to be checked rather than assumed. It does exist, and every
 * hop is a stored column:
 *
 *   `messages.in_reply_to`            what the replying agent quoted, angle brackets already stripped by
 *                                     `mime.ts`'s `messageIds` — *"because that is the form these are
 *                                     compared in"* — so this is an equality on a value neither side
 *                                     reformats, the same property `domain_pauses.domain` rests on.
 *   `send_manifests.rfc_message_id`   *"the Message-ID this Node authors"*, `snd_<ulid>@<sending domain>`,
 *                                     emitted verbatim by `renderRfc822`.
 *   `butler_run_effects.subject`      the manifest id a `mail.send.propose` produced. A draft's subject is a
 *                                     `dft_` and a case's is a `cas_`, so the join to `send_manifests` is
 *                                     itself the filter on node type — there is no `node_type` clause here
 *                                     because it would constrain nothing.
 *   `butler_runs.butler_id`           whose run sealed it.
 *
 * A function rather than two copies, for the reason `ATTRIBUTED` is a constant in `src/breakers.ts`: two
 * copies is two chances for one of them to drift, and the one that drifted would count somebody else's reply
 * into this Butler's chain. Interpolated rather than bound because the only thing that varies is **which
 * column names the message**, and a column name is not a value.
 *
 * `v` is the `butler_versions` alias the caller correlates on. Every use is inside a sub-select of a
 * statement that has one.
 */
function provokedByThisButler(messageColumn: string): string {
  return `EXISTS (
    SELECT 1 FROM messages m
      JOIN send_manifests sm ON sm.org_id = m.org_id AND sm.rfc_message_id = m.in_reply_to
      JOIN butler_run_effects e ON e.org_id = sm.org_id AND e.subject = sm.id
      JOIN butler_runs prior ON prior.org_id = e.org_id AND prior.id = e.run_id
     WHERE m.org_id = v.org_id AND m.id = ${messageColumn} AND prior.butler_id = v.butler_id)`;
}

/**
 * The pause and the loop, as columns on a `SELECT` that already has a `butler_versions v`.
 *
 * The caller binds, in this order and no other: `?1` the organization, `?2` the `msg_` id of the delivery
 * being decided, `?3` the ISO-8601 instant the loop window starts at (`loopWindowStart`). The positions are
 * numbered rather than positional-anonymous precisely because this fragment is pasted into somebody else's
 * statement, and an unnumbered `?` would take whatever slot the surrounding SQL happened to leave it.
 *
 * Five sub-selects. Three for the pause, which are `evaluateBreakers`' three for a domain pause reached the
 * same way and for the same reason: the id, the reason and the instant are what a refusal has to be able to
 * say, and a half-populated pause would let a caller render "paused since null".
 */
export const PAUSE_AND_LOOP_COLUMNS = `
  (SELECT p.id FROM butler_pauses p
    WHERE p.org_id = v.org_id AND p.butler_id = v.butler_id AND p.resumed_at IS NULL) AS pause_id,
  (SELECT p.reason FROM butler_pauses p
    WHERE p.org_id = v.org_id AND p.butler_id = v.butler_id AND p.resumed_at IS NULL) AS pause_reason,
  (SELECT p.placed_at FROM butler_pauses p
    WHERE p.org_id = v.org_id AND p.butler_id = v.butler_id AND p.resumed_at IS NULL) AS pause_at,

  (SELECT COUNT(*) FROM butler_runs r
    WHERE r.org_id = v.org_id AND r.butler_id = v.butler_id AND r.started_at > ?3
      AND ${provokedByThisButler("r.trigger_key")}) AS loop_prior,

  (SELECT ${provokedByThisButler("?2")}) AS loop_this`;

/** The five columns above, as a row. */
export interface PauseAndLoopRow {
  pause_id: string | null;
  pause_reason: string | null;
  pause_at: string | null;
  loop_prior: number;
  loop_this: number;
}

/**
 * The pause, for a statement that has a run's ids rather than a version row.
 *
 * The caller binds `?1` the organization and `?3` the `btl_` id. `?2` is deliberately skipped so the two
 * fragments in this file agree about what `?1` means and neither has to be read to bind the other.
 */
export const PAUSE_COLUMNS_FOR_RUN = `
  (SELECT p.id FROM butler_pauses p
    WHERE p.org_id = ?1 AND p.butler_id = ?3 AND p.resumed_at IS NULL) AS pause_id,
  (SELECT p.reason FROM butler_pauses p
    WHERE p.org_id = ?1 AND p.butler_id = ?3 AND p.resumed_at IS NULL) AS pause_reason,
  (SELECT p.placed_at FROM butler_pauses p
    WHERE p.org_id = ?1 AND p.butler_id = ?3 AND p.resumed_at IS NULL) AS pause_at`;

/* ---- reading what came back -------------------------------------------------------------------- */

/**
 * A pause from its three columns, or null.
 *
 * **Every field or none**, which is `evaluateBreakers`' rule for a domain pause and is not defensive tidiness:
 * the instant and the reason are what a refusal says, and a row that answered one of the three would produce
 * a refusal missing the part the reader needs.
 */
export function pausedFrom(row: {
  pause_id: string | null; pause_reason: string | null; pause_at: string | null;
} | null | undefined): ButlerPaused | null {
  if (row == null) return null;
  if (row.pause_id === null || row.pause_reason === null || row.pause_at === null) return null;
  return { pauseId: row.pause_id, reason: row.pause_reason, placedAt: row.pause_at };
}

/** The instant the loop window starts, as the ISO-8601 string the stored timestamps sort as. */
export function loopWindowStart(now: number): string {
  return new Date(now - BUDGETS["butler.loop_window_seconds"] * 1000).toISOString();
}

/** The loop reading, from the two counts. Pure arithmetic: the comparison lives in one place. */
export function loopReading(row: Pick<PauseAndLoopRow, "loop_prior" | "loop_this">): LoopReading {
  const limit = BUDGETS["butler.loop_max_self_provoked_runs"];
  const thisOne = row.loop_this !== 0;
  const selfProvoked = row.loop_prior + (thisOne ? 1 : 0);
  return {
    prior: row.loop_prior,
    thisOne,
    selfProvoked,
    limit,
    windowSeconds: BUDGETS["butler.loop_window_seconds"],
    // `>` rather than `>=`, the same test `assertWithinBudget` and every rate breaker use: the budget is what
    // is allowed, so reaching it is not exceeding it.
    tripped: selfProvoked > limit,
  };
}

/* ---- what a person is told ---------------------------------------------------------------------- */

/**
 * AGENTS.md §3's four parts, as the sentence stored in `butler_pauses.detail`.
 *
 * Stored rather than recomputed for the reason the column's own comment gives: the number came from a
 * **windowed** count, so by the time an administrator reads the pause the rows behind it have aged out and
 * nothing can reproduce it. `send.rate_limited` records the same fact for the same reason.
 *
 * The raise command is `pnpm receipts` rather than a `mailda policy set`, and that is the honest one:
 * `packages/budgets` is generated from `docs/receipts` and never hand-edited, so editing the receipt **is**
 * how the limit changes. Pointing at a command that does not exist would be worse than pointing at none.
 */
export function describeLoopTrip(
  reading: LoopReading,
  butler: { id: string; name: string },
  messageId: string,
): string {
  return `E_BUTLER_LOOP  butler.loop_max_self_provoked_runs=${reading.limit}, ${JSON.stringify(butler.name)} `
    + `has been re-triggered ${reading.selfProvoked} time(s) by replies to mail it sent itself in the last `
    + `${Math.round(reading.windowSeconds / 60)} minutes. butler ${butler.id}  delivery ${messageId}. `
    + "This Butler is paused: it will start no further runs until an administrator resumes it with a reason "
    + "— POST /api/butler-pauses/:id/resume. Republishing it does NOT clear this. "
    + "receipt docs/receipts/butler-pause.md; raise the limit by editing that receipt and re-running "
    + "pnpm receipts.";
}

/** What the operational log says when a paused Butler is passed over, or a live run finds itself stopped. */
export function describePause(paused: ButlerPaused, butler: { id: string; name: string }): string {
  return `E_BUTLER_PAUSED  ${JSON.stringify(butler.name)} (${butler.id}) has been paused since `
    + `${paused.placedAt} (${paused.pauseId}, ${paused.reason}) and starts no runs. An administrator resumes `
    + "it with a reason — POST /api/butler-pauses/:id/resume. Publishing a new version does not resume it.";
}

/* ---- the listing ---------------------------------------------------------------------------------- */

/**
 * Every Butler pause in force, newest first, for `doctor` and for the resume path's refusals.
 *
 * One statement, no writes. Joined to `butlers` for the name, because *"Butler btl_01J… is paused"* answers
 * nothing — the same argument `createButlerDraft` makes for requiring a name at all.
 */
export async function pausesInForce(env: Env, orgId: string): Promise<ButlerPauseRow[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT p.id, p.butler_id, p.reason, p.detail, p.tripped_by, p.placed_at, b.name AS butler_name
       FROM butler_pauses p JOIN butlers b ON b.org_id = p.org_id AND b.id = p.butler_id
      WHERE p.org_id = ? AND p.resumed_at IS NULL
      ORDER BY p.placed_at DESC`,
  ).bind(orgId).all<{
    id: string; butler_id: string; reason: string; detail: string; tripped_by: string;
    placed_at: string; butler_name: string;
  }>();
  return results.map((row) => ({
    pauseId: row.id,
    butlerId: row.butler_id,
    butlerName: row.butler_name,
    reason: row.reason,
    detail: row.detail,
    trippedBy: row.tripped_by,
    placedAt: row.placed_at,
  }));
}

/* ---- what `doctor` reads -------------------------------------------------------------------------- */

/**
 * One published Butler, as `doctor` sees it.
 *
 * `triggerMailbox` is parsed out of the frozen `ast_json` rather than read from a column, for the reason
 * `triggerButlers` gives about doing the same thing: a projected trigger column would be a second copy of a
 * fact inside a frozen AST, and therefore a thing that can disagree with the program. `null` means the stored
 * AST would not parse — which `triggerButlers` also survives, counting it in `notStarted`.
 */
export interface PublishedButlerState {
  butlerId: string;
  butlerName: string;
  versionId: string;
  publishedAt: string | null;
  triggerMailbox: string | null;
  runsSincePublished: number;
  lastRunAt: string | null;
  /**
   * The pause in force on this Butler, with the sentence and the delivery behind it.
   *
   * A pause is always visible here, and that rests on a lifecycle property rather than on luck: a pause is
   * placed at trigger time, which only reaches a Butler that has a **published** version, and 0027's
   * `btv_forward_only` means a published version never stops being one except by being superseded by another.
   * So every paused Butler has exactly one row in this listing. Said rather than assumed, because if that
   * ever stopped holding this check would go quiet on the pauses it exists to show.
   */
  paused: (ButlerPaused & { detail: string; trippedBy: string }) | null;
}

/** The org-wide facts the loop detector's own visibility rests on. Same value on every row of the statement. */
export interface LoopVisibility {
  /** Inbound messages carrying an `In-Reply-To` this Node could read. Zero means the detector cannot fire. */
  threadedInbound: number;
  /** Sends a Butler has proposed. Zero means there is nothing that could be looping. */
  butlerSends: number;
}

export interface ButlerPauseReport {
  butlers: PublishedButlerState[];
  visibility: LoopVisibility;
}

/**
 * Every published Butler, its pause, its run history since publication, and what the loop detector can see.
 *
 * **One statement**, the shape `evaluateBreakers` and `checkDeliveryVisibility` use: the pause fields and the
 * two run figures are correlated sub-selects on `v`, and the two visibility counts are org-wide scalars that
 * come back identical on every row. Asking for them here rather than in a statement of their own is the
 * seventh-sub-select trick `evaluateBreakers` uses for `pausesInForce` — a question added to a statement
 * already being issued costs nothing, and it is what keeps `doctor`'s delta for this whole feature at +1 on a
 * Node with no Butlers.
 *
 * **`runs_since_published` is anchored on publication rather than on a window, and that is deliberate.** A
 * window would need a figure for *"how long may a Butler legitimately go without running"*, and nothing has
 * measured that — a Butler on a quiet mailbox may honestly go a month. Publication is an instant this schema
 * already records, so the question becomes *"has this version ever run since it went live"*, which needs no
 * number at all.
 */
export async function publishedButlerState(env: Env, orgId: string): Promise<ButlerPauseReport> {
  const { results } = await env.CATALOG.prepare(
    `SELECT v.id AS version_id, v.butler_id, v.ast_json, v.published_at, b.name AS butler_name,
      (SELECT p.id FROM butler_pauses p
        WHERE p.org_id = v.org_id AND p.butler_id = v.butler_id AND p.resumed_at IS NULL) AS pause_id,
      (SELECT p.reason FROM butler_pauses p
        WHERE p.org_id = v.org_id AND p.butler_id = v.butler_id AND p.resumed_at IS NULL) AS pause_reason,
      (SELECT p.placed_at FROM butler_pauses p
        WHERE p.org_id = v.org_id AND p.butler_id = v.butler_id AND p.resumed_at IS NULL) AS pause_at,
      (SELECT p.detail FROM butler_pauses p
        WHERE p.org_id = v.org_id AND p.butler_id = v.butler_id AND p.resumed_at IS NULL) AS pause_detail,
      (SELECT p.tripped_by FROM butler_pauses p
        WHERE p.org_id = v.org_id AND p.butler_id = v.butler_id AND p.resumed_at IS NULL) AS pause_tripped_by,
      (SELECT COUNT(*) FROM butler_runs r
        WHERE r.org_id = v.org_id AND r.butler_id = v.butler_id
          AND r.started_at >= COALESCE(v.published_at, r.started_at)) AS runs_since,
      (SELECT MAX(r.started_at) FROM butler_runs r
        WHERE r.org_id = v.org_id AND r.butler_id = v.butler_id) AS last_run_at,
      (SELECT COUNT(*) FROM messages m
        WHERE m.org_id = v.org_id AND m.in_reply_to IS NOT NULL) AS threaded_inbound,
      (SELECT COUNT(*) FROM butler_run_effects e
        WHERE e.org_id = v.org_id AND e.node_type = 'mail.send.propose' AND e.outcome = 'ok') AS butler_sends
     FROM butler_versions v JOIN butlers b ON b.org_id = v.org_id AND b.id = v.butler_id
     WHERE v.org_id = ? AND v.state = 'published'`,
  ).bind(orgId).all<{
    version_id: string; butler_id: string; ast_json: string; published_at: string | null;
    butler_name: string; pause_id: string | null; pause_reason: string | null; pause_at: string | null;
    pause_detail: string | null; pause_tripped_by: string | null;
    runs_since: number; last_run_at: string | null; threaded_inbound: number; butler_sends: number;
  }>();

  return {
    butlers: results.map((row) => {
      const paused = pausedFrom(row);
      return {
        butlerId: row.butler_id,
        butlerName: row.butler_name,
        versionId: row.version_id,
        publishedAt: row.published_at,
        triggerMailbox: triggerMailboxOf(row.ast_json),
        runsSincePublished: row.runs_since,
        lastRunAt: row.last_run_at,
        // Every field or none again, one level out: `pausedFrom` already refused a half-populated pause, and
        // these two are NOT NULL columns on the same row, so a non-null pause has both. The fallbacks are
        // what makes that a compiler-checked fact rather than a `!`.
        paused: paused === null ? null : {
          ...paused, detail: row.pause_detail ?? "", trippedBy: row.pause_tripped_by ?? "",
        },
      };
    }),
    // Zero rows is zero Butlers, and a Node with no Butlers has nothing that could loop. Reading the figures
    // off the first row rather than issuing a second statement is what the sub-selects are there for.
    visibility: {
      threadedInbound: results[0]?.threaded_inbound ?? 0,
      butlerSends: results[0]?.butler_sends ?? 0,
    },
  };
}

/**
 * The trigger's mailbox address, out of a stored AST, or null when the AST will not parse.
 *
 * `butlerSchema.parse` and not `checkButler`, exactly as `triggerButlers` does and for its reason: matching a
 * trigger needs the trigger, and a version whose *graph* has become uncheckable still has one.
 */
function triggerMailboxOf(astJson: string): string | null {
  try {
    return butlerSchema.parse(JSON.parse(astJson)).trigger.mailbox.trim().toLowerCase();
  } catch {
    // Not swallowed: the caller renders `null` as *"this Butler's stored program will not parse"*, which is
    // an operational state a person can act on, and `triggerButlers` counts the same row in `notStarted`.
    return null;
  }
}

/** When mail last arrived at each of this Node's addresses, and how much. One statement, no writes. */
export interface AddressActivity {
  address: string;
  deliveries: number;
  lastAt: string;
}

/**
 * The denominator for *"this Butler has stopped running"*, and the whole reason that question is answerable.
 *
 * A Butler that produces no runs and a Butler nothing has triggered look identical from `butler_runs` — the
 * `no_observations` shape #66 named one layer up. What separates them is whether **mail arrived at the
 * address its trigger names**, and this is that fact, per address, in one grouped statement over
 * `ingress_receipts` alone.
 *
 * `envelope_to` rather than a join through `addresses` and `messages`: it is the column
 * `materialiseReceipt` resolves the mailbox through, so it is the same value the trigger's own comparison
 * ends up making, and reading one table is cheaper than joining three.
 *
 * **The residual, stated rather than implied:** this is a grouped read whose *rows read* grow with inbound
 * volume, bounded by `since` — the earliest publication among live Butlers — and not by a constant.
 * `doctor.max_subrequests_per_run` bounds subrequests, never rows, and `checkDeliveryVisibility` is in the
 * same position. It is issued only when this Node has at least one published Butler.
 */
export async function deliveryActivity(env: Env, orgId: string, since: string): Promise<AddressActivity[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT envelope_to AS address, COUNT(*) AS deliveries, MAX(accepted_at) AS last_at
       FROM ingress_receipts WHERE org_id = ? AND accepted_at >= ? GROUP BY envelope_to`,
  ).bind(orgId, since).all<{ address: string; deliveries: number; last_at: string }>();
  return results.map((row) => ({
    // Lowercased and trimmed on both sides, which is the comparison `triggerButlers` makes on the same two
    // values. A second normalisation rule here would be a second answer to "is this the mailbox".
    address: row.address.trim().toLowerCase(),
    deliveries: row.deliveries,
    lastAt: row.last_at,
  }));
}
