import { describe, expect, it } from "vitest";

import { agentGrantableActions } from "@mailda/contract/agent";
import {
  CAPABILITIES, capabilityIds, heldCapabilities, machineUsable, offerableCapabilities, requiresOf, routesFor,
} from "@mailda/contract/capability";
import { ROUTES, type RouteSpec } from "@mailda/contract/routes";
import { AGENT_GRANTABLE_RELATIONS } from "@mailda/contract/relations";

/**
 * The capability vocabulary covers every grantable route, exactly once.
 *
 * ## What breaks without this
 *
 * `agentGrantableActions()` derives what a machine may be granted from the route registry's exposure tiers, so
 * a new `read` or `act` route becomes grantable **on the commit that adds it**. The capability vocabulary is
 * hand-written, so it does not. Two failure modes, and they are not symmetrical:
 *
 * - **A route in no capability** is grantable in principle and unreachable through the only vocabulary the
 *   mint surface accepts. Nothing reports it: the route works, `agentGrantableActions()` lists it, and no
 *   administrator can confer it. An authority nobody can grant and nothing says is missing.
 * - **A route in two capabilities** makes a ceiling ambiguous to read back and worse to revoke. A UI showing
 *   two capabilities that overlap invites somebody to remove one and believe they have removed the authority.
 *
 * The first is the likely one, because it happens by *not* doing something. Adding a route is a normal day's
 * work; remembering that a hand-written list elsewhere needs a new entry is not.
 *
 * ## Why the counts are derived here and not asserted
 *
 * There is no expected number in this file. A count would be a fourth copy of the same fact and would go stale
 * the way `docs/machine-surfaces.md`'s tier table did — all five of its numbers were wrong at once, silently,
 * for five layers. What is asserted is the *relationship* between two derived sets, which cannot go stale.
 */

const GRANTABLE = new Set(agentGrantableActions());

describe("every grantable route has exactly one capability", () => {
  it("names them all, so no authority is grantable-in-principle and unconferrable", () => {
    const named = new Set(CAPABILITIES.flatMap((one) => one.routes));
    const unnamed = [...GRANTABLE].filter((route) => !named.has(route)).sort();
    expect(
      unnamed,
      "these routes are grantable to a machine and belong to no capability, so no administrator can confer "
      + "them through the only vocabulary the mint surface accepts. Add each to a capability in "
      + "packages/contract/src/capability.ts — or, if a machine should never have it, change its exposure tier "
      + "and let agentGrantableActions() stop offering it:\n  " + unnamed.join("\n  "),
    ).toEqual([]);
  });

  it("names none of them twice", () => {
    const seen = new Map<string, string[]>();
    for (const capability of CAPABILITIES) {
      for (const route of capability.routes) {
        seen.set(route, [...(seen.get(route) ?? []), capability.id]);
      }
    }
    const shared = [...seen.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([route, owners]) => `${route} → ${owners.join(", ")}`);
    expect(
      shared,
      "a route in two capabilities makes a ceiling ambiguous to read back: somebody removing one capability "
      + "would believe they had removed the authority:\n  " + shared.join("\n  "),
    ).toEqual([]);
  });

  it("names nothing that is not grantable", () => {
    /*
     * The other direction, and it is the one that produces an offer nobody can complete — the failure
     * `docs/machine-surfaces.md` argues is worse than no offer at all. A capability naming a `governed` route
     * would appear in the list, be chosen, and mint an agent whose ceiling silently lacks it.
     */
    const strays = CAPABILITIES
      .flatMap((one) => one.routes.map((route) => ({ id: one.id, route })))
      .filter((entry) => !GRANTABLE.has(entry.route))
      .map((entry) => `${entry.route} (in ${entry.id})`);
    expect(
      strays,
      "these capabilities name routes a machine cannot be granted, so choosing one would mint a ceiling "
      + "quietly missing part of what it promised:\n  " + strays.join("\n  "),
    ).toEqual([]);
  });

  it("finds a real vocabulary, so a broken import cannot pass by comparing nothing", () => {
    // The control. Two empty sets satisfy all three assertions above.
    /*
     * The floor was 20 when the grantable set was 48. It is 20 now: `agentGrantableActions()` intersects the
     * exposure tier with `machineProvisionable`, and twenty-eight routes check `org.admin` or requester
     * ownership — authority no mint can confer. They were being offered.
     */
    expect(GRANTABLE.size, "no grantable routes — has exposureOf changed shape?").toBeGreaterThan(10);
    expect(CAPABILITIES.length, "no capabilities").toBeGreaterThan(5);
    expect(CAPABILITIES.every((one) => one.routes.length > 0)).toBe(true);
  });
});

