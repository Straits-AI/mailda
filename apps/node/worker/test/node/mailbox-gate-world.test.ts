import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ROUTES, type RouteSpec } from "@mailda/contract/routes";

/**
 * A route whose handler consults a mailbox relation must **declare** that it does.
 *
 * ## Why this exists, and why it is a static check rather than another driver
 *
 * `test/route-authority-parity.test.ts` grew, over several rounds, into a mechanism that genuinely holds the
 * `mailbox` scope: it tries every relation outside a route's declaration, every `anyOf` alternative, every
 * proper subset of an `allOf`, and each subset crossed with an impostor. Eight authorization mutations die on
 * it that previously passed the whole suite.
 *
 * And it looks only at routes that **declare** `scope: "mailbox"`. When this file was written, ten
 * undeclared routes were gated by a mailbox relation and therefore outside that loop entirely; three
 * mutations proved it, each green across 1,531 tests:
 *
 * | route | what a `mailbox.content.read` holder could do |
 * |:--|:--|
 * | `PUT /api/drafts` | compose a draft *as* a mailbox they may not send from |
 * | `POST /api/sends/:sendId/release` | clear #50's Butler gate — the one that exists because no person saw it |
 * | `POST /api/sends/:sendId/release-hold` | release a policy-held send, *"a governance bypass with a benign-looking name"* |
 *
 * `POST /api/sends/dispatch` was in exactly this position two commits ago and was fixed by declaring it —
 * which fixed one route and left its neighbours. That is the shape this file replaces: *somebody remembered
 * to declare it* becomes *an undeclared mailbox-gated route fails the build*.
 *
 * All ten are declared now. What remains undeclared and mailbox-gated is three routes whose gate is one call
 * deep — `POST /api/cases/:caseId/:action`, `POST /api/exports`, `POST /api/exports/:exportId/run` — each
 * held by a named test elsewhere (`layer3-queue`, `ediscovery-export`) and each absent from
 * `GATED_INDIRECTLY`, which is the hand-written half this file cannot check.
 *
 * It is the same fail-closed move the parity suite's own anonymous loop needed when a placeholder id let the
 * router 404 before the handler ran. Applied one level up: rather than trusting that the input set is
 * complete, derive it and fail when it is not.
 *
 * ## What counts as consulting a mailbox relation
 *
 * The named gates, all of which answer *"may this principal do that with this mailbox"* and all of which read
 * `relationship_tuples`. Read from the handler file the way `route-registry.test.ts` reads it — this
 * repository's established idiom for holding `index.ts` to something — and bounded to the block between one
 * route match and the next.
 *
 * ## The limits, stated because the first version stated one and had three
 *
 * - **One level deep.** A gate reached through a helper `index.ts` calls is invisible, which is why
 *   `POST /api/sends/:sendId/release` is in `GATED_INDIRECTLY` rather than found by the scan. That map is
 *   hand-written and nothing asserts it is complete; four families were missing when it was first written.
 * - **Gates called by their own names.** `import { maySend as mayGate }` defeats a substring scan, and no
 *   text scan can follow a rename. The control below asserts several blocks *do* call a listed gate, so a
 *   wholesale rename fails loudly rather than passing silently — but an alias on one call site would not.
 *
 * Both are smaller claims than "every mailbox-gated route", and they are the ones this file can keep. The
 * two limits it *used* to have — a `Map` keyed by path that discarded fifteen duplicate paths, and regex
 * routes skipped entirely, together hiding half the handler — are fixed rather than documented.
 */

const INDEX = new URL("../../src/index.ts", import.meta.url).pathname;

/**
 * Functions that decide something using a mailbox relation.
 *
 * `assertMaySend` and `maySend` are the send gate; `mayRead` and `authorize` the read gate;
 * `mailboxesWithRelation` and `readableMailboxes` bound a listing; `hasAnyRelation` is what they all reach.
 */
const MAILBOX_GATES = [
  "maySend",
  "assertMaySend",
  "mayRead",
  "authorize(",
  "authorizeExport",
  "mailboxesWithRelation",
  "readableMailboxes",
  "hasAnyRelation",
] as const;

/**
 * Routes whose gate lives one call deeper than this scan can see, with the function that holds it.
 *
 * Named rather than missed. Each is declared `mailbox` in the registry on the strength of that function, so
 * `route-authority-parity.test.ts` covers them; this list records why the scan below does not find them
 * itself.
 */
