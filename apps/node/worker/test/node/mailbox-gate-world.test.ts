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
 * And it looks only at routes that **declare** `scope: "mailbox"`. Fifty-eight routes declare no authority at
 * all, and roughly ten of those are gated by a mailbox relation, so they sit outside the loop entirely. Three
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
 * The honest limit, stated because a reader should know it: this sees one level. A gate reached through a
 * helper that `index.ts` calls is invisible here, which is why `POST /api/sends/:sendId/release` is listed by
 * the *domain function* it calls rather than found by the scan. That is a smaller claim than "every
 * mailbox-gated route", and it is the one this file can keep.
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

/** Every route the handler serves, with the source between its match and the next one. */
function handlerBlocks(): Map<string, string> {
  const source = readFileSync(INDEX, "utf8");
  const lines = source.split("\n");
  const starts: { line: number; path: string }[] = [];

  for (const [index, line] of lines.entries()) {
    const literal = /url\.pathname === "([^"]+)"/.exec(line);
    if (literal !== null) starts.push({ line: index, path: literal[1]! });
    // A regex route names its own variable, which is the closest thing to a path the block carries.
    const named = /const (\w+) = (?:new RegExp\(`|\/\^)/.exec(line);
    if (named !== null) starts.push({ line: index, path: `~${named[1]}` });
  }

  const blocks = new Map<string, string>();
  for (const [index, start] of starts.entries()) {
    const end = starts[index + 1]?.line ?? lines.length;
    blocks.set(start.path, lines.slice(start.line, end).join("\n"));
  }
  return blocks;
}

describe("a mailbox-gated route says so in the registry", () => {
  it("finds handler blocks at all, so a rewritten router cannot empty this check", () => {
    /*
     * The control, and this file needs one more than most: every assertion below is "nothing was found
     * wrong", which a scanner that read no source satisfies perfectly. `index.ts` serves over a hundred
     * routes; the floor is far below that and far above zero.
     */
    const blocks = handlerBlocks();
    expect(blocks.size, "no handler blocks found — has the router's shape changed?").toBeGreaterThan(50);
    expect(
      [...blocks.values()].filter((block) => MAILBOX_GATES.some((gate) => block.includes(gate))).length,
      "no block calls any mailbox gate, so the gate list no longer matches the code",
    ).toBeGreaterThan(5);
  });

  it("declares every route whose own handler consults a mailbox relation", () => {
    const declared = new Map(
      (ROUTES as readonly RouteSpec[]).map((spec) => [spec.path, spec.authority?.scope]),
    );

    const undeclared: string[] = [];
    for (const [path, block] of handlerBlocks()) {
      // Regex-named blocks cannot be matched to a registry path by this scan; the indirect list carries them.
      if (path.startsWith("~")) continue;
      if (!MAILBOX_GATES.some((gate) => block.includes(gate))) continue;
      const scope = declared.get(path);
      if (scope !== "mailbox") undeclared.push(`${path} — declared ${scope ?? "nothing"}`);
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
