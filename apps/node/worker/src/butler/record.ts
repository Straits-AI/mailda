import type { Ctx } from "@mailda/runtime";

/**
 * The run record: **did it run, what did it do, and what refused it** (#50, migration 0028).
 *
 * ## Why this is separate from the Workflow's own state
 *
 * `workflow-provisioning.md` measured instance state and logs as retained 3 days on Workers Free and 30 on
 * Paid. So a Workflow instance is *execution state that expires*, not a record, and #50's resolution splits
 * them on exactly that line: the Workflow owns execution, D1 owns the record. A view over instance state
 * would have gone blank at 30 days for every send a Butler ever proposed.
 *
 * ## The seam this file named is now closed, and it closed **here** rather than beside this
 *
 * This paragraph used to say *"not #53's ledger"* and point at a table nobody had built. #53 landed as four
 * columns on these two tables (migration 0030) rather than as tables of its own, for the reason 0028 gave when
 * it named the seam: a ledger is *additive over these two tables, keyed on `butler_runs.id`*, and a second set
 * of run tables beside them would be two accounts of one run that can disagree.
 *
 * So what a run records now also includes **what it was given** (`trigger_facts`, the `event.*` root the
 * trigger assembled) and **whether it is a replay** (`replay_of`, `replayed_by`). Those three are what
 * `inspect` could not have had otherwise: the program is frozen on `butler_versions`, the outcome is in
 * `butler_run_effects`, and the input lived only in Workflow instance params, which expire in 3 days on Free
 * and 30 on Paid.
 *
 * What is still deliberately absent is a row per **step**, and per-step recorded LLM or connector output. The
 * first is 0028's own argument unchanged — a pure node performs no I/O and costs 0, so a row each is storage
 * bought for arithmetic nobody can be asked about — and the second has nothing to record until Layer 6 has an
 * LLM or a connector. `src/butler/replay.ts` says both out loud rather than letting a reader infer that the
 * effect list is the walk.
 *
 * ## Most of this file returns **statements**, and that is what keeps the writes atomic and cheap
 *
 * `caseForDelivery` set the idiom: a function that returns a `D1PreparedStatement` lets its caller commit it
 * *in the same batch* as the thing it records. Here it buys two properties at once. A run's effect row, its
 * accumulated spend and — when there is one — its park all land in one transaction, so a record that
 * disagrees with itself is unrepresentable; and D1 runs a batch as one round trip, so three statements cost
 * **one** subrequest against a pot the run has to fit inside.
 *
 * ## Every write is idempotent, because a Workflow step is retried
 *
 * A `step.do` body runs again on retry, so a record write inside one has to be safe twice. The two inserts
 * are `INSERT OR IGNORE` against a key the run *derives* rather than mints — the run's own id, and the
 * effect's position in the walk — which is #9's shape reached from a third direction: the conflict is the
 * signal, and here the signal is *"this was already recorded"*.
 *
 * Terminal state is an `UPDATE` gated on the run still being live, for the reason `auditedBatch`'s gate
 * exists: a second terminal write would move `finished_at` and the counts to describe a run that finished
 * twice.
 */