describe("a capability is legible to the person choosing it", () => {
  it("has a unique id and says something", () => {
    expect(capabilityIds().length, "two capabilities share an id").toBe(new Set(capabilityIds()).size);
    // A `says` shorter than this is a restatement of the id, which tells a chooser nothing they did not have.
    const thin = CAPABILITIES.filter((one) => one.says.trim().length < 30).map((one) => one.id);
    expect(thin, "these capabilities have no description worth reading").toEqual([]);
  });

  it("marks the ones that reach the content of mail", () => {
    /*
     * `reachesContent` is the distinction the entire authorization layer is built around — §7's
     * `mailbox.metadata.read` against `mailbox.content.read` — so it is the one fact a chooser must not have
     * to infer from a capability's name. Asserted against the routes rather than trusted: any capability
     * naming a body, raw, draft, send or export route reaches content by construction, and a flag that
     * disagreed with its own routes would be worse than no flag.
     */
    /*
     * A route reaches content if it can **return** it or **accept** it. The first draft matched any
     * `/api/sends` path and flagged `POST /api/sends/:sendId/cancel`, which takes an identifier and stops a
     * message leaving — it neither returns a body nor carries one. The heuristic was wrong, not the flag, and
     * a heuristic that over-reports here is one somebody eventually silences.
     */
    const looksLikeContent = (route: string) =>
      (route.startsWith("GET ") && /\/body$|\/raw$|\/api\/drafts|\/api\/sends|\/objects\//.test(route))
      || route === "PUT /api/drafts";
    for (const capability of CAPABILITIES) {
      const reaches = capability.routes.some(looksLikeContent);
      if (reaches) {
        expect(
          capability.reachesContent,
          `${capability.id} names a route that reaches message content and is not marked as doing so`,
        ).toBe(true);
      }
    }
    // The control: at least one capability is marked, and at least one is not.
    expect(CAPABILITIES.some((one) => one.reachesContent)).toBe(true);
    expect(CAPABILITIES.some((one) => !one.reachesContent)).toBe(true);
  });
});

describe("expanding and reading back a ceiling", () => {
  it("expands to routes and reports an id it does not know", () => {
    const expanded = routesFor(["mail.read", "nonsense.made-up"]);
    expect(expanded.routes).toContain("GET /api/messages");
    /*
     * Unknown ids come back rather than being dropped. Dropping one would mint an agent narrower than the
     * administrator asked for, and an under-privileged credential fails later — in the middle of something,
     * looking like a bug rather than like a ceiling.
     */
    expect(expanded.unknown, "an unknown capability was silently ignored").toEqual(["nonsense.made-up"]);
  });

  it("deduplicates and sorts, so two orderings of one request are one ceiling", () => {
    const forwards = routesFor(["mail.read", "mail.draft"]).routes;
    const backwards = routesFor(["mail.draft", "mail.read", "mail.read"]).routes;
    expect(forwards).toEqual(backwards);
  });

  it("reads a ceiling back as held-of-total, not as a name that implies the whole", () => {
    /*
     * The reason the display is derived rather than stored. An agent minted before a capability grew holds
     * fewer routes than the capability now names, and the honest answer is `3 of 4` — a stored capability name
     * would read `mail.read` and imply a route the agent does not have and, because the ceiling is pinned,
     * never will.
     */
    const partial = routesFor(["mail.read"]).routes.slice(0, 3);
    const read = heldCapabilities(partial).held.find((one) => one.id === "mail.read");
    expect(read?.held).toBe(3);
    expect(read?.total).toBe(4);

    // The control: a whole capability reads as whole.
    const full = heldCapabilities(routesFor(["mail.read"]).routes).held.find((one) => one.id === "mail.read");
    expect(full?.held).toBe(full?.total);
  });

  it("omits capabilities the agent holds nothing of", () => {
    const held = heldCapabilities(routesFor(["identity.read"]).routes).held;
    expect(held.map((one) => one.id)).toEqual(["identity.read"]);
  });

  it("reports a route that belongs to no capability rather than dropping it", () => {
    /*
     * Reachable without any mistake: an agent minted before a route was renamed holds a string that now
     * matches nothing. A display that dropped it would under-report a live ceiling — the authority is still in
     * `agent_actions` and still checked, so hiding it is the one thing this must not do.
     */
    const back = heldCapabilities(["GET /api/messages", "GET /api/renamed-away"]);
    expect(back.unnamed).toEqual(["GET /api/renamed-away"]);
    expect(back.held.map((one) => one.id)).toEqual(["mail.read"]);
  });

  it("offers only capabilities with at least one grantable route", () => {
    // Everything is offerable today, which is what the closed world above guarantees. The assertion is that
    // the filter is derived from the tiers at all, so a reclassification takes effect on the same commit.
    expect(offerableCapabilities().length).toBe(CAPABILITIES.length);
  });
});

describe("a capability's requirements come from its routes, not from a summary of them", () => {
  /*
   * `requires` was a hand-written field: sixteen summaries of facts that live in handlers. They drifted in
   * three directions at once — `mail.read` promising the original `.eml` on content read alone,
   * `send.observe` omitting `message.export`, and **nine** capabilities declaring no relation while their
   * routes check `org.admin`, which no mint can confer.
   *
   * It is derived now. These assertions are about the derivation, and the execution suite in
   * `test/agent-capabilities.test.ts` is what proves the derivation is the truth.
   */
  it("names both relations where a route checks both", () => {
    /*
     * The contradiction this replaced. `GET /api/messages/:receiptId/raw` checks `message.export` through
     * `hasAnyRelation` **and** content read through `mayRead`; the capability promised the bytes on content
     * read alone, so an agent granted exactly what it asked for got a 404 on the one route the description
     * singled out.
     */
    const read = CAPABILITIES.find((one) => one.id === "mail.read")!;
    expect(read.routes).toContain("GET /api/messages/:receiptId/raw");
    expect(requiresOf(read)).toEqual(["mailbox.content.read", "message.export"]);

    // And the same route's authority is where that comes from, rather than a second list agreeing with it.
    const spec = (ROUTES as readonly RouteSpec[])
      .find((one) => one.method === "GET" && one.path === "/api/messages/:receiptId/raw")!;
    expect(spec.authority).toEqual({
      scope: "mailbox", allOf: ["mailbox.content.read", "message.export"],
    });
  });

  it("names message.export for the submitted bytes too", () => {
    // `send.observe` declared `mailbox.content.read` while `/submitted` shares the inbound raw path's
    // decision — `authorizeSendExport`, which is content read *and* export.
    expect(requiresOf(CAPABILITIES.find((one) => one.id === "send.observe")!))
      .toEqual(["mailbox.content.read", "message.export"]);
  });

  it("requires nothing where the routes are unscoped", () => {
    // The control. A derivation that returned everything for everybody would satisfy the two above.
    expect(requiresOf(CAPABILITIES.find((one) => one.id === "identity.read")!)).toEqual([]);
    expect(requiresOf(CAPABILITIES.find((one) => one.id === "health.read")!)).toEqual([]);
  });

  it("does not turn an anyOf into a requirement", () => {
    /*
     * `GET /api/messages` is satisfied by metadata read *or* content read. A route satisfied by either cannot
     * say which an administrator should grant, so demanding one would refuse a legitimate ceiling — a
     * metadata-only agent is a real and useful thing.
     */
    const spec = (ROUTES as readonly RouteSpec[])
      .find((one) => one.method === "GET" && one.path === "/api/messages")!;
    expect(spec.authority).toMatchObject({ scope: "mailbox" });
    expect(requiresOf(CAPABILITIES.find((one) => one.id === "mail.read")!))
      .not.toContain("mailbox.metadata.read");
  });

  it("offers only capabilities a machine can actually be provisioned for", () => {
    /*
     * Nine capabilities named routes checking `org.admin`, which `AGENT_GRANTABLE_RELATIONS` excludes
     * deliberately. So they offered authority the product cannot provision: select `butler.read`, mint, and
     * hand over a credential refused on every route it names.
     *
     * Asserted as an equality between two derived sets rather than against a list, so neither a new
     * capability nor a reclassified route can drift past it.
     */
    expect(offerableCapabilities().map((one) => one.id).sort())
      .toEqual(CAPABILITIES.map((one) => one.id).sort());
    for (const capability of CAPABILITIES) {
      expect(machineUsable(capability), `${capability.id} names a route no machine can be provisioned for`)
        .toBe(true);
    }
  });

  it("keeps the work queue out of the reading capability", () => {
    /*
     * `GET /api/mailboxes` is the queue rail — `mailboxQueues` lists mailboxes the caller holds
     * `send.propose` on. It sat inside `mail.read`, so a read-only agent could open messages and received an
     * **empty catalogue**, with no product-level way to discover the ids it was allowed to read. Two
     * questions, two routes.
     */
    const read = CAPABILITIES.find((one) => one.id === "mail.read")!;
    expect(read.routes, "the work-queue list is back inside the reading capability")
      .not.toContain("GET /api/mailboxes");
    expect(read.routes).toContain("GET /api/mailboxes/readable");
    expect(requiresOf(read), "reading mail requires the authority to send from it")
      .not.toContain("send.propose");
    expect(CAPABILITIES.find((one) => one.id === "queue.read")!.routes).toContain("GET /api/mailboxes");
  });
});

describe("every declared authority names relations this Node can actually confer", () => {
  it("uses only relations the mint offers, or a scope that says it cannot be provisioned", () => {
    /*
     * The check that found `ediscovery.export` missing from the mint enum while `export.read` required it: a
     * requirement naming a relation nobody can select is an instruction that cannot be followed, which is
     * worse than none.
     *
     * Derived from the mint request's own enum rather than restated — the first version of this hand-copied
     * the list and quietly included the value that was missing, so it passed while the requirement was
     * unsatisfiable.
     *
     * `organization` and `export` are allowed to name things outside that enum, because they say in their own
     * shape that no mint can satisfy them. `machineProvisionable` is what turns that into a refusal.
     */
    const grantable = new Set<string>(AGENT_GRANTABLE_RELATIONS);
    const strays: string[] = [];
    for (const spec of ROUTES as readonly RouteSpec[]) {
      const authority = spec.authority;
      if (authority === undefined || authority.scope !== "mailbox") continue;
      for (const relation of [...(authority.allOf ?? []), ...(authority.anyOf ?? [])]) {
        if (!grantable.has(relation)) strays.push(`${spec.method} ${spec.path} → ${relation}`);
      }
    }
    expect(strays, "these mailbox authorities name relations the mint surface cannot confer").toEqual([]);
  });

  it("declares an authority for every route a machine may be granted", () => {
    /*
     * `machineProvisionable(undefined)` is `false`, so an unclassified route leaves the grantable set rather
     * than entering it — the fail-closed direction. This asserts the consequence directly, because "it fails
     * closed" is a sentence and a missing declaration is a route somebody forgot to think about.
     */
    const undeclared = (ROUTES as readonly RouteSpec[])
      .filter((spec) => GRANTABLE.has(`${spec.method} ${spec.path}`) && spec.authority === undefined)
      .map((spec) => `${spec.method} ${spec.path}`);
    expect(undeclared, "these routes are grantable to a machine and declare no authority").toEqual([]);
  });
});
