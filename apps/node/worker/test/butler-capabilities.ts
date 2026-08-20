import { requirementsOf, type ButlerNode, type Capability } from "@mailda/butler-ast";

/**
 * The ceiling a fixture graph needs, derived from the graph (#51).
 *
 * Every Butler test in this directory builds a source document from a node list, and publication now refuses
 * a document whose declared action set is not **exactly** the action set its nodes need. Writing that list
 * out by hand in six test files would be the correspondence problem those files exist to catch, one level
 * up: the copy nobody updated would refuse to publish and somebody would "fix" it by loosening the check.
 *
 * So the ceiling is derived, from the same `requirementsOf` the checker reads. That makes this helper
 * unable to prove the check works — a fixture computed from the code under test always agrees with it — and
 * proving it is deliberately somebody else's job: `packages/butler-ast/test/capability.test.ts` writes its
 * ceilings by hand and asserts every refusal, and `test/butler-capability.test.ts` writes them by hand where
 * the point is what the runtime does with a ceiling that is wrong. What this helper is for is the other
 * forty tests, whose subject is not the ceiling and which need a Butler that publishes.
 *
 * **The first action of each requirement**, so a two-action requirement contributes one and the
 * over-declaration refusal stays live for these fixtures too: a helper that declared both would make every
 * test in this directory blind to it.
 */
export function capabilitiesFor(nodes: readonly unknown[], address: string): Capability[] {
  const actions = new Set<string>();
  for (const node of nodes) {
    for (const requirement of requirementsOf(node as ButlerNode)) actions.add(requirement[0]);
  }
  return [...actions].map((action) => ({
    action, resource: `mailbox:${address}`,
  })) as Capability[];
}
