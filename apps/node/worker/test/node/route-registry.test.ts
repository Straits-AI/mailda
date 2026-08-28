import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { METHOD_UNCHECKED, ROUTES, path, route } from "@mailda/contract/routes";

/**
 * The shared contract's route set, held to the Worker that serves it (#85, ADR 12).
 *
 * ## Why this file is the first thing #85 built
 *
 * ADR 12 locks *"UI, CLI, SDK, Skill and MCP parity is **generated from shared contracts**"*, and the
 * property worth having is the last three words — the thing that stops clients drifting from one Node.
 * `packages/contract/src/routes.ts` is the description; **this is what makes it true.** A registry nothing
 * checks is a fourth hand-maintained copy of the API, which is the problem rather than the fix.
 *
 * ## Both directions, because each catches a different mistake
 *
 * - A path the Worker serves and the registry omits is a route no generated surface will ever expose. It
 *   fails silently as *absence*, which is the hardest kind to notice.
 * - A path in the registry the Worker does not serve is worse: a generated client would call it, and this
 *   Node answers an unmatched `/api/…` path with the **interface shell and a 200**. A caller gets HTML where
 *   it expected JSON, from a request that looks like it succeeded.
 *
 * ## Reading the handler rather than importing it
 *
 * `src/index.ts` is a Worker module — it reaches `cloudflare:` imports and cannot be loaded in Node, which is
 * what `test/node/` runs under. So the routes are extracted **lexically**, and the extraction is deliberately
 * narrow: a string compared to `url.pathname`, or a regex literal handed `.exec(url.pathname)`. Those are the
 * only two shapes this Worker uses to decide a route, and both are unambiguous to read.
 *
 * That narrowness is a real constraint and it is stated rather than hidden: **a route dispatched some third
 * way would be invisible here.** What makes that safe is the direction it fails in — an unrecognised shape
 * means a path the extractor does not see, so the registry-to-Worker check below would flag its entry as
 * unserved the moment somebody registered it, and the anti-vacuity floor catches wholesale breakage.
 */

const INDEX = join(import.meta.dirname, "../../src/index.ts");

/**
 * Every path template `src/index.ts` decides a route on.
 *
 * Regex captures become `:param`. The **names cannot be recovered** — the handler captures positionally —
 * so both sides are compared with names erased. That is a genuine limit of reading the handler rather than
 * generating it, and the consequence is that this file proves the *shape* of the route set rather than the
 * spelling of its parameters. `routes.ts` names them for readers and `path()` refuses an unknown one, which
 * is where that spelling is held to account.
 */
function servedPaths(): Set<string> {
  const source = readFileSync(INDEX, "utf8");
  const found = new Set<string>();

  for (const match of source.matchAll(/url\.pathname === "([^"]+)"/g)) {
    found.add(match[1]!);
  }

  for (const line of source.split("\n")) {
    // Bounded rather than greedy: a `.*?` across a 2,400-line file backtracks catastrophically, which is how
    // the first version of this extractor hung instead of failing.
    const match = /= (\/\^.{0,300}?\$\/)\.exec\(url\.pathname\)/.exec(line);
    if (match === null) continue;
    found.add(anonymise(
      match[1]!.slice(2, -2).replace(/\\\//g, "/"),
    ));
  }

  /*
   * A second idiom: `new RegExp(\`^…\`)` built from the identifier registry.
   *
   * It exists because the two rules this file and `id-prefix-world.test.ts` enforce collided. A literal
   * regex is what this scanner reads, and writing one for `/api/agents/:agentId` means spelling the ULID
   * alphabet by hand — which that file refuses by name, and refuses for a reason: `case_` and `cas_` came to
   * disagree exactly that way. So the route composes its pattern from `idPattern(ID_PREFIXES.agent)` and this
   * scanner learned to see it.
   *
   * The interpolation is reduced to a captured segment before anonymising: what the pattern *matches* is one
   * path segment, and which alphabet it accepts is not this file's question.
   */
  for (const line of source.split("\n")) {
    const match = /new RegExp\(`(\^.{0,300}?\$)`\)/.exec(line);
    if (match === null) continue;
    found.add(anonymise(
      match[1]!.slice(1, -1)
        // The interpolation with its own capture group, so the result is one captured segment rather than a
        // group wrapping a group — which is what produced `/api/agents/(:x)` on the first attempt.
        .replace(/\(\$\{[^}]*\}\)/g, "([^/]+)")
        .replace(/\$\{[^}]*\}/g, "([^/]+)"),
    ));
  }
  return found;
}

/** A path template with its parameter names erased, so the two sides are comparable. */
function anonymise(template: string): string {
  return template
    // `([^/]+)` from the handler, `:name` from the registry — one segment, captured, either way.
    .replace(/\(\[\^\/\]\+\)/g, ":x")
    // `(claim|steal|release|close)` — an alternation is still one captured segment.
    .replace(/\([a-z|]{2,60}\)/g, ":x")
    .replace(/:(\w+)/g, ":x");
}

const registered = new Set(ROUTES.map((spec) => anonymise(spec.path)));

