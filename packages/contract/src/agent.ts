import { ROUTES, type RouteSpec } from "./routes.ts";

/**
 * Which of this Node's routes a machine may be offered, and which it may not (#88, #89, ADR 12).
 *
 * ## Why curation is the work, and the transport is not
 *
 * #85 generated an SDK: ninety-four methods, one per route, named mechanically. That is the right surface
 * for a program somebody wrote on purpose. It is the **wrong** surface for an agent, and handing it over
 * unchanged would be a worse interface than the SDK it wraps.
 *
 * Both remaining ADR 12 surfaces — the Agent Skill (#88) and the MCP server (#89) — need the same answer to
 * the same question: *what should a machine be able to do here?* So it is answered once, here, and both read
 * it. Answering it twice is how the two would come to disagree about which acts are safe, which is the worst
 * possible thing for them to disagree about.
 *
 * ## The rule
 *
 * | tier | offered | what it is |
 * |:--|:--|:--|
 * | `read` | yes | answers a question, changes nothing |
 * | `act` | yes | changes something, and a person can undo it |
 * | `governed` | **no** | the Node requires more than one person, or the act is irreversible |
 * | `operator` | **no** | installation, credentials, maintenance — the acts of running the Node |
 * | `surface` | **no** | the machine surface itself, which is not a capability on it |
 *
 * ## `governed` is the category that matters, and it is not about permission
 *
 * §18 and #61 count **distinct people**. An agent acting inside somebody's session is that person — not a
 * second one — so every dual-control rule already refuses it, and correctly. This tier does not add a
 * refusal; the Node has it.
 *
 * What it prevents is **offering the act at all**. A Skill that lists "approve a send" teaches an agent to
 * try, and an agent that tries will keep trying: it reads the refusal, sees `fix: ask somebody who holds
 * approval.decide`, and has no way to know that *it* can never be that somebody. The refusal is written for
 * a person who can go and ask. An offer a caller can never complete is a worse interface than no offer.
 *
 * Irreversibility is folded into the same tier for the same reason rather than a separate one: the question
 * a curator is asking is *"can this be undone by a person who did not expect it"*, and the answer is no in
 * both cases.
 *
 * ## `operator` is separate from `governed`, and the distinction is real
 *
 * Supplying a sending token, resealing evidence, rotating a signing key and claiming a Node are not acts
 * somebody could approve for an agent — they are acts of *running* the Node rather than of using it. They
 * are excluded because they are out of scope for the surface, not because they are dangerous, and conflating
 * the two would suggest a second approver could unlock them.
 *
 * ## Every route is classified, and a new one fails
 *
 * `test/node/agent-exposure-world.test.ts` asserts a closed world: a route added without a tier fails,
 * rather than defaulting. A default here would be permissive for exactly the route nobody thought about,
 * which is the shape `content-deletion-world.test.ts` and `budget-plan-scope.test.ts` exist to prevent.
 *
 * **Reads are derived, with named exceptions.** Every `GET` is `read` unless the table below says otherwise —
 * a route that answers a question changes nothing, and writing ninety judgements where one rule suffices is
 * how a registry acquires an entry that disagrees with its own path.
 *
 * There is exactly one exception and it earns its line: `GET /index.html` is the **interface shell**, which
 * is a page rather than a question anybody would ask a Node. Offering it as a capability would put "fetch
 * the HTML" in a list of things an agent can do, which is noise at best and an invitation to scrape at
 * worst. `test/node/agent-exposure-world.test.ts` asserts the exception set stays this small.
 *
 * ## `surface` is the fifth tier, and it exists because of one route
 *
 * `POST /mcp` is the MCP server (#89). Offering it *as an MCP tool* would be recursion — a tool whose
 * effect is to open another tool list — and it is not `operator` either, because it is not an act of running
 * the Node. It is the surface, and a surface is not a capability on itself.
 *
 * Found by this file's own closed world the moment #89 added the route, which is what the throw is for.
 */

export type Exposure = "read" | "act" | "governed" | "operator" | "surface";

export interface Classification {
  readonly tier: Exposure;
  /** Why. Read by a person auditing the list, and by the Skill, which quotes it. */
  readonly why: string;
}

