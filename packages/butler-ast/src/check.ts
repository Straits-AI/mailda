import * as z from "zod";

import {
  butler, butlerEnvelope, schemaFor, type Butler, type ButlerNode,
} from "./ast.ts";
import {
  affordableMaxItems, describeCost, priceButler, RUN_BUDGET, RUN_BUDGET_FREE, RUN_BUDGET_FREE_NAME,
  type ButlerCost,
} from "./cost.ts";
import { successorsOf } from "./graph.ts";
import {
  isLoopKind, isNodeKind, isShipped, NODE_KINDS, RESERVED_KINDS, SHIPPED_KINDS,
  type NodeKind,
} from "./nodes.ts";

/**
 * The checker: what can be decided about a Butler without running it (#49, #54).
 *
 * ## What it decides, and what it deliberately leaves to somebody else
 *
 * | Decided here | Left, and to whom |
 * |:--|:--|
 * | a reserved node is refused, by name, with the reason | whether a node's *expression* is safe — #52, the taint checker |
 * | the graph is acyclic | what happens at runtime when a collection exceeds its bound — #50's engine |
 * | every loop declares a well-formed `maxItems` | whether the stored bytes fit a row — `src/butlers.ts` |
 * | every edge names a node that exists | |
 * | every node's payload matches its declared shape | |
 * | **the whole graph is affordable against one run's subrequest pot** | |
 *
 * **#54 filled the seam #49 pinned.** The affordability pass sums the fixed cost of every non-loop node,
 * adds `maxItems × per-item cost` for each loop, and refuses publication when the total exceeds the pot. The
 * arithmetic and the choice of pot are in `cost.ts`; what this file adds is *when* it runs and what the
 * refusal says. #49 recorded the absence of a number here as a decision, and it was the right one then: the
 * inputs moved twice that week and the plan-scoped pot had not been chosen. It has now, and it is Workers
 * Paid — argued in `cost.ts`'s header, where the number lives.
 *
 * ## Why iteration and acyclicity are compatible claims
 *
 * A Butler repeats work only through `map` and `foreach`, and a loop's body is entered by a `body` edge
 * and returns to its own loop **implicitly** — the return is not an edge in the graph. So the graph a
 * Butler declares is a DAG, every cycle in it is a mistake, and *"cycle detection"* and *"bounded
 * iteration"* are not in tension: iteration is expressible in exactly one place, where a bound is
 * mandatory. A body node whose `next` points back at its own loop header **is** a cycle and is refused,
 * which is the case that would otherwise be an unbounded loop wearing a bounded loop's clothes.
 *
 * ## One vocabulary for every refusal
 *
 * A schema failure, a reserved node and a cycle come back as the same kind of `Finding`, with AGENTS.md's
 * four parts: the code, what happened, why it is refused, and what to do. Two vocabularies would mean an
 * author's tooling handles half the refusals and prints a stack trace for the other half — and it is an
 * agent reading these, not a person, which is exactly the standard AGENTS.md §3 sets.
 *
 * Every finding is collected rather than thrown, so one call reports every problem a Butler has. A checker
 * that stops at the first is a checker somebody runs eleven times.
 */

export interface Finding {
  /** Stable machine code. */
  code: string;
  /** The node it is about, when there is one. */
  node?: string;
  what: string;
  why: string;
  fix: string;
}

export type CheckResult =
  | { ok: true; ast: Butler; cost: ButlerCost; findings: [] }
  | { ok: false; findings: Finding[] };

function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parses without checking. A Butler naming a reserved node **succeeds here** — that is the point.
 *
 * Exported so the distinction is testable rather than asserted: `test/check.test.ts` shows the same
 * document parsing and then being refused, which is what "reserved in the AST and rejected by the
 * checker" has to mean if it means anything.
 */
export function parseButler(input: unknown): { ok: true; ast: Butler } | { ok: false; issues: string } {
  const parsed = butler.safeParse(input);
  return parsed.success ? { ok: true, ast: parsed.data } : { ok: false, issues: issuesOf(parsed.error) };
}

/**
 * Parses and checks. This is what publication calls.
 *
 * Takes `unknown` rather than a `Butler`, and that is load-bearing rather than defensive: the thing being
 * checked at publication comes back out of `butler_versions.ast_json` as text, so it has not been through
 * the schema at that point. A checker typed to accept only already-valid input could not be used at the
 * one moment it matters most.
 */
