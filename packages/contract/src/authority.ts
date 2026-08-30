import { AGENT_GRANTABLE_RELATIONS, type AgentGrantableRelation } from "./relations.ts";

/**
 * What a route requires of the caller, declared beside the route rather than inferred from its name.
 *
 * ## Why this exists
 *
 * Authorization is enforced **per route**, and the agent capability vocabulary described it **per capability**
 * — a hand-written summary of a set of routes. Every one of those summaries was a second copy of a fact that
 * lives in a handler, and each drifted in its own direction:
 *
 * | capability | said | the routes check |
 * |:--|:--|:--|
 * | `mail.read` | content read reaches the original `.eml` | that route also checks `message.export` |
 * | `send.observe` | `mailbox.content.read` | `/submitted` also checks `message.export` |
 * | nine others | no relation at all | `org.admin` or requester ownership, which no mint can confer |
 *
 * The last row is the one that matters most: nine capabilities offered authority the product **cannot
 * provision**. An administrator could select them, mint the agent, and hand over a credential that is refused
 * on every route it names.
 *
 * So the requirement moves next to the check it describes, and everything else is derived from it: what a
 * capability requires, what the mint refuses, what the interface warns about, and what the execution tests
 * drive. One place to be wrong, and a test that drives every route proves it is not.
 *
 * ## What the shapes mean
 *
 * - `public` — reachable **without signing in**. `GET /health`, `GET /.well-known/jwks.json`, and nothing
 *   else: two routes, both of which answer a stranger on purpose.
 * - `recovery` — open to a stranger *only when this Node cannot authenticate anybody*. `GET /api/doctor` is
 *   the one, and the conditionality is the point: it refuses an anonymous caller on a healthy Node and opens
 *   when the failure being diagnosed is the sign-in path itself.
 * - `organization` — needs `org.admin`. **Not machine-provisionable**: an agent would need itself *and* its
 *   sponsor to be administrators, and `AGENT_GRANTABLE_RELATIONS` deliberately excludes `org.admin`.
 * - `mailbox` — needs relations on the mailbox being reached. `allOf` is every one of them; `anyOf` is any
 *   one. `GET /api/messages` is `anyOf` metadata-or-content, `GET /api/messages/:receiptId/raw` is `allOf`
 *   content-and-export, and those are different facts that a single list could not express.
 *
 * `anyOf` deliberately contributes **nothing** to what a capability requires, and `allOf` contributes all of
 * it. A route satisfied by either of two relations cannot say which one an administrator should grant, so
 * demanding one would refuse a legitimate ceiling; a route needing both must say so, or the mint hands over a
 * credential that fails on its own promise.
 */
