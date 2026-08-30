import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXTERNALLY_SPECIFIED, NOT_JSON, ROUTES, type RouteSpec } from "@mailda/contract/routes";

/**
 * Which schema-bearing routes are actually **driven** against a real Node, and which only have a schema.
 *
 * ## The gap this exists to make visible
 *
 * `schemaCoverage()` reports 99 of 103 routes described, and `test/contract-responses.test.ts` opens by saying
 * every schema-bearing route is driven and parsed. Both are true sentences about different things:
 * `schemaCoverage()` proves a route *has* a schema. It cannot say whether any test executes one.
 *
 * Three deterministic contract violations shipped through that gap at once, on success paths, with CI green:
 *
 * | route | what it sent |
 * |:--|:--|
 * | `POST /api/agents` | the bare agent, where the strict schema embeds `agentSummary` |
 * | `POST /api/recovery-codes/rotate` | `set`, undeclared |
 * | `POST /api/recovery-codes/confirm` | `alreadyConfirmed`, undeclared |
 *
 * Each is a one-line disagreement that a single request would have caught. None was ever requested.
 *
 * ## Why this counts rather than requiring a driver for everything
 *
 * Requiring all 99 today would be the right end state and the wrong next step: ten need fixtures with several
 * seeded rows, and a rule nobody can satisfy is one somebody deletes. So the **undriven** set is named
 * instead, exactly — a list that can only shrink. Adding a schema-bearing route fails this until it has a
 * driver or an entry; writing a driver fails it until the entry is removed. Neither direction drifts quietly.
 *
 * That is the same shape `contract-responses.test.ts` already uses for schema coverage, applied to the thing
 * it was mistaken for. 89 of 99 are driven — measured, because the first version of this file guessed 31 and
 * would have passed through the loss of fifty.
 */

const ALL: readonly RouteSpec[] = ROUTES;
const suite = readFileSync(
  new URL("../contract-responses.test.ts", import.meta.url).pathname,
  "utf8",
);

/** Routes no JSON schema can describe, excluded from both sides as `schemaCoverage` excludes them. */
const UNDESCRIBABLE = new Set<string>([...NOT_JSON, ...EXTERNALLY_SPECIFIED]);

/**
 * Every route the suite actually sends a request to.
 *
 * Read from the `answers(…)` and `act(…)` call sites rather than from the `it(…)` titles, because a title is
 * a claim and a call is the request. The first draft matched titles and would have counted a test named after
 * a route it never called.
 */
function driven(): Set<string> {
  const found = new Set<string>();
  for (const match of suite.matchAll(/\b(?:answers|act)\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]+)"/g)) {
    found.add(`${match[1]} ${match[2]}`);
  }
  // `route("GET", "/api/…")` followed by a hand-built `SELF.fetch` is a driver too — the queue route is one,
  // because its path parameter is filled by `path()` rather than by the helper.
  for (const match of suite.matchAll(/\broute\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*"([^"]+)"/g)) {
    found.add(`${match[1]} ${match[2]}`);
  }
  return found;
}

/**
 * Schema-bearing routes with no driver, each with what it would take.
 *
 * Not a backlog to be tolerated — a list that can only shrink. Every entry is a route whose success shape is
 * currently unchecked, which is exactly the condition three of them shipped broken in.
 */
/**
 * Routes driven **outside** `contract-responses.test.ts`, with the file that drives them.
 *
 * ## Why this is a map and not a sentence
 *
 * The acknowledgement route was listed in `UNDRIVEN` with a comment saying another file drove it. That
 * comment was true and unchecked: deleting the HTTP test from `recovery-escrow.test.ts` would have left this
 * world green, because the exemption was prose. An exemption nothing verifies is the same shape as the schema
 * coverage this file exists to distinguish from real drivers — precise about what it can see, silent about
 * what it cannot.
 *
 * Each entry names the file, and the test below reads that file and requires a request to the route in it. So
 * removing the driver fails here, and moving it fails here until the entry moves with it.
 */
const DRIVEN_ELSEWHERE: Readonly<Record<string, string>> = {
  /*
   * Needs a completed restore that really collided with a live key — a conflict cannot be inserted as a row
   * and mean anything, because the check reads the detail the restore itself wrote. Driven there against a
   * real Worker and parsed through `conflictAcknowledgedResponse`.
   */
  "POST /api/recovery/conflicts/:restoreId/acknowledge": "../recovery-escrow.test.ts",
};

const UNDRIVEN: readonly string[] = [
  ...Object.keys(DRIVEN_ELSEWHERE),
  // Spends a real code and needs a wiped vault, which `test/recovery-escrow.test.ts` sets up properly; the
  // shape is parsed there against the same schema.
  "POST /api/recovery/redeem",
  // Need a minted agent, which `test/agents.test.ts` builds. Both shapes are asserted there.
  "GET /api/agents",
  "DELETE /api/agents/:agentId",
  // Need a message whose body index has failed, which `test/message-search.test.ts` constructs.
  "GET /api/search/failed",
  "POST /api/search/repair",
  // Needs a seeded person and mailboxes; `test/agents.test.ts` covers the shape it returns.
  "GET /api/people/:userId/mailboxes",
  // Authentication paths with their own suites and their own cookie assertions.
  "POST /api/auth/login",
  "POST /api/auth/logout-everywhere",
  "DELETE /api/auth/passkeys",
  // Need a delivered notice and a sealed export respectively; both are ordinary fixtures and neither is hard.
  // These two are the honest backlog rather than a case for an exemption.
  "GET /api/notifications",
  "GET /api/exports",
];

