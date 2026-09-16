import { describe, expect, it } from "vitest";

import { ROUTES } from "@mailda/contract/routes";

import { TEMPLATES, resolve } from "../../src/router.ts";
import { handlerSites } from "./support/handlers.ts";

/**
 * The two properties of the handler table that the type system cannot state.
 *
 * `Handlers` is a mapped type over the registry, so the compiler already refuses a registered route with no
 * handler and a handler for no route. It cannot refuse two domain files naming the same key — an object
 * spread keeps the later one and says nothing — and it cannot tell that two parameterised templates could
 * both match one request path, which would make the answer depend on declaration order.
 */
describe("the handler table", () => {
  it("finds the handlers, so nothing below passes over an empty table", () => {
    // The control: a parser that stopped recognising the object-literal shape would return nothing, and
    // every assertion after this one would hold over nothing.
    expect(handlerSites().length).toBe(ROUTES.length);
  });

  it("has exactly one handler per registered route", () => {
    const counts = new Map<string, string[]>();
    for (const site of handlerSites()) {
      counts.set(site.key, [...(counts.get(site.key) ?? []), `${site.file}:${site.line}`]);
    }
    const doubled = [...counts].filter(([, where]) => where.length > 1)
      .map(([key, where]) => `${key} at ${where.join(" and ")}`);
    expect(doubled, "a route with two handlers is served by whichever spread came last").toEqual([]);

    const registered = new Set(ROUTES.map((spec) => `${spec.method} ${spec.path}`));
    const unregistered = [...counts.keys()].filter((key) => !registered.has(key));
    const unserved = [...registered].filter((key) => !counts.has(key));
    expect({ unregistered, unserved }).toEqual({ unregistered: [], unserved: [] });
  });

  it("resolves every registered template to itself and to nothing else", () => {
    /*
     * A template is resolved by substituting a value into its own parameters and asking the router. If a
     * second template also matched, declaration order would be deciding the route — the shape of defect the
     * `if`-chain this replaced was full of, and the one thing exact-before-parameterised does not settle.
     */
    const ambiguous: string[] = [];
    for (const spec of ROUTES) {
      const filled = spec.path.replace(/:\w+/g, "x");
      const others = TEMPLATES.filter((one) =>
        one.pattern !== null && one.key !== `${spec.method} ${spec.path}` && one.key.startsWith(`${spec.method} `)
        && one.pattern.test(filled)
      );
      if (others.length > 0) ambiguous.push(`${spec.method} ${spec.path} also matches ${others.map((o) => o.key).join(", ")}`);
      expect(resolve(spec.method, filled)?.key).toBe(`${spec.method} ${spec.path}`);
    }
    expect(ambiguous).toEqual([]);
  });

  it("names the segments the registry names", () => {
    const found = resolve("POST", "/api/cases/cas_1/claim");
    expect(found).toEqual({
      key: "POST /api/cases/:caseId/:action", params: { caseId: "cas_1", action: "claim" }, open: false,
    });
    expect(resolve("GET", "/health")?.open).toBe(true);
    expect(resolve("GET", "/api/doctor")?.open).toBe(true);
    // Exact before parameterised: the literal sibling is never captured as a parameter.
    expect(resolve("GET", "/api/mailboxes/readable")?.key).toBe("GET /api/mailboxes/readable");
    expect(resolve("GET", "/api/mailboxes/mbx_1/cases")?.key).toBe("GET /api/mailboxes/:mailboxId/cases");
  });

  it("answers the method-unchecked five on any verb and nothing else on a wrong one", () => {
    expect(resolve("HEAD", "/health")?.key).toBe("GET /health");
    expect(resolve("POST", "/api/me")?.key).toBe("GET /api/me");
    expect(resolve("PATCH", "/api/sends")).toBeNull();
    expect(resolve("GET", "/api/sendz")).toBeNull();
  });
});