export function checkButler(input: unknown): CheckResult {
  const findings: Finding[] = [];

  const envelope = butlerEnvelope.safeParse(input);
  if (!envelope.success) {
    return {
      ok: false,
      findings: [{
        code: "E_BUTLER_MALFORMED",
        what: `this is not a mailda/v1 Butler: ${issuesOf(envelope.error)}`,
        why: "the envelope carries the version, the trigger and the entry point; nothing below it can be "
          + "checked until it parses",
        fix: "start from apiVersion: mailda/v1, kind: Butler, and a metadata, trigger, entry and nodes",
      }],
    };
  }

  const raw = envelope.data;

  /* ---- ids: unique, and the entry names one ---- */
  const seen = new Set<string>();
  for (const node of raw.nodes) {
    if (seen.has(node.id)) {
      findings.push({
        code: "E_BUTLER_DUPLICATE_NODE_ID",
        node: node.id,
        what: `two nodes are called ${JSON.stringify(node.id)}`,
        why: "every edge in this AST is a node id, so a duplicate makes the graph ambiguous — an edge would "
          + "name two different nodes and the run would depend on which one a reader happened to mean",
        fix: "rename one of them",
      });
    }
    seen.add(node.id);
  }

  if (!seen.has(raw.entry)) {
    findings.push({
      code: "E_BUTLER_NO_ENTRY",
      what: `entry names ${JSON.stringify(raw.entry)}, which is not one of this Butler's nodes`,
      why: "a run starts at the entry; a Butler whose entry names nothing would publish and do nothing",
      fix: `set entry to one of: ${[...seen].join(", ")}`,
    });
  }

  /* ---- classification: reserved and unknown, before any payload is looked at ---- */
  const checkable: ButlerNode[] = [];
  for (const node of raw.nodes) {
    if (!isNodeKind(node.type)) {
      findings.push({
        code: "E_BUTLER_NODE_UNKNOWN",
        node: node.id,
        what: `node ${node.id} has type ${JSON.stringify(node.type)}, which is not a node type in mailda/v1`,
        why: "the node set is closed, so a type nothing declares is a typo or a node from a different "
          + "version rather than a feature this Node will grow at runtime",
        fix: `use one of the ${SHIPPED_KINDS.length} shipped types: ${SHIPPED_KINDS.join(", ")}`,
      });
      continue;
    }

    const kind: NodeKind = node.type;
    if (!isShipped(kind)) {
      findings.push({
        code: "E_BUTLER_NODE_RESERVED",
        node: node.id,
        what: `node ${node.id} is a ${kind}, which is reserved in the AST and refused at publication`,
        why: NODE_KINDS[kind].because,
        fix: `remove ${node.id}, or express the same intent with a shipped node: ${SHIPPED_KINDS.join(", ")}`,
      });
      continue;
    }

    /*
     * The loop bound is read from the raw value, before the payload schema runs. The schema requires it too
     * — `maxItems: z.int().min(1)` — and going through Zod for this one field would report it as
     * `nodes.3.maxItems: Invalid input: expected number`, which tells an author what a validator wanted
     * rather than what the bound is for. A bound that is exceeded fails the step and processes nothing; an
     * author who reads this refusal needs to know that, not the name of a Zod issue code.
     */
    if (isLoopKind(kind)) {
      const declared = (node as { maxItems?: unknown }).maxItems;
      if (!(typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 1)) {
        findings.push({
          code: "E_BUTLER_LOOP_UNBOUNDED",
          node: node.id,
          what: `${kind} ${node.id} declares maxItems=${JSON.stringify(declared)}, which is not an integer of at least 1`,
          why: "every loop declares its own bound, and a collection larger than the bound fails the step and "
            + "processes nothing. Truncation was refused: \"replied to 100 of 340 customers and reported "
            + "success\" is a system reporting something untrue about work owed to customers",
          fix: `give ${node.id} a maxItems of at least 1. Whether that bound is affordable is then checked `
            + "against the cost of the whole graph, and E_BUTLER_UNAFFORDABLE names the arithmetic",
        });
        continue;
      }
    }

    const parsed = schemaFor(kind).safeParse(node);
    if (!parsed.success) {
      findings.push({
        code: "E_BUTLER_NODE_MALFORMED",
        node: node.id,
        what: `node ${node.id} is not a well-formed ${kind}: ${issuesOf(parsed.error)}`,
        why: "each node type has a declared shape, and a field the engine will read has to be there before "
          + "the Butler is frozen — a published version cannot be edited",
        fix: `correct ${node.id} against the ${kind} schema`,
      });
      continue;
    }
    checkable.push(parsed.data as ButlerNode);
  }

  /* ---- edges: every named id exists ---- */
  const byId = new Map(checkable.map((node) => [node.id, node]));
  for (const node of checkable) {
    for (const target of successorsOf(node)) {
      if (byId.has(target)) continue;
      findings.push({
        code: "E_BUTLER_EDGE_DANGLING",
        node: node.id,
        what: `node ${node.id} points at ${JSON.stringify(target)}, which is not a checkable node of this Butler`,
        why: "an edge to nothing is a run that stops somewhere its author did not choose — and if the target "
          + "is a node that failed its own check above, this is the second symptom of that one cause",
        fix: `point ${node.id} at an existing node, or at null to end the run there`,
      });
    }
  }

  /*
   * ---- cycles ----
   *
   * Depth-first from **every** node, not only from the entry. Acyclicity is a property of the graph, and a
   * cycle sitting in a component nothing reaches today is a cycle the next edit connects. Reporting it now
   * costs one traversal; discovering it later costs a run that does not terminate.
   *
   * The path is reported, because "this Butler has a cycle" sends an author looking and
   * "notify -> wait -> notify" sends them to the edge.
   */
  const state = new Map<string, "open" | "closed">();
  const path: string[] = [];
  const reported = new Set<string>();

  const walk = (id: string): void => {
    const status = state.get(id);
    if (status === "closed") return;
    if (status === "open") {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id];
      const key = cycle.join(">");
      if (!reported.has(key)) {
        reported.add(key);
        findings.push({
          code: "E_BUTLER_CYCLE",
          node: id,
          what: `these edges form a cycle: ${cycle.join(" -> ")}`,
          why: "the graph a Butler declares is acyclic, because the only repetition in this language is a "
            + "loop with a declared bound. A cycle is an unbounded loop with no bound to exceed, so nothing "
            + "would ever fail — the run would simply not terminate",
          fix: "break one of those edges. To repeat work, use a map or foreach with a maxItems",
        });
      }
      return;
    }
    state.set(id, "open");
    path.push(id);
    const node = byId.get(id);
    if (node !== undefined) {
      for (const target of successorsOf(node)) {
        if (byId.has(target)) walk(target);
      }
    }
    path.pop();
    state.set(id, "closed");
  };

  for (const node of checkable) walk(node.id);

  /*
   * ---- affordability (#54) ----
   *
   * Last, and only on an otherwise clean graph. Every finding above describes a graph whose cost is not
   * defined: a dangling edge means a node the sum cannot find, an unbounded loop means a `maxItems` there is
   * nothing to multiply by, a reserved node means an operation nobody has priced. Pricing one of those would
   * produce a second finding with a fabricated number in it, and a fabricated number in a refusal is worse
   * than a missing one — it ends the reader's question instead of prompting it.
   *
   * The cost is computed either way, because an author who publishes successfully should be able to see what
   * their Butler costs rather than only hearing about it when it is too much. It is on the ok branch of
   * `CheckResult`.
   */
  if (findings.length > 0) return { ok: false, findings };

  const cost = priceButler(checkable);
  if (cost.total > RUN_BUDGET) findings.push(unaffordable(cost));

  if (findings.length > 0) return { ok: false, findings };

  /*
   * Everything above worked on the envelope's loose nodes plus a per-node parse. The whole document is
   * parsed once more here so the returned value is the *union's* inferred type rather than an assembly of
   * separately-validated pieces — which is what makes the result safe to hand to the engine, and what would
   * catch a divergence between `schemaFor(kind)` and the discriminated union built from the same map.
   */
  const whole = butler.safeParse(input);
  if (!whole.success) {
    return {
      ok: false,
      findings: [{
        code: "E_BUTLER_SCHEMA_DIVERGED",
        what: `every node checked individually and the document as a whole did not: ${issuesOf(whole.error)}`,
        why: "the per-node schemas and the discriminated union are built from one declaration, so this "
          + "cannot happen without a bug in this package",
        fix: "report it — packages/butler-ast/src/ast.ts holds both halves",
      }],
    };
  }

  return { ok: true, ast: whole.data, cost, findings: [] };
}

