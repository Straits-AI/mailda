import { BUDGETS } from "@mailda/budgets";
import {
  checkButler, describeFindings, RUN_BUDGET, RUN_BUDGET_NAME,
  type Butler, type ButlerNode, type ShippedKind,
} from "@mailda/butler-ast";
import type { Ctx } from "@mailda/runtime";

import { log } from "../audit.ts";
import { metering, type Cost } from "../cost-meter.ts";
import { assignCase, closeCase, lookupRow, proposeSend, writeDraft, type EffectResult } from "./effects.ts";
import { ButlerFault, isTrue, evaluate, evaluateOperand, validateAgainst, type RunState } from "./expr.ts";
import { ceilingOf } from "./ceiling.ts";
import { RELEASE_TIMEOUT_BUDGET } from "./gate.ts";
import { describePause, pausedFrom, PAUSE_COLUMNS_FOR_RUN } from "./pause.ts";
import { contentIdentity, type IncumbentSend, type ReplayIncumbents } from "../outbound/manifest.ts";
import {
  abandonRun, closeRun, effectStatement, openRunStatement, parkStatement, resumeRun, spendStatement,
  type EffectRecord, type RunCounts, type RunReplay, type TerminalState,
} from "./record.ts";
import type { ButlerPrincipal } from "./principal.ts";

/**
 * The interpreter: one walk over one published AST (#50).
 *
 * ## Structure, in the order the code runs
 *
 * 1. **Load** the version's `ast_json` and open the run record, in one `batch()` — one subrequest for a
 *    read and a write, inside a `step.do` so a resumed instance pays for neither again.
 * 2. **Re-check** it with `checkButler`. Costs no subrequest and re-establishes every property publication
 *    established: no reserved node, acyclic, every edge resolves, affordable.
 * 3. **Forecast**: the checker's own price for this graph plus what the engine adds, against one instance's
 *    pot. Refuses before any effect if it cannot fit.
 * 4. **Walk** the graph from `entry`, following one edge at a time.
 * 5. **Close** the record with a terminal state, a reason and the counts.
 *
 * ## Why the interpreter is a function and the `WorkflowEntrypoint` is four lines
 *
 * `ButlerRun.run()` receives `this.env` from the platform, so an entrypoint that did the work could not be
 * metered — `metering()` wraps an env a caller passes in. So the walk takes `env`, `ctx` and a `RunSteps`,
 * and the entrypoint is an adapter that supplies the real three. Two things fall out of that, both of which
 * this layer needs: `docs/receipts/butler-run-cost.md` can measure a real run against real D1 and R2 with
 * the real cost meter, and a test can drive `wait` and the release gate without waiting for either.
 *
 * ## What is a step and what is not
 *
 * A `step.do` per node that performs I/O — the four effects and `lookup`. **Nothing else**, and that is the
 * same line `butler-step-cost.md` draws: `guard`, `switch`, `map`, `foreach`, `join`, `wait`, `stop`,
 * `transform` and `validate` are measured at **0** subrequests, so wrapping them would buy a durable record
 * of arithmetic and pay for it in step storage.
 *
 * That is only sound because the expression language is **pure** — it reads the run's state and nothing else,
 * with no clock, no randomness and no I/O (`expr.ts`). A Workflow re-runs the whole body on every resume and
 * replays cached step results, so a pure node recomputes to the same answer. A node that read `Date.now()`
 * would give two answers across a sleep and the run would take a different edge on either side of it.
 *
 * Step names are `<nodeId>#<visit>`, because a loop enters the same node many times and Workflows key a step
 * by name and occurrence. The visit counter is deterministic: it comes from the walk, which is the same walk
 * on every replay.
 *
 * ## Refusal is an outcome; a fault is not
 *
 * **Four** terminal states, and the boundaries between them are the point. `record.ts` declares *six* run
 * states and the other two — `running` and `awaiting_release` — are the live ones a run passes through, which
 * is why `TerminalState` excludes them and why `finish` can only ever write one of the four below:
 *
 * | state | means |
 * |:--|:--|
 * | `finished` | the graph ran out of nodes |
 * | `stopped` | a `stop` node ended it, or a release gate timed out — reason says which |
 * | `refused` | **the run stopped itself**: the stored AST no longer checks, a `validate` did not hold, it could not afford to go on, or its Butler was paused (#75) between the trigger and this invocation |
 * | `failed` | a fault: an unresolvable path, a schema this engine cannot honour, a loop over more items than its bound |
 *
 * A *policy* denial, a breaker, an unsatisfiable approval, a held case — none of those is any of the above.
 * They are recorded per effect and the run carries on, because being refused is the system working
 * (`effects.ts`).
 *
 * ## The reserved nodes cannot appear, and this says what happens if one does anyway
 *
 * `checkButler` refuses every reserved node at publication, and `butler_versions` freezes what was
 * published with two database triggers. So `llm.classify` in a stored AST is unreachable through every path
 * this Node has — and a stored AST is still **data**, and data can be edited by somebody with direct
 * database access. That is exactly why step 2 exists: the check runs again here, at zero cost, and a
 * reserved node makes the run **refuse itself before performing any effect**, with the checker's own
 * finding — *"reserved in the AST and refused at publication"* plus the sentence saying what is missing — in
 * the run's reason and the operational log. It is not a crash, and it is not silently skipped. The same
 * re-check catches the other three things a hand-edited row could introduce: a cycle, a dangling edge, and a
 * graph that cannot afford itself.
 *
 * ## The one thing nothing here bounds, said plainly
 *
 * A loop whose body performs no I/O costs **nothing**, so `packages/butler-ast/src/cost.ts` admits any
 * `maxItems` for it — and says so, in as many words, naming CPU as the boundary of that pass because CPU
 * cannot be metered from inside a Worker. A `foreach` of a billion pure `transform`s is therefore
 * publishable, and this engine does not refuse it either: it runs until the platform's CPU limit kills the
 * invocation. **That is unenforced by us**, deliberately, because the alternative is an iteration ceiling with
 * no measurement behind it. What is enforced is everything that spends a subrequest, which is everything that
 * touches the world.
 *
 * **And what an operator then sees is `running`, for ever** — corrected here because the obvious sentence
 * ("the step retries and the run ends `failed`") is wrong twice over. A pure loop is not inside a `step.do`
 * at all, by the rule above, so there is no step to retry; and the kill is a termination rather than a thrown
 * error, so the `catch` below never runs and neither does `finish`. The row keeps `state = 'running'` with a
 * NULL `finished_at`, which `GET /api/butler-runs` shows and nothing reaps. What the platform does with the
 * instance afterwards is **unmeasured**. Said rather than repaired: a reaper would need a staleness figure
 * with no measurement behind it, and the honest answer to "how long may a run legitimately run" is that a
 * `wait` node reaches 365 days.
 */