const GATED_INDIRECTLY: Readonly<Record<string, string>> = {
  "PUT /api/drafts": "saveDraft → assertMaySend (src/drafts.ts)",
  "POST /api/sends/:sendId/release": "releaseButlerSend → maySend (src/butler/release.ts)",
  "POST /api/sends/:sendId/release-hold": "releasePolicyHold → maySend (src/outbound/dispatch.ts)",
  "POST /api/sends": "sealManifest → assertMaySend (src/outbound/manifest.ts)",
  "POST /api/sends/:sendId/retry": "retrySend → maySend (src/outbound/dispatch.ts)",
  "DELETE /api/drafts/:draftId": "discardDraft → assertMaySend (src/drafts.ts)",
};

/**
 * Every handler block, as a **list** rather than a map, with the path it serves where that is derivable.
 *
 * ## Three ways the first version saw less than it claimed
 *
 * It examined 53 of 104 blocks and said it examined all of them:
 *
 * - **A `Map` keyed by path overwrote duplicates.** Fifteen paths carry more than one method — `/api/access`
 *   three times, `/api/teams`, `/api/sends`, `/api/matters` — so all but the last block of each was
 *   discarded. Adding a gate to `POST /api/teams` passed, because the `GET` block came later and replaced it.
 * - **Regex-matched routes were skipped entirely**, which is 34 blocks and most of the send, message, team
 *   and Butler surface. Adding a gate straight to `POST /api/cases/:caseId/:action` passed.
 * - **An aliased import defeats the substring test.** `import { maySend as mayGate }` and a `mayGate(…)` call
 *   passes, because the import line is outside every block.
 *
 * The first two are fixed here: blocks are a list, and a regex block resolves to its registry path by the
 * same `anonymise` route `route-registry.test.ts` uses. The third is **not** fixed and is stated instead —
 * a substring scan over text cannot follow a rename, and the honest answer is that this check assumes gates
 * are called by their own names. `MAILBOX_GATES` is asserted non-empty against the source, so a wholesale
 * rename fails loudly rather than quietly.
 */
