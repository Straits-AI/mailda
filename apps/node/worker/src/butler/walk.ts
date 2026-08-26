import type { ButlerNode } from "@mailda/butler-ast";

import { type EffectResult } from "./effects.ts";
import { ButlerFault, isTrue, evaluate, evaluateOperand, validateAgainst, type RunState } from "./expr.ts";
import type { ReplayIncumbents } from "../outbound/manifest.ts";
import type { TerminalState } from "./record.ts";
import type { EffectHandle } from "./world.ts";

/**
 * The walk: one pass over one checked AST, with every capability it needs handed to it (#87, §5).
 *
 * ## Why this is a separate file, and what it is not
 *
 * It was `interpret`'s innermost closure until #87's answer 5 needed a **second** caller. A dry run has to
 * make the same decisions as a live one — the same guards, the same loop bounds, the same affordability
 * arithmetic — and the only way that is a guarantee rather than an intention is for there to be one walk.
 *
 * Two copies would have been the correspondence problem this repository keeps paying for, in the worst place
 * available: a simulation that diverges from the engine is a tool that tells authors their Butler is fine.
 *
 * **Nothing here writes, and nothing here can.** Every effect goes through `Walkable.effects`, every record
 * through `perform` or `complain`, every wait through `steps`. There is no `env` in this file and no import
 * that reaches one, which is what makes the capability question decidable by reading the `Walkable` a caller
 * built rather than by auditing this switch.
 *
 * ## What a caller supplies, and why these are the seams
 *
 * The list is not a design preference — it is exactly the set of things a live run and a dry run must do
 * differently, arrived at by extracting the walk and seeing what would not come with it. Everything else
 * moved unchanged, which is the reason to trust that the decisions are shared.
 */
export interface Walkable {
  /** The AST's nodes by id. `checkButler` has already refused a dangling edge, so a miss here is a fault. */
  readonly byId: ReadonlyMap<string, ButlerNode>;

  /** The run's state root. Mutable: `as` bindings are written into `state.steps` as the walk proceeds. */
  readonly state: RunState;

  /**
   * The whole trigger, because `draft` needs to know *which* trigger fired to derive recipients (#52) and
   * `RunState` carries only the facts.
   */
  readonly trigger: {
    readonly event: string;
    readonly key: string;
    readonly facts: Readonly<Record<string, unknown>>;
  };

  /** The replayed run's sends, or null. Reaches `proposeSend` so the content rule can reuse their keys. */
  readonly incumbents: ReplayIncumbents | null;

  /**
   * The capability. `liveEffects` requires an `Env` and a simulated caller has none, so what a walk can
   * cause is decided by which handle was constructed for it — the argument is in `world.ts`.
   */
  readonly effects: EffectHandle;

  /** `wait` and the release gate. A dry run supplies one that reports rather than sleeps. */
  readonly steps: {
    do<T>(name: string, body: () => Promise<T>): Promise<T>;
    sleep(name: string, seconds: number): Promise<void>;
  };

  /** Rebuilt per invocation, deliberately: see `perform`'s note in `interpret.ts`. */
  readonly counts: WalkCounts;

  /** `nodeId#visit`, so a step name is stable across replays of the same walk. */
  nameFor(nodeId: string): string;

  /** Performs one effect node and records it. The live one writes a row; a dry run keeps it in memory. */
  perform(node: ButlerNode, step: string, body: () => Promise<EffectResult>): Promise<EffectResult>;

  /**
   * Records why a run ended badly. Returns nothing: the walk builds its own terminal, so the *state* a
   * refusal produces stays visible here rather than being decided by whoever implemented the recording.
   */
  complain(reason: string, message: string): Promise<void>;

  /** Whether this node's reserved cost still fits the run's pot. */
  affordable(node: ButlerNode): boolean;

  /** The terminal for a node that does not fit. Separate from `affordable` because it also records. */
  exhausted(node: ButlerNode): Promise<Terminal>;

