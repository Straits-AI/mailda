import { BUDGETS } from "@mailda/budgets";

import type { ButlerNode } from "./ast.ts";
import { reachableFrom } from "./graph.ts";
import { isLoopKind, type LoopKind, type ShippedKind } from "./nodes.ts";

/**
 * What a Butler costs to run, and which pot that is measured against (#54).
 *
 * ## The rule, and where it comes from
 *
 * `docs/receipts/butler-step-cost.md` states it: **sum the fixed cost of every non-loop node, add
 * `maxItems × per-item cost` for each loop, and refuse publication if the total exceeds the budget with
 * headroom.** The receipt reached that rule by arithmetic rather than by taste — a `foreach` of 200 items
 * each proposing a send spends 4,000 subrequests, 40% of a whole Paid run, so a loop cannot be priced in
 * isolation from what the rest of the graph already spends.
 *
 * It is a **publication-time** refusal, and that is the half #49 could not do. #49 gives a loop a runtime
 * bound: a collection larger than `maxItems` fails the step and processes nothing. The platform's subrequest
 * ceiling extends no such courtesy. It kills the invocation wherever it is — mid-loop, after the effects it
 * already performed — so a Butler that cannot afford itself must be refused before it can ever run.
 *
 * ## Why the numbers come from `@mailda/budgets` and not from the Worker
 *
 * The costs are Worker measurements: `metering()` in `workerd` against real D1 and R2, recorded in
 * `butler-step-cost.md`. This package cannot import the Worker — it is a dependency of it, and reversing
 * that would put the AST behind the thing that stores the AST.
 *
 * The seam is `@mailda/budgets`, and it was checked rather than assumed. It is **generated from
 * `docs/receipts/*.md`** and it is a package with no dependencies of its own, so what this module imports is
 * the compiled form of the *receipts*, not of the Worker. That distinction is the whole reason it is the right
 * seam: the number's provenance is a measurement filed in the repository, `pnpm receipts:check` fails on any
 * hand edit, and one figure serves the measurement test that produced it and the checker that divides it.
 *
 * Two alternatives, and what each costs:
 *
 * - **Take the cost table as a parameter**, injected by whoever calls the checker. Then two callers can
 *   disagree about what a Butler costs, the pinned tests in this package pin nothing, and the answer to
 *   "will this publish" depends on who asked. Rejected.
 * - **Write the numbers here.** AGENTS.md: you cannot write the number, only the receipt. Rejected, and it
 *   would also have gone stale twice this month without anything noticing.
 *
 * ## Which pot, decided here rather than deferred
 *
 * The pot is plan-scoped — 10,000 subrequests per Workflow instance on Workers Paid, 1,000 on Workers Free
 * (#68) — and **a Node cannot detect its own plan**: `doctor`'s check is `severity: "report"`, *"Not
 * checkable from inside a Worker"*, because there is no account API from inside one. Both `butler-step-cost.md`
 * and `butler-step-budget.md` recorded the choice of row as deferred to whoever wrote this pass. This is it,
 * and the choice is **Workers Paid**.
 *
 * Three reasons, in the order they decided it:
 *
 * 1. **On the Free row a good widget touches the tripwire.** AGENTS.md defines a tripwire as a limit placed
 *    *past where any good widget goes*, and says that if a good one touches it the tripwire is wrong rather
 *    than the widget. A `foreach` of 200 items each proposing a send — the fan-out this repository reaches
 *    for elsewhere — costs 4,038 with the graph around it, which the Free pot refuses four times over. That
 *    is not a tripwire, it is a product limit nobody measured a need for.
 * 2. **The permissive direction lands only on a configuration this project already refuses.** ADR 25 requires
 *    Workers Paid and `mailda deploy` enforces it with an account token. Refusing against Free would impose a
 *    bound a tenth the size on **every supported Node** to protect one that is unsupported.
 * 3. **The receipt names the failure mode of an unusably small bound**, in its own words: it *"gets raised by
 *    whoever hits it, without re-measuring"*. A bound that refuses ordinary Butlers is a bound that gets
 *    raised by an author, and then nothing here is measuring anything.
 *
 * **What the rejected option would have bought, stated rather than glossed.** A Free Node is possible even
 * though it is unsupported: `deploy-button-install.md` measured the one-click path and it verifies no plan at
 * all. On such a Node a Butler this pass admits can die mid-run — the pot empties at item 50 of a 200-send
 * loop, having already sealed 50 manifests. Refusing against Free would have prevented exactly that, and the
 * price was reason 1. So the refusal below **names both rows and both figures**, and says which one it
 * applied: an operator who has ignored ADR 25 can read the Free arithmetic in the same message as the Paid
 * one, rather than discovering it from a dead instance.
 *
 * ## Headroom is per node and already receipted, so there is no second fudge factor
 *
 * The rule says "with headroom". The headroom is **inside the four figures**: `butler-step-cost.md` records
 * them as *"bounds with headroom, not the measured figures"* — `case.assign` 8 against a measured 5,
 * `case.close` 3 against 1, `draft` 10 against 5, `lookup` 4 against 1. Summing the bounds therefore prices
 * every node above what it costs, and the total is an over-estimate by construction.
 *
 * A second global margin — 80% of the pot, say — would be a number with no measurement behind it, and this
 * file would then be the only place in the repository where a literal ceiling was written without a receipt.
 * Stated here so the next reader does not read its absence as an oversight.
 *
 * **One figure has no headroom left and that is worth saying twice.**
 * `butler.step_cost_max_send_propose = 20` against a worst realistic seal measured at **20** — the reply
 * path, both derived policy conditions, an approval gate and the breaker query. It still holds. It is exactly
 * the truth for the worst path and an over-estimate for the ordinary one (12), so this pass is not permissive
 * today. It is one operation away from being permissive, and the day the seal gains one,
 * `test/butler-step-cost.measure.test.ts` fails and whoever added it must re-measure and then decide with the
 * consequence in view: at 24 the Paid pot buys 416 sends instead of 500.
 */

