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
    "DELETE /api/drafts/:draftId",
    "POST /api/butlers",
    "PUT /api/butlers/:butlerId/draft",
    "POST /api/matters",
    "POST /api/matters/:matterId/close",
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
    "Case work is what a shared mailbox is for, and every one of these is reversible by the next person: a "
    + "claim can be stolen, a release re-taken, a close re-opened. The collision they exist to prevent is "
    + "two people replying, which is a reason to *record* who holds a case rather than to withhold it.",
    "POST /api/cases/:caseId/:action",
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
    "Verifying the audit chain and asking what would be dispatched both read the world and change nothing "
    + "a person would need to undo. `dispatch` hands over what was already due — it starts nothing new.",
    "POST /api/audit/verify",
    "POST /api/sends/dispatch",
  ),

  // ---- governed: more than one person, or nobody can undo it ---------------------------------------
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
