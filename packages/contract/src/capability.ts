import { agentGrantableActions } from "./agent.ts";
import { machineProvisionable, requiredRelations } from "./authority.ts";
import { ROUTES, type RouteSpec } from "./routes.ts";
import type { AgentGrantableRelation } from "./relations.ts";

/**
 * What an agent may be granted, said in the product's own words rather than in HTTP.
 *
 * ## Why route strings were the wrong vocabulary
 *
 * An agent's ceiling is stored and enforced as a set of `"GET /api/messages"` strings, which is right for
 * enforcement and wrong for everything else. Two costs, and the second is the one that matters:
 *
 * 1. **Nobody granting a capability thinks in routes.** An administrator deciding what a machine may do is
 *    answering *"may it read mail? may it draft a reply? may it publish a Butler?"* — and answering that in
 *    terms of `PUT /api/butlers/:butlerId/draft` means translating a policy question into a routing table.
 *    The translation is where a mistake becomes invisible: nothing about `POST /api/matters` says whether
 *    granting it is a small thing.
 * 2. **A ceiling built by hand has no completeness.** Reading mail takes four routes, and an administrator who
 *    grants three of them creates an agent that works until it needs the fourth. That failure arrives later,
 *    as a refusal in the middle of something, and looks like a bug rather than like a ceiling.
 *
 * So this is the input vocabulary and the display vocabulary. It is deliberately **not** the storage
 * vocabulary — see below.
 *
 * ## Capabilities are expanded and pinned at mint, not stored and resolved later
 *
 * The tempting design is to store `mail.read` and expand it on every request. That would be wrong, and the
 * reason is §16's rule for Butlers, which applies unchanged here: *new grants do not silently expand a
 * published Butler.* If a stored `mail.read` were resolved at check time, then adding a route to `mail.read`
 * next month would widen **every existing agent** that holds it — a ceiling that grows without anybody
 * granting anything, which is precisely what pinning exists to prevent.
 *
 * So `mintAgent` expands capabilities into routes and stores the routes. The consequences are both the right
 * way round:
 *
 * - Adding a route to a capability affects only agents minted afterwards. Existing ones keep the ceiling they
 *   were given.
 * - Renaming a route leaves an existing agent holding a string that matches nothing, so it loses that
 *   capability rather than gaining a different one. Fail-closed.
 *
 * And because the routes are what is stored, **no schema change was needed**: `agent_actions` already holds
 * them. Reading a ceiling back means grouping routes into capabilities again — which is derivation rather than
 * a second stored copy, so the display cannot disagree with what is enforced. `heldCapabilities` reports
 * `held` against `total` for exactly this reason: an agent minted before a capability grew shows `4 of 5`,
 * which is the truth, where a stored capability name would have shown `mail.read` and implied the fifth.
 *
 * ## The closed world
 *
 * Every grantable route belongs to **exactly one** capability, and `test/node/capability-world.test.ts` fails
 * otherwise. A route in none would be ungrantable through this vocabulary while `agentGrantableActions()` says
 * it is grantable — an authority nobody can confer and nothing reports missing. A route in two would make
 * revocation ambiguous in a UI built on these names.
 */

