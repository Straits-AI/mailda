import { agentGrantableActions } from "@mailda/contract/agent";
import type { MailboxRelation } from "./access.ts";
import { capabilityIds, routesFor } from "@mailda/contract/capability";
import { ID_PREFIXES, idPattern, type Ctx } from "@mailda/runtime";

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
/**
 * How many mailbox relations one mint may confer.
 *
 * Stated rather than derived — there is nothing to derive it from, since a Node's mailbox count is unbounded
 * and this bounds one request's shape. Fifty pairs is more than any agent has a use for and small enough that
 * refusing costs nothing.
 */
const MAX_GRANTS = 50;

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
  input: {
    name: string;
    sponsorUserId: string;
    /**
     * **Capability ids**, not route strings. Expanded here and the expansion is what gets stored.
     *
     * `capability.ts` carries the argument for both halves. The short version: an administrator deciding what
     * a machine may do is answering *"may it read mail?"*, not composing a routing table — and expanding at
     * mint rather than resolving at check time is §16's pinning rule, since a stored `mail.read` resolved
     * later would silently widen every existing agent the day somebody added a route to that capability.
     */
    capabilities: readonly string[];
    /**
     * The mailboxes this agent may act in, and how — written as `relationship_tuples` in the mint batch.
     *
     * ## Why minting grants them rather than leaving it to a second act
     *
     * An agent's authority is its **capabilities intersected with its relations**, and minting used to write
     * only the first. So a credential made through the product authenticated, called the relation-free
     * diagnostics, and could not read a mailbox, draft from one or see its own sends — a token that works and
     * does nothing, with no error to explain it. The administrator's journey ended one step before the agent
     * was usable, and the missing step was a `POST /api/access` against an `agt_` identifier through a screen
     * built for people.
     *
     * Granted here so the credential is never handed over without the authority it was meant to have, and so
     * the sponsor check below happens **at mint** rather than as a silent nothing on the first request.
     *
     * Empty is allowed and is not a mistake: `health.read` and `identity.read` need no mailbox at all.
     */
    grants?: readonly { mailboxId: string; relation: MailboxRelation }[];
    lifetimeDays?: number;
  },
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
  /*
   * Bounded **before** anything is done per entry.
   *
   * Every entry is deduplicated and expanded below, so the *stored* ceiling was always sane whatever arrived
   * — but the deduplication builds a `Set` from the raw array, so the work is the caller's array length
   * rather than the ceiling's. A million repetitions of one legitimate name deduplicates to a ceiling of one
   * and does a million entries of work getting there.
   *
   * The bound is `capabilityIds().length`, derived rather than chosen: a hardcoded number would start
   * refusing legitimate ceilings the moment the vocabulary grew past it, and that refusal would read as a
   * permissions bug rather than as a limit. Asking for more distinct capabilities than exist is not a ceiling
   * anybody can mean.
   */
  const ceilingSize = capabilityIds().length;
  if (input.capabilities.length > ceilingSize) {
    throw unprocessable("E_AGENT_ACTIONS_UNBOUNDED", {
      what: `${input.capabilities.length} capabilities were requested and only ${ceilingSize} exist`,
      why: "the capability vocabulary is finite, so a longer list is either repetition or a mistake. It is "
        + "refused before the list is read rather than deduplicated quietly, because a request nobody could "
        + "have meant is worth an answer",
      fix: "send each capability once, from GET /api/agent-capabilities",
    });
  }
  if (input.capabilities.length === 0) {
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
      fix: "name the capabilities this agent needs, from GET /api/agent-capabilities",
    });
  }

  /*
   * The ceiling is **expanded from the vocabulary**, so nothing arbitrary can be stored (audit P0-2, and the
   * capability layer after it).
   *
   * This route once took route strings and stored them, so an administrator could hand an agent
   * `POST /api/agents` and it would mint agents, escaping its own pinned ceiling in one call. That was fixed
   * by validating against `agentGrantableActions()`; taking capabilities instead makes the same guarantee
   * structurally, because a capability can only name a grantable route —
   * `test/node/capability-world.test.ts` fails otherwise.
   *
   * An unknown id is **refused rather than dropped**. Dropping one would mint an agent narrower than was
   * asked for, and an under-privileged credential fails later, in the middle of something, looking like a bug
   * rather than like a ceiling.
   */
  const wanted = [...new Set(input.capabilities)];
  const expansion = routesFor(wanted);
  if (expansion.unknown.length > 0) {
    throw unprocessable("E_AGENT_CAPABILITY_UNKNOWN", {
      what: `this Node has no capability named: ${expansion.unknown.join(", ")}`,
      why: "an agent's ceiling is chosen from a fixed vocabulary rather than written as routes, so a name "
        + "outside it cannot be expanded into anything. Accepting it would mint a credential narrower than "
        + "you asked for and you would find out later",
      fix: "choose from GET /api/agent-capabilities",
    });
  }

  /*
   * Validated rather than clamped into shape. `Math.min` accepts anything: `NaN` propagates through it,
   * reaches `new Date(NaN).toISOString()` and throws a bare `RangeError` — a 500 with no `what`, `why` or
   * `fix` for a request the caller could simply have been told about. Zero and negatives are worse than an
   * error, because they mint successfully: the operator is handed a credential that expired before they read
   * it and finds out when it fails, with nothing to say why.
   *
   * The **cap** stays a clamp, deliberately. Asking for a longer life than the maximum is a reasonable thing
   * to want and shortening it silently is the documented behaviour; asking for a life of `NaN` is not
   * anything.
   */
  /*
   * The sponsor must be a **person in this organization**, checked rather than trusted.
   *
   * The field took any non-empty string, and the consequences were not cosmetic:
   *
   * - **Nested delegation by accident.** Naming another agent as sponsor made the intersection in
   *   `delegation.ts` check *that agent's* tuples, with no recursion to the human at the root and no regard
   *   for whether its credential had expired or been revoked. An agent could outlive the person the whole
   *   chain hangs from. Deliberate nested delegation is a design — recursive intersection, cycle detection, a
   *   depth bound, root attribution — and it must not arrive by accepting a string.
   * - **A trail that names a machine where it promises a person.** `delegator_user_id`'s contract says it
   *   names the human accountable, and an `agt_` there makes that sentence false in the one record whose
   *   value is that it is not.
   * - **Cross-organization sponsorship.** The sponsor's tuples are read with this Node's `org_id`, so a
   *   sponsor from another organization holds nothing here — the agent would simply never work, which is a
   *   confusing way to find out you typed the wrong id.
   *
   * `usr_` is checked through `idPattern`, not by hand: `test/node/id-prefix-world.test.ts` requires it and
   * has caught the hand-written alphabet three times.
   */
  if (!idPattern(ID_PREFIXES.user).test(input.sponsorUserId)) {
    throw unprocessable("E_AGENT_SPONSOR_NOT_A_PERSON", {
      what: `${input.sponsorUserId} is not a person's identifier`,
      why: "an agent borrows a named human's authority, and the audit trail records that human as the one "
        + "accountable. A Butler or another agent as sponsor would mean an agent outliving the person the "
        + "delegation hangs from, with nothing checking the root",
      fix: "name a person in this organization as the sponsor",
    });
  }
  const sponsor = await env.CATALOG.prepare(
    "SELECT 1 FROM users WHERE id = ? AND org_id = ? LIMIT 1",
  ).bind(input.sponsorUserId, orgId).first();
  if (sponsor === null) {
    /*
     * One refusal for "no such person" and "somebody else's organization". §5C: an administrator of this
     * organization has no business learning which identifiers exist in another, and the remedy is the same.
     */
    throw unprocessable("E_AGENT_SPONSOR_UNKNOWN", {
      what: "that sponsor is not a person in this organization",
      why: "an agent's authority is bounded by its sponsor's, which is read against this organization — a "
        + "sponsor from anywhere else holds nothing here, so the credential would be minted and never work",
      fix: "name somebody from GET /api/people",
    });
  }

  const lifetime = input.lifetimeDays ?? DEFAULT_LIFETIME_DAYS;
  if (!Number.isFinite(lifetime) || lifetime <= 0) {
    throw unprocessable("E_AGENT_LIFETIME_INVALID", {
      what: `a lifetime of ${String(input.lifetimeDays)} days is not a length of time`,
      why: "an agent's expiry is the thing that makes the credential temporary, so it has to be a positive "
        + `number of days. Longer than ${MAX_LIFETIME_DAYS} is shortened to it rather than refused, because `
        + "asking for more is a reasonable thing to want",
      fix: `pass a positive number of days, up to ${MAX_LIFETIME_DAYS}`,
    });
  }
  /*
   * Every requested relation is checked against the **sponsor**, now, rather than discovered as a silent
   * refusal later.
   *
   * `effective(agent) = ceiling ∩ agent's tuples ∩ sponsor's tuples`, so granting an agent
   * `mailbox.content.read` on a mailbox its sponsor cannot read produces a tuple that never matches. The
   * agent authenticates, asks, and is refused — correctly, and with nothing anywhere saying the grant was
   * void from the moment it was written. An administrator finding that out through an automation that quietly
   * does nothing is the worst available way to learn it.
   *
   * The check is a **snapshot**, and that is stated rather than implied: it says the sponsor holds this now.
   * The intersection at request time is what keeps it true afterwards, which is the whole point of that term
   * — a sponsor losing access still narrows the agent on the next request, without anything re-running here.
   */
  /*
   * Normalised **before** anything is done per entry: deduplicated by `mailboxId::relation`, and bounded.
   *
   * Each grant costs a sponsor-authority query and a batch statement, so the work was the caller's array
   * length rather than the ceiling's — a thousand repetitions of one pair does a thousand queries to arrive at
   * one tuple. `INSERT OR IGNORE` collapsed the duplicates at the very end, which is the wrong end.
   *
   * The bound is stated rather than derived, because there is nothing to derive it from: a mailbox count is
   * unbounded and this is a limit on one request's shape. Fifty pairs is more mailboxes than any agent has a
   * use for and small enough that the refused case costs nothing.
   */
  const seen = new Set<string>();
  const grants = (input.grants ?? []).filter((one) => {
    const key = `${one.mailboxId}::${one.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if ((input.grants ?? []).length > MAX_GRANTS) {
    throw unprocessable("E_AGENT_GRANTS_UNBOUNDED", {
      what: `${(input.grants ?? []).length} mailbox grants were requested and the limit is ${MAX_GRANTS}`,
      why: "each grant is checked against the sponsor and written as its own tuple, so a long list is work "
        + "done before anything is refused. A list this long is repetition or a mistake",
      fix: `send each mailbox and relation once, up to ${MAX_GRANTS} pairs`,
    });
  }

  for (const wantedGrant of grants) {
    const held = await env.CATALOG.prepare(
      `SELECT 1 FROM relationship_tuples
        WHERE org_id = ? AND subject_id IN (SELECT ? UNION SELECT team_id FROM team_members
                                             WHERE org_id = ? AND user_id = ?)
          AND object_type = 'mailbox' AND relation = ? AND object_id = ? LIMIT 1`,
    ).bind(orgId, input.sponsorUserId, orgId, input.sponsorUserId, wantedGrant.relation, wantedGrant.mailboxId)
      .first();
    if (held === null) {
      throw unprocessable("E_AGENT_GRANT_EXCEEDS_SPONSOR", {
        what: `the sponsor does not hold ${wantedGrant.relation} on ${wantedGrant.mailboxId}`,
        why: "an agent's reach is its own relations intersected with its sponsor's, so this grant would be "
          + "written and never match. The agent would authenticate, ask, and be refused, with nothing saying "
          + "the grant was void from the moment it was made",
        fix: "grant the sponsor that relation first, or name a sponsor who already holds it",
      });
    }
  }

  const days = Math.min(lifetime, MAX_LIFETIME_DAYS);
  const at = new Date(ctx.now()).toISOString();
  const expiresAt = new Date(ctx.now() + days * 86_400_000).toISOString();
  const id = ctx.id(ID_PREFIXES.agent);
  const token = mintToken();
  const tokenHash = await sha256Hex(token);
  /*
   * The expansion is checked against the tiers **as well**, and this is a backstop rather than a second
   * opinion.
   *
   * `test/node/capability-world.test.ts` asserts no capability names a route outside
   * `agentGrantableActions()`, so this cannot fire on a tree whose tests pass. It is kept because the thing it
   * guards is P0-2 — an agent granted `POST /api/agents` mints agents and escapes its own pinned ceiling in
   * one call — and a check that only exists in a test file is a check that does not run in production. The
   * capability vocabulary is hand-written; a route reclassified to `governed` without the vocabulary
   * following would otherwise be conferred by a Node whose tests nobody ran.
   */
  const grantable = new Set(agentGrantableActions());
  const withheld = expansion.routes.filter((route) => !grantable.has(route));
  if (withheld.length > 0) {
    throw unprocessable("E_AGENT_ACTION_WITHHELD", {
      what: `these capabilities expand to authority no machine may hold: ${withheld.join(", ")}`,
      why: "only read and reversible act routes reach an agent. A capability naming anything else is a "
        + "mistake in this Node's own vocabulary rather than in your request — the exposure tiers are the "
        + "authority and the vocabulary has drifted from them",
      fix: "report this: a capability in packages/contract/src/capability.ts names a withheld route, which "
        + "test/node/capability-world.test.ts exists to catch",
    });
  }

  const actions = expansion.routes;

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
    /*
     * The **grants** are in the detail, not only the actions. A route names what verbs an agent may attempt;
     * a grant names which mailboxes it may reach, and the second is the question an access review asks. The
     * comment here used to claim the trail records how far the agent reaches while recording only the first
     * half of that.
     *
     * The exact pairs rather than a count or a digest: live `relationship_tuples` can be revoked, so they are
     * not a snapshot this can be reconstructed from later. The audit chain is the only immutable copy of what
     * was conferred, and `MAX_GRANTS` is what keeps the entry bounded.
     */
    detail: {
      name, sponsorUserId: input.sponsorUserId, actions, expiresAt,
      grants: grants.map((one) => `${one.mailboxId}::${one.relation}`),
    },
  }, (entry) => [
    entry,
    env.CATALOG.prepare(
      `INSERT INTO agents (id, org_id, name, sponsor_user_id, created_by, token_hash, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).bind(id, orgId, name, input.sponsorUserId, createdBy, tokenHash, at, expiresAt),
    ...actions.map((action) => env.CATALOG.prepare(
      "INSERT INTO agent_actions (agent_id, action) VALUES (?,?)",
    ).bind(id, action)),
    /*
     * The relations, in the same batch as the identity and its ceiling. All three or none: a credential that
     * exists with a ceiling and no reach is the state this whole parameter was added to stop somebody being
     * handed, and a partial write would recreate it from the other direction.
     */
    ...grants.map((one) => env.CATALOG.prepare(
      `INSERT OR IGNORE INTO relationship_tuples
         (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,'mailbox',?,?)`,
    ).bind(ctx.id("rt"), orgId, id, one.relation, one.mailboxId, at)),
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
  /*
   * The entry is **gated on there being a live agent to revoke**.
   *
   * The `UPDATE` was already conditional on `revoked_at IS NULL` and a comment explained that zero changes is
   * not an error — which is true, and was not the question. The entry was written regardless, so a second
   * press recorded a second withdrawal of something already withdrawn, and a revoke of an identifier that
   * never existed recorded a withdrawal of nothing at all. An administrator working through guessed
   * identifiers would write themselves a trail of revocations that did not happen, in the one artifact whose
   * value is that it did.
   *
   * Still not an error for the caller: they asked for the agent to be withdrawn and it is withdrawn. The
   * difference is only in what the trail claims.
   */
  await auditedBatch(env, ctx, orgId, {
    action: "agent.revoked",
    outcome: "ok",
    actorUserId,
    subject: agentId,
  }, (entry) => [
    entry,
    env.CATALOG.prepare(
      "UPDATE agents SET revoked_at = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL",
    ).bind(at, orgId, agentId),
  ], {
    sql: "SELECT 1 FROM agents WHERE org_id = ? AND id = ? AND revoked_at IS NULL",
    params: [orgId, agentId],
  });
}

/**
 * The mailboxes each agent may reach, and whether that reach is **live right now**.
 *
 * ## Why granted and effective are two columns
 *
 * `effective(agent) = ceiling ∩ agent's tuples ∩ sponsor's tuples`, and only the middle term is what minting
 * wrote. A sponsor who loses a relation silently narrows every agent that borrowed it — which is the point of
 * sponsoring and also the thing nobody can see. An access review asking *"what can this agent reach"* off the
 * granted list alone gets an answer that was true on the day it was minted.
 *
 * So both are reported. `granted` is what the agent holds; `effective` is what survives the intersection at
 * this moment. A row where they disagree is an automation that has quietly stopped doing part of its job, and
 * an operator finding that out from the agent screen rather than from a support ticket is the whole reason
 * this query exists.
 *
 * One statement for every agent in the organization rather than one per agent: the screen lists them together,
 * and a query per row is how a list of twenty becomes twenty round trips.
 */
export async function agentReach(env: Env, orgId: string): Promise<Map<string, {
  mailboxId: string; mailboxName: string | null; relation: string; effective: boolean;
}[]>> {
  const rows = await env.CATALOG.prepare(
    `SELECT a.id AS agent_id, t.object_id AS mailbox_id, m.name AS mailbox_name, t.relation,
            EXISTS (
              SELECT 1 FROM relationship_tuples s
               WHERE s.org_id = t.org_id AND s.object_type = 'mailbox'
                 AND s.relation = t.relation AND s.object_id = t.object_id
                 AND s.subject_id IN (SELECT a.sponsor_user_id
                                       UNION SELECT team_id FROM team_members
                                              WHERE org_id = t.org_id AND user_id = a.sponsor_user_id)
            ) AS effective
       FROM agents a
       JOIN relationship_tuples t ON t.org_id = a.org_id AND t.subject_id = a.id
                                 AND t.object_type = 'mailbox'
       LEFT JOIN mailboxes m ON m.org_id = t.org_id AND m.id = t.object_id
      WHERE a.org_id = ?
      ORDER BY m.name, t.relation`,
  ).bind(orgId).all<{
    agent_id: string; mailbox_id: string; mailbox_name: string | null; relation: string; effective: number;
  }>();

  const byAgent = new Map<string, {
    mailboxId: string; mailboxName: string | null; relation: string; effective: boolean;
  }[]>();
  for (const row of rows.results) {
    const held = byAgent.get(row.agent_id) ?? [];
    held.push({
      mailboxId: row.mailbox_id,
      mailboxName: row.mailbox_name,
      relation: row.relation,
      effective: Number(row.effective) === 1,
    });
    byAgent.set(row.agent_id, held);
  }
  return byAgent;
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
