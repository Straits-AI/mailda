import { agentGrantableActions } from "./agent.ts";

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
    says: "Read mail: list it, open a message, and fetch the original bytes.",
    reachesContent: true,
    routes: [
      "GET /api/mailboxes",
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
    says: "See what has been sent and how each delivery went.",
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
    says: "See the case queues: what is unclaimed, what is claimed, and what is assigned to whom.",
    reachesContent: false,
    routes: ["GET /api/cases"],
  },
  {
    id: "matter.open",
    says: "List matters and open new ones. Closing one is withheld — it settles what an investigation may "
      + "still reach.",
    reachesContent: false,
    routes: ["GET /api/matters", "POST /api/matters"],
  },
  {
    id: "butler.read",
    says: "Read Butlers, their versions and every run they have made, including a run's full trace.",
    reachesContent: true,
    routes: [
      "GET /api/butler-pauses",
      "GET /api/butler-runs",
      "GET /api/butler-runs/:runId",
      "GET /api/butler-runs/:runId/inspect",
      "GET /api/butlers",
      "GET /api/butlers/:butlerId",
    ],
  },
  {
    id: "butler.author",
    says: "Draft and simulate Butlers. **Publishing is withheld** — a published Butler acts on its own, so "
      + "putting one into force needs a person.",
    reachesContent: false,
    routes: ["POST /api/butlers", "POST /api/butlers/:butlerId/simulate", "PUT /api/butlers/:butlerId/draft"],
  },
  {
    id: "policy.author",
    says: "Read policies and draft changes to them. Putting a policy into force is withheld.",
    reachesContent: false,
    routes: ["GET /api/policies", "POST /api/policies", "PUT /api/policies/:policyId/draft"],
  },
  {
    id: "audit.read",
    says: "Read the audit trail and verify its hash chain.",
    reachesContent: false,
    routes: ["GET /api/audit", "POST /api/audit/verify"],
  },
  {
    id: "directory.read",
    says: "Read who is in this organization, which teams they are in, and what each of them may reach.",
    reachesContent: false,
    routes: [
      "GET /api/access",
      "GET /api/invitations",
      "GET /api/people",
      "GET /api/teams",
      "GET /api/teams/:teamId",
      "GET /api/teams/:teamId/members",
    ],
  },
  {
    id: "supervision.read",
    says: "Read supervised-access grants, pending approvals and notices due.",
    reachesContent: false,
    routes: ["GET /api/approvals", "GET /api/notifications", "GET /api/supervised"],
  },
  {
    id: "hold.read",
    says: "Read the legal holds in force.",
    reachesContent: false,
    routes: ["GET /api/holds"],
  },
  {
    id: "export.read",
    says: "Read e-discovery exports **and the exported message bytes inside them**. This reaches content that "
      + "somebody else assembled, so it is not part of reading mail.",
    reachesContent: true,
    routes: ["GET /api/exports", "GET /api/exports/:exportId/objects/:objectId"],
  },
  {
    id: "health.read",
    says: "Read this Node's own condition: the doctor's findings, logs, transport, breakers and pauses.",
    reachesContent: false,
    routes: [
      "GET /api/breakers",
      "GET /api/doctor",
      "GET /api/domain-pauses",
      "GET /api/logs",
      "GET /api/transport",
      "GET /health",
    ],
  },
  {
    id: "identity.read",
    says: "Read who this credential is acting as, and the signing keys a client needs to check a session.",
    reachesContent: false,
    routes: ["GET /.well-known/jwks.json", "GET /api/auth/passkeys", "GET /api/me"],
  },
];

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
  const grantable = new Set(agentGrantableActions());
  return CAPABILITIES.filter((one) => one.routes.some((route) => grantable.has(route)));
}