export interface Capability {
  /** Stable id. Stored nowhere — it is an input and a label — so renaming one is safe. */
  readonly id: string;
  /** What a person reads when choosing it. Written for somebody deciding, not documenting. */
  readonly says: string;
  /**
   * True when exercising this reaches the **content of mail** rather than only its metadata.
   *
   * Surfaced separately because it is the distinction the whole authorization layer is built around (§7's
   * `mailbox.metadata.read` against `mailbox.content.read`), and a list of capabilities that did not mark it
   * would let "read mail" and "read about mail" look alike at the moment somebody is choosing between them.
   */
  readonly reachesContent: boolean;
  readonly routes: readonly string[];
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "mail.read",
    says: "Read mail: list the mailboxes you may read, page their messages, open one, and fetch the "
      + "original bytes. The original `.eml` needs `message.export` as well as content read — the route "
      + "checks both.",
    reachesContent: true,
    routes: [
      "GET /api/mailboxes/readable",
      "GET /api/messages",
      "GET /api/messages/:receiptId/body",
      "GET /api/messages/:receiptId/raw",
    ],
  },
  {
    id: "mail.draft",
    says: "Write and revise drafts. Sending is not included and cannot be — sealing a send is withheld from "
      + "every machine.",
    reachesContent: true,
    routes: ["GET /api/drafts", "GET /api/drafts/:draftId", "PUT /api/drafts"],
  },
  {
    id: "send.observe",
    says: "See what has been sent, how each delivery went, and the bytes that were submitted. The submitted "
      + "message needs `message.export` as well as content read, the same as an inbound original.",
    reachesContent: true,
    routes: ["GET /api/sends", "GET /api/sends/:sendId/submitted"],
  },
  {
    id: "send.cancel",
    says: "Cancel a send that has not gone out yet. Its own capability rather than part of observing, because "
      + "it stops somebody else's message leaving.",
    reachesContent: false,
    routes: ["POST /api/sends/:sendId/cancel"],
  },
  {
    id: "queue.read",
    says: "See where there is work: the mailboxes you may send from, and each one's case queue.",
    reachesContent: false,
    routes: ["GET /api/mailboxes", "GET /api/mailboxes/:mailboxId/cases"],
  },
  {
    id: "notice.read",
    says: "Read the notices due on mailboxes you can read — what is waiting, and on which mailbox.",
    reachesContent: false,
    routes: ["GET /api/notifications"],
  },
  {
    id: "health.read",
    says: "Read this Node's own condition: the doctor's findings, the send breakers and any domain pauses. "
      + "The doctor's organization-wide half is an administrator's and is not included.",
    reachesContent: false,
    routes: ["GET /api/breakers", "GET /api/doctor", "GET /api/domain-pauses", "GET /health"],
  },
  {
    id: "identity.read",
    says: "Read who this credential is acting as and whose authority it borrows, and the signing keys a "
      + "client needs to check a session.",
    reachesContent: false,
    routes: ["GET /.well-known/jwks.json", "GET /api/auth/passkeys", "GET /api/me"],
  },
];

/*
 * ## Nine capabilities were removed, and the removal is the finding
 *
 * `matter.open`, `butler.read`, `butler.author`, `policy.author`, `directory.read`, `hold.read`,
 * `export.read`, `supervision.read` and the transport half of `health.read` all named routes that check
 * `org.admin`. `AGENT_GRANTABLE_RELATIONS` excludes that relation deliberately — an agent holding
 * organization administration is a machine administering the organization it acts inside, while the
 * delegation model's whole claim is that it acts *within* one person's authority.
 *
 * So they offered authority the product **cannot provision**. An administrator could select `butler.read`,
 * mint the agent, and hand over a credential refused on every route it named. None of it was visible from the
 * vocabulary, because the vocabulary described requirements by hand and those nine declared none.
 *
 * They are not withheld by a list here. They are gone because `agentGrantableActions()` now intersects the
 * exposure tier with `machineProvisionable`, so their routes left the machine-grantable set and
 * `capability-world` no longer requires a home for them. Deleting the entries was the consequence rather than
 * the mechanism, which is what stops them coming back.
 *
 * Building any of them properly means deciding that agents may hold organization-scoped authority — recursive
 * intersection through the sponsor, a depth bound, root attribution, and organization grants selectable in the
 * mint surface. That is a design, not a list entry.
 */


/**
 * The mailbox relations a capability's routes actually require, derived from their declared authority.
 *
 * ## Why this is computed and was written by hand
 *
 * Authorization is enforced per **route**; the vocabulary described it per **capability**. Sixteen hand-written
 * summaries of facts that live in handlers, and they drifted in three directions at once — `mail.read`
 * promising the original `.eml` on content read alone, `send.observe` omitting `message.export`, and seven
 * capabilities declaring no relation while their routes require `org.admin`.
 *
 * A summary of a set of checks goes stale. The checks do not.
 *
 * `anyOf` contributes nothing, and `allOf` contributes everything. A route satisfied by *either* of two
 * relations cannot say which an administrator should grant, so demanding one would refuse a legitimate
 * ceiling; a route needing *both* must say so, or the mint hands over a credential that fails on its own
 * promise.
 */
export function requiresOf(capability: Capability): readonly AgentGrantableRelation[] {
  const all: readonly RouteSpec[] = ROUTES;
  const byRoute = new Map(all.map((spec) => [`${spec.method} ${spec.path}`, spec.authority]));
  const needed = new Set<AgentGrantableRelation>();
  for (const route of capability.routes) {
    for (const relation of requiredRelations(byRoute.get(route))) needed.add(relation);
  }
  return [...needed].sort();
}