/**
 * The refusal for a Butler that cannot afford itself.
 *
 * AGENTS.md §3's four parts, and the third one — *the ask* — is a sum rather than a single number, so it is
 * spelled out instead of stated: which nodes outside a loop, which loop, its bound, its per-item cost and
 * their product. A developer who reads only `10018 > 10000` learns that something is too big. One who reads
 * `foreach fan_out costs maxItems=499 × 20 per item = 9980` knows which line of their Butler to edit and to
 * what, which is the standard AGENTS.md sets for an agent fixing its own mistake.
 *
 * **Both plans appear.** The pot divided is Workers Paid, for the reasons in `cost.ts`; the Free figure is
 * printed beside it because a Free Node is unsupported rather than impossible, and an operator on one should
 * meet the arithmetic here rather than in a dead instance.
 */
function unaffordable(cost: ButlerCost): Finding {
  const suggestion = affordableMaxItems(cost);
  const freeLoop = cost.loops[0];
  const freeAdvice = freeLoop === undefined || freeLoop.perItem === 0 || freeLoop.nested
    ? `the whole graph would have to fit inside ${RUN_BUDGET_FREE}`
    : `${freeLoop.id}'s affordable maxItems there is `
      + `${Math.max(0, Math.floor((RUN_BUDGET_FREE - (cost.total - freeLoop.total)) / freeLoop.perItem))}`;

  const fix = suggestion === null
    ? "take work out of the graph — there are fewer, or cheaper, nodes to run — or split it into more than "
      + "one Butler. Nothing here is a loop bound that could be lowered instead"
    : `lower ${suggestion.loop.id}'s maxItems to ${suggestion.maxItems} or fewer, which is what is left of `
      + `the pot after the rest of the graph, or take work out of the loop's body`;

  /*
   * Which node to name, and when to name none.
   *
   * A loop, if there is one that **costs something** — it is the multiplier and therefore the thing to
   * change. A loop whose body performs no I/O contributes nothing to the total, so naming it sends the author
   * to the one line in their Butler that is provably not the reason: a `foreach` of a million pure
   * transforms beside 3,334 `case.close` nodes was blamed for an overspend it contributed 0 to, and the
   * sentence below told the same author that the run would be killed "mid-loop" when the loop is free and the
   * chain is what empties the pot. `cost.loops` is sorted dearest first, so the first entry with a non-zero
   * total is the dearest contributing loop.
   *
   * Otherwise the dearest node, but **only if it actually dominates**: a chain of 3,334 identical
   * `case.close` nodes has a "dearest" that is simply the first one the scan reached, and printing
   * `node close_0` would send an author to a line that is no more at fault than the other 3,333. A tenth of
   * the total is the threshold; below it the finding carries no node, and `what` already says how many nodes
   * there are and what they cost together, which is the true answer.
   */
  const costlyLoop = cost.loops.find((loop) => loop.total > 0);
  const dominant = cost.dearest !== null && cost.dearest.total * 10 > cost.total
    ? cost.dearest.id
    : undefined;

  return {
    code: "E_BUTLER_UNAFFORDABLE",
    node: costlyLoop?.id ?? dominant,
    what: `this Butler costs ${describeCost(cost)}`,
    why: "a Workflow instance has one subrequest pot for the whole run rather than one per step "
      + "(workflow.budget_unit_is_instance=1, measured), so a run that asks for more does not fail a step and "
      + `carry on — the invocation is killed wherever it has got to${costlyLoop === undefined ? "" : ", mid-loop"}`
      + ", after the effects it already performed. A loop bound that is exceeded at runtime fails the step "
      + "and processes nothing; the platform's ceiling extends no such courtesy, which is why this is refused "
      + "at publication, the one place it is knowable before any mail moves",
    fix: `${fix}. This Node prices against Workers Paid because ADR 25 requires it; on Workers Free the pot `
      + `is ${RUN_BUDGET_FREE_NAME}=${RUN_BUDGET_FREE} and ${freeAdvice}. `
      + "receipt docs/receipts/butler-step-cost.md",
  };
}

/** Renders findings the way AGENTS.md §3 requires, for an error message or a CLI. */
export function describeFindings(findings: readonly Finding[]): string {
  return findings
    .map((finding) => {
      const node = finding.node === undefined ? "" : `\n  node     ${finding.node}`;
      return `${finding.code}  ${finding.what}${node}\n  why      ${finding.why}\n  fix      ${finding.fix}`;
    })
    .join("\n");
}

/** The reserved catalogue, for anything that wants to explain the refusals before an author hits one. */
export const RESERVED_WITH_REASONS = RESERVED_KINDS.map((kind) => ({
  type: kind,
  because: NODE_KINDS[kind].because,
}));