/** The event a release sends to a parked instance. One name, used by the run and by the release act. */
export const RELEASE_EVENT = "butler.release";

/**
 * What the interpreter needs from a Workflow, and nothing more.
 *
 * Three methods rather than the whole `WorkflowStep`: `step.do`'s config overloads, its rollback handlers
 * and `sleepUntil` are all unused, and a narrower interface is what lets a test supply a runner that
 * executes inline. `sleepUntil` in particular has no field to read — #49's `wait` node carries `seconds` and
 * nothing else — so mapping it would be a capability with no way to reach it.
 */
export interface RunSteps {
  do<T>(name: string, body: () => Promise<T>): Promise<T>;
  sleep(name: string, seconds: number): Promise<void>;
  /** Resolves with the event's payload, or rejects when the timeout passes. */
  waitForEvent(name: string, type: string, timeoutSeconds: number): Promise<unknown>;
}

/** What a trigger hands a run. Ids and facts only: the program is read from storage, never carried. */
export interface ButlerRunPayload {
  readonly orgId: string;
  readonly butlerId: string;
  readonly butlerVersionId: string;
  readonly trigger: {
    readonly event: string;
    /** The delivery this run is about, and the second half of the instance id. */
    readonly key: string;
    /** The `event` root of the run's state. */
    readonly facts: Readonly<Record<string, unknown>>;
  };
  /**
   * That this run is a replay of another, and whose decision it was (#53).
   *
   * Absent on every run a delivery caused. When present it does **three** things and it is worth listing them
   * because only the first is obvious: it lands on the run record as `replay_of`/`replayed_by`, it makes the
   * engine read the replayed run's sends so the content rule can reuse their keys, and it adds one to the
   * engine's fixed cost for that read.
   *
   * The `trigger.facts` it arrives with are the **recorded** facts of the run being replayed, copied by
   * `src/butler/replay.ts`. That is the line the whole design rests on: **a replay inherits the input and
   * re-asks the judgement.** Re-deriving the facts would run the same program over different input — a case
   * created since, a conversation merged since — which is not a replay of anything.
   */
  readonly replay?: RunReplay;
}

export interface RunResult {
  readonly runId: string;
  /** Always terminal: `interpret` returns only through `finish`, which writes one of the four. */
  readonly state: TerminalState;
  readonly reason: string | null;
  readonly nodesExecuted: number;
  readonly effects: readonly (EffectRecord & { seq: number })[];
  /** What this invocation spent, as the cost meter saw it. Reported by the measurement test. */
  readonly cost: Cost;
}

type Terminal = { state: TerminalState; reason: string | null };

/**
 * What the engine spends that no node accounts for: three subrequests, and here they are.
 *
 *   1. the `batch()` that reads the version's `ast_json` and inserts the `butler_runs` row — a read and a
 *      write for one round trip;
 *   2. the read of what previous invocations of this run already spent, once **per invocation**, so a run
 *      that sleeps pays it again;
 *   3. the terminal write.
 *
 * From `docs/receipts/butler-run-cost.md`, where it is the one figure **pinned as an equality** rather than
 * bounded with headroom: it is not a measurement of anything external, it is a count of the three statements
 * above, so a bound with slack would be a tripwire on our own arithmetic. `test/butler-run-cost.measure.test.ts`
 * measures a `stop`-only Butler and asserts exactly this.
 */
const ENGINE_FIXED_SUBREQUESTS = BUDGETS["butler.run_cost_engine_fixed"];

/**
 * What one **node** costs the engine, as opposed to what the function it calls costs.
 *
 * This is the table `docs/receipts/butler-run-cost.md` exists for, and the reason it is a second table rather
 * than a reuse of `SHIPPED_NODE_COST` is a measurement: a node is strictly more than its function — the
 * engine records what happened, and for two nodes it checks the **Butler's own** authority where the function
 * checks somebody else's. Four of the five differences fit inside the headroom `butler-step-cost.md`'s bounds
 * already carry. The fifth does not: `mail.send.propose` measures **23** against that receipt's **20**,
 * because the node reads the draft back before sealing it.
 *
 * So the guard below reserves from *this* receipt. #54's figures stay what they are — correct measurements of
 * the functions they name — and the consequence is stated rather than papered over: the publication-time
 * total is a **floor**, and this is what actually stops a sending loop overspending its pot.
 *
 * Exhaustive over `ShippedKind` by construction, like `SHIPPED_NODE_COST` and the successor map: a node
 * moving from reserved to shipped with no entry here does not compile. `null` rather than `0` so "this node
 * is free" is a decision with a name — and the nine free ones are free for the same reason they are in #54's
 * table, which is that they perform no I/O at all.
 */