/** How an agent should be told to think about a capability, in words rather than a path. */
export interface AgentCapability {
  readonly name: string;
  readonly summary: string;
  readonly method: RouteSpec["method"];
  readonly path: string;
  readonly tier: Exposure;
}

const changing = (tier: Exposure, why: string, ...routes: string[]): Record<string, Classification> =>
  Object.fromEntries(routes.map((route) => [route, { tier, why }]));

/**
 * Every route classified by hand: everything that changes something, plus the one `GET` exception.
 *
 * Keyed `METHOD /path`, the same spelling `NOT_JSON` and `schemaCoverage` use.
 */
export const DECLARED_ROUTES: Record<string, Classification> = {
  // ---- the one GET that is not a read, and the one route that is the surface itself -----------------
  ...changing("operator",
    "The interface shell. A page rather than a question anybody would ask a Node — offering it as a "
    + "capability would put \"fetch the HTML\" in a list of things an agent can do, which is noise at best "
    + "and an invitation to scrape at worst.",
    "GET /index.html",
  ),
  ...changing("surface",
    "The MCP server itself (#89). Offering it as an MCP tool would be recursion — a tool whose effect is to "
    + "open another tool list — and it is not an act of running the Node either. A surface is not a "
    + "capability on itself.",
    "POST /mcp",
  ),

  // ---- act: a person can undo it, and nothing leaves the Node ---------------------------------------
  ...changing("act",
    "Writes or edits something a person can change back. A draft is not a send, a Butler draft is not a "
    + "published one, and a matter is a folder rather than an act on anybody's mail.",
    "PUT /api/drafts",
    "POST /api/butlers",
    "PUT /api/butlers/:butlerId/draft",
    "POST /api/matters",
    "POST /api/policies",
    "PUT /api/policies/:policyId/draft",
  ),
  ...changing("act",
    "A dry run: it walks a program, causes nothing, and cannot write. Offering this to an agent is the "
    + "point of having built it — checking what a Butler would do is exactly the question a machine should "
    + "be able to ask before a person publishes one (#87).",
    "POST /api/butlers/:butlerId/simulate",
  ),

  ...changing("act",
    "Cancelling stops a send that has not left, and the direction is what makes it safe: an over-eager "
    + "machine cancelling produces a message that was not sent, which a person can write again — the "
    + "opposite of the failure sealing risks. It is bounded by send.propose on the mailbox like every other "
    + "act on that send.\n\nFound by the closed world below rather than by review: this was the one changing "
    + "route the first draft of this file forgot, and the throw named it before anything ran.",
    "POST /api/sends/:sendId/cancel",
  ),
  ...changing("act",
    "Verifying the audit chain reads the world and changes nothing a person would need to undo.",
    "POST /api/audit/verify",
  ),

  // ---- governed: more than one person, or nobody can undo it ---------------------------------------
  /*
   * Four routes moved here from `act` on 28 August 2026, after an audit read the tier's own rule back to it:
   * **`act` means a person can undo it.** Each of these was classified by its shape — a DELETE on a draft, a
   * POST that files something — rather than by what it does, and each fails the rule.
   */
  ...changing("governed",
    "Discarding a draft destroys text somebody wrote. \"They can type it again\" is not undo, and the body is "
    + "collected from R2 by the reconciler afterwards — there is nothing to restore from. An agent tidying "
    + "drafts is an agent deleting a person's unfinished work.",
    "DELETE /api/drafts/:draftId",
  ),
  ...changing("governed",
    "Closing a matter is one-way. `matters.ts` has openMatter and closeMatter and no reopen, and the closure "
    + "stamps the time from which employee-notification obligations become due (§7). A resumed investigation "
    + "needs a new matter, so this is a governance event rather than filing.",
    "POST /api/matters/:matterId/close",
  ),
  ...changing("governed",
    "This route carries claim, steal, release **and close**, and close is irreversible: `cases.ts` has no "
    + "reopen and the state guards read `state != 'closed'`. Its previous entry here said 'a close can be "
    + "re-opened', which is this repository's recurring defect — prose asserting a property the code below "
    + "it does not have — in the file that decides what a machine may do.\n\nWithheld whole rather than in "
    + "part, because the tier is per route and this route bundles the reversible with the irreversible. That "
    + "costs an agent `claim`, which is genuinely useful and genuinely safe; restoring it means splitting "
    + "the route or making curation parameter-aware, and neither is a thing to do while closing a hole.",
    "POST /api/cases/:caseId/:action",
  ),
  ...changing("governed",
    "Dispatch hands every due send to the transport **now**. It starts no new send, which is what its "
    + "previous entry said, and that is not the question the tier asks: mail leaves, and mail leaving is the "
    + "one act in this product nobody can undo.\n\nIt also contradicted a promise made three files away. "
    + "The MCP handshake tells every client that these tools 'read and draft; they do not send' — and this "
    + "one sent. A guarantee stated in a handshake and broken by a capability list is worse than no "
    + "guarantee, because a client has been told it can stop checking.",
    "POST /api/sends/dispatch",
  ),

  ...changing("governed",
    "Mail leaving is the one act in this product nobody can undo. Sealing commits a message to policy and "
    + "the dispatcher takes it from there; a cancellation is a race, not a reversal.",
    "POST /api/sends",
    "POST /api/sends/:sendId/retry",
  ),
  ...changing("governed",
    "Releasing a held or gated send is a person deciding that mail may go. §18 and #61 count distinct "
    + "people, and an agent inside somebody's session is that person rather than a second one — so the Node "
    + "already refuses. What this prevents is *offering* it, which would teach an agent to try an act it can "
    + "never complete.",
    "POST /api/sends/:sendId/release",
    "POST /api/sends/:sendId/release-hold",
    "POST /api/approvals/:approvalId/decide",
    "POST /api/approvals/:approvalId/withdraw",
  ),
  ...changing("governed",
    "Publishing is the versioning event: it makes a program live, and a Butler proposes sends from other "
    + "people's mailboxes without a person present. Drafting is an `act` and publishing is not, which is "
    + "exactly the line #49's draft-then-publish lifecycle draws.",
    "POST /api/butlers/:butlerId/publish",
    "POST /api/policies/:policyId/publish",
  ),
  ...changing("governed",
    "Preservation and its release. A hold is what stops evidence being destroyed, an export is the most "
    + "consequential read this Node performs (§7), and supervised access reads somebody else's mail. Each "
    + "needs two people who are not the asker.",
    "POST /api/holds",
    "POST /api/holds/:holdId/lift",
    "POST /api/exports",
    "POST /api/exports/:exportId/run",
    "POST /api/supervised",
  ),
  ...changing("governed",
    "Stopping or resuming mail to a whole domain, and restarting a Butler a machine stopped. A breaker "
    + "exists because something went wrong at volume; a machine that could clear one could clear the "
    + "evidence of its own loop.",
    "POST /api/domain-pauses",
    "POST /api/domain-pauses/:pauseId/lift",
    "POST /api/butler-pauses/:pauseId/resume",
    "POST /api/butler-runs/:runId/replay",
  ),
  ...changing("governed",
    "Who may do what. Granting, revoking, inviting and team membership all change what somebody can reach "
    + "afterwards, and a machine widening its own principal's authority is the shape this tier exists for.",
    "POST /api/access",
    "DELETE /api/access",
    "POST /api/invitations",
    "POST /api/teams",
    "POST /api/teams/:teamId/rename",
    "POST /api/teams/:teamId/members",
    "DELETE /api/teams/:teamId/members",
  ),
  ...changing("governed",
    "Merging two conversations repoints every message in one at the other. There is no unmerge.",
    "POST /api/conversations/merge",
  ),

  // ---- operator: running the Node rather than using it ----------------------------------------------
  ...changing("operator",
    "Installation and the account lifecycle. Not acts a second person could approve for a machine — acts of "
    + "standing a Node up, which is why they are separate from `governed` rather than a stricter shade of it.",
    "POST /api/claim",
    "POST /api/prepare",
    "POST /api/invitations/redeem",
    /*
     * Spending an ADR 29 recovery code to restore the vault (#92). `operator` rather than `governed`, and
     * the distinction is the one this tier exists for: a second person cannot make this safe for a machine.
     * The code **is** the credential — the route is unauthenticated on purpose, because the state it exists
     * for is one where session keys are unopenable — so an agent that could call it would be an agent
     * holding this Node's last resort. There are ten of them and they are single-use, so an agent retrying
     * a mistyped code would burn the escrow it was trying to use.
     */
    "POST /api/recovery/redeem",
    /*
     * Minting a replacement set and confirming one was received (audit, 0042/0043). `operator` for the same
     * reason redeem is, arriving from the other direction: minting **destroys** the current set atomically
     * and returns the replacement plaintext once, in a response nothing can reproduce.
     *
     * An agent calling rotate would invalidate the ten codes an operator has on paper and receive their
     * successors into a transcript — a denial of recovery and a disclosure of the last resort, in one call.
     * That there is a human behind the session does not help: they did not read the codes, and by the time
     * they notice, the old sheet is already dead.
     *
     * Confirm is here rather than in `read` because it is not a read: it writes `confirmed_at` across the
     * set, and what it asserts is *that a person holds the paper*. A machine confirming on somebody's behalf
     * is the one assertion in this product a machine cannot honestly make — it would turn `doctor`'s
     * unconfirmed finding green while nobody had the codes, which is precisely the silent state 0043 exists
     * to prevent.
     */
    "POST /api/recovery-codes/rotate",
    "POST /api/recovery-codes/confirm",
    /*
     * Repairing the body index (0044). `operator` because it is maintenance of the Node rather than work on
     * anybody's mail: it re-queues indexing, changes nothing a reader can see, and its listing names message
     * ids across the whole organization — including mail the caller may hold no relation to.
     *
     * A machine could safely *call* it. The reason it is withheld anyway is that deciding **which** failures
     * are worth retrying is the whole job: some are deterministically unparseable and repairing those spends
     * the backfill's budget on work that cannot succeed. An agent handed the list would retry all of them,
     * which is the behaviour the route's 422 exists to refuse from a human.
     */
    "GET /api/search/failed",
    "POST /api/search/repair",
    /*
     * Minting, listing and revoking agents (#109 L2). `operator`, and this is the one classification in this
     * file that would be dangerous to get wrong in the other direction.
     *
     * An agent that could mint agents is an agent that can escape its own ceiling: the pinned action list is
     * the whole mechanism, and a machine able to create a second machine with a wider one has stepped around
     * it in a single call. The expiry goes the same way — a credential that can mint its successor does not
     * expire, it renews itself in the dark, which is precisely what refusing a refresh was for.
     *
     * Listing is withheld with them rather than treated as an ordinary read: it enumerates every machine
     * identity on the Node with its sponsor and its reach, which is a map of how to escalate.
     */
    "POST /api/agents",
    "GET /api/agents",
    "GET /api/agent-capabilities",
    "DELETE /api/agents/:agentId",
    /*
     * The audit trail and the operational log, withheld for the same reason and found the same way.
     *
     * Both were `read` by the GET-derivation rule and both were gated on nothing but a session — so an
     * ordinary member could read every actor and subject in the organization, the access-grant history, agent
     * sponsorship, matter and supervised-access events, and the error detail and request ids of everybody
     * else's work. Adding `org.admin` to the routes fixed the human hole and exposed the machine one: an
     * agent holding `audit.read` would then need itself *and* its sponsor to be administrators, which the
     * mint surface cannot confer — a capability offering authority the product cannot provision.
     *
     * So it is withheld rather than made unprovisionable. Reading the whole organization's trail is the same
     * map of how to escalate that `GET /api/agents` is, arrived at from the other side, and an agent that can
     * read every act taken on a Node can find the one act nobody watched.
     */
    "GET /api/audit",
    "POST /api/audit/verify",
    "GET /api/logs",
  ),
  ...changing("operator",
    "Credentials and sessions. A machine that could rotate a signing key, sign itself out everywhere or "
    + "register a passkey would be administering the way in rather than using it.",
    "POST /api/auth/login",
    "POST /api/auth/refresh",
    "POST /api/auth/logout",
    "POST /api/auth/logout-everywhere",
    "POST /api/auth/rotate-signing-key",
    "POST /api/auth/passkeys",
    "POST /api/auth/passkeys/challenge",
    "POST /api/auth/passkeys/verify",
    "DELETE /api/auth/passkeys",
    "PUT /api/transport",
  ),
  ...changing("operator",
    "Maintenance sweeps and mailbox settings. Resealing rewrites every stored object under a new key and "
    + "reconciling deletes what it judges stranded; neither is a thing to ask a machine to decide.",
    "POST /api/maintenance/reseal",
    "POST /api/maintenance/reconcile",
    "PATCH /api/mailboxes/:mailboxId",
  ),
};