describe("the response suite's reach is stated rather than assumed", () => {
  it("finds drivers at all, so a renamed helper cannot empty this check", () => {
    // The control. A scanner that matched nothing would report every route undriven, which is loud — but one
    // that matched nothing *and* was compared against an empty expectation would report perfection.
    expect(driven().size, "no driver call sites found — have `answers`/`act` been renamed?")
      .toBeGreaterThan(20);
  });

  it("drives every route whose success shape has been wrong", () => {
    /*
     * The three that shipped broken. Named individually rather than left to the count, because the count is a
     * floor and these are the specific regressions: each one answered its own schema incorrectly while the
     * suite that claims to check every schema-bearing route never sent it a request.
     */
    const scarred = [
      "POST /api/agents",
      "POST /api/recovery-codes/rotate",
      "POST /api/recovery-codes/confirm",
      "GET /api/me",
    ];
    const missing = scarred.filter((key) => !driven().has(key));
    expect(missing, "a route that has already shipped a wrong success shape is undriven again").toEqual([]);
  });

  it("drives every schema-bearing route but the ones named here", () => {
    /*
     * An exact set rather than a floor. A floor teaches people to edit the number, and the first version of
     * this test carried one so far below the truth — 31, against an actual 89 — that it would have passed
     * through the loss of fifty drivers. Measured, then written down.
     *
     * Adding a schema-bearing route now fails this until it has a driver or an entry below. Writing a driver
     * fails it until the entry is removed. Neither direction can drift quietly, which is the property the
     * three broken success shapes needed and did not have.
     */
    const describable = ALL.filter((spec) => !UNDESCRIBABLE.has(`${spec.method} ${spec.path}`))
      .filter((spec) => spec.response !== undefined);
    const undriven = describable
      .map((spec) => `${spec.method} ${spec.path}`)
      .filter((key) => !driven().has(key))
      .sort();

    expect(
      undriven,
      "these schema-bearing routes are never sent a request by test/contract-responses.test.ts, so their "
      + "success shapes are unchecked. Write a driver, or add the route here with the fixture it would need:",
    ).toEqual([...UNDRIVEN].sort());
  });

  it("proves every externally-driven route really is driven, in the file that claims it", () => {
    /*
     * The half the prose could not do. `DRIVEN_ELSEWHERE` earns each route its place in `UNDRIVEN`, so the
     * claim has to be checked or the exemption is just a way of writing "ignore this".
     *
     * Matched on the concrete path a driver actually sends — `:restoreId` is filled in at the call site — so
     * the pattern is the path with its parameters replaced by a wildcard.
     */
    const missing: string[] = [];
    for (const [route, file] of Object.entries(DRIVEN_ELSEWHERE)) {
      const [method, path] = route.split(" ") as [string, string];
      const source = readFileSync(new URL(file, import.meta.url).pathname, "utf8");
      /*
       * The path and the method **in the same call**, not two greps over the file.
       *
       * The first version required the path pattern to appear somewhere and `method: "POST"` to appear
       * somewhere; `recovery-escrow.test.ts` has three unrelated `method: "POST"` lines, so changing the
       * driver's verb — a realistic regression if the route's method changed — would have passed. The
       * docstring said it "requires a request to the route", and it required two strings to co-occur.
       */
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:\w+/g, "[^\"`'/]+");
      const inOneCall = new RegExp(
        `${escaped}[^]{0,400}?method:\\s*"${method}"|method:\\s*"${method}"[^]{0,400}?${escaped}`,
      );
      const drives = inOneCall.test(source);
      if (!drives) missing.push(`${route} — ${file} does not send it`);
    }
    expect(
      missing,
      "these routes are exempt from the driver requirement because another file drives them, and that file "
      + "no longer does. Restore the driver, or move the entry to where the driver went:",
    ).toEqual([]);

    // The control: an empty map would satisfy the loop without checking anything.
    expect(Object.keys(DRIVEN_ELSEWHERE).length).toBeGreaterThan(0);
  });

  it("has no driver for a route that does not exist", () => {
    /*
     * The other direction. A driver naming a route the registry no longer has is a test that cannot fail for
     * the reason it was written — it either 404s and is fixed, or it silently exercises nothing. Both of the
     * route renames this round (`/api/cases`, `/api/me`'s shape) went through this file.
     */
    const registered = new Set(ALL.map((spec) => `${spec.method} ${spec.path}`));
    const stray = [...driven()].filter((key) => !registered.has(key)).sort();
    expect(stray, "these drivers name routes the contract does not declare").toEqual([]);
  });
});