const RUN_COST_OF: { [K in ShippedKind]: keyof typeof BUDGETS | null } = {
  guard: null,
  switch: null,
  map: null,
  foreach: null,
  join: null,
  wait: null,
  stop: null,
  transform: null,
  validate: null,

  lookup: "butler.run_cost_max_lookup",
  "case.assign": "butler.run_cost_max_case_assign",
  "case.close": "butler.run_cost_max_case_close",
  draft: "butler.run_cost_max_draft",
  "mail.send.propose": "butler.run_cost_max_send_propose",
};

/** What one execution of one node costs the engine, in subrequests. Zero for every node with no I/O. */
export const RUN_NODE_COST: { [K in ShippedKind]: number } = Object.fromEntries(
  Object.entries(RUN_COST_OF).map(([kind, key]) => [kind, key === null ? 0 : BUDGETS[key]]),
) as { [K in ShippedKind]: number };

interface VersionFacts {
  astJson: string;
  butlerName: string;
  /**
   * `butler_versions.published_by` — **the sponsor** whose live authority caps this version (#51).
   *
   * Read here rather than asked for separately because it is a column of the row the run was already
   * loading, which is the first half of #51's *"the pinned ceiling is free"*: the ceiling and the person it
   * is capped against arrive together, in the statement that fetches the program, for no extra subrequest.
   *
   * Nullable in the schema because a draft has no publisher. A published row with a NULL here is
   * unreachable through `publishButler` and is refused below rather than defaulted to anybody.
   */
  sponsorUserId: string | null;
}

/**
 * Runs one Butler.
 *
 * `runId` is passed rather than derived, because the instance id is the platform's and the caller is what
 * knows it — `event.instanceId` inside the entrypoint, an explicit value in a test.
 */
