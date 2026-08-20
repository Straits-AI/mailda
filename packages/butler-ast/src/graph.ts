import type { ButlerNode } from "./ast.ts";
import { isShipped, type NodeKind, type ShippedKind } from "./nodes.ts";

/**
 * The edges of a Butler, named once (#49, extracted by #54).
 *
 * Two passes need the same answer to *"where does control flow go from here"* — the structural checker's
 * cycle detection and the affordability pass's loop bodies — and the second was not going to import the
 * first, because the first imports the second. So the edge set lives here, in the one module both read, and
 * neither can hold an opinion the other does not. That is the same argument `nodes.ts` makes for keeping one
 * declaration of the node set, applied one level along.
 *
 * Every node id a node names, forward or otherwise. Exhaustive over the shipped kinds by construction: a new
 * shipped kind with no entry here does not compile.
 *
 * Split from `SUCCESSORS` because the two questions are different. `references` answers "does this id
 * exist", which every named id must satisfy. `successors` answers "does control flow go there", which is the
 * only edge set a cycle can be made of. Today the shipped set has no backward reference, so the two coincide
 * — kept separate anyway, because collapsing them would make the first backward reference a silent false
 * cycle.
 *
 * **A loop's `body` is a successor edge and its implicit return is not.** That asymmetry is what makes
 * "acyclic" and "iterates" compatible claims (see `check.ts`), and it is also what lets the affordability
 * pass find a loop's body by walking forward from `body` — the walk cannot escape back into the loop,
 * because an edge that did would already have been refused as a cycle.
 */
const SUCCESSORS: {
  [K in ShippedKind]: (node: Extract<ButlerNode, { type: K }>) => Array<string | null | undefined>;
} = {
  guard: (node) => [node.then, node.otherwise],
  switch: (node) => [...node.cases.map((branch) => branch.next), node.default],
  map: (node) => [node.body, node.next],
  foreach: (node) => [node.body, node.next],
  join: (node) => [node.next],
  wait: (node) => [node.next],
  stop: () => [],
  transform: (node) => [node.next],
  validate: (node) => [node.next],
  lookup: (node) => [node.next],
  "case.assign": (node) => [node.next],
  "case.close": (node) => [node.next],
  draft: (node) => [node.next],
  "mail.send.propose": (node) => [node.next],
};

/** The forward edges of one checked node. */
export function successorsOf(node: ButlerNode): string[] {
  const kind = node.type as NodeKind;
  if (!isShipped(kind)) return [];
  const extract = SUCCESSORS[kind] as (n: ButlerNode) => Array<string | null | undefined>;
  return extract(node).filter((id): id is string => typeof id === "string");
}

/**
 * Every node reachable from `start`, `start` included, following successor edges only.
 *
 * Terminates on a cyclic graph as well as an acyclic one — the visited set is what bounds it, not the
 * acyclicity the checker separately proves. That matters because both callers run against a graph whose
 * cycles have been *reported*, and a pass that hung on the graph it was reporting on would be a checker that
 * never printed its own finding.
 */
export function reachableFrom(start: string, byId: ReadonlyMap<string, ButlerNode>): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (node === undefined) continue;
    seen.add(id);
    for (const target of successorsOf(node)) stack.push(target);
  }
  return seen;
}