/**
 * The pot one whole run spends from, and its name.
 *
 * The **name** is exported beside the value, and every message below prints it from here rather than
 * spelling it out. A refusal that says `workflow.paid.…=1000` because somebody changed which key the value
 * came from would be a message claiming a plan it did not divide — the exact overclaim #68 corrected in the
 * key itself, reappearing one layer along in the text about it.
 */
export const RUN_BUDGET_NAME = "workflow.paid.subrequest_budget_per_instance" as const;
export const RUN_BUDGET = BUDGETS[RUN_BUDGET_NAME];

/** The same pot on the plan ADR 25 refuses. Named in every refusal, never divided by. */
export const RUN_BUDGET_FREE_NAME = "workflow.free.subrequest_budget_per_instance" as const;
export const RUN_BUDGET_FREE = BUDGETS[RUN_BUDGET_FREE_NAME];

/** The budget key each priced node divides, so a refusal can name it rather than just its value. */
const COST_BUDGET_OF: { [K in ShippedKind]: keyof typeof BUDGETS | null } = {
  /*
   * The zero column. Seven of these are measured zero in `butler-step-cost.md`; `map` and `foreach` join them
   * by the #54 correction, on the argument that a loop is control flow — it evaluates an expression already
   * in the run's state and enters an edge — and on `butler-step-budget.md`'s probe, where 30 steps of 100
   * queries closed at exactly 3,000, so a `step.do` costs no subrequest of its own. What a loop costs is its
   * body, priced per item below.
   *
   * `null` rather than `0` so that "this node is free" is a decision with a name, not a missing entry.
   */
  guard: null,
  switch: null,
  map: null,
  foreach: null,
  join: null,
  wait: null,
  stop: null,
  transform: null,
  validate: null,

  lookup: "butler.step_cost_max_lookup",
  "case.assign": "butler.step_cost_max_case_assign",
  "case.close": "butler.step_cost_max_case_close",
  draft: "butler.step_cost_max_draft",
  "mail.send.propose": "butler.step_cost_max_send_propose",
};