export async function interpret(
  rawEnv: Env,
  ctx: Ctx,
  payload: ButlerRunPayload,
  steps: RunSteps,
  runId: string,
): Promise<RunResult> {
  const { env, cost } = metering(rawEnv);
  const orgId = payload.orgId;

  /*
   * What previous invocations of this run spent, and the pot read live off it.
   *
   * Declared here rather than where it is read, because every `finish` below writes the figure into the run
   * record and the early exits reach `finish` *before* the read has happened. Zero until then is the true
   * answer at those points and not a placeholder: the read is itself the first thing this invocation does
   * beyond loading the program, so an exit above it has one invocation's cost and no history.
   */
  let spentBefore = 0;
  /** The pot, live: what previous invocations spent plus what this one has. */
  const spent = (): number => spentBefore + cost.subrequests;

  /*
   * One `batch()`: read the program, open the record. D1 runs a batch as a single transaction and the cost
   * meter prices it as the one round trip it is, so a read and a write cost one subrequest between them.
   *
   * Inside a `step.do` because its result is what every later replay needs and re-reading it on each resume
   * would be a subrequest per wait. The value returned is a string plus a name — well inside the 1 MiB
   * non-stream step ceiling, since `ast_json` and `source_text` together must already fit one D1 row.
   */
  const facts = await steps.do("load", async (): Promise<VersionFacts | null> => {
    const results = await env.CATALOG.batch([
      env.CATALOG.prepare(
        `SELECT v.ast_json AS ast_json, v.published_by AS sponsor_user_id, b.name AS butler_name
           FROM butler_versions v JOIN butlers b ON b.org_id = v.org_id AND b.id = v.butler_id
          WHERE v.org_id = ? AND v.id = ? AND v.state = 'published' LIMIT 1`,
      ).bind(orgId, payload.butlerVersionId),
      openRunStatement(env, ctx, {
        runId, orgId,
        butlerId: payload.butlerId,
        versionId: payload.butlerVersionId,
        triggerEvent: payload.trigger.event,
        triggerKey: payload.trigger.key,
        // The run's input, frozen on the row (#53). Written by the same statement as the rest of the
        // identity, so a record with no account of what it was given is not representable. On a replay the
        // route has already committed this exact row inside its own audited transaction; `INSERT OR IGNORE`
        // makes this the no-op it already had to be for a retried step, and the values cannot differ because
        // both writers read them off one payload.
        triggerFacts: JSON.stringify(payload.trigger.facts),
        ...(payload.replay === undefined ? {} : { replay: payload.replay }),
      }),
    ]);
    const row = (results[0]?.results?.[0] ?? null) as
      { ast_json: string; butler_name: string; sponsor_user_id: string | null } | null;
    return row === null
      ? null
      : { astJson: row.ast_json, butlerName: row.butler_name, sponsorUserId: row.sponsor_user_id };
  });

  const counts = { nodesExecuted: 0, effects: 0, refusals: 0 };
  const recorded: (EffectRecord & { seq: number })[] = [];

  /*
   * A run whose version is not published. Reachable two ways and neither is a bug here: the version was
   * superseded between the trigger and the run — which a queued instance behind a busy Node will meet — or
   * somebody deleted the row. Refused rather than run, because a superseded program is not the current one
   * and #49's whole lifecycle rests on a draft never executing.
   *
   * `openRun` above wrote the record with the ids the payload carries, so this refusal is visible even
   * though nothing about the program could be read.
   */
  if (facts === null) {
    return await finish(env, ctx, orgId, runId, cost, spent(), counts, recorded, {
      state: "refused", reason: "version_not_published",
    });
  }

  /*
   * The principal, with an **empty** ceiling until the AST checks out, and then with the real one.
   *
   * `let` rather than two names, because everything below this line takes one principal and a second name
   * for the same Butler is a second thing a later reader has to know which of to pass. The empty ceiling is
   * not a permissive default — an empty ceiling denies everything — and nothing between here and the
   * assignment below performs an authority check; the only use of `butler` in that stretch is `complain`,
   * which reads the ids and the name so a refusal can say which program was refused.
   */
  let butler: ButlerPrincipal = {
    orgId, butlerId: payload.butlerId, versionId: payload.butlerVersionId, name: facts.butlerName,
    ceiling: { sponsorUserId: facts.sponsorUserId ?? "", byAction: new Map() },
  };

  /*
   * A published version with no publisher.
   *
   * Unreachable through `publishButler`, which writes `published_by` in the same statement that promotes the
   * row, and unwritable afterwards since 0031 froze the column. Refused rather than defaulted, because every
   * default available is wrong: an empty sponsor would make the sponsor term match nothing and read as a
   * revocation, and treating the absence as *"no sponsor term"* would delete a term of §7's intersection for
   * exactly the row that could not account for itself.
   */
  if (facts.sponsorUserId === null) {
    await complain(env, ctx, orgId, runId, butler, "sponsor_unknown",
      `published version ${payload.butlerVersionId} records no publisher, so there is no sponsor whose live `
      + "authority this run's capability ceiling can be capped against (#51). Republish the Butler");
    return await finish(env, ctx, orgId, runId, cost, spent(), counts, recorded, {
      state: "refused", reason: "sponsor_unknown",
    });
  }

  /*
   * The re-check. Zero subrequests, and it re-establishes everything publication established — because a
   * stored AST is data, and data can be edited by somebody with database access. A reserved node, a cycle, a
   * dangling edge or a graph that cannot afford itself all land here, and all of them refuse the run *before*
   * any effect. That is the answer to "what if a reserved node appears anyway": not a crash, not silently
   * skipped, but the checker's own finding in the run's reason and in the operational log.
   */
  let parsed: unknown;
  try {
    parsed = JSON.parse(facts.astJson);
  } catch (error) {
    await complain(env, ctx, orgId, runId, butler, "ast_not_json",
      (error as Error).message.split("\n")[0] ?? "unreadable");
    return await finish(env, ctx, orgId, runId, cost, spent(), counts, recorded, {
      state: "refused", reason: "ast_not_json",
    });
  }

  const checked = checkButler(parsed);
  if (!checked.ok) {
    await complain(env, ctx, orgId, runId, butler, "ast_does_not_check",
      describeFindings(checked.findings));
    return await finish(env, ctx, orgId, runId, cost, spent(), counts, recorded, {
      state: "refused", reason: "ast_does_not_check",
    });
  }

  /*
   * The forecast: a cheap pre-check, and **a floor rather than a total**.
   *
   * #54 refuses at publication a Butler whose **nodes** cost more than one instance's pot, pricing each node
   * at what the function it calls costs. A run costs more than that — measured, and recorded in
   * `docs/receipts/butler-run-cost.md` — so this adds the engine's fixed three and catches the boundary case
   * where a graph priced at the whole pot cannot even pay for the machinery around it. Pure arithmetic, no
   * subrequest, and it refuses before any effect.
   *
   * It is deliberately **not** a re-pricing of the graph against `RUN_NODE_COST`: that would mean a second
   * implementation of `priceButler`'s multiplier arithmetic — the loop nesting, the saturating products, the
   * over-pricing rule — and two implementations of one sum is the correspondence problem this repository
   * keeps paying for. The live guard below needs no graph arithmetic at all: it reserves one node's cost at
   * a time against what the run has actually spent, which is a stronger check than any forecast because it
   * cannot be wrong about the shape of the graph.
   */
  /*
   * A replay pays **one** more than the fixed three, and it is `1` because it is one statement: the read of
   * the replayed run's sends, below. Not a measurement and therefore not a receipt — AGENTS.md's own
   * exemption for a number that is `0`/`1` and means none/one — and deliberately not folded into
   * `butler.run_cost_engine_fixed`, which is pinned as an equality at 3 for an ordinary run and is
   * re-measured as 3 by `test/butler-run-cost.measure.test.ts` and `test/butler-pause-cost.measure.test.ts`.
   */
  const engineFixed = ENGINE_FIXED_SUBREQUESTS + (payload.replay === undefined ? 0 : 1);
  const forecast = checked.cost.total + engineFixed;
  if (forecast > RUN_BUDGET) {
    await complain(env, ctx, orgId, runId, butler, "unaffordable_with_engine",
      `E_BUDGET_EXCEEDED  ${RUN_BUDGET_NAME}=${RUN_BUDGET}, this Butler's nodes cost `
      + `${checked.cost.total} and the engine adds ${engineFixed} for a forecast of ${forecast}`);
    return await finish(env, ctx, orgId, runId, cost, spent(), counts, recorded, {
      state: "refused", reason: "unaffordable_with_engine",
    });
  }

  /*
   * What previous invocations of this run already spent.
   *
   * One subrequest, per invocation, and it is what makes the guard below correct across a sleep or a park:
   * the pot is per **instance**, a resumed instance gets a fresh meter, and whether the platform's pot
   * resets with it is unmeasured. Reading the accumulated figure enforces the stricter reading, which is the
   * safe direction — over-counting refuses a run that would have fitted, under-counting kills one that has
   * already sent mail.
   *
   * Deliberately **not** inside a `step.do`: a cached step would return the figure from the first invocation
   * for ever, which is the one value that must not be cached.
   */
  const carried = await env.CATALOG.prepare(
    `SELECT
       (SELECT subrequests_spent FROM butler_runs WHERE org_id = ?1 AND id = ?2) AS subrequests_spent,
       ${PAUSE_COLUMNS_FOR_RUN}`,
  ).bind(orgId, runId, payload.butlerId).first<{
    subrequests_spent: number | null;
    pause_id: string | null; pause_reason: string | null; pause_at: string | null;
  }>();
  spentBefore = carried?.subrequests_spent ?? 0;

  /*
   * The pause, asked once **per invocation** — and this is the second half of #75's answer, not a repeat of
   * the first.
   *
   * `triggerButlers` stops a paused Butler starting a run. It cannot stop a run that was **already in
   * flight** when the pause landed, and #50 measured that a workflow outlives the Worker that declared it: a
   * `wait` node reaches 365 days, and a Node with ten thousand proposed sends holds ten thousand sleeping
   * instances. A pause that stopped new triggers and let all of them wake up and act would be a pause in name
   * only.
   *
   * So the question rides on the read above, which is already issued once per invocation and already
   * deliberately **not** cached inside a `step.do`. Three more scalar sub-selects on a statement that was
   * already being made: `butler.pause_check_added_subrequests` is 0, and that is why it is pinned as an
   * equality rather than bounded.
   *
   * **`abandonRun`, not `finish`.** A resumed run may have performed effects in an earlier invocation, and
   * this act does not know what they were — only that the Butler is stopped. So it writes the state and the
   * reason and states no counts, which is the distinction `abandonRun` was written for by the release path,
   * reached from a second direction.
   *
   * **What that does not do is rescue a figure, and `abandonRun`'s own header says why.** The count columns
   * are written by `closeRun` alone, and this can only reach a run that has never closed, so on this path they
   * read zero either way. What a suspended run performed is its `butler_run_effects` rows — measured in
   * `test/butler-pause.test.ts`, which suspends a run for real and finds the row saying `effects = 0` beside
   * two effect rows. Naming that here rather than implying the row is trustworthy.
   */
  const stopped = pausedFrom(carried);
  if (stopped !== null) {
    await complain(env, ctx, orgId, runId, butler, "paused", describePause(stopped, {
      id: butler.butlerId, name: butler.name,
    }));
    await abandonRun(env, ctx, orgId, runId, "refused", "butler_paused");
    return {
      runId,
      state: "refused",
      reason: "butler_paused",
      // What **this invocation** walked and performed, which is nothing. It is not a claim about the run:
      // what the run did is its `butler_run_effects` rows, and `abandonRun` above deliberately writes no
      // count over them — see the note there about what that does and does not preserve.
      nodesExecuted: 0,
      effects: [],
      cost,
    };
  }

  /*
   * The sends the replayed run made, read **once** and keyed by content identity (#53).
   *
   * One statement per invocation, on the replay path only — which is why the send node's own cost is
   * unchanged: `butler.run_cost_max_send_propose` reserves what a `mail.send.propose` costs, and asking this
   * question inside the node would have made a replay's send cost one more than the guard reserves for it.
   *
   * Deliberately **not** inside a `step.do`. The hash of an existing manifest cannot change, but the `state`
   * carried alongside it can — a send `awaiting` release when the replay started may be `handed_over` when it
   * resumes — and a cached step would bind the stale one into the run's own state for ever.
   *
   * A LEFT JOIN rather than an inner one, because the two cases have to be told apart: a send effect whose
   * manifest is **gone** makes its content unprovable, and calling that materially new is the permissive
   * failure — a byte-identical replay minting a fresh key and handing the same message over twice. So it
   * refuses the run instead. `interpret` is the right place for that refusal rather than the route, because a
   * manifest can be deleted between the two.
   */
  let incumbents: ReplayIncumbents | null = null;
  if (payload.replay !== undefined) {
    const { results } = await env.CATALOG.prepare(
      `SELECT e.subject AS effect_subject, m.id, m.state, m.state_reason, m.mailbox_id,
              m.envelope_to, m.envelope_cc, m.envelope_bcc, m.subject, m.in_reply_to_message_id,
              m.body_normalized_sha256
         FROM butler_run_effects e
         LEFT JOIN send_manifests m ON m.org_id = e.org_id AND m.id = e.subject
        WHERE e.org_id = ? AND e.run_id = ? AND e.node_type = 'mail.send.propose' AND e.subject IS NOT NULL`,
    ).bind(orgId, payload.replay.ofRunId).all<{
      effect_subject: string; id: string | null; state: string | null; state_reason: string | null;
      mailbox_id: string | null; envelope_to: string | null; envelope_cc: string | null;
      envelope_bcc: string | null; subject: string | null; in_reply_to_message_id: string | null;
      body_normalized_sha256: string | null;
    }>();

    const byContent = new Map<string, IncumbentSend>();
    for (const row of results) {
      if (row.id === null) {
        await complain(env, ctx, orgId, runId, butler, "replay_send_unprovable",
          `the replayed run ${payload.replay.ofRunId} proposed send ${row.effect_subject} and no manifest `
          + "for it exists, so this Node cannot prove whether this replay would repeat it. Refused rather "
          + "than treated as new content, because a new idempotency key for an identical message is a second "
          + "delivery nobody can recall (ADR 40)");
        return await finish(env, ctx, orgId, runId, cost, spent(), counts, recorded, {
          state: "refused", reason: "replay_send_unprovable",
        });
      }
      byContent.set(await contentIdentity({
        mailboxId: row.mailbox_id!,
        to: JSON.parse(row.envelope_to ?? "[]") as string[],
        cc: row.envelope_cc === null ? [] : (JSON.parse(row.envelope_cc) as string[]),
        bcc: row.envelope_bcc === null ? [] : (JSON.parse(row.envelope_bcc) as string[]),
        subject: row.subject ?? "",
        inReplyToMessageId: row.in_reply_to_message_id,
        bodyNormalizedSha256: row.body_normalized_sha256!,
      }), { id: row.id, state: row.state!, stateReason: row.state_reason });
    }
    incumbents = { ofRunId: payload.replay.ofRunId, byContent };
  }

  const ast: Butler = checked.ast;

  /*
   * The pinned ceiling, from the AST that has just been re-checked (#51).
   *
   * **After the re-check and not before**, which is what makes the ceiling a property of a program this
   * engine agrees is a program. A ceiling read out of an unchecked blob would be a bound taken from bytes
   * whose node set, edges and affordability nobody has verified — and `checkButler` is also what proved the
   * ceiling's action set is exactly what these nodes need, which is the claim the runtime intersection then
   * relies on.
   *
   * It costs no subrequest: the addresses it names are resolved by a sub-select inside the statement each
   * check was already issuing. See `ceiling.ts`.
   */
  butler = { ...butler, ceiling: ceilingOf(ast, facts.sponsorUserId) };

  const byId = new Map(ast.nodes.map((node) => [node.id, node]));
  const state: RunState = {
    event: payload.trigger.facts,
    butler: { id: butler.butlerId, versionId: butler.versionId, name: butler.name },
    steps: {},
  };

  const visits = new Map<string, number>();
  const nameFor = (nodeId: string): string => {
    const visit = (visits.get(nodeId) ?? 0) + 1;
    visits.set(nodeId, visit);
    return `${nodeId}#${visit}`;
  };

  /**
   * Performs one effect node: the step, its record, and the in-memory accounting.
   *
   * **The split between what is inside the step and what is outside it is the whole of replay safety.**
   * A Workflow re-runs the body on every resume and serves a completed step from cache, so anything inside
   * `step.do` happens once per run while anything outside it happens once per *invocation*. The D1 write
   * belongs inside — it is the durable record, written with the effect in one transaction. The counters and
   * the list belong **outside**, because they are rebuilt from scratch on every replay and a run that
   * resumed after a sleep would otherwise close with a count of the effects performed since the sleep and
   * no others.
   *
   * `seq` is taken before the step for the same reason: it is the walk's position, identical on every
   * replay, which is what lets `bre_by_run` be the idempotency mechanism rather than a constraint to work
   * around.
   */
  const perform = async (
    node: ButlerNode,
    step: string,
    body: () => Promise<EffectResult>,
  ): Promise<EffectResult> => {
    const seq = recorded.length + 1;
    const result = await steps.do(step, async () => {
      const outcome = await body();
      const entry: EffectRecord = {
        nodeId: node.id,
        nodeType: node.type,
        outcome: outcome.outcome,
        reason: outcome.reason,
        subject: outcome.subject,
      };
      /*
       * One `batch()` for two or three statements: the effect row, the run's accumulated spend, and — when
       * the send needs a person — the park. D1 runs it as one transaction and the cost meter prices it as
       * the one round trip it is, so a record that disagrees with itself is unrepresentable and the whole
       * thing costs one subrequest against a pot the run has to fit inside.
       *
       * The `+ 1` on the spend is this batch itself, which the meter cannot have counted yet.
       */
      await env.CATALOG.batch([
        effectStatement(env, ctx, orgId, runId, seq, entry),
        spendStatement(env, orgId, runId, spent() + 1),
        ...(outcome.park === undefined
          ? []
          : [parkStatement(env, ctx, orgId, runId, outcome.park)]),
      ]);
      return outcome;
    });

    recorded.push({
      seq,
      nodeId: node.id,
      nodeType: node.type,
      outcome: result.outcome,
      reason: result.reason,
      subject: result.subject,
    });
    if (result.outcome === "ok") counts.effects += 1;
    if (result.outcome === "refused") counts.refusals += 1;
    return result;
  };

  /**
   * The guard: refuse an effect this run cannot afford, **before** performing it.
   *
   * This is what turns *"the invocation is killed wherever it has got to, after the effects it already
   * performed"* into a refusal somebody can read. A Butler that reaches it is not broken — it is a graph
   * whose publication-time price was a floor, and this is the enforcement the floor cannot be.
   *
   * The reservation comes from `RUN_NODE_COST`, which is what a node measurably costs *this engine*, not
   * from `SHIPPED_NODE_COST`, which is what the function it calls costs. Where those differ, the difference
   * is real and reserving the smaller one would be reserving too little for the one node it matters for.
   */
  const affordable = (node: ButlerNode): boolean =>
    spent() + RUN_NODE_COST[node.type as ShippedKind] <= RUN_BUDGET;

  const exhausted = async (node: ButlerNode): Promise<Terminal> => {
    // AGENTS.md §3's four parts: the named budget with its number, the ask, the identifiers, and — through
    // the receipt named in the message — the way to change it.
    await complain(env, ctx, orgId, runId, butler, "budget_exhausted",
      `E_BUDGET_EXCEEDED  ${RUN_BUDGET_NAME}=${RUN_BUDGET}, this run has spent ${spent()} and `
      + `${node.id} (a ${node.type}) needs up to `
      + `${RUN_NODE_COST[node.type as ShippedKind]} more. Nothing further was performed. `
      + "receipt docs/receipts/butler-run-cost.md");
    return { state: "refused", reason: "budget_exhausted" };
  };

  /** Walks one chain of edges. Returns a terminal when the whole run ends, `null` when the chain does. */
  const runChain = async (from: string | null | undefined): Promise<Terminal | null> => {
    let cursor: string | null | undefined = from;
    while (cursor !== null && cursor !== undefined) {
      const node = byId.get(cursor);
      // Unreachable: `checkButler` above refuses a dangling edge. Terminal rather than a silent stop,
      // because reaching it would mean the checker and this walk disagree about the graph.
      if (node === undefined) return { state: "failed", reason: "edge_to_nothing" };

      counts.nodesExecuted += 1;
      const step = nameFor(node.id);

      switch (node.type) {
        case "guard":
          cursor = isTrue(node.when, state, node.id) ? node.then : node.otherwise;
          break;

        case "switch": {
          // Compared as a string, because `cases[].equals` is one by schema. `evaluateOperand` rather than
          // `isTrue`: a switch wants the value, and one evaluator for both is what stops `guard` and
          // `switch` disagreeing about what an expression means.
          const subject = String(evaluateOperand(node.on, state, node.id));
          cursor = node.cases.find((branch) => branch.equals === subject)?.next ?? node.default;
          break;
        }

        case "transform":
          state.steps[node.as] = evaluate(node.value, state, node.id);
          cursor = node.next;
          break;

        case "validate": {
          const problems = validateAgainst(
            evaluate(node.value, state, node.id), node.schema, node.id,
          );
          if (problems.length > 0) {
            await complain(env, ctx, orgId, runId, butler, "validate_failed", problems.join("; "));
            return { state: "refused", reason: "validate_failed" };
          }
          cursor = node.next;
          break;
        }

        case "join":
          // A merge, not a barrier: no fan-out node ships, so at most one branch is ever live and there is
          // nothing to wait for. #49 says so on the node itself.
          cursor = node.next;
          break;

        case "wait":
          // `step.sleep`, which reaches 365 days and costs no concurrency while waiting. No `sleepUntil`:
          // the node carries `seconds` and nothing else, so there is no instant to sleep until.
          await steps.sleep(step, node.seconds);
          cursor = node.next;
          break;

        case "stop":
          return { state: "stopped", reason: node.reason };

        case "map":
        case "foreach": {
          const over = evaluate(node.over, state, node.id);
          if (!Array.isArray(over)) {
            throw new ButlerFault("E_BUTLER_LOOP_NOT_A_COLLECTION", {
              what: `${node.type} ${node.id} was given ${over === null ? "null" : typeof over} to loop over`,
              why: "a bounded loop iterates a collection; anything else has no length to compare against "
                + "maxItems and no items to bind",
              fix: `make ${JSON.stringify(node.over)} resolve to an array`,
            }, node.id);
          }
          if (over.length > node.maxItems) {
            /*
             * #49's rule, verbatim: a collection larger than the bound **fails the step and processes
             * nothing**. It never truncates — *"replied to 100 of 340 customers and reported success"* is a
             * system reporting something untrue about work owed to customers.
             *
             * So this is terminal and no item has run. AGENTS.md §3's four parts, with the ask being the
             * real length rather than a bound.
             */
            await complain(env, ctx, orgId, runId, butler, "loop_bound_exceeded",
              `E_BUDGET_EXCEEDED  ${node.type} ${node.id} declares maxItems=${node.maxItems}, this run `
              + `asked for ${over.length}. Nothing was processed: the bound fails the step rather than `
              + "truncating, because a partial reply reported as a success is untrue about work owed");
            return { state: "failed", reason: "loop_bound_exceeded" };
          }
          const collected: unknown[] = [];
          for (const item of over) {
            state.steps[node.as] = item;
            // Cleared before the body, so "the body bound nothing under collectAs" is a fact about **this**
            // iteration rather than about any earlier one. Without it the second iteration would silently
            // collect the first's result again.
            if (node.type === "map") delete state.steps[node.collectAs];
            const terminal = await runChain(node.body);
            if (terminal !== null) return terminal;
            if (node.type === "map") {
              /*
               * `collectAs` collects what the body bound **under that same name**, per iteration.
               *
               * One name rather than two, and one concept rather than an invented one: inside the body
               * `steps.<collectAs>` is this iteration's result, and after the loop it is the array of them.
               * A body that bound nothing under it is refused rather than collecting nulls — a name that
               * gathers a list of nothing is a name that lies about what the loop did.
               */
              if (!Object.hasOwn(state.steps, node.collectAs)) {
                throw new ButlerFault("E_BUTLER_MAP_COLLECTS_NOTHING", {
                  what: `map ${node.id} collects as ${JSON.stringify(node.collectAs)} and its body bound `
                    + "nothing under that name",
                  why: "a map that collected nulls would report a list of results for iterations that "
                    + "produced none. A foreach is the node that collects nothing, and it says so",
                  fix: `give a node in ${JSON.stringify(node.body)}'s chain \`as: ${node.collectAs}\`, or `
                    + "use a foreach",
                }, node.id);
              }
              collected.push(state.steps[node.collectAs]);
            }
          }
          if (node.type === "map") state.steps[node.collectAs] = collected;
          cursor = node.next;
          break;
        }

        case "lookup": {
          if (!affordable(node)) return await exhausted(node);
          const result = await perform(node, step, async () => await lookupRow(env, butler, node, state));
          if (result.bind !== undefined) state.steps[node.as] = result.bind;
          cursor = node.next;
          break;
        }

        case "case.assign": {
          if (!affordable(node)) return await exhausted(node);
          await perform(node, step, async () => await assignCase(env, ctx, butler, node, state));
          cursor = node.next;
          break;
        }

        case "case.close": {
          if (!affordable(node)) return await exhausted(node);
          await perform(node, step, async () => await closeCase(env, ctx, butler, node, state));
          cursor = node.next;
          break;
        }

        case "draft": {
          if (!affordable(node)) return await exhausted(node);
          // `payload.trigger`, not `state.event`, and the difference is not stylistic: deriving recipients
          // from the parent delivery (#52) needs to know *which trigger fired*, and `RunState` carries only
          // the facts and not the trigger's name. A `draft` in a run started by something other than a
          // delivery has no correspondent, and that has to be a refusal rather than a missing key — so the
          // thing passed is the whole trigger, which is the only value that can answer it.
          const result = await perform(node, step, async () =>
            await writeDraft(env, ctx, butler, node, state, payload.trigger, incumbents !== null));
          if (result.bind !== undefined) state.steps[node.as] = result.bind;
          cursor = node.next;
          break;
        }

        case "mail.send.propose": {
          if (!affordable(node)) return await exhausted(node);
          const result = await perform(node, step, async () =>
            await proposeSend(env, ctx, butler, node, state, incumbents));
          if (result.park !== undefined) {
            /*
             * The human-release gate. The manifest is already `awaiting` with this reason — `sealManifest`
             * sealed it that way, so there is no window in which `dispatchDue` could have moved it — and the
             * run now parks. Waiting costs no concurrency, so a Node with ten thousand proposed sends holds
             * ten thousand sleeping instances and no capacity.
             *
             * A timeout ends the **run** and not the send: the manifest stays `awaiting`, still releasable
             * by `POST /api/sends/:id/release` and still cancellable. Letting a clock hand mail over would
             * make this a delay rather than a gate.
             */
            const timeoutSeconds = releaseTimeoutSeconds();
            try {
              await steps.waitForEvent(`${step}:release`, RELEASE_EVENT, timeoutSeconds);
            } catch {
              // Deliberately not re-thrown and deliberately not swallowed either: it becomes a terminal
              // state a person can see, which is what AGENTS.md asks of a `catch`.
              return { state: "stopped", reason: "release_timed_out" };
            }
            await resumeRun(env, ctx, orgId, runId);
          }
          cursor = node.next;
          break;
        }

        default:
          /*
           * A reserved node reached the walk.
           *
           * Unreachable through every path this Node has: `checkButler` above refuses each of the fifteen
           * reserved kinds by name, before any effect. This exists anyway, and not out of caution — without
           * it the walk **hangs**. `ButlerNode` is the union of *all* declared kinds, shipped and reserved,
           * because #49 made a reserved node genuinely representable; so `node.type` can be `llm.classify` at
           * the type level, the switch above would match nothing, `cursor` would not move, and the loop would
           * spin until the platform killed the step. A terminal state is the one answer that is neither a
           * hang nor a silent skip.
           *
           * **Unreachable and therefore untested, and that is said rather than implied.** Getting a reserved
           * node into this switch means getting one past `checkButler`, and there is no path from outside
           * this file that does — removing the re-check does not reach here either, it faults earlier on the
           * refused result's absent `ast`. Measured, rather than assumed: the observed failure of that
           * mutation is `TypeError: Cannot read properties of undefined (reading 'nodes')`. So this branch
           * is not a check, it is what makes the switch **total** — and the reason to have it is that the
           * alternative failure is a hang, which is the one shape an operator cannot diagnose.
           */
          return { state: "failed", reason: "reserved_node_reached_the_walk" };
      }
    }
    return null;
  };

  let terminal: Terminal;
  try {
    terminal = (await runChain(ast.entry)) ?? { state: "finished", reason: null };
  } catch (error) {
    if (error instanceof ButlerFault) {
      await complain(env, ctx, orgId, runId, butler, error.code, error.message);
      terminal = { state: "failed", reason: error.code };
    } else {
      // Not swallowed: recorded as a terminal state, logged, and re-raised is the one thing not done —
      // because a Workflow that throws is retried, and retrying a run that has already performed its
      // effects would perform them again. The record is the operational state AGENTS.md requires.
      await complain(env, ctx, orgId, runId, butler, "engine_fault",
        (error as Error).message.split("\n")[0] ?? "unknown");
      terminal = { state: "failed", reason: "engine_fault" };
    }
  }

  return await finish(env, ctx, orgId, runId, cost, spent(), counts, recorded, terminal);
}

