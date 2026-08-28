import { agentGrantableActions } from "@mailda/contract/agent";
import { ID_PREFIXES, type Ctx } from "@mailda/runtime";

import { assertAdmin } from "./access.ts";
import { auditedBatch } from "./audit.ts";
import { unprocessable } from "./errors.ts";

/**
 * Delegated agent principals: a machine caller with an identity of its own (#109 L2).
 *
 * ## What this is, and the thing it is repeatedly mistaken for
 *
 * Authorization and attribution for a machine. **Not an AI capability** — whether the holder is a language
 * model, a script or somebody's cron job is outside this file, and the `llm.*` nodes are a different and
 * later thing. Conflating them is how "agent-native" becomes a claim about intent rather than a property.
 *
 * ## Three terms, and only one of them is new
 *
 *     effective(agent) = pinned action ceiling ∩ live tuples of the agent ∩ live tuples of the sponsor
 *
 * The second and third are `relationship_tuples` with an `agt_` subject and `butler/authority.ts`'s existing
 * intersection — reused, because a second intersection that disagreed with the first is the divergence
 * `original-bytes-world.test.ts` exists because of. There is no table of mailboxes here for the same reason:
 * an agent's resource ceiling **is** its tuples, conferred through the same door as every other relation.
 *
 * `agent_actions` is the new term. §16 requires a published Butler's ceiling to be computed at publication so
 * that "new grants do not silently expand" it; an agent gets that property for the same reason and by the
 * same mechanism.
 *
 * ## Why the credential is an opaque secret rather than a signature
 *
 * ADR 27 puts authority in a short-lived signature and revocation in the database. That is right for a human
 * session, which has a refresh to renew it. An agent has **no refresh** — a refreshable agent token is a
 * permanent one with extra steps — so its credential is long-lived, and a long-lived signature cannot be
 * withdrawn before it expires. An opaque secret checked against a stored hash makes revocation a column and
 * expiry a comparison, which is what a credential a machine holds for weeks actually needs.
 *
 * The cost is a database read on every agent request, where a signature needs none. That is the trade, and it
 * is the right way round: a credential that cannot be revoked promptly is worse than one that costs a seek.
 */

/**
 * Bytes of randomness in a token.
 *
 * Thirty-two, not sixteen. A recovery code is typed by a person, so its length is a usability constraint and
 * 128 bits is the contract; a machine token is copied by a machine and has no such ceiling. Doubling it costs
 * nothing anybody experiences and removes the question entirely.
 *
 * **Rendered as hex, not base32.** Nobody reads this aloud, so the alphabet that makes a recovery code
 * unambiguous on paper buys nothing — and hex has no packing arithmetic to get wrong, which is exactly what
 * `formatCode` got wrong by discarding 48 of its 128 bits.
 */
const TOKEN_BYTES = 32;

/** How long a minted credential lasts unless the caller asks for less. */
const DEFAULT_LIFETIME_DAYS = 90;

/** The longest life this Node will mint. */
const MAX_LIFETIME_DAYS = 365;

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly sponsorUserId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** The pinned action ceiling, as route names from the machine capability list. */
  readonly actions: readonly string[];
}

export interface MintedAgent {
  readonly agent: Agent;
  /** The token, in plaintext, **once**. Nothing stores it and nothing can produce it again. */
  readonly token: string;
}

/**
 * The principal an agent token resolves to.
 *
 * `userId` is the **agent's** id, which is what makes attribution work with no further mechanism:
 * `kindOfActor` derives `agent` from the `agt_` prefix, exactly as it derives `butler` from `btl_`.
 * `delegatorUserId` is the sponsor, and every act records both (0045).
 */
