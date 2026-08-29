/**
 * The mailbox relations a mint may confer on an agent.
 *
 * ## Why this is its own module with no imports
 *
 * Two things need it and they sit on opposite sides of the dependency graph: `schemas.ts` uses it as the
 * request enum, and `capability.ts` types each capability's `requires` against it. Putting it in
 * `capability.ts` — where it started — made a cycle, because `capability.ts` reads the exposure tiers from
 * `agent.ts`, which reads `ROUTES`, which reads `schemas.ts`. The symptom was not a compile error but a
 * module that loaded as `undefined` and a whole suite reporting *no tests*.
 *
 * One list, no dependencies, and the cycle is unrepresentable.
 *
 * ## Why these five
 *
 * Every one is `conferredBy: "admin_grant"` in `access.ts`, so an administrator can already grant it to a
 * person and nothing new is being delegated by offering it here. `supervised.read` is deliberately absent: it
 * is time-boxed, needs two approvals and cites a matter (§7), so it is not a thing a mint hands out — and
 * `POST /api/access` refuses it with a message explaining the ceremony, which is the better answer than a
 * checkbox.
 *
 * `ediscovery.export` is here because `export.read` needs it. It was missing while that capability required
 * it, so the mint form would have told an administrator to grant something the form could not offer.
 */
export const AGENT_GRANTABLE_RELATIONS = [
  "mailbox.metadata.read",
  "mailbox.content.read",
  "send.propose",
  "message.export",
  "ediscovery.export",
] as const;

export type AgentGrantableRelation = (typeof AGENT_GRANTABLE_RELATIONS)[number];
