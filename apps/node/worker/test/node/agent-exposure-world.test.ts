import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DECLARED_ROUTES, ROUTES, agentCapabilities, exposureOf, withheldCapabilities, type RouteSpec,
} from "@mailda/contract";

/**
 * A closed world over what a machine may be offered (#88, #89).
 *
 * ## Why this is a test and not a review habit
 *
 * `packages/contract/src/agent.ts` decides which routes an Agent Skill and an MCP server may expose. Both
 * surfaces read it, so a route that arrives unclassified would land in whichever direction the code
 * defaulted — and the only defensible default is *refuse*, which means a new capability silently never
 * appears, which is an absence and therefore the hardest failure to notice.
 *
 * So there is no default. `exposureOf` **throws**, and this file is what runs it over every route before
 * anybody does.
 *
 * It already worked once: `POST /api/sends/:sendId/cancel` was the one changing route the first draft
 * forgot, and the throw named it on the first run rather than a reviewer noticing later.
 *
 * ## The property that actually matters
 *
 * Not "every route has a tier" — that is bookkeeping. It is that **nothing which needs two people is
 * offered to something that can only ever be one.** §18 and #61 count distinct people, and an agent acting
 * inside somebody's session is that person, so every dual-control route is unreachable to it by
 * construction. Offering one anyway would teach an agent to attempt an act it can never complete.
 */

const ALL: readonly RouteSpec[] = ROUTES;

describe("every route is classified, and a new one cannot default", () => {
  it("classifies all of them", () => {
    // `exposureOf` throws on an unclassified changing route, so this fails by name rather than by count.
    for (const spec of ALL) expect(() => exposureOf(spec)).not.toThrow();
    expect(ALL.length).toBeGreaterThan(90);
  });

  it("derives read for every GET but the named exceptions, and there are four", () => {
    /*
     * Reads are derived rather than listed, so ninety judgements cannot disagree with ninety paths. The
     * exception set is asserted **exactly**, because an exception list that can grow quietly is the
     * derivation turning back into a table one entry at a time.
     *
     * `GET /index.html` is the interface shell — a page rather than a question anybody would ask a Node.
     *
     * `GET /api/search/failed` was added with 0044's repair path: it *is* a read, and it is `operator`
     * anyway, because what it reads is maintenance state across the whole organization's mail and its only
     * purpose is to feed the repair route beside it. A read that exists to decide a write belongs with the
     * write.
     *
     * `GET /api/agents` is the sharpest of the four. It enumerates every machine identity on the Node with
     * its sponsor and its reach — which is a map of how to escalate, and exactly what an agent looking for a
     * wider ceiling would read first.
     *
     * `GET /api/agent-capabilities` is the same reasoning about the other half. It publishes the vocabulary a
     * ceiling is chosen from — every name, and the routes behind each one — so a machine reading it is reading
     * the list of what machines may be granted. That is the map from the other direction, and it is withheld
     * for the same reason `GET /api/agents` is.
     */
    const exceptions = Object.keys(DECLARED_ROUTES).filter((key) => key.startsWith("GET "));
    expect(exceptions.sort()).toEqual([
      "GET /api/agent-capabilities", "GET /api/agents", "GET /api/search/failed", "GET /index.html",
    ]);

    for (const spec of ALL.filter((one) => one.method === "GET")) {
      const expected = exceptions.includes(`GET ${spec.path}`) ? "operator" : "read";
      expect(exposureOf(spec).tier, spec.path).toBe(expected);
    }
  });

  it("keeps the surface out of its own tool list", () => {
    /*
     * `POST /mcp` is the MCP server. Offering it as an MCP tool would be recursion, and it is not an act of
     * running the Node either — hence a fifth tier rather than a stretched fourth. Found by this file's own
     * throw the moment #89 added the route.
     */
    const mcp = ALL.find((spec) => spec.path === "/mcp")!;
    expect(exposureOf(mcp).tier).toBe("surface");
    const offered = agentCapabilities((spec) => `${spec.method} ${spec.path}`).map((one) => one.name);
    expect(offered).not.toContain("POST /mcp");
  });

  it("has no entry for a route that does not exist", () => {
    /*
     * The other direction, and the one that rots quietly: a classification for a route somebody removed is a
     * decision about nothing, and it would sit here reading as coverage.
     */
    const served = new Set(ALL.map((spec) => `${spec.method} ${spec.path}`));
    const phantom = Object.keys(DECLARED_ROUTES).filter((key) => !served.has(key));
    expect(phantom).toEqual([]);
  });
});

