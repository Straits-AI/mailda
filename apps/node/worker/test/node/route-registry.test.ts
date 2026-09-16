import { describe, expect, it } from "vitest";

import { path, route } from "@mailda/contract/routes";

/*
 * What this file no longer checks, and why.
 *
 * It used to read `src/index.ts` with regular expressions to establish that every path the router decided
 * on was registered and every registered route was served. That agreement is a type now: `HANDLERS` in
 * `src/routes/index.ts` is `Record<RouteKey, Handler>` over the registry, so a missing handler and an
 * unregistered one are both compile errors, and the `METHOD_UNCHECKED` five are read by the router rather
 * than recounted here. What a type cannot see — two parts contributing the same key, two templates that
 * could match one path — is `route-table.test.ts`.
 */

describe("filling a route's parameters refuses what it cannot account for", () => {
  it("substitutes and encodes", () => {
    expect(path(route("POST", "/api/butlers/:butlerId/publish"), { butlerId: "btl_1" }))
      .toBe("/api/butlers/btl_1/publish");
    // Encoded, because an id is data. Nothing mints one containing a slash, which is exactly why a path
    // built by concatenation would go unnoticed until something did.
    expect(path(route("GET", "/api/teams/:teamId"), { teamId: "a/b" })).toBe("/api/teams/a%2Fb");
  });

  it("refuses a missing parameter rather than emitting a literal colon", () => {
    /*
     * The failure this prevents is the worst-shaped one available. `/api/sends/:sendId/cancel` sent as-is
     * reaches the Worker, matches no guard, and is answered with the interface shell and a **200** — so the
     * caller sees success and the send is not cancelled.
     */
    expect(() => path(route("POST", "/api/sends/:sendId/cancel"), {})).toThrow(/needs sendId/);
    expect(() => path(route("POST", "/api/sends/:sendId/cancel"), { sendId: "" })).toThrow(/needs sendId/);
  });

  it("refuses a parameter the route does not take", () => {
    expect(() => path(route("GET", "/api/sends"), { sendId: "snd_1" })).toThrow(/takes no parameters/);
    expect(() => path(route("GET", "/api/teams/:teamId"), { teamId: "t", extra: "x" }))
      .toThrow(/takes teamId, not extra/);
  });

  it("does not compile a route nobody registered, which is stronger than throwing", () => {
    /*
     * `@ts-expect-error`, not `expect(...).toThrow()`, and the change is the substance of #85 rather than a
     * detail of this test.
     *
     * `ROUTES` is `as const`, so `route`'s second parameter is the union of templates registered for that
     * method. A client naming a route this Node does not serve stops compiling — for every caller, at build
     * time — rather than throwing when a test happens to exercise that one call. The directive fails the
     * typecheck **both** ways, so this also asserts the check is still live.
     */
    /*
     * Inside a function that is never called: the directive suppresses the *type* error, and the call would
     * still run and throw the runtime message this check is meant to have made unreachable. Typechecking
     * does not require execution, which is the whole difference being asserted.
     */
    void (() => {
      // @ts-expect-error — no such route.
      route("GET", "/api/sendz");
      // @ts-expect-error — the right path under the wrong verb. Method is part of a route's identity.
      route("PATCH", "/api/sends");
    });
    // And the same path under a verb that *is* registered compiles, so the check is not simply refusing all.
    expect(route("POST", "/api/sends").summary).toMatch(/manifest/);
  });
});