  /**
   * Called after a proposed send parks for a person.
   *
   * Returns a terminal to end on, or `null` to carry on past the gate. The live implementation waits for the
   * release event and returns `release_timed_out` if nobody comes; a dry run returns `null` immediately,
   * which reads as *"a person would decide here, and here is the rest of the program if they said yes"*.
   */
  awaitRelease(step: string): Promise<Terminal | null>;
}

/**
 * The walk's running tallies.
 *
 * Deliberately *not* `RunCounts`, which is the readonly shape a **finished** run is recorded with. This is
 * the accumulator, and the walk writes to it — same three fields, opposite mutability, and conflating them
 * is what the typecheck caught when this file was first extracted.
 */
export interface WalkCounts {
  nodesExecuted: number;
  effects: number;
  refusals: number;
}

/** Where a run ended, and why. `reason` is null only for an ordinary `finished`. */
export type Terminal = { state: TerminalState; reason: string | null };

/**
 * Walks the program from `entry` and returns where it ended.
 *
 * The `catch` is here rather than at either caller because it is part of the walk's contract: a
 * `ButlerFault` is an author's program going wrong and becomes a terminal state with the fault's own code,
 * and anything else becomes `engine_fault`. Neither is re-raised — a Workflow that throws is retried, and
 * retrying a run that has already performed its effects would perform them again.
 */
export async function walk(w: Walkable, entry: string): Promise<Terminal> {
  const { byId, state, trigger, incumbents, effects, steps, counts } = w;
  const nameFor = (nodeId: string): string => w.nameFor(nodeId);
  const perform = (
    node: ButlerNode, step: string, body: () => Promise<EffectResult>,
  ): Promise<EffectResult> => w.perform(node, step, body);
  const affordable = (node: ButlerNode): boolean => w.affordable(node);
  const exhausted = (node: ButlerNode): Promise<Terminal> => w.exhausted(node);

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
            await w.complain("validate_failed", problems.join("; "));
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
            await w.complain("loop_bound_exceeded",
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
          const result = await perform(node, step, async () => await effects.lookup(node, state));
          if (result.bind !== undefined) state.steps[node.as] = result.bind;
          cursor = node.next;
          break;
        }

        case "case.assign": {
          if (!affordable(node)) return await exhausted(node);
          await perform(node, step, async () => await effects.assignCase(node, state));
          cursor = node.next;
          break;
        }

        case "case.close": {
          if (!affordable(node)) return await exhausted(node);
          await perform(node, step, async () => await effects.closeCase(node, state));
          cursor = node.next;
          break;
        }

        case "draft": {
          if (!affordable(node)) return await exhausted(node);
          // The whole `trigger`, not `state.event`, and the difference is not stylistic: deriving recipients
          // from the parent delivery (#52) needs to know *which trigger fired*, and `RunState` carries only
          // the facts and not the trigger's name. A `draft` in a run started by something other than a
          // delivery has no correspondent, and that has to be a refusal rather than a missing key — so the
          // thing passed is the whole trigger, which is the only value that can answer it.
          const result = await perform(node, step, async () =>
            await effects.writeDraft(node, state, trigger, incumbents !== null));
          if (result.bind !== undefined) state.steps[node.as] = result.bind;
          cursor = node.next;
          break;
        }

        case "mail.send.propose": {
          if (!affordable(node)) return await exhausted(node);
          const result = await perform(node, step, async () =>
            await effects.proposeSend(node, state, incumbents));
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
            const stopped = await w.awaitRelease(step);
            if (stopped !== null) return stopped;
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

  try {
    return (await runChain(entry)) ?? { state: "finished", reason: null };
  } catch (error) {
    if (error instanceof ButlerFault) {
      await w.complain(error.code, error.message);
      return { state: "failed", reason: error.code };
    }
    // Not swallowed: recorded as a terminal state a person can see, which is what AGENTS.md asks of a catch.
    await w.complain("engine_fault", (error as Error).message.split("\n")[0] ?? "unknown");
    return { state: "failed", reason: "engine_fault" };
  }
}
