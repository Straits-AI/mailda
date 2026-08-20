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
 * ## What this is not, and where the seam is
 *
 * **Not #53's ledger.** No step inputs, no recorded LLM or connector output, no cached step result, and
 * therefore none of the four replay modes. The seam is named here so it is not discovered: a ledger is
 * additive over these two tables and keyed on `butler_runs.id`. Nothing in this module reads a column that
 * does not exist or writes one that is always NULL, which is the placeholder shape
 * `test/node/placeholder-columns.test.ts` exists to catch.
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

export interface RunIdentity {
  /** The Workflow instance id: `<butlerVersionId>-<triggerKey>`. */
  readonly runId: string;
  readonly orgId: string;
  readonly butlerId: string;
  readonly versionId: string;
  readonly triggerEvent: string;
  readonly triggerKey: string;
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
        started_at, finished_at, nodes_executed, effects, refusals, subrequests_spent)
     VALUES (?,?,?,?,?,?, 'running', ?, NULL, ?, NULL, 0, 0, 0, 0)`,
  ).bind(
    identity.runId, identity.orgId, identity.butlerId, identity.versionId,
    identity.triggerEvent, identity.triggerKey, at, at,
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

/** Writes the terminal state and the counts together, so they cannot describe different sets of rows. */
export async function closeRun(
  env: Env,
  ctx: Ctx,
  orgId: string,
  runId: string,
  state: TerminalState,
  reason: string | null,
  counts: RunCounts,
): Promise<void> {
  const at = new Date(ctx.now()).toISOString();
  await env.CATALOG.prepare(
    `UPDATE butler_runs
        SET state = ?, state_at = ?, outcome_reason = ?, finished_at = ?,
            nodes_executed = ?, effects = ?, refusals = ?
      WHERE org_id = ? AND id = ? AND state IN (${LIVE.map(() => "?").join(", ")})`,
  ).bind(
    state, at, reason, at, counts.nodesExecuted, counts.effects, counts.refusals,
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
}

const RUN_COLUMNS =
  `id, butler_id, version_id, trigger_event, trigger_key, state, state_at, outcome_reason,
   started_at, finished_at, nodes_executed, effects, refusals, subrequests_spent`;

/** One run. */
export async function runRow(env: Env, orgId: string, runId: string): Promise<RunRow | null> {
  return await env.CATALOG.prepare(
    `SELECT ${RUN_COLUMNS} FROM butler_runs WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, runId).first<RunRow>();
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
