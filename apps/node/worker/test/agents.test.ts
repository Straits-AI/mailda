import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { agentFor, listAgents, mintAgent, revokeAgent } from "../src/agents.ts";
import { principalFor } from "../src/authz-read.ts";

/**
 * The delegated agent principal (#109 L2).
 *
 * ## What this layer is, and the thing it is repeatedly mistaken for
 *
 * Authorization and attribution for a machine caller. **Not an AI capability** — whether the holder is a
 * language model, a script or somebody's cron job is outside it. The `llm.*` nodes are a different and later
 * thing, and conflating them is how "agent-native" becomes a claim about intent.
 *
 * ## What L1 had already made unnecessary
 *
 * Attribution. `kindOfActor` derives an actor's kind from its typed prefix, so an `agt_` records
 * `actorKind: "agent"` with nothing passed, and 0045's delegator carries the sponsor. So the assertions here
 * are about the **credential** — its ceiling, its expiry, its revocation — rather than about who the trail
 * says did what, which `test/butler-run.test.ts` and `delegation-world` already hold.
 */

const testEnv = env as unknown as Env;
const ORG = "org_agents";
const ADMIN = "usr_agents_admin";
const SPONSOR = "usr_agents_sponsor";
const OUTSIDER = "usr_agents_outsider";

const AGENT_READS = "GET /api/messages";
const AGENT_CANNOT = "POST /api/sends/seal";

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId, new Date(ctx.now()).toISOString()).run();
}