export interface AgentPrincipal {
  readonly orgId: string;
  readonly userId: string;
  readonly delegatorUserId: string;
  readonly actions: readonly string[];
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hex, lower case, no separators. A machine copies this; nothing about it is for a person to read. */
function mintToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Mints an agent, returning its token once.
 *
 * ## Administrator-gated, and the sponsor is named rather than assumed
 *
 * `assertAdmin` first, because minting confers a machine identity that acts on mail — and `access.ts` confers
 * every other relation by `admin_grant`, so a second door with different rules would be two stories about who
 * may delegate authority.
 *
 * The sponsor is a **parameter**, so the person who authorises the identity need not be the person whose
 * authority it borrows. That is the separation supervised grants already have, and it matters here for the
 * same reason: an administrator minting an agent for themselves is one person deciding both halves.
 *
 * ## The ceiling is pinned and cannot be widened
 *
 * `actions` is written once, at mint. There is no route that adds one later, deliberately: §16's *"new grants
 * do not silently expand a published Butler"* is the same property, and an agent whose ceiling could grow is
 * one whose authority nobody can state by reading the row.
 */
export async function mintAgent(
  env: Env,
  ctx: Ctx,
  orgId: string,
  createdBy: string,
  input: { name: string; sponsorUserId: string; actions: readonly string[]; lifetimeDays?: number },
): Promise<MintedAgent> {
  await assertAdmin(env, orgId, createdBy);

  const name = input.name.trim();
  if (name === "") {
    throw unprocessable("E_AGENT_NAME_EMPTY", {
      what: "an agent needs a name",
      why: "the name is what a refusal and an audit entry say instead of an identifier — a trail full of "
        + "`agt_01K…` is a trail nobody reads",
      fix: "pass a name describing what this agent is for",
    });
  }
  if (input.actions.length === 0) {
    /*
     * Refused rather than minted empty. An agent with no ceiling can do nothing, so creating one is either a
     * mistake or a placeholder somebody intends to widen later — and widening is exactly what the pinned
     * ceiling exists to prevent. Making it impossible to create is cheaper than explaining later why the
     * credential they made is inert.
     */
    throw unprocessable("E_AGENT_NO_ACTIONS", {
      what: "an agent was requested with an empty action ceiling",
      why: "the ceiling is pinned at mint and cannot be widened, so an agent created with nothing can never "
        + "do anything — and the route that would widen it does not exist on purpose",
      fix: "name the capabilities this agent needs, from the machine capability list",
    });
  }

  /*
   * The ceiling is checked against the **curation table**, not merely stored (audit P0-2).
   *
   * `packages/contract/src/agent.ts` classifies every route and only `read` and `act` reach a machine. That
   * classification bound one consumer — the MCP tool list — and this route accepted arbitrary strings, so an
   * administrator could hand an agent `POST /api/agents` and it would mint agents, escaping its own pinned
   * ceiling in one call. Sealing a send was reachable the same way, and sealing is `governed` because it is
   * the one act nobody can undo.
   *
   * Generated from the table rather than validated against a copy of it, which is the difference between one
   * source of truth and two that agree until somebody edits one.
   *
   * **Refused regardless of who asks.** An administrator's authority is to delegate what they hold, not to
   * widen what a machine class may ever do — so there is no override, and `assertAdmin` passing above does
   * not make this reachable.
   */
  const grantable = new Set(agentGrantableActions());
  const withheld = [...new Set(input.actions)].filter((action) => !grantable.has(action));
  if (withheld.length > 0) {
    throw unprocessable("E_AGENT_ACTION_WITHHELD", {
      what: `these capabilities are not grantable to a machine: ${withheld.join(", ")}`,
      why: "the machine capability list is curated by exposure tier, and only read and reversible act routes "
        + "reach an agent. A route that is governed, operator or a surface is withheld from every machine — "
        + "an agent that could mint agents or seal a send would step around its own ceiling",
      fix: "grant capabilities from the machine capability list. An unclassified route is withheld too, "
        + "because a ceiling cannot name what the contract does not describe",
    });
  }

  const days = Math.min(input.lifetimeDays ?? DEFAULT_LIFETIME_DAYS, MAX_LIFETIME_DAYS);
  const at = new Date(ctx.now()).toISOString();
  const expiresAt = new Date(ctx.now() + days * 86_400_000).toISOString();
  const id = ctx.id(ID_PREFIXES.agent);
  const token = mintToken();
  const tokenHash = await sha256Hex(token);
  const actions = [...new Set(input.actions)];

  /*
   * `auditedBatch`, so the identity and the record of its creation commit together. An agent that exists with
   * no audit entry is a machine principal nobody authorised as far as the trail is concerned, which is the
   * state this whole layer exists to make unreachable.
   */
  await auditedBatch(env, ctx, orgId, {
    action: "agent.minted",
    outcome: "ok",
    actorUserId: createdBy,
    subject: id,
    // The token is not here and must never be. The trail records that an agent was made, by whom, for whom,
    // and how far it reaches — everything except the secret.
    detail: { name, sponsorUserId: input.sponsorUserId, actions, expiresAt },
  }, (entry) => [
    entry,
    env.CATALOG.prepare(
      `INSERT INTO agents (id, org_id, name, sponsor_user_id, created_by, token_hash, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(id, orgId, name, input.sponsorUserId, createdBy, tokenHash, at, expiresAt),
    ...actions.map((action) => env.CATALOG.prepare(
      "INSERT INTO agent_actions (agent_id, action) VALUES (?,?)",
    ).bind(id, action)),
  ]);

  return {
    token,
    agent: {
      id, name, sponsorUserId: input.sponsorUserId, createdBy, createdAt: at,
      expiresAt, revokedAt: null, actions,
    },
  };
}

/**
 * Resolves an agent token to a principal, or null.
 *
 * Null for unknown, revoked and expired alike — one answer, because distinguishing them would tell a caller
 * holding a wrong token whether it was ever right. The same reasoning `confirmRecoveryCodes` uses: an oracle
 * behind authentication is still an oracle.
 *
 * Two queries rather than one join: the agent, then its actions. The second is only reached when the first
 * succeeds, so an invalid token costs one seek on a unique index.
 */
export async function agentFor(env: Env, ctx: Ctx, token: string): Promise<AgentPrincipal | null> {
  if (token === "") return null;
  const row = await env.CATALOG.prepare(
    `SELECT id, org_id, sponsor_user_id, expires_at, revoked_at FROM agents WHERE token_hash = ? LIMIT 1`,
  ).bind(await sha256Hex(token))
    .first<{ id: string; org_id: string; sponsor_user_id: string; expires_at: string; revoked_at: string | null }>();

  if (row === null || row.revoked_at !== null) return null;
  // Compared as ISO strings, which sort lexically for a fixed-width UTC instant — the same comparison
  // `LIVE_SUPERVISED_GRANT` makes, and for the same reason: a date parsed on the way in is a second place
  // for a timezone to be wrong.
  if (row.expires_at <= new Date(ctx.now()).toISOString()) return null;

  const actions = await env.CATALOG.prepare(
    "SELECT action FROM agent_actions WHERE agent_id = ?",
  ).bind(row.id).all<{ action: string }>();

  return {
    orgId: row.org_id,
    userId: row.id,
    delegatorUserId: row.sponsor_user_id,
    actions: actions.results.map((a) => a.action),
  };
}

/**
 * Withdraws an agent immediately.
 *
 * A column rather than a delete, so the trail's references to `agt_…` still resolve to a name and a sponsor.
 * An audit entry naming an identifier nothing can explain is a trail that decays.
 */
export async function revokeAgent(env: Env, ctx: Ctx, orgId: string, actorUserId: string, agentId: string):
Promise<void> {
  await assertAdmin(env, orgId, actorUserId);
  const at = new Date(ctx.now()).toISOString();
  const outcome = await auditedBatch(env, ctx, orgId, {
    action: "agent.revoked",
    outcome: "ok",
    actorUserId,
    subject: agentId,
  }, (entry) => [
    entry,
    env.CATALOG.prepare(
      "UPDATE agents SET revoked_at = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL",
    ).bind(at, orgId, agentId),
  ]);
  // The batch's second statement. Zero changes means it was already revoked or never existed, and neither is
  // an error worth raising — the caller asked for it to be withdrawn and it is.
  void outcome;
}

/** Every agent in this organization, newest first. Never the token, and never its hash. */
export async function listAgents(env: Env, orgId: string): Promise<Agent[]> {
  const rows = await env.CATALOG.prepare(
    `SELECT a.id, a.name, a.sponsor_user_id, a.created_by, a.created_at, a.expires_at, a.revoked_at,
            (SELECT group_concat(action) FROM agent_actions WHERE agent_id = a.id) AS actions
       FROM agents a WHERE a.org_id = ? ORDER BY a.created_at DESC`,
  ).bind(orgId).all<{
    id: string; name: string; sponsor_user_id: string; created_by: string; created_at: string;
    expires_at: string; revoked_at: string | null; actions: string | null;
  }>();
  return rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    sponsorUserId: row.sponsor_user_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    actions: row.actions === null ? [] : row.actions.split(","),
  }));
}