/**
 * What one execution of one node costs, in subrequests.
 *
 * Exhaustive over `ShippedKind` by construction, like the successor map: a node moving from reserved to
 * shipped with no entry here does not compile. That is the enforcement behind `butler-step-cost.md`'s
 * `stale_when` clause *"a node type is added to the shipped set without a measurement here"* — which was an
 * unenforced sentence until this pass existed, and was already violated by three nodes when it was written
 * (`lookup`, `map` and `foreach`).
 */
export const SHIPPED_NODE_COST: { [K in ShippedKind]: number } = Object.fromEntries(
  Object.entries(COST_BUDGET_OF).map(([kind, budget]) => [kind, budget === null ? 0 : BUDGETS[budget]]),
) as { [K in ShippedKind]: number };

/** The receipt key a node's cost came from, for a refusal that has to name the bound. See `COST_BUDGET_OF`. */
export function costBudgetOf(kind: ShippedKind): keyof typeof BUDGETS | null {
  return COST_BUDGET_OF[kind];
}

/**
 * Multiplication that stops at `Number.MAX_SAFE_INTEGER` instead of losing precision.
 *
 * Nested loops multiply their bounds, and `maxItems` is only required to be a safe integer — so two loops of
 * a million nest to 10^12 and four nest past what a double can represent exactly. A silently imprecise total
 * would be a wrong number in whichever direction the rounding fell. Saturating is honest and the result is
 * refused either way; `ButlerCost.saturated` says it happened so a refusal never prints a total it made up.
 */
const CEILING = Number.MAX_SAFE_INTEGER;
function saturatingProduct(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return a > CEILING / b ? CEILING : a * b;
}
function saturatingSum(a: number, b: number): number {
  return a > CEILING - b ? CEILING : a + b;
}

/** One priced loop, as a refusal has to be able to read it out. */
export interface LoopCost {
  readonly id: string;
  readonly kind: LoopKind;
  readonly maxItems: number;
  /** One iteration of this loop's body, nested loops inside it included. */
  readonly perItem: number;
  /** `maxItems × perItem` — this loop's whole contribution, per one execution of the loop itself. */
  readonly total: number;
  /**
   * True when this loop is itself inside another loop's body, which makes `total` a figure *per outer
   * iteration* rather than the whole graph. Carried rather than inferred because it changes what the number
   * means, and a reader who divided a nested loop's total into the pot would be out by the outer bound.
   */
  readonly nested: boolean;
  /** The dearest node inside the body, so a refusal can say which node makes the loop expensive. */
  readonly dearest: NodeCost | null;
}

/** One priced node: what one execution costs, and how many executions the graph permits. */
export interface NodeCost {
  readonly id: string;
  readonly type: ShippedKind;
  readonly each: number;
  /** How many times the graph can run it: the product of the bounds of every loop whose body reaches it. */
  readonly executions: number;
  readonly total: number;
}

export interface ButlerCost {
  /** The whole graph, in subrequests against one Workflow instance's pot. */
  readonly total: number;
  /** What the nodes no loop body reaches cost — the "fixed cost of every non-loop node" half of the rule. */
  readonly outsideLoops: number;
  /** How many nodes that was, so a refusal with no loop in it can still say what it is made of. */
  readonly outsideLoopCount: number;
  /** Every loop, dearest first. */
  readonly loops: readonly LoopCost[];
  /** The dearest single node contribution in the graph, loop bodies included. */
  readonly dearest: NodeCost | null;
  /** True when a nested-loop product hit `Number.MAX_SAFE_INTEGER`; the total is a floor, not a figure. */
  readonly saturated: boolean;
}

