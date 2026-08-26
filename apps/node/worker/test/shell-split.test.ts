import { describe, expect, it } from "vitest";

import { APP_ROUTES, isAppRoute } from "../src/app-routes.ts";
import { clientAsset, page } from "../src/ui.ts";

/**
 * ADR 30's split, asserted rather than described.
 *
 * The decision is that **sign-in, first-run claim and a locked-out `doctor` carry no framework**, because
 * they are the screens an operator sees when the Node is broken. #23 was that case literally: a dropped
 * binding made sign-in return 500, leaving the diagnostic the only reachable surface. If the page ever
 * loads the React bundle up front, that property is gone — and nothing about the page would look wrong.
 *
 * `react-shell-bundle.md` records the same thing as a number (`shell.pre_auth_bundle_bytes: 0`). A receipt
 * is a measurement taken once; this is what keeps it true.
 */
describe("the pre-authentication surface loads no bundle (ADR 30)", () => {
  it("does not reference the application bundle in the page it serves", () => {
    const html = page();
    // A `<script src="/app/shell.js">` would be the obvious way to lose this. So would a modulepreload,
    // which costs the same bytes while looking like an optimisation.
    expect(html).not.toContain("/app/shell.js");
    expect(html).not.toContain("modulepreload");
  });

  it("serves the framework-free script as the page's only entry point", () => {
    const html = page();
    expect(html).toContain('<script type="module" src="/app/app.js"></script>');
  });

  it("still serves the bundle, on its own path, for the dynamic import to reach", () => {
    // The other half: a split that dropped the bundle entirely would also pass the assertions above.
    const shell = clientAsset("/app/shell.js");
    expect(shell).not.toBeNull();
    expect(shell!.headers.get("content-type")).toContain("text/javascript");
  });

  it("reaches the bundle by dynamic import rather than a static one", async () => {
    const source = await clientAsset("/app/app.js")!.text();
    // A static `import ... from "/app/shell.js"` would make the bundle a hard dependency of the
    // pre-authentication screens even though nothing there uses it.
    expect(source).not.toMatch(/^import .*\/app\/shell\.js/m);
    expect(source).toContain('await import("/app/shell.js")');
  });
});

/**
 * The route list is shared so a deep link works, and it is a list rather than a catch-all so a mistyped
 * URL still gets a real 404 instead of an interface claiming that page exists.
 */
describe("application routes", () => {
  it("serves the page for every route the shell owns", () => {
    for (const route of APP_ROUTES) expect(isAppRoute(route)).toBe(true);
  });

  it("does not answer for anything else", () => {
    for (const path of ["/nonsense", "/outbox/", "/OUTBOX", "/api/sends", "/app/app.js"]) {
      expect(isAppRoute(path)).toBe(false);
    }
  });

  it("keeps the screens and the served routes in step", async () => {
    // `main.tsx` builds its routes *from* this list and types the screen map as `Record<AppRoute, …>`, so
    // a route with no screen is a compile error. What that cannot catch is the list being edited to
    // include something the shell has no component for at all — which this notices, because the bundle
    // would then contain a path the map never mentions.
    const bundle = await clientAsset("/app/shell.js")!.text();
    for (const route of APP_ROUTES) expect(bundle).toContain(JSON.stringify(route));
  });
});