/** The tier for one route. `GET` is `read` by construction; everything else is declared above. */
export function exposureOf(spec: RouteSpec): Classification {
  const declared = DECLARED_ROUTES[`${spec.method} ${spec.path}`];
  if (declared !== undefined) return declared;
  if (spec.method === "GET") {
    return {
      tier: "read",
      why: "Answers a question and changes nothing. Derived rather than declared, so ninety judgements "
        + "cannot disagree with ninety paths.",
    };
  }
  {
    /*
     * Thrown rather than defaulted, and the direction is the point: a default would be permissive for
     * exactly the route nobody thought about. The closed-world test catches this before anybody runs it.
     */
    throw new Error(
      `${spec.method} ${spec.path} changes something and has no agent exposure tier. Classify it in `
      + "packages/contract/src/agent.ts — read the rule at the top first, because the interesting question "
      + "is whether a machine could ever complete it rather than whether it is allowed to try.",
    );
  }
}

/**
 * The capabilities a machine surface may offer: everything `read` or `act`, and nothing else.
 *
 * Sorted by path so the list is stable — a Skill regenerated in a different order would produce a diff that
 * says nothing, and a diff that says nothing is one nobody reads.
 */
/**
 * Every route a machine credential may be granted, as `"METHOD /path"`.
 *
 * ## Why this exists as its own export
 *
 * The curation table below decides what a machine may do, and until #109 L2 it bound **one** consumer: the
 * MCP tool list. An agent's pinned ceiling accepted arbitrary strings, so an administrator could grant
 * `POST /api/agents` — an agent that mints agents escapes its own ceiling in a single call — or
 * `POST /api/sends/seal`, which is `governed` because sealing is the one act nobody can undo.
 *
 * The classification was right and reached nothing. So the ceiling is now generated from it rather than
 * validated against a copy of it, which is the difference between one source of truth and two that agree
 * until somebody edits one.
 *
 * `read` and `act` only. Anything `governed`, `operator` or `surface` is withheld from a machine **regardless
 * of who asks** — an administrator's authority is to delegate what they hold, not to widen what a machine
 * class may ever do.
 */