function loopBoundOf(node: ButlerNode): number {
  return (node as Extract<ButlerNode, { type: LoopKind }>).maxItems;
}

function costOf(node: ButlerNode): number {
  return SHIPPED_NODE_COST[node.type as ShippedKind] ?? 0;
}

/**
 * Prices a checked graph.
 *
 * ## The multiplier, which is the whole algorithm
 *
 * A node's cost is multiplied by the bounds of **every** loop whose body reaches it. That one sentence gives
 * the receipt's rule and nesting at the same time: a node no body reaches has multiplier 1 and lands in the
 * fixed sum; a node in one body is multiplied by that loop's `maxItems`; a node in a loop inside a loop is in
 * both bodies and is multiplied by both, which is what it will actually cost.
 *
 * Written as a multiplier rather than as a recursion over loop bodies because the recursive form has to
 * subtract nested bodies out of their parents to avoid counting them twice, and that subtraction is the kind
 * of arithmetic this repository has been off by one in twice.
 *
 * ## Where it deliberately over-prices
 *
 * A node reachable both from a loop body and from the main flow is priced at the loop's multiplier — the run
 * would enter it fewer times than that. Over-pricing refuses a Butler that would have fit; under-pricing
 * admits one that dies mid-run having already sent mail. Given only those two, this pass takes the first, and
 * the shape is rare enough to have no fixture: a body's `next` normally ends the body.
 *
 * Takes the nodes rather than a `Butler` so the checker can price the graph it has already parsed per node,
 * without a second whole-document parse.
 */
export function priceButler(nodes: readonly ButlerNode[]): ButlerCost {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const loops = nodes.filter((node) => isLoopKind(node.type));

  /* Each loop's body, and the multiplier every node inherits from the loops that reach it. */
  const bodies = loops.map((loop) => ({
    loop,
    body: reachableFrom(
      (loop as Extract<ButlerNode, { type: LoopKind }>).body,
      byId,
    ),
  }));

  const multiplierOf = (id: string): number =>
    bodies.reduce(
      (product, { loop, body }) => (body.has(id) ? saturatingProduct(product, loopBoundOf(loop)) : product),
      1,
    );

  const priced: NodeCost[] = nodes.map((node) => {
    const each = costOf(node);
    const executions = multiplierOf(node.id);
    return {
      id: node.id,
      type: node.type as ShippedKind,
      each,
      executions,
      total: saturatingProduct(each, executions),
    };
  });

  const total = priced.reduce((sum, node) => saturatingSum(sum, node.total), 0);
  /*
   * "Outside a loop" is membership of a loop body, **not** a multiplier of 1, and the two differ on exactly
   * one shape: `maxItems: 1`. A loop bounded at one runs its body once, so every node in it has an
   * `executions` of 1 — and asking the multiplier put those nodes in the fixed sum *and* in the loop's own
   * `total`, so `describeCost` reported them twice. The parts of the refusal then did not add up to the
   * total it printed beside them (a `withLoop(1)` graph read "7 node(s) outside a loop cost 58; foreach
   * fan_out costs maxItems=1 × 20 per item = 20" against a total of 58), which is a refusal doing the thing
   * this file argues against everywhere else: putting a number in front of a reader that is not the answer.
   * `1` is a legal bound with no receipt needed — `ast.ts` says so in as many words — so this is a shape an
   * author reaches, not a pathological one.
   */
  const insideSomeLoop = new Set(bodies.flatMap(({ body }) => [...body]));
  const outside = priced.filter((node) => !insideSomeLoop.has(node.id));
  const dearestOf = (candidates: readonly NodeCost[]): NodeCost | null =>
    candidates.filter((node) => node.total > 0)
      .reduce<NodeCost | null>((best, node) => (best === null || node.total > best.total ? node : best), null);

  const pricedById = new Map(priced.map((node) => [node.id, node]));

  const loopCosts: LoopCost[] = bodies.map(({ loop, body }) => {
    const maxItems = loopBoundOf(loop);
    const outerMultiplier = multiplierOf(loop.id);
    /*
     * One iteration of this loop's body. Divided out of the body's total contribution rather than summed
     * separately: every node in the body has this loop and this loop's own enclosing loops among its
     * multipliers, so the division is exact — and it stays exact for nested loops, whose inner bounds survive
     * it and are exactly what "per item" should include.
     */
    const contribution = [...body].reduce(
      (sum, id) => saturatingSum(sum, pricedById.get(id)?.total ?? 0),
      0,
    );
    const divisor = saturatingProduct(outerMultiplier, maxItems);
    const perItem = divisor === 0 ? 0 : Math.ceil(contribution / divisor);
    return {
      id: loop.id,
      kind: loop.type as LoopKind,
      maxItems,
      perItem,
      total: saturatingProduct(maxItems, perItem),
      nested: outerMultiplier > 1,
      dearest: dearestOf([...body].flatMap((id) => {
        const node = pricedById.get(id);
        return node === undefined ? [] : [node];
      })),
    };
  }).sort((a, b) => b.total - a.total);

  return {
    total,
    outsideLoops: outside.reduce((sum, node) => saturatingSum(sum, node.total), 0),
    outsideLoopCount: outside.length,
    loops: loopCosts,
    dearest: dearestOf(priced),
    saturated: total >= CEILING || loopCosts.some((loop) => loop.total >= CEILING),
  };
}

