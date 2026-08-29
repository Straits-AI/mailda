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
 * - `none` — reaches nothing scoped. `GET /health`, `GET /api/me`.
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
  | { readonly scope: "none" }
  | { readonly scope: "organization"; readonly allOf: readonly ["org.admin"] }
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
  return authority !== undefined && authority.scope === "mailbox" ? authority.allOf ?? [] : [];
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
  if (authority.scope === "none") return true;
  if (authority.scope === "organization") return false;
  /*
   * Requester-owned artefacts are out of reach whatever relation an agent holds: it cannot be the requester,
   * because the route that creates one is withheld from machines. A capability naming this would offer a
   * download nobody could perform.
   */
  if (authority.scope === "export") return false;
  const named = [...(authority.allOf ?? []), ...(authority.anyOf ?? [])];
  return named.every((one) => (AGENT_GRANTABLE_RELATIONS as readonly string[]).includes(one));
}
