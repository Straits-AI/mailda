import { describe, expect, it } from "vitest";

import { ROUTES, type RouteSpec } from "@mailda/contract/routes";

import { handlerSites } from "./support/handlers.ts";
import { reachableRelations } from "./support/mailbox-gates.ts";

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
 * `relationship_tuples`. Read from the handler table (`support/handlers.ts`): each `"METHOD /path"` property
 * in `src/routes/*.ts` is one handler, parsed rather than pattern-matched, so a block is exactly the code
 * that answers the route and not whatever happened to sit between two regular expressions.
 *
 * ## The limits, stated because the first version stated one and had three
 *
 * - **One level deep.** A gate reached through a helper the handler calls is invisible, which is why
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

function handlerBlocks(): { path: string; file: string; source: string }[] {
  return handlerSites().map((site) => ({ path: site.path, file: site.file, source: site.text }));
}

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
    expect(blocks.length, "no handler blocks found — has the table's shape changed?").toBe(ROUTES.length);
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

  it("declares every route whose gate lives below its first call", () => {
    /*
     * The half the block scan cannot see, **derived** rather than listed.
     *
     * This was `GATED_INDIRECTLY`, a six-entry object mapping route to gating function, written by hand — a
     * second source of truth with nothing guaranteeing completeness, and incomplete the day it was written:
     * `POST /api/cases/:caseId/:action`, `POST /api/exports`, `POST /api/exports/:exportId/run` and
     * `GET /api/butler-runs/:runId/inspect` were all missing.
     *
     * `support/mailbox-gates.ts` walks the Worker's sources and answers the mechanical question — which
     * grantable relations can this handler reach — and this asserts the registry agrees. It does not judge
     * whether the gate is right; `route-authority-parity.test.ts` does that by granting every neighbouring
     * relation, which is the assertion that found nine holes.
     */
    const reach = reachableRelations();
    const declaredScopes = new Map<string, Set<string | undefined>>();
    for (const spec of ROUTES as readonly RouteSpec[]) {
      const key = registryTemplate(spec.path);
      declaredScopes.set(key, (declaredScopes.get(key) ?? new Set()).add(spec.authority?.scope));
    }

    const undeclared: string[] = [];
    let gated = 0;
    for (const { path, file, source } of handlerBlocks()) {
      const relations = reach(file, source);
      if (relations.size === 0) continue;
      gated += 1;
      /*
       * `mailbox`, `export` and `filtered` all state a relation requirement the parity suite drives.
       * `filtered` was missing from the first version, which demanded a declaration for
       * `GET /api/notifications` — whose authority is `{scope:"filtered", by:"relation", relations:
       * ["mailbox.content.read"]}`, i.e. exactly the relation the analyser found. A check that rejects the
       * correct declaration is worse than no check, because the only way to satisfy it is to make the
       * registry lie.
       */
      const scopes = declaredScopes.get(registryTemplate(path));
      const states = ["mailbox", "export", "filtered"].some((one) => scopes?.has(one) === true);
      if (!states) {
        undeclared.push(`${path} — reaches ${[...relations].sort().join(", ")}, declared ${
          [...(scopes ?? [])].join("/") || "nothing"
        }`);
      }
    }

    expect(
      undeclared,
      "these handlers can reach a grantable mailbox relation below their first call and the registry does not "
      + "say so, so route-authority-parity.test.ts never drives them:",
    ).toEqual([]);

    /*
     * The control the hand-written map could not have: if the walk finds no gates at all — a renamed
     * primitive, a broken import resolver — every assertion above passes over nothing.
     */
    expect(gated, "the walk found no gated handler, so it is reading the source wrongly").toBeGreaterThan(10);
  });

});