/** `foreach fan_out costs maxItems=499 × 20 per item = 9980 (send_one, a mail.send.propose at ...=20)` */
function describeLoop(loop: LoopCost): string {
  const dearest = loop.dearest === null
    ? "nothing inside it spends a subrequest"
    : `dearest inside it: ${loop.dearest.id}, a ${loop.dearest.type} at ${
      costBudgetOf(loop.dearest.type) ?? "no cost"}=${loop.dearest.each}`;
  const scope = loop.nested ? " per outer iteration, because this loop is inside another" : "";
  return `${loop.kind} ${loop.id} costs maxItems=${loop.maxItems} × ${loop.perItem} per item = ${loop.total}`
    + `${scope} (${dearest})`;
}

/**
 * The `maxItems` that would make the dearest loop fit, or `null` when nothing would.
 *
 * The subtraction is the point of the whole pass, and it is why the answer is 498 rather than the receipt's
 * headline 500: `10,000 / 20` is what a loop costs *alone*, and this loop is not alone — the five nodes
 * around it already spent 38.
 *
 * `null` for a nested dearest loop, and that is a refusal to guess rather than a gap: a nested loop's `total`
 * is per outer iteration, so subtracting it from the graph's total would leave the wrong remainder and the
 * suggestion would be a confidently wrong number in the permissive direction. The refusal still names every
 * loop's arithmetic; what it does not do is hand the author a bound that would not have worked.
 */
export function affordableMaxItems(cost: ButlerCost): { loop: LoopCost; maxItems: number } | null {
  const dearest = cost.loops[0];
  if (dearest === undefined || dearest.perItem === 0 || dearest.nested) return null;
  const rest = cost.total - dearest.total;
  const room = RUN_BUDGET - rest;
  if (room < dearest.perItem) return null;
  return { loop: dearest, maxItems: Math.floor(room / dearest.perItem) };
}

/**
 * The three parts of the refusal that are arithmetic rather than prose, so the finding and any other reader
 * of a `ButlerCost` describe it the same way.
 */
export function describeCost(cost: ButlerCost): string {
  const floor = cost.saturated ? "at least " : "";
  const parts = [
    `${floor}${cost.total} subrequests per run against ${RUN_BUDGET_NAME}=${RUN_BUDGET}`,
    `${cost.outsideLoopCount} node(s) outside a loop cost ${cost.outsideLoops}`,
    ...cost.loops.map(describeLoop),
  ];
  return parts.join("; ");
}
