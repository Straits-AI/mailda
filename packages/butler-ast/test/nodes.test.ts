import { describe, expect, it } from "vitest";

import {
  isShipped, LOOP_KINDS, NODE_KIND_NAMES, NODE_KINDS, RESERVED_KINDS, SHIPPED_KINDS,
  type NodeKind,
} from "../src/nodes.ts";
import { butlerNode, NODE_CATALOGUE, schemaFor } from "../src/ast.ts";

/**
 * The shipped/reserved split is one declaration, and this file is what stops it becoming two.
 *
 * ## The type-level half, which no runtime assertion can reach
 *
 * `NODE_KINDS` is declared `as const satisfies Record<string, NodeDeclaration>`. Annotating it
 * `: Record<string, NodeDeclaration>` instead would compile, run identically, pass every runtime test in
 * this file — and widen `NodeKind` to `string`, which makes every exhaustive map in this package vacuously
 * satisfiable and lets `isShipped("anything")` type-check. That is the specific hazard AGENTS.md's landmine
 * definition describes, and the only thing that catches it is a type-level assertion, so there is one below.
 * It fails at `pnpm typecheck`, not at `vitest`.
 */

type Assert<T extends true> = T;

/** If `NodeKind` ever widens to `string`, this line stops compiling. */
type _NodeKindIsClosed = Assert<"not.a.node.type" extends NodeKind ? false : true>;

/** And the shipped/reserved partition is by status, not by a second list. */
type _DraftShips = Assert<"draft" extends import("../src/nodes.ts").ShippedKind ? true : false>;
type _LlmIsReserved = Assert<"llm.classify" extends import("../src/nodes.ts").ReservedKind ? true : false>;
type _TemplateIsReserved = Assert<
  "template.render" extends import("../src/nodes.ts").ReservedKind ? true : false
>;

void (0 as unknown as [_NodeKindIsClosed, _DraftShips, _LlmIsReserved, _TemplateIsReserved]);

describe("the node set (#49)", () => {
  it("ships exactly the fourteen nodes the resolution names, after its own correction", () => {
    // Written out rather than derived. This is the one list in the package that is *supposed* to be a
    // second copy: it is the ticket's text, and its whole job is to disagree with the code if the code
    // changes. `template.render` is absent here because the correction moved it, and putting it back
    // silently is the failure the correction was about.
    expect([...SHIPPED_KINDS].sort()).toEqual([
      "case.assign", "case.close", "draft", "foreach", "guard", "join", "lookup", "mail.send.propose",
      "map", "stop", "switch", "transform", "validate", "wait",
    ]);
  });

  it("reserves the rest, including template.render", () => {
    expect([...RESERVED_KINDS].sort()).toEqual([
      "approval.request", "archive", "case.note", "case.task", "case.upsert", "connector.call", "label",
      "llm.classify", "llm.draft", "llm.evaluate", "llm.extract", "llm.summarize", "quarantine", "route",
      "template.render",
    ]);
  });

  it("gives every reserved node a reason that names what is missing", () => {
    for (const kind of RESERVED_KINDS) {
      const because = NODE_KINDS[kind].because;
      // A reason is what an author reads instead of "unsupported". Length is a crude proxy; the real
      // assertion is that no reason is one of the words that says nothing.
      expect(because.length, kind).toBeGreaterThan(30);
      expect(because.toLowerCase(), kind).not.toMatch(/^(not implemented|unsupported|todo)/);
    }
  });

  it("has a schema for every declared kind and no kind without one", () => {
    // The mapped type in ast.ts makes this a compile error too. Asserted at runtime as well because the
    // union is built by mapping over NODE_KIND_NAMES, and an empty or short list there would produce a
    // union that quietly accepts less than it declares.
    for (const kind of NODE_KIND_NAMES) expect(schemaFor(kind), kind).toBeDefined();
    expect(NODE_KIND_NAMES.length).toBe(SHIPPED_KINDS.length + RESERVED_KINDS.length);
    expect(NODE_CATALOGUE.map((entry) => entry.type)).toEqual(NODE_KIND_NAMES);
  });

  it("puts every declared kind in the discriminated union, so a reserved node is representable", () => {
    for (const kind of NODE_KIND_NAMES) {
      const parsed = butlerNode.safeParse({ id: "n", type: kind, ...payloadFor(kind) });
      expect(parsed.success, `${kind} must be a member of the union`).toBe(true);
    }
  });

  it("carries a reserved node's own fields through parsing rather than stripping them", () => {
    // "Representable in the AST" has to mean the fields survive. A schema that dropped `profile` would be
    // recording that somebody asked for an LLM node and losing what they asked it to do.
    const parsed = butlerNode.parse({
      id: "extract", type: "llm.extract", profile: "sales-intake@3", outputSchema: "schemas/lead.v4.json",
    });
    expect(parsed).toMatchObject({ profile: "sales-intake@3", outputSchema: "schemas/lead.v4.json" });
  });

  it("names both loops and nothing else", () => {
    expect([...LOOP_KINDS]).toEqual(["map", "foreach"]);
    for (const kind of LOOP_KINDS) expect(isShipped(kind)).toBe(true);
  });
});

/** Minimum valid payload per kind, so the union-membership test above is about membership and not shape. */
function payloadFor(kind: NodeKind): Record<string, unknown> {
  switch (kind) {
    case "guard": return { when: "x", then: null, otherwise: null };
    case "switch": return { on: "x", cases: [{ equals: "a", next: null }], default: null };
    case "map": return { over: "x", as: "i", maxItems: 1, body: "b", collectAs: "out", next: null };
    case "foreach": return { over: "x", as: "i", maxItems: 1, body: "b", next: null };
    case "wait": return { seconds: 1, next: null };
    case "stop": return { reason: "done" };
    case "transform": return { as: "v", value: "x", next: null };
    case "validate": return { value: "x", schema: { type: "object" }, next: null };
    case "lookup": return { entity: "case", id: "x", as: "c", next: null };
    case "case.assign": return { caseId: "x", assignee: "y", next: null };
    case "case.close": return { caseId: "x", next: null };
    case "draft":
      return { mailboxId: "m", to: ["a"], subject: "s", body: "b", as: "d", next: null };
    case "mail.send.propose": return { draft: "d", next: null };
    default: return {};
  }
}