/** A request as an agent would make it: the token as a bearer, against a route in its ceiling. */
function asAgent(token: string, path = "/api/messages", method = "GET"): Request {
  return new Request(`https://node.example${path}`, {
    method, headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(async () => {
  for (const table of ["agent_actions", "agents", "relationship_tuples", "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table} WHERE 1=1`).run();
  }
  await tuple(ADMIN, "org.admin", "organization", ORG);
});

describe("minting is an administrator's act, and the sponsor is named rather than assumed", () => {
  it("refuses a caller who is not an administrator", async () => {
    /*
     * `access.ts` confers every relation by `admin_grant`, so a second door with different rules would be two
     * stories about who may delegate authority. An agent is a machine identity that acts on mail; creating
     * one is a governance event.
     */
    await expect(mintAgent(testEnv, createSystemCtx(), ORG, OUTSIDER, {
      name: "triage", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    })).rejects.toThrow();
  });

  it("lets an administrator name somebody else as the sponsor", async () => {
    /*
     * The separation that makes minting governed rather than convenient: the person who authorises the
     * identity need not be the person whose authority it borrows. An administrator minting an agent for
     * themselves is one person deciding both halves of a delegation.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "triage", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    expect(minted.agent.sponsorUserId).toBe(SPONSOR);
    expect(minted.agent.createdBy).toBe(ADMIN);
    expect(minted.agent.sponsorUserId).not.toBe(minted.agent.createdBy);
  });

  it("refuses an empty ceiling rather than minting a credential that can do nothing", async () => {
    /*
     * There is deliberately no route that widens a ceiling, so an agent created with nothing can never do
     * anything. Refusing at mint is cheaper than explaining later why the credential somebody made is inert.
     */
    await expect(mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "empty", sponsorUserId: SPONSOR, actions: [],
    })).rejects.toThrow(/E_AGENT_NO_ACTIONS/);
  });

  it("records the mint without putting the token anywhere near the trail", async () => {
    /*
     * The one place the secret exists is the return value. An audit detail carrying it would put a live
     * credential in a table designed to be read — and the trail is what an investigation reads.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "triage", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    const entry = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, subject, detail FROM audit_entries WHERE action = 'agent.minted' LIMIT 1",
    ).first<{ actor_user_id: string; subject: string; detail: string }>();

    expect(entry?.actor_user_id).toBe(ADMIN);
    expect(entry?.subject).toBe(minted.agent.id);
    expect(entry?.detail, "the mint's audit detail contains the token").not.toContain(minted.token);
    // And the sponsor is in it, because the question asked later is whose authority this borrows.
    expect(entry?.detail).toContain(SPONSOR);
  });
});

describe("the credential resolves to a principal that names both parties", () => {
  it("carries the agent as the actor and the sponsor as the delegator", async () => {
    /*
     * The whole point of L1 landing first. `userId` is the `agt_`, so `kindOfActor` derives `agent` with
     * nothing passed; `delegatorUserId` is the sponsor, so every act the request writes records both.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "triage", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    expect(who?.userId).toBe(minted.agent.id);
    expect(who?.delegatorUserId).toBe(SPONSOR);
    expect(who?.orgId).toBe(ORG);
  });

  it("answers null for an unknown token", async () => {
    expect(await agentFor(testEnv, createSystemCtx(), "not-a-token")).toBeNull();
  });

  it("answers null once revoked, on the next request", async () => {
    /*
     * Revocation is a column and the credential is checked on every request, which is what an opaque token
     * buys over a signature: a long-lived signature cannot be withdrawn before it expires, and an agent has
     * no refresh to shorten its life with.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "triage", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    expect(await agentFor(testEnv, createSystemCtx(), minted.token)).not.toBeNull();

    await revokeAgent(testEnv, createSystemCtx(), ORG, ADMIN, minted.agent.id);
    expect(await agentFor(testEnv, createSystemCtx(), minted.token)).toBeNull();
  });

  it("answers null once expired, without anything having to run", async () => {
    /*
     * Expiry is a comparison rather than a sweep. A credential that needed a job to expire it is one that
     * stays live while the job is broken — and the job being broken is the state nobody notices.
     */
    const ctx = createSystemCtx();
    const minted = await mintAgent(testEnv, ctx, ORG, ADMIN, {
      name: "short", sponsorUserId: SPONSOR, actions: [AGENT_READS], lifetimeDays: 1,
    });
    const later = { ...ctx, now: () => ctx.now() + 2 * 86_400_000 };
    expect(await agentFor(testEnv, later, minted.token)).toBeNull();
  });

  it("keeps the revoked agent readable, so the trail's references still resolve", async () => {
    // A column rather than a delete. An audit entry naming an identifier nothing can explain is a trail that
    // decays into identifiers.
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "triage", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await revokeAgent(testEnv, createSystemCtx(), ORG, ADMIN, minted.agent.id);
    const listed = await listAgents(testEnv, ORG);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.revokedAt).not.toBeNull();
    expect(listed[0]!.name).toBe("triage");
  });
});

describe("the pinned ceiling binds on every surface, not only on tools", () => {
  it("admits a request to a route in the ceiling", async () => {
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "triage", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    expect(who, "a route inside the ceiling was refused").not.toBeNull();
  });

  it("refuses a route outside it, and refuses rather than answering unauthenticated", async () => {
    /*
     * **The assertion this layer exists for.** The ceiling is checked in `principalFor`, so it binds against
     * the REST route as well as against the MCP tool that wraps it — a ceiling enforced only where tools are
     * dispatched is one any caller steps around by calling the route directly.
     *
     * And it throws rather than returning null: null means *not signed in*, and this caller is. Collapsing
     * the two would send a machine to re-authenticate over something no new token can fix.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "reader", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await expect(
      principalFor(testEnv, createSystemCtx(), asAgent(minted.token, "/api/sends/seal", "POST")),
    ).rejects.toThrow(/E_AGENT_ACTION_NOT_PERMITTED/);
  });

  it("refuses a route the contract does not describe", async () => {
    // An agent's ceiling names routes, so it cannot hold one that has no name. The refusal is the same,
    // because "not in your ceiling" is the true answer either way.
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "reader", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await expect(
      principalFor(testEnv, createSystemCtx(), asAgent(minted.token, "/api/nothing-here")),
    ).rejects.toThrow(/E_AGENT_ACTION_NOT_PERMITTED/);
  });

  it("cannot be widened after minting, because nothing writes to the ceiling twice", async () => {
    /*
     * §16's *"new grants do not silently expand a published Butler"* applied to an agent. Asserted against
     * the stored rows rather than against the absence of a route, because an absent route is a claim about
     * this repository today and the rows are the mechanism.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "reader", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    const rows = await testEnv.CATALOG.prepare(
      "SELECT action FROM agent_actions WHERE agent_id = ?",
    ).bind(minted.agent.id).all<{ action: string }>();
    expect(rows.results.map((r) => r.action)).toEqual([AGENT_READS]);
    expect(rows.results.map((r) => r.action)).not.toContain(AGENT_CANNOT);
  });
});