export type Authority =
  /**
   * Reachable without signing in.
   *
   * ## This used to be called `none`, and it meant two incompatible things
   *
   * `none` was documented as *"reaches nothing scoped"* and applied both to `GET /health`, which answers a
   * stranger, and to `GET /api/me`, whose handler calls `principalFor` and answers `401` without one. Five
   * routes were declared that way while requiring a principal — `/api/me`, `/api/auth/passkeys`,
   * `/api/breakers`, `/api/domain-pauses` and `/api/doctor`.
   *
   * Not a leak: the handler stayed stricter than the declaration, which is the safe direction. It was still
   * the exact defect this whole file exists to close — a registry saying something the handler does not — and
   * it survived the parity suite because that suite drove `organization`, `member`, `filtered` and
   * `self-or-admin`, and never drove this one. The scope nobody tested was the scope that was wrong.
   *
   * Authentication and resource authority are separate questions. They are kept in one field because they do
   * not cross here: every scoped route requires a principal, and every unauthenticated route is unscoped, so a
   * second axis would add a field to 106 routes with nothing to discriminate. `public` and `member` are the
   * two halves the old name conflated, and `test/route-authority-parity.test.ts` now drives both — a `public`
   * route must answer with no cookie, and a `member` route must refuse without one and answer with one.
   */
  | { readonly scope: "public" }
  /**
   * Open to a stranger **only when this Node cannot authenticate anybody**.
   *
   * `GET /api/doctor` alone. On a healthy claimed Node it answers `401` to an anonymous caller; when the
   * credential or signing key is gone it serves the reduced report, because the thing an operator needs to
   * read at that moment is the diagnosis of why they cannot sign in.
   *
   * Its own scope rather than `public` or `member`, because it is neither and calling it either would be the
   * `none` mistake again in a smaller font. A machine can hold it — the reduced report discloses only
   * infrastructure — so it is provisionable.
   */
  | { readonly scope: "recovery" }
  | { readonly scope: "organization"; readonly allOf: readonly ["org.admin"] }
  /**
   * Authenticated, and nothing further. Every member of the organization sees the same thing.
   *
   * Distinct from `public`, which is *unauthenticated-reachable* — `GET /health` answers a stranger. A
   * `member` route answers anybody signed in and nobody else, which is a different fact about a different
   * boundary, and the two shared one name until it was driven.
   *
   * `GET /api/teams` is the example and its handler argues the case: a team is a name and a headcount, which
   * is the organizational chart rather than the access map. Who is *in* it and what it *holds* are separate
   * routes and both are `organization`.
   */
  | { readonly scope: "member" }
  /**
   * Authenticated, and then the **result** is narrowed by what the caller holds. There is no refusal to test.
   *
   * This is the shape that was missing, and its absence is why five routes were declared `organization` while
   * their handlers required no administrator at all. Each returns a filtered list to an ordinary member —
   * `GET /api/approvals` the mailboxes they may decide for, `GET /api/matters` the matters they opened — and
   * an empty list is not a refusal. Declaring them `org.admin` was the only way the old algebra could say
   * "not everybody sees everything", and it said something false.
   *
   * **What** narrows it is part of the declaration, because for a machine that is the difference between a
   * capability and an empty promise:
   *
   * - `relation` — you see the mailboxes you hold one of these on. An agent cannot hold `approval.decide`
   *   (it is not in `AGENT_GRANTABLE_RELATIONS`), so an agent calling `GET /api/approvals` gets 200 and an
   *   empty list, for ever.
   * - `ownership` — you see what you opened. `GET /api/matters` gives an administrator every matter and
   *   everybody else their own, and returns an empty list rather than a 403 *because the shape is already a
   *   filtered list, so it discloses no more than "you opened none"*.
   * - `addressee` — you see what was addressed to you, or to a mailbox you may read. `GET /api/notifications`
   *   is both, which is why declaring it `mailbox.content.read` was an understatement rather than a lie.
   *
   * Reachable is not the same as useful, and `machineUseful` below is what tells them apart.
   */
  | {
    readonly scope: "filtered";
    readonly by: "relation" | "ownership" | "addressee";
    /** The relations that widen the result. Only meaningful when `by` is `relation`. */
    readonly relations?: readonly string[];
  }
  /**
   * Your own by default; somebody else's needs `org.admin`.
   *
   * `GET /api/access` is the one, and its handler puts it plainly: *"knowing what you hold is not
   * privileged"*. It defaults the subject to the caller and demands administration only when the subject is
   * somebody else — which it refuses with a §5C 404 rather than a 403, so the two are not even the same
   * shape of no.
   */
  | { readonly scope: "self-or-admin" }
  /**
   * Held by the **requester** of an artefact somebody else created, not by whoever is calling.
   *
   * `GET /api/exports/:exportId/objects/:objectId` re-asks on every object whether the *requester* still holds
   * `ediscovery.export` and whether the approval still stands — which is what makes §7's "revocation
   * terminates export jobs" enforceable rather than asserted. An agent holding `ediscovery.export` is
   * therefore still not entitled to anything, because it is not the requester of any export: creating one is
   * `governed` and withheld from every machine.
   *
   * So the relation alone would have said provisionable and been wrong. This is the shape that says otherwise.
   */
  | { readonly scope: "export"; readonly allOf: readonly ["ediscovery.export"]; readonly owner: "requester" }
  | {
    readonly scope: "mailbox";
    readonly allOf?: readonly AgentGrantableRelation[];
    readonly anyOf?: readonly AgentGrantableRelation[];
  };

/** The relations a caller must hold on one mailbox to satisfy this route. `anyOf` is not one of them. */
export function requiredRelations(authority: Authority | undefined): readonly AgentGrantableRelation[] {
  if (authority === undefined) return [];
  if (authority.scope === "mailbox") return authority.allOf ?? [];
  /*
   * **A filtered route requires what narrows it**, when a mint can confer it.
   *
   * This returned nothing for `filtered`, on the reasoning that such a route refuses nobody — which is true
   * and answers the wrong question. `notice.read` expands to `GET /api/notifications`, whose mailbox-wide
   * branch is gated on `mailbox.content.read`; without it the credential authenticated, called the route
   * successfully, and read an empty list for ever. The capability was mintable and empty, which is the same
   * defect as an unsatisfiable one wearing a 200.
   *
   * Ungrantable narrowers are excluded rather than demanded: `GET /api/approvals` narrows by
   * `approval.decide`, and requiring it would make a capability nobody could satisfy. `machineUseful` already
   * withholds that route from machines entirely, so the two answers agree — one keeps the route out of the
   * vocabulary, this one makes what is *in* it provisionable.
   */
  if (authority.scope === "filtered" && authority.by === "relation") {
    return (authority.relations ?? [])
      .filter((one): one is AgentGrantableRelation =>
        (AGENT_GRANTABLE_RELATIONS as readonly string[]).includes(one)
      );
  }
  return [];
}