describe("nothing that needs two people is offered to something that can only be one", () => {
  /**
   * The routes whose refusals name a second person, by the codes those refusals use.
   *
   * Written as the *acts* rather than as a list of paths, so a new route that needs two people fails this
   * by being unlisted-and-offered rather than by being forgotten in two places.
   */
  const NEEDS_TWO_PEOPLE = [
    "POST /api/approvals/:approvalId/decide",
    "POST /api/approvals/:approvalId/withdraw",
    "POST /api/holds/:holdId/lift",
    "POST /api/supervised",
    "POST /api/exports",
    "POST /api/domain-pauses",
    "POST /api/domain-pauses/:pauseId/lift",
  ];

  it("withholds every one of them", () => {
    const offered = new Set(agentCapabilities((spec) => `${spec.method} ${spec.path}`).map((one) => one.name));
    const leaked = NEEDS_TWO_PEOPLE.filter((route) => offered.has(route));
    expect(
      leaked.length === 0 ? null
        : `${leaked.join(", ")} is offered to a machine surface and needs two distinct people. An agent `
          + "inside somebody's session is that person, so it can never complete one — offering it teaches "
          + "an agent to try (#88).",
    ).toBeNull();
  });

  it("withholds sealing a send, which is the one act nobody can undo", () => {
    const offered = new Set(agentCapabilities((spec) => `${spec.method} ${spec.path}`).map((one) => one.name));
    expect(offered.has("POST /api/sends")).toBe(false);
    // And releasing one, which is a person deciding that mail may go.
    expect(offered.has("POST /api/sends/:sendId/release")).toBe(false);
    expect(offered.has("POST /api/sends/:sendId/release-hold")).toBe(false);
  });

  it("offers the dry run, because that is what it was built for", () => {
    /*
     * The positive case, and it is not filler: #87 built a simulation that causes nothing and cannot write,
     * and *"what would this Butler do"* is exactly the question a machine should be able to ask before a
     * person publishes one. A curation rule that withheld it would be timid rather than careful.
     */
    const offered = new Set(agentCapabilities((spec) => `${spec.method} ${spec.path}`).map((one) => one.name));
    expect(offered.has("POST /api/butlers/:butlerId/simulate")).toBe(true);
    expect(offered.has("POST /api/butlers")).toBe(true);
    // …and not publishing it, which is the line #49's draft-then-publish lifecycle already draws.
    expect(offered.has("POST /api/butlers/:butlerId/publish")).toBe(false);
  });

  it("accounts for every route exactly once, offered or withheld", () => {
    const offered = agentCapabilities((spec) => `${spec.method} ${spec.path}`);
    const withheld = withheldCapabilities();
    expect(offered.length + withheld.length).toBe(ALL.length);
    // Non-vacuity in both directions: a rule that offered everything, or nothing, would be no rule.
    expect(offered.length).toBeGreaterThan(20);
    expect(withheld.length).toBeGreaterThan(20);
  });

  it("gives every withheld route a reason a person can read", () => {
    // The Skill quotes these, so an empty one would ship as a blank line explaining an absence.
    for (const entry of withheldCapabilities()) {
      expect(entry.why.length, entry.route).toBeGreaterThan(40);
    }
  });
});

describe("the tier table in docs/machine-surfaces.md counts what exposureOf counts", () => {
  /*
   * That table's five numbers were **all wrong at the same time** — 41/12/25/17/1 against an actual
   * 39/9/29/25/1 — and nothing had ever checked them. A table of counts in a document whose subject is *what a
   * machine may do* reads as evidence that the set is known, so the failure mode is not an inaccuracy: it is a
   * reader believing the curation has been counted when it has not.
   *
   * Parsed out of the document rather than restated here, because a second copy in this file would be the same
   * defect one level down. The tripwire's job is to make the prose and the code disagree loudly, not to become
   * a third place the number lives.
   */
  const doc = readFileSync(
    new URL("../../../../../docs/machine-surfaces.md", import.meta.url).pathname,
    "utf8",
  );

  function documented(): Record<string, number> {
    const rows: Record<string, number> = {};
    for (const line of doc.split("\n")) {
      const match = /^\|\s*`(read|act|governed|operator|surface)`\s*\|.*\|\s*(\d+)\s*\|$/.exec(line.trim());
      if (match !== null) rows[match[1]!] = Number(match[2]);
    }
    return rows;
  }

  it("finds the table, so a rewritten document cannot pass by matching nothing", () => {
    // The control. If the table moves or its shape changes, this file must fail rather than quietly stop
    // checking — which is how the counts got five layers out of date in the first place.
    expect(Object.keys(documented()).sort()).toEqual(
      ["act", "governed", "operator", "read", "surface"],
    );
  });

  it("agrees with the classification on every tier", () => {
    const actual: Record<string, number> = {};
    for (const spec of ALL) {
      const tier = exposureOf(spec).tier;
      actual[tier] = (actual[tier] ?? 0) + 1;
    }
    expect(
      documented(),
      "docs/machine-surfaces.md states tier counts that no longer match the route registry",
    ).toEqual(actual);
  });
});
