import { describe, expect, it } from "vitest";

import { ROUTES, type RouteSpec } from "@mailda/contract/routes";

import { handlerSites } from "./support/handlers.ts";

/**
 * Every query parameter a handler reads is declared on its route.
 *
 * `RouteSpec.query` is what the SDK, the Skill and MCP generate from, so a parameter read by a handler and
 * absent there is a control only the browser can send: `GET /api/audit?action=` and `GET /api/logs?level=`
 * were exactly that until 26 September 2026, and eight more with them. The registry cannot state this
 * invariant as a type, because the read is a string literal inside the handler, so this is rung three of
 * AGENTS.md §2c: the handler source read with the TypeScript parser, never as a phrase.
 *
 * Only literal reads are checked. `GET /api/messages` reads its parameters through `MESSAGE_PAGE_PARAMS`,
 * whose names the registry declares by the same constant, which is a stronger tie than this test provides.
 */
describe("query parameters", () => {
  const literalReads = (text: string): string[] =>
    [...text.matchAll(/searchParams\.get\("([^"]+)"\)/g)].map((match) => match[1]!);

  it("finds literal reads, so the check below holds over more than nothing", () => {
    const read = handlerSites().flatMap((site) => literalReads(site.text));
    expect(read.length).toBeGreaterThanOrEqual(10);
  });

  it("declares every parameter a handler reads by name", () => {
    // Read through `RouteSpec` rather than off the literal tuple, as the SDK generator does: `query` is
    // optional on the spec and absent from most tuple members' types.
    const all: readonly RouteSpec[] = ROUTES;
    const declared = new Map(all.map((spec) =>
      [`${spec.method} ${spec.path}`, new Set((spec.query ?? []).map((one) => one.name))]));
    const undeclared: string[] = [];
    for (const site of handlerSites()) {
      const names = declared.get(site.key) ?? new Set<string>();
      for (const name of literalReads(site.text)) {
        if (!names.has(name)) undeclared.push(`${site.key} reads ?${name}= (${site.file}:${site.line})`);
      }
    }
    expect(undeclared, "declare it in RouteSpec.query so the SDK, Skill and MCP can send it").toEqual([]);
  });
});