/**
 * Can a machine ever be provisioned to satisfy this?
 *
 * `organization` cannot: `org.admin` is not in `AGENT_GRANTABLE_RELATIONS`, and it is excluded deliberately
 * rather than by omission. An agent holding organization administration is a machine that administers the
 * organization it acts inside, and the delegation model's whole claim is that it acts *within* one person's
 * authority. Nested administration is a design somebody should make on purpose.
 *
 * An undeclared authority answers `false`, which is the fail-closed direction: a route nobody has classified
 * is one nobody has decided a machine may reach.
 */
export function machineProvisionable(authority: Authority | undefined): boolean {
  if (authority === undefined) return false;
  // Public, recovery-conditional and member-reachable routes all admit a machine: an agent authenticates, and
  // the two unauthenticated ones admit anybody at all.
  if (authority.scope === "public") return true;
  if (authority.scope === "recovery") return true;
  if (authority.scope === "organization") return false;
  /*
   * An agent authenticates, so all three of these are reachable. `filtered` is reachable and may still be
   * useless — see `machineUseful`, which is the question this one is not asking.
   */
  if (authority.scope === "member") return true;
  if (authority.scope === "filtered") return true;
  if (authority.scope === "self-or-admin") return true;
  /*
   * Requester-owned artefacts are out of reach whatever relation an agent holds: it cannot be the requester,
   * because the route that creates one is withheld from machines. A capability naming this would offer a
   * download nobody could perform.
   */
  if (authority.scope === "export") return false;
  const named = [...(authority.allOf ?? []), ...(authority.anyOf ?? [])];
  return named.every((one) => (AGENT_GRANTABLE_RELATIONS as readonly string[]).includes(one));
}

/**
 * Can a machine get a **non-empty** answer, as opposed to merely a successful one?
 *
 * `machineProvisionable` asks whether the door opens. This asks whether there is anything behind it. They
 * came apart the moment `filtered` existed: `GET /api/approvals` answers any authenticated caller with 200,
 * and narrows the list to mailboxes where the caller holds `approval.decide` — a relation no mint can confer.
 * So an agent gets `{approvals: []}` for ever, and a capability built on it would be the same empty promise
 * that cost nine capabilities their place in the vocabulary.
 *
 * Every other scope answers alike, because for them reachable and useful are the same question.
 */
/**
 * Why no machine can be provisioned to use this, in a sentence, or `null` when one can.
 *
 * Exists so that `withheldCapabilities` can explain a route it withholds for a reason that is **not** its
 * exposure tier. Those two reasons look identical in a list and are not the same fact: a `governed` route is
 * one a machine may not do, and an `org.admin` route is one a machine could be trusted with and cannot be
 * given. An agent author reading "withheld" without the distinction will keep asking for the second kind.
 */
export function whyMachinesCannotUse(authority: Authority | undefined): string | null {
  if (authority === undefined) {
    return "this route has not been classified, and an unclassified route is withheld until somebody decides "
      + "it — the fail-closed direction";
  }
  if (authority.scope === "organization") {
    return "it requires org.admin, which is deliberately not an agent-grantable relation: an agent holding it "
      + "would administer the organization it acts inside, and nested administration is a design somebody "
      + "should make on purpose";
  }
  if (authority.scope === "export") {
    return "it belongs to the requester of an export, and creating one is withheld from every machine — so an "
      + "agent cannot be the requester of anything this would answer for";
  }
  if (authority.scope === "mailbox") {
    const named = [...(authority.allOf ?? []), ...(authority.anyOf ?? [])];
    const ungrantable = named.filter((one) => !(AGENT_GRANTABLE_RELATIONS as readonly string[]).includes(one));
    return ungrantable.length === 0 ? null : `it requires ${ungrantable.join(" and ")}, which no mint confers`;
  }
  if (authority.scope === "filtered" && !machineUseful(authority)) {
    return `it answers any authenticated caller and narrows the result to what ${
      (authority.relations ?? []).join(" or ")
    } reaches — a relation no mint confers, so an agent would be admitted and shown an empty result for ever`;
  }
  return null;
}

export function machineUseful(authority: Authority | undefined): boolean {
  if (!machineProvisionable(authority)) return false;
  if (authority?.scope !== "filtered") return true;
  /*
   * Ownership and addressee narrow by things an agent can acquire: it can open a matter and it can be sent a
   * notice. A relation it can never hold is the only one that empties the answer permanently.
   */
  if (authority.by !== "relation") return true;
  return (authority.relations ?? [])
    .some((one) => (AGENT_GRANTABLE_RELATIONS as readonly string[]).includes(one));
}