describe("every route this Node serves is described once", () => {
  it("finds the routes, so nothing below passes by comparing two empty sets", () => {
    /*
     * The anti-vacuity check, and the number is a floor rather than an equality on purpose: this file must
     * fail when routes go **missing from the extractor**, and must not need editing every time somebody adds
     * a route. 60 is comfortably below the 71 the tree has and far above anything a broken regex returns.
     */
    const served = servedPaths();
    expect(served.size).toBeGreaterThan(60);
    expect(served).toContain("/api/sends");
    expect(served).toContain(anonymise("/api/butlers/([^/]+)/publish"));
  });

  it("registers every path the handler decides on", () => {
    const missing = [...servedPaths()].map(anonymise).filter((p) => !registered.has(p)).sort();
    expect(
      missing.length === 0 ? null
        : `${missing.join(", ")} — served by src/index.ts and absent from packages/contract/src/routes.ts. `
          + "A route missing from the registry is one no generated surface will ever expose, which fails as "
          + "absence rather than as an error (ADR 12).",
    ).toBeNull();
  });

  it("registers nothing the handler does not serve", () => {
    const served = new Set([...servedPaths()].map(anonymise));
    const phantom = [...registered].filter((p) => !served.has(p)).sort();
    expect(
      phantom.length === 0 ? null
        : `${phantom.join(", ")} — registered and not served. This is the worse direction: an unmatched `
          + "/api/… path is answered with the interface shell and a 200, so a generated client gets HTML "
          + "from a request that looks like it succeeded.",
    ).toBeNull();
  });
});

describe("the registry names the same verbs the handler answers", () => {
  /**
   * The half that completes the chain, and the reason it exists is a defect that shipped.
   *
   * The path checks above pin *which routes* exist. They cannot see a **verb** mismatch, and one was live:
   * `src/client/app/api.ts` sent `PUT /api/policies/:id/draft` while the handler answered only POST, so
   * editing a policy draft returned 404 `not_found` for as long as the route existed. Confirmed against a
   * running Node before it was fixed, not inferred.
   *
   * With this in place the chain runs end to end with no hand-maintained link:
   *
   * | link | held by |
   * |:--|:--|
   * | client → registry | `PathFor<M>` — an unregistered template, or the right path under the wrong verb, does not compile |
   * | registry → handler | this file: paths above, methods here |
   *
   * So a client and a handler cannot disagree about a verb without something failing, which is exactly what
   * neither of them had before.
   */
  function servedMethods(): Map<string, Set<string>> {
    const source = readFileSync(INDEX, "utf8");
    const lines = source.split("\n");
    const consts = new Map<string, string>();
    for (const line of lines) {
      const match = /const (\w+) = (\/\^.{0,300}?\$\/)\.exec\(url\.pathname\)/.exec(line);
      if (match !== null) {
        consts.set(match[1]!, anonymise(match[2]!.slice(2, -2).replace(/\\\//g, "/")));
      }
    }

    const found = new Map<string, Set<string>>();
    lines.forEach((line, index) => {
      let template: string | null = null;
      const literal = /url\.pathname === "([^"]+)"/.exec(line);
      if (literal !== null) template = literal[1]!;
      else {
        for (const [name, pattern] of consts) {
          if (new RegExp(`if \\(${name}\\b`).test(line)) { template = pattern; break; }
        }
      }
      if (template === null) return;
      // The guard's line plus the two after it, which is where a `&&` continuation sits.
      const window = lines.slice(index, index + 3).join(" ");
      const verbs = [...window.matchAll(/request\.method === "([A-Z]+)"/g)].map((m) => m[1]!);
      const key = anonymise(template);
      if (!found.has(key)) found.set(key, new Set());
      for (const verb of verbs) found.get(key)!.add(verb);
    });
    return found;
  }

  it("agrees with the handler about every verb it can read", () => {
    const served = servedMethods();
    const wanted = new Map<string, Set<string>>();
    for (const spec of ROUTES) {
      const key = anonymise(spec.path);
      if (!wanted.has(key)) wanted.set(key, new Set());
      wanted.get(key)!.add(spec.method);
    }

    const disagreements: string[] = [];
    let compared = 0;
    for (const [template, verbs] of served) {
      // The five method-unchecked routes have no verb to compare; they are asserted as a set below.
      if (verbs.size === 0) continue;
      const registered = wanted.get(template);
      if (registered === undefined) continue;   // a missing entry is the path check's failure, not this one.
      compared += 1;
      const only = (set: Set<string>) => [...set].sort().join(",");
      if (only(verbs) !== only(registered)) {
        disagreements.push(`${template}: handler answers ${only(verbs)}, registry says ${only(registered)}`);
      }
    }

    /*
     * Anti-vacuity, and it matters more here than usual: this comparison silently skips anything the
     * extractor could not read a verb for, so a broken extractor would agree with everything.
     */
    expect(compared).toBeGreaterThan(50);
    expect(
      disagreements.length === 0 ? null
        : `${disagreements.join("; ")} — a client generated from the registry would send a verb this Node `
          + "does not answer, and an unmatched method falls through to a 404 that reads as a missing "
          + "resource rather than a wrong request (#85).",
    ).toBeNull();
  });
});

describe("the routes that answer any verb are a closed set", () => {
  /**
   * Five handlers test `url.pathname` and never `request.method`, so `DELETE /health` is served exactly as
   * `GET /health` is.
   *
   * All five are read-only, so nothing is destroyed — but a generated client would state a method this Node
   * does not check, and closing that gap is what ADR 12 is for. Rather than change five handlers as a side
   * effect of writing a registry, the set is **named**, so a sixth is a decision somebody makes on purpose.
   */
  it("is exactly the five recorded, so a sixth cannot join quietly", () => {
    const source = readFileSync(INDEX, "utf8");
    const unchecked: string[] = [];
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      const match = /if \(.*url\.pathname === "([^"]+)"/.exec(line);
      if (match === null) return;
      // The guard's own line plus the two after it, which is where a `&&` continuation would sit.
      const window = lines.slice(index, index + 3).join(" ");
      if (!/request\.method === "/.test(window)) unchecked.push(match[1]!);
    });

    expect([...new Set(unchecked)].sort()).toEqual([...METHOD_UNCHECKED].sort());
  });
});

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