/**
 * Can an agent be provisioned to use every route in this capability?
 *
 * `organization` scope answers no, and that is the product decision the audit asked for: an agent holding
 * `org.admin` is a machine administering the organization it acts inside, while the delegation model's whole
 * claim is that it acts *within* one person's authority. Nested administration is a design somebody should
 * make deliberately — recursive intersection, a depth bound, root attribution — not one that arrives because
 * a capability listed a route.
 *
 * The alternative was to keep offering them. That is the state this replaces: an administrator could select
 * `butler.read`, mint the agent, and hand over a credential refused on every route it names.
 */
export function machineUsable(capability: Capability): boolean {
  const all: readonly RouteSpec[] = ROUTES;
  const byRoute = new Map(all.map((spec) => [`${spec.method} ${spec.path}`, spec.authority]));
  return capability.routes.every((route) => machineProvisionable(byRoute.get(route)));
}

/** Every capability id, sorted. */
export function capabilityIds(): readonly string[] {
  return CAPABILITIES.map((one) => one.id).sort();
}

/**
 * The routes a set of capability ids expands to, and any id this vocabulary does not know.
 *
 * Unknown ids are **returned rather than ignored**, so `mintAgent` can refuse and name them. Silently dropping
 * one would mint an agent narrower than the administrator asked for — an under-privileged credential that
 * fails later, in the middle of something, looking like a bug.
 */
export function routesFor(ids: readonly string[]): { routes: string[]; unknown: string[] } {
  const known = new Map(CAPABILITIES.map((one) => [one.id, one]));
  const routes = new Set<string>();
  const unknown: string[] = [];
  for (const id of ids) {
    const capability = known.get(id);
    if (capability === undefined) unknown.push(id);
    else for (const route of capability.routes) routes.add(route);
  }
  return { routes: [...routes].sort(), unknown: [...new Set(unknown)].sort() };
}

/**
 * What an agent's stored routes amount to, in capability terms — for showing a ceiling back to a person.
 *
 * Reports `held` against `total` instead of a bare name, and that is the whole reason this is a derivation
 * rather than a stored column. An agent minted before `mail.read` gained a fifth route holds four of five, and
 * the honest thing to show is `4 of 5`: a stored capability name would have read `mail.read` and implied the
 * fifth, which the agent does not have and will never have, because the ceiling is pinned.
 *
 * Capabilities the agent holds nothing of are omitted. Routes belonging to no capability are returned in
 * `unnamed` — normally empty, because `test/node/capability-world.test.ts` requires every grantable route to
 * be named, but an agent minted before a route was renamed can legitimately hold a string that matches
 * nothing, and a display that dropped it would under-report a live ceiling.
 */
export function heldCapabilities(
  actions: readonly string[],
): { held: { id: string; says: string; reachesContent: boolean; held: number; total: number }[];
     unnamed: string[] } {
  const holding = new Set(actions);
  const held = CAPABILITIES
    .map((one) => ({
      id: one.id,
      says: one.says,
      reachesContent: one.reachesContent,
      held: one.routes.filter((route) => holding.has(route)).length,
      total: one.routes.length,
    }))
    .filter((one) => one.held > 0);

  const named = new Set(CAPABILITIES.flatMap((one) => one.routes));
  return { held, unnamed: actions.filter((action) => !named.has(action)).sort() };
}

/**
 * Every capability, with whether this vocabulary currently covers a grantable route it names.
 *
 * For the mint surface: an administrator choosing capabilities needs the list, and a capability whose routes
 * have all been reclassified as `governed` should not be offered. Derived from `agentGrantableActions()` so a
 * reclassification takes effect on the same commit rather than leaving an offer nobody can complete.
 */
export function offerableCapabilities(): readonly Capability[] {
  /*
   * **Every** route, on both counts. A capability keeps its name when one route is reclassified as governed,
   * so `some` would go on offering it while `mintAgent` refuses the complete expansion — an offer that mints
   * nothing, which `docs/machine-surfaces.md` argues is worse than no offer at all.
   *
   * `machineUsable` is the second count and the one that removed seven capabilities: a route needing
   * `org.admin` cannot be provisioned for an agent at all, so offering the capability was offering a
   * credential refused on every route it named.
   */
  const grantable = new Set(agentGrantableActions());
  return CAPABILITIES
    .filter((one) => one.routes.every((route) => grantable.has(route)))
    .filter(machineUsable);
}