/** Every state a run can be in. */
export const RUN_STATES = [
  /** The interpreter is walking the graph. */
  "running",
  /** Parked on `step.waitForEvent` for a human to release a send it proposed. */
  "awaiting_release",
  /** The graph ran out of nodes. */
  "finished",
  /** A `stop` node ended it, or a release gate timed out. The reason says which. */
  "stopped",
  /**
   * The run stopped **itself**: its AST no longer checks, a `validate` did not hold, it ran out of pot, or
   * its Butler was paused (#75) while it was in flight — in which case the counts on the row are the ones the
   * run last wrote, because `abandonRun` and not `closeRun` is what ends it.
   */
  "refused",
  /** A fault: an unresolvable path, a schema this engine cannot honour, a loop past its own bound. */
  "failed",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** The states from which a run can still move. Everything else is written once and never again. */
const LIVE: readonly RunState[] = ["running", "awaiting_release"];

export type TerminalState = Exclude<RunState, "running" | "awaiting_release">;

export type EffectOutcome = "ok" | "refused" | "failed";

/**
 * That a run is a replay, and whose decision it was (#53).
 *
 * Carried on the payload rather than passed separately to the route's own write, because **two callers open
 * one row**. The replay route commits `openRunStatement` in the same `auditedBatch` as its `butler.replayed`
 * entry — the act has to be recorded or not happen — and `interpret` calls the same function again a moment
 * later.
 *
 * What makes that safe is `INSERT OR IGNORE`, which already had to make this statement a no-op twice for a
 * retried Workflow step: the second call cannot change the row whatever it binds. Carrying the fields on the
 * payload is a smaller property than that and worth having anyway — both callers derive every value from one
 * object, so the two statements are identical rather than merely both ignored.
 */
export interface RunReplay {
  /** The run being replayed. */
  readonly ofRunId: string;
  /** The person who asked. Never a Butler: a replay is a human decision to repeat an act with effects. */
  readonly byUserId: string;
}

export interface RunIdentity {
  /**
   * The Workflow instance id.
   *
   * `<butlerVersionId>-<triggerKey>` for a run a delivery caused, and `<butlerVersionId>-<replayId>` for a
   * replay — because the primary key exists to stop one delivery producing two records of one version, so a
   * replay keyed on the delivery would collide with the record it is replaying. Migration 0030 carries the
   * argument, including why the two are the same shape rather than an exception.
   */
  readonly runId: string;
  readonly orgId: string;
  readonly butlerId: string;
  readonly versionId: string;
  readonly triggerEvent: string;
  readonly triggerKey: string;
  /**
   * The `event.*` root, frozen as JSON (#53).
   *
   * The run's **input**, which is not re-derivable: `deliveryFacts` would answer about now, and a case created
   * after the run or a conversation merged since would make a "replay" a run of the same program over
   * different input. Serialized by the caller so this module has no opinion about the fact set's shape.
   */
  readonly triggerFacts: string;
  /** Absent on an ordinary run, which is a value: a run a delivery caused is nobody's act. */
  readonly replay?: RunReplay;
}

export interface EffectRecord {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly outcome: EffectOutcome;
  /** The machine token behind the outcome, or null. See migration 0028 on the two families. */
  readonly reason: string | null;
  /** What was produced or touched: a manifest id, a draft id, a case id. Where an effect key lands. */
  readonly subject: string | null;
}

export interface RunCounts {
  readonly nodesExecuted: number;
  readonly effects: number;
  readonly refusals: number;
}

/** Opens the record. Safe twice; batched with the read of the program it is about. */
export function openRunStatement(env: Env, ctx: Ctx, identity: RunIdentity): D1PreparedStatement {
  const at = new Date(ctx.now()).toISOString();
  return env.CATALOG.prepare(
    `INSERT OR IGNORE INTO butler_runs
       (id, org_id, butler_id, version_id, trigger_event, trigger_key, state, state_at, outcome_reason,
        started_at, finished_at, nodes_executed, effects, refusals, subrequests_spent,
        trigger_facts, replay_of, replayed_by)
     VALUES (?,?,?,?,?,?, 'running', ?, NULL, ?, NULL, 0, 0, 0, 0, ?,?,?)`,
  ).bind(
    identity.runId, identity.orgId, identity.butlerId, identity.versionId,
    identity.triggerEvent, identity.triggerKey, at, at,
    identity.triggerFacts, identity.replay?.ofRunId ?? null, identity.replay?.byUserId ?? null,
  );
}

/**
 * Appends one effect.
 *
 * `seq` comes from the interpreter's walk rather than from a counter read out of this table: a read would be
 * a second subrequest and would race a retry, and the walk's position is already deterministic — which is
 * what makes the UNIQUE index the idempotency mechanism rather than a constraint to work around.
 */
export function effectStatement(
  env: Env,
  ctx: Ctx,
  orgId: string,
  runId: string,
  seq: number,
  effect: EffectRecord,
): D1PreparedStatement {
  return env.CATALOG.prepare(
    `INSERT OR IGNORE INTO butler_run_effects
       (id, org_id, run_id, seq, node_id, node_type, outcome, reason, subject, at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    ctx.id("bre"), orgId, runId, seq, effect.nodeId, effect.nodeType, effect.outcome,
    effect.reason, effect.subject, new Date(ctx.now()).toISOString(),
  );
}

/**
 * The run's spend so far, written absolutely rather than incrementally.
 *
 * The caller knows what previous invocations spent (it read the column at the top of this invocation) and
 * the meter knows what this one has, so the sum is the whole run's figure and no arithmetic depends on how
 * many times this statement has run. An `x = x + delta` would double-count on a retried step, which is the
 * one shape a retried Workflow makes likely.
 */
export function spendStatement(
  env: Env,
  orgId: string,
  runId: string,
  total: number,
): D1PreparedStatement {
  return env.CATALOG.prepare(
    "UPDATE butler_runs SET subrequests_spent = ? WHERE org_id = ? AND id = ?",
  ).bind(total, orgId, runId);
}

/**
 * Parks the run: it has proposed a send and is waiting for a person.
 *
 * A state of its own rather than a flag on `running`, because *"nothing is happening and that is correct"*
 * and *"nothing is happening"* are different answers, and only the second is worth an operator's attention.
 * Gated on the run still running so a park cannot revive one that has already ended.
 */
export function parkStatement(
  env: Env,
  ctx: Ctx,
  orgId: string,
  runId: string,
  reason: string,
): D1PreparedStatement {
  return env.CATALOG.prepare(
    `UPDATE butler_runs SET state = 'awaiting_release', state_at = ?, outcome_reason = ?
      WHERE org_id = ? AND id = ? AND state = 'running'`,
  ).bind(new Date(ctx.now()).toISOString(), reason, orgId, runId);
}

/** Un-parks it. The reason is cleared: it is no longer waiting, and a stale reason is a wrong answer. */
export async function resumeRun(env: Env, ctx: Ctx, orgId: string, runId: string): Promise<void> {
  await env.CATALOG.prepare(
    `UPDATE butler_runs SET state = 'running', state_at = ?, outcome_reason = NULL
      WHERE org_id = ? AND id = ? AND state = 'awaiting_release'`,
  ).bind(new Date(ctx.now()).toISOString(), orgId, runId).run();
}

/**
 * Writes the terminal state and the counts together, so they cannot describe different sets of rows.
 *
 * **`spent` is written here, and it had to be, because `spendStatement` alone leaves the column a lie.**
 * That statement is batched with an effect and is issued nowhere else, so a run that performed no effect
 * never wrote the column at all and closed reading `subrequests_spent = 0` — its `INSERT` default — over a
 * run that really spent the engine's fixed three. The first Butler run executed against real Cloudflare
 * Workflows was a `stop`-only graph and it closed exactly that way: `nodes_executed = 1`, `effects = 0`,
 * `subrequests_spent = 0`. A number nobody had measured, in a column an operator reads as a measurement.
 *
 * It costs nothing to fix here: this `UPDATE` is already being issued, so the figure rides along in the
 * statement that ends the run. `+ 1` is this statement itself, which the meter cannot have counted yet —
 * the same adjustment `spendStatement`'s caller makes for the batch it rides in.
 *
 * **What it still does not cover, stated rather than implied.** The figure is `spentBefore + this
 * invocation`, and `spentBefore` comes from the column — so an invocation that ended in `step.sleep` without
 * performing an effect contributed nothing, and its overhead is absent from every later reading. That
 * overhead is **one** subrequest: the read of `subrequests_spent` itself, the only thing outside a
 * `step.do`, since a resumed instance serves the load batch from cache. So a run that sleeps *n* times
 * before its first effect under-reports by at most *n*, and `interpret`'s affordability guard is that much
 * less strict than its own comment claims. Closing it would mean one durable write per `wait` — a real
 * subrequest on every waiting run, and a `wait` repriced at publication — to recover an accounting slack in
 * a bound the platform does not impose in the first place (each invocation gets its own pot; accumulating
 * across them is this engine choosing to be stricter). That trade is not worth making, so the residue is
 * named here and in `docs/receipts/butler-run-cost.md` rather than paid for.
 */
export async function closeRun(
  env: Env,
  ctx: Ctx,
  orgId: string,
  runId: string,
  state: TerminalState,
  reason: string | null,
  counts: RunCounts,
  spent: number,
): Promise<void> {
  const at = new Date(ctx.now()).toISOString();
  await env.CATALOG.prepare(
    `UPDATE butler_runs
        SET state = ?, state_at = ?, outcome_reason = ?, finished_at = ?,
            nodes_executed = ?, effects = ?, refusals = ?, subrequests_spent = ?
      WHERE org_id = ? AND id = ? AND state IN (${LIVE.map(() => "?").join(", ")})`,
  ).bind(
    state, at, reason, at, counts.nodesExecuted, counts.effects, counts.refusals, spent + 1,
    orgId, runId, ...LIVE,
  ).run();
}

/**
 * Ends a run nobody can resume, **without touching the counts**.
 *
 * **Two callers, and the second is why the shape generalises rather than being a special case.**
 *
 * The first is a release that found the instance gone: the send is released, the run's execution state has
 * expired, and leaving the record reading `awaiting_release` for ever would be a lie about a run that is not
 * waiting for anything. The second is `interpret` finding its Butler **paused** (#75) at the top of an
 * invocation — a run that slept through a pause being placed, which is the case a trigger-time check
 * structurally cannot cover.
 *
 * Both write the state and the reason and nothing else, because neither act knows what the run did — only
 * that it is not going on. `closeRun` with the caller's zeroes would be either act claiming knowledge it
 * lacks.
 *
 * ## What this does **not** protect, said plainly because the obvious reading is wrong
 *
 * `nodes_executed`, `effects` and `refusals` are written by **`closeRun` alone** — not by `openRun`, not by
 * `spendStatement`, not by `parkStatement`. And `LIVE` is `running` and `awaiting_release`, so the only rows
 * this statement can match are rows that have never closed. **Therefore there is no reachable state in which
 * a run reaching here has non-zero counts to preserve**: on both paths the three columns read zero, and
 * writing zeroes over them would have been indistinguishable. Measured, not assumed —
 * `test/butler-pause.test.ts` drives a genuinely suspended run through the pause and asserts the row reads
 * `effects = 0` while `butler_run_effects` holds its two rows.
 *
 * So the reason to call this rather than `closeRun` is **not** that it rescues a figure: it is that it does
 * not *state* one. What a run performed is `butler_run_effects`, which has a row per effect written with the
 * effect in one transaction and is what `GET /api/butler-runs/:id` returns beside the row. The count columns
 * are a projection of those rows that only a close computes, and a run abandoned before it closed has the
 * rows without the projection. #53's run ledger owns closing that gap; until it does, a reader who trusts
 * `effects` on an abandoned run is reading a figure nothing ever wrote.
 */
export async function abandonRun(
  env: Env,
  ctx: Ctx,
  orgId: string,
  runId: string,
  state: TerminalState,
  reason: string,
): Promise<void> {
  const at = new Date(ctx.now()).toISOString();
  await env.CATALOG.prepare(
    `UPDATE butler_runs SET state = ?, state_at = ?, outcome_reason = ?, finished_at = ?
      WHERE org_id = ? AND id = ? AND state IN (${LIVE.map(() => "?").join(", ")})`,
  ).bind(state, at, reason, at, orgId, runId, ...LIVE).run();
}

export interface RunRow {
  id: string;
  butler_id: string;
  version_id: string;
  trigger_event: string;
  trigger_key: string;
  state: string;
  state_at: string;
  outcome_reason: string | null;
  started_at: string;
  finished_at: string | null;
  nodes_executed: number;
  effects: number;
  refusals: number;
  subrequests_spent: number;
  replay_of: string | null;
  replayed_by: string | null;
  /*
   * **Migration 0030's `trigger_facts` is deliberately not a field here**, and its absence is a disclosure
   * decision rather than a size one.
   *
   * It is the `event.*` root, which carries the triggering message's `subject`, `from` and `return_path` —
   * mail content by `trigger.ts`'s own classification — and this interface is serialized straight into three
   * JSON responses gated on `org.admin` alone: the run listing, `GET /api/butler-runs/:id`, and `inspect`.
   * Every one of them disclosed a subject line to an administrator holding nothing on the mailbox, and
   * `inspectRun`'s per-mailbox gate on the *parsed* facts would have been defeated by the raw column sitting
   * beside it in the same object.
   *
   * So the blob has exactly one reader, `triggerFactsOf` below, named for what it returns. That is the total
   * shape rather than three route-level omissions: a fourth route cannot leak a column its row does not carry.
   */
}

const RUN_COLUMNS =
  `id, butler_id, version_id, trigger_event, trigger_key, state, state_at, outcome_reason,
   started_at, finished_at, nodes_executed, effects, refusals, subrequests_spent,
   replay_of, replayed_by`;

/** One run. */
export async function runRow(env: Env, orgId: string, runId: string): Promise<RunRow | null> {
  return await env.CATALOG.prepare(
    `SELECT ${RUN_COLUMNS} FROM butler_runs WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, runId).first<RunRow>();
}

/**
 * The `event.*` root a run was given, verbatim — or null for a run opened before migration 0030.
 *
 * **The only reader of the column**, and the only way to obtain it. Split out from `runRow` because the facts
 * are mail content and a run row is not: see the note at the end of `RunRow` for why that is a function rather
 * than three careful routes. A caller reaching for this is either inheriting the input into a replay — where the
 * facts go to the program and not to a person — or disclosing them, and `inspectRun` is where the second is
 * authorized. Nothing here checks: a read this narrow is easier to audit by its call sites than by a parameter
 * it could be handed the wrong value for.
 *
 * One scalar read on a route a person triggers by hand. It runs in parallel with `programOf` on both paths, so
 * it adds no round trip to either.
 */
export async function triggerFactsOf(env: Env, orgId: string, runId: string): Promise<string | null> {
  const row = await env.CATALOG.prepare(
    "SELECT trigger_facts FROM butler_runs WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, runId).first<{ trigger_facts: string | null }>();
  return row?.trigger_facts ?? null;
}

export interface RunEffectRow {
  seq: number;
  node_id: string;
  node_type: string;
  outcome: string;
  reason: string | null;
  subject: string | null;
  at: string;
}

/** What one run did, in order. */
export async function runEffects(env: Env, orgId: string, runId: string): Promise<RunEffectRow[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT seq, node_id, node_type, outcome, reason, subject, at
       FROM butler_run_effects WHERE org_id = ? AND run_id = ? ORDER BY seq`,
  ).bind(orgId, runId).all<RunEffectRow>();
  return results;
}

/**
 * The newest runs, and nothing else.
 *
 * `limit` is a caller's page size rather than a budget, so it needs no receipt — and it is clamped here
 * anyway, because an unbounded `LIMIT ?` reached from a route is a way to read the whole table in one query.
 * `1` and `100` are ends of a range rather than measurements.
 */
export async function recentRuns(env: Env, orgId: string, limit: number): Promise<RunRow[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT ${RUN_COLUMNS} FROM butler_runs WHERE org_id = ? ORDER BY started_at DESC LIMIT ?`,
  ).bind(orgId, Math.max(1, Math.min(limit, 100))).all<RunRow>();
  return results;
}

/**
 * Every replay of one run, oldest first (#53).
 *
 * On `brn_by_replay_of`, which is partial on `replay_of IS NOT NULL` — so this reads an index holding only the
 * replays on the Node rather than one entry per run that is not one. What `inspect` needs to answer *"has
 * somebody already re-run this"* before a reader asks for another, which is the question that stops two people
 * replaying the same run twice while looking at the same screen.
 */
export async function replaysOf(env: Env, orgId: string, runId: string): Promise<Array<{
  id: string; state: string; outcome_reason: string | null; started_at: string; replayed_by: string | null;
}>> {
  const { results } = await env.CATALOG.prepare(
    `SELECT id, state, outcome_reason, started_at, replayed_by FROM butler_runs
      WHERE org_id = ? AND replay_of = ? ORDER BY started_at`,
  ).bind(orgId, runId).all<{
    id: string; state: string; outcome_reason: string | null; started_at: string; replayed_by: string | null;
  }>();
  return results;
}

/**
 * The run a manifest was proposed by, or null.
 *
 * One query, on `bre_by_subject`. What the release act needs: a person releases a **send**, and the run
 * parked on it is what has to be told. A manifest with no run is an ordinary human-composed send, which is
 * the majority case and is not an error here — it simply has nothing to resume.
 */
export async function runOfSubject(env: Env, orgId: string, subject: string): Promise<string | null> {
  const row = await env.CATALOG.prepare(
    "SELECT run_id FROM butler_run_effects WHERE org_id = ? AND subject = ? ORDER BY seq LIMIT 1",
  ).bind(orgId, subject).first<{ run_id: string }>();
  return row?.run_id ?? null;
}