/**
 * The release timeout, read from the budget rather than written here.
 *
 * `approval.send_expiry_seconds` — *"how long an approval of a send stays good for"* — because a release is
 * a person agreeing to a Butler's send in substance, and this Node must not hold two opinions about how long
 * somebody has to decide about one send. `src/butler/gate.ts` carries the argument.
 */
function releaseTimeoutSeconds(): number {
  // Read through the key `gate.ts` names, so the figure and the argument for reusing it cannot drift apart.
  return BUDGETS[RELEASE_TIMEOUT_BUDGET];
}

/** Writes the terminal state and returns what a caller (or a test) needs to see. */
async function finish(
  env: Env,
  ctx: Ctx,
  orgId: string,
  runId: string,
  cost: Cost,
  spent: number,
  counts: RunCounts,
  recorded: (EffectRecord & { seq: number })[],
  terminal: Terminal,
): Promise<RunResult> {
  await closeRun(env, ctx, orgId, runId, terminal.state, terminal.reason, counts, spent);
  return {
    runId,
    state: terminal.state,
    reason: terminal.reason,
    nodesExecuted: counts.nodesExecuted,
    effects: recorded,
    cost,
  };
}

/**
 * Puts a fault or a refusal in the operational log, where `doctor` can see it.
 *
 * `log` rather than `audit`, and the boundary is 0008's: the audit trail records acts somebody is answerable
 * for, and a Butler's run is not one of those — its *effects* are, and they are audited by the functions
 * that perform them with the Butler as actor. What belongs in the log is *"why did this behave oddly"*,
 * which is exactly what an unresolvable path or an exhausted budget is. `log` is bounded and trimmed, which
 * is right for something a busy Node can emit per delivery.
 */
async function complain(
  env: Env,
  ctx: Ctx,
  orgId: string,
  runId: string,
  butler: ButlerPrincipal,
  event: string,
  message: string,
): Promise<void> {
  await log(env, ctx, {
    level: "warn",
    event: `butler.${event}`,
    message: message.split("\n").slice(0, 6).join(" "),
    orgId,
    detail: { runId, butlerId: butler.butlerId, versionId: butler.versionId, butler: butler.name },
  }).catch(() => undefined);
}