export function agentGrantableActions(): readonly string[] {
  const all: readonly RouteSpec[] = ROUTES;
  return all
    .map((spec) => ({ spec, classification: exposureOf(spec) }))
    .filter(({ classification }) => classification.tier === "read" || classification.tier === "act")
    .map(({ spec }) => `${spec.method} ${spec.path}`)
    .sort();
}

export function agentCapabilities(nameFor: (spec: RouteSpec) => string): AgentCapability[] {
  const all: readonly RouteSpec[] = ROUTES;
  return all
    .map((spec) => ({ spec, classification: exposureOf(spec) }))
    .filter(({ classification }) => classification.tier === "read" || classification.tier === "act")
    .map(({ spec, classification }) => ({
      name: nameFor(spec),
      summary: spec.summary,
      method: spec.method,
      path: spec.path,
      tier: classification.tier,
    }))
    .sort((left, right) => (left.path === right.path
      ? left.method.localeCompare(right.method)
      : left.path.localeCompare(right.path)));
}

/**
 * What is deliberately withheld, and why. The Skill states this rather than leaving an absence.
 *
 * Takes the same `nameFor` the offered list does, so both halves of the document speak one vocabulary. The
 * first draft named the offered capabilities by SDK method and the withheld ones by route path, which would
 * have had an agent reading two spellings of the same thing and inferring they were different surfaces.
 */
export function withheldCapabilities(
  nameFor: (spec: RouteSpec) => string = (spec) => `${spec.method} ${spec.path}`,
): Array<{ name: string; route: string; tier: Exposure; why: string }> {
  const all: readonly RouteSpec[] = ROUTES;
  return all
    .map((spec) => ({ spec, classification: exposureOf(spec) }))
    .filter(({ classification }) => classification.tier !== "read" && classification.tier !== "act")
    .map(({ spec, classification }) => ({
      name: nameFor(spec),
      route: `${spec.method} ${spec.path}`,
      tier: classification.tier,
      why: classification.why,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