function handlerBlocks(): { path: string | null; source: string }[] {
  const source = readFileSync(INDEX, "utf8");
  const lines = source.split("\n");
  const starts: { line: number; path: string | null }[] = [];

  for (const [index, line] of lines.entries()) {
    const literal = /url\.pathname === "([^"]+)"/.exec(line);
    if (literal !== null) starts.push({ line: index, path: literal[1]! });

    /*
     * A regex route, resolved to the path template the registry declares. Bounded `.{0,300}?` for the reason
     * `route-registry.test.ts` gives: a greedy match across this file backtracks catastrophically, which is
     * how its first extractor hung rather than failed.
     */
    const literalRegex = /= (\/\^.{0,300}?\$\/)\.exec\(url\.pathname\)/.exec(line);
    if (literalRegex !== null) {
      starts.push({ line: index, path: anonymise(literalRegex[1]!.slice(2, -2).replace(/\\\//g, "/")) });
      continue;
    }
    const composed = /new RegExp\(`(\^.{0,300}?\$)`\)/.exec(line);
    if (composed !== null) {
      starts.push({ line: index, path: anonymise(composed[1]!.replace(/\\\//g, "/")) });
    }
  }

  return starts.map((start, index) => ({
    path: start.path,
    source: lines.slice(start.line, starts[index + 1]?.line ?? lines.length).join("\n"),
  }));
}

/**
 * A regex route's pattern reduced to the path template the registry uses.
 *
 * `^/api/sends/([^/]+)/cancel$` becomes `/api/sends/:x/cancel`, and an interpolated `${…}` segment reduces
 * the same way — what the pattern *matches* is one path segment, and which alphabet it accepts is
 * `id-prefix-world.test.ts`'s question rather than this file's.
 */
function anonymise(pattern: string): string {
  return pattern
    .replace(/^\^/, "").replace(/\$$/, "")
    .replace(/\((?:\$\{[^}]*\}|[^)]*)\)/g, ":x");
}

/** The registry's paths in the same shape, so a resolved regex route can be matched to its declaration. */
function registryTemplate(path: string): string {
  return path.replace(/:\w+/g, ":x");
}

describe("a mailbox-gated route says so in the registry", () => {
  it("finds handler blocks at all, so a rewritten router cannot empty this check", () => {
    /*
     * The control, and this file needs one more than most: every assertion below is "nothing was found
     * wrong", which a scanner that read no source satisfies perfectly. `index.ts` serves over a hundred
     * routes; the floor is far below that and far above zero.
     */
    const blocks = handlerBlocks();
    expect(blocks.length, "no handler blocks found — has the router's shape changed?").toBeGreaterThan(90);
    expect(
      blocks.filter((one) => one.path !== null).length,
      "no block resolved to a path, so nothing below can be matched to a declaration",
    ).toBeGreaterThan(90);
    expect(
      blocks.filter((one) => MAILBOX_GATES.some((gate) => one.source.includes(gate))).length,
      "no block calls any mailbox gate, so the gate list no longer matches the code — a rename would show "
      + "here rather than as a silent pass, which is the one defence against an aliased call",
    ).toBeGreaterThan(5);
  });

  it("declares every route whose own handler consults a mailbox relation", () => {
    /*
     * Keyed by the **template**, so a regex route resolves to its declaration and the several methods on one
     * path are all considered. The first version keyed a `Map` by path and lost fifteen duplicate paths to
     * overwriting — adding a gate to `POST /api/teams` passed because the `GET` block came later.
     *
     * A path with more than one method takes the union of its declared scopes: if any method on it declares
     * `mailbox`, a gate found in any of its blocks is accounted for. That is deliberately generous — this
     * check's job is to make sure the parity suite *sees* the route, and that suite drives per method.
     */
    const declaredScopes = new Map<string, Set<string | undefined>>();
    for (const spec of ROUTES as readonly RouteSpec[]) {
      const key = registryTemplate(spec.path);
      declaredScopes.set(key, (declaredScopes.get(key) ?? new Set()).add(spec.authority?.scope));
    }

    const undeclared: string[] = [];
    for (const { path, source } of handlerBlocks()) {
      if (path === null) continue;
      if (!MAILBOX_GATES.some((gate) => source.includes(gate))) continue;
      /*
       * `export` counts as declared alongside `mailbox`. `GET /api/exports/:exportId/objects/:objectId` calls
       * `authorizeExportObject`, which re-asks on every object whether the **requester** still holds
       * `ediscovery.export` and whether the approval stands — a mailbox relation, reached through a scope of
       * its own because the holder is the requester rather than the caller. Declaring it `mailbox` would be
       * false; leaving it out of this check would be the gap this file exists to close. It is driven by
       * `test/ediscovery-export.test.ts`, where dropping the requester term fails.
       */
      const scopes = declaredScopes.get(registryTemplate(path));
      if (scopes === undefined || !(scopes.has("mailbox") || scopes.has("export"))) {
        undeclared.push(`${path} — declared ${[...(scopes ?? [])].join("/") || "nothing"}`);
      }
    }

    expect(
      undeclared,
      "these handlers consult a mailbox relation and do not declare `scope: \"mailbox\"`, so "
      + "test/route-authority-parity.test.ts never drives them — which is how a mailbox.content.read holder "
      + "came to be able to release a policy-held send with the whole suite green:",
    ).toEqual([]);
  });

  it("declares every route whose gate lives one call deeper", () => {
    /*
     * The half the scan cannot see, held as an exact map rather than trusted. Every entry must be declared
     * `mailbox`, so removing a declaration fails here even though no gate appears in `index.ts` itself.
     */
    const declared = new Map(
      (ROUTES as readonly RouteSpec[]).map((spec) => [`${spec.method} ${spec.path}`, spec.authority?.scope]),
    );
    const wrong = Object.entries(GATED_INDIRECTLY)
      .filter(([route]) => declared.get(route) !== "mailbox")
      .map(([route, gate]) => `${route} — gated by ${gate}, declared ${declared.get(route) ?? "nothing"}`);

    expect(
      wrong,
      "these routes are gated by a mailbox relation inside the function they call, and the registry does not "
      + "say so:",
    ).toEqual([]);

    // The control: an empty map would satisfy the filter without checking anything.
    expect(Object.keys(GATED_INDIRECTLY).length).toBeGreaterThan(3);
  });
});
