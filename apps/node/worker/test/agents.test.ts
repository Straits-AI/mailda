import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { assertAdmin, isAdmin } from "../src/access.ts";
import { auditedBatch, verifyChain } from "../src/audit.ts";
import { mailboxQueues } from "../src/cases.ts";
import { notificationsFor } from "../src/notifications.ts";
import { agentGrantableActions } from "@mailda/contract/agent";

import { agentFor, listAgents, mintAgent, revokeAgent } from "../src/agents.ts";
import {
  listMessages, mailboxesWithRelation, mayRead, maySend, messagePageQuery, principalFor,
  readableSubjects,
} from "../src/authz-read.ts";
import { sponsorTerm } from "../src/delegation.ts";
import { indexBody, indexMessage } from "../src/search.ts";
import { liveGrantsBySubject, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA } from "../src/supervised.ts";

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

/** `mayRead` records a supervised act when a grant answers, so it takes one rather than accepting null. */
const READ_ACT = { action: "supervised.opened", subject: "rcpt_agents00000000000000000" } as const;

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

describe("the sponsor is a live ceiling, not a label on the trail", () => {
  /*
   * ## The defect this block was written to prove
   *
   * `agents.ts` states the rule in its own header:
   *
   *     effective(agent) = pinned action ceiling ∩ live tuples of the agent ∩ live tuples of the sponsor
   *
   * The third term was **not enforced**. `principalFor` returns the agent as `userId` and the sponsor as
   * `delegatorUserId`, and every relation check resolves subjects from `who.userId` alone — so the sponsor
   * appeared in the audit trail and constrained nothing.
   *
   * That is this repository's signature defect: prose asserting a property the code below it does not have,
   * written the same day as a commit message about that defect class. Found by an external audit, not here,
   * because every test in this file covered the credential's mechanics — secrecy, hashing, expiry,
   * revocation, route matching — and none covered the authority model.
   *
   * What it costs: an agent keeps reaching a mailbox after its sponsor's relation is revoked, after the
   * sponsor leaves the team that granted it, or where the sponsor never held it at all. The sentence the
   * sponsor exists for — *a human cannot delegate more authority than they continue to hold* — was false.
   */
  const MAILBOX = "mbx_agents_test";

  it("permits a read when the agent and the sponsor both hold the relation", async () => {
    /*
     * The control, and it runs first. Without it, every refusal below could be a broken fixture — an agent
     * that can read nothing would satisfy the assertions for the wrong reason.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "reader", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);
    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);

    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    const allowed = await mayRead(testEnv, createSystemCtx(), who!, MAILBOX, READ_ACT);
    expect(allowed, "an agent whose sponsor holds the relation was refused").toBe(true);
  });

  it("refuses a read the agent holds and the sponsor does not", async () => {
    /*
     * **The assertion.** The agent has the tuple; the sponsor never did. Under the two-term implementation
     * this passes the check, and the sponsor is a label rather than a ceiling.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "overreach", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);
    // The sponsor is deliberately granted nothing.

    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    const allowed = await mayRead(testEnv, createSystemCtx(), who!, MAILBOX, READ_ACT);
    expect(
      allowed,
      "an agent reached a mailbox its sponsor cannot: the sponsor is attribution rather than a ceiling, and "
      + "a human can delegate authority they do not hold",
    ).toBe(false);
  });

  it("stops permitting a read once the sponsor's relation is revoked", async () => {
    /*
     * The half that matters operationally. Revoking a person's access has to withdraw what they delegated —
     * otherwise removing somebody from a mailbox leaves their agents reading it, which is the failure an
     * offboarding checklist cannot see.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "reader", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);
    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);

    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    expect(await mayRead(testEnv, createSystemCtx(), who!, MAILBOX, READ_ACT)).toBe(true);

    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ? AND object_id = ?",
    ).bind(ORG, SPONSOR, MAILBOX).run();

    const after = await mayRead(testEnv, createSystemCtx(), who!, MAILBOX, READ_ACT);
    expect(after, "the agent still reads a mailbox its sponsor was removed from").toBe(false);
  });

  it("refuses when the agent's own relation is revoked and the sponsor's remains", async () => {
    // The other direction, so the intersection is shown to be an AND rather than a swap of which side counts.
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "reader", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);

    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    const allowed = await mayRead(testEnv, createSystemCtx(), who!, MAILBOX, READ_ACT);
    expect(allowed, "an agent with no relation of its own read a mailbox").toBe(false);
  });
});

describe("the pinned ceiling cannot name a capability machines are withheld", () => {
  it("refuses to mint an agent that could mint agents", async () => {
    /*
     * **The escalation the curation table exists to prevent.** `packages/contract/src/agent.ts` classifies
     * every route, and only `read` and `act` reach a machine — `POST /api/agents` is `operator` precisely
     * because an agent that can mint agents escapes its own pinned ceiling in one call.
     *
     * The mint accepted arbitrary strings, so that classification bound the MCP tool list and nothing else.
     * An administrator could hand an agent the route directly.
     */
    await expect(mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "escalator", sponsorUserId: SPONSOR, actions: ["POST /api/agents"],
    })).rejects.toThrow(/E_AGENT_ACTION_WITHHELD/);
  });

  it("refuses a governed capability, which no machine may hold", async () => {
    // Sealing a send is the one act nobody can undo, and it is `governed` for that reason.
    await expect(mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "sender", sponsorUserId: SPONSOR, actions: ["POST /api/sends/seal"],
    })).rejects.toThrow(/E_AGENT_ACTION_WITHHELD/);
  });

  it("refuses a route the curation table does not classify at all", async () => {
    await expect(mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "invented", sponsorUserId: SPONSOR, actions: ["POST /api/does-not-exist"],
    })).rejects.toThrow(/E_AGENT_ACTION_WITHHELD/);
  });

  it("still admits the capabilities a machine is meant to have", async () => {
    // The control. A ceiling that refused everything would satisfy all three assertions above.
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "reader", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    expect(minted.agent.actions).toEqual([AGENT_READS]);
  });
});

describe("the listing is constrained by the sponsor too, not only the single-object check", () => {
  /*
   * `hasAnyRelation` guards one object at a time. The **listing** builds its own tuple predicate, and it did
   * not see a delegator at all — so closing the single-object hole would have left an agent able to page and
   * search every mailbox it held a relation on, regardless of its sponsor.
   *
   * That is the more dangerous half: a check refuses one message and a listing hands over a page of subject
   * lines and sender addresses.
   */
  const MAILBOX = "mbx_agents_list";
  const ADDRESS = "in@agents-list.example";
  const RECEIPT = "rcpt_agentslist0000000000001";

  async function seedMail() {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT OR IGNORE INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(MAILBOX, ORG, "Enquiries", new Date(ctx.now()).toISOString()),
      testEnv.CATALOG.prepare(
        "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, new Date(ctx.now()).toISOString()),
      testEnv.CATALOG.prepare(
        `INSERT OR IGNORE INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
           raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(RECEIPT, ORG, `evt_${RECEIPT}`, "x@y.example", ADDRESS, 100,
        `${ORG}/raw/${RECEIPT}`, "0".repeat(64), new Date(ctx.now()).toISOString()),
    ]);
  }

  /*
   * The mail above, parsed into a message and indexed in both FTS tables.
   *
   * Idempotent, because `beforeEach` clears the tuples and the agents but not the mail — an authorization
   * test wants the corpus to be a constant and only the grants to move. `INSERT OR IGNORE` plus a delete of
   * the subject-index row, since a second plain insert would either violate
   * `messages.ingress_receipt_id` or leave two index rows for one message.
   */
  async function seedBody() {
    await seedMail();
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const messageId = "msg_agentslist000000000000001";
    await testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         thread_root_rfc_id, conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(messageId, ORG, "2026-Q3", `${ORG}/raw/${RECEIPT}`, "0".repeat(64), 100,
      `${RECEIPT}@example.net`, ctx.id("thr"), "Quarterly restructuring", "x@y.example", at, at,
      RECEIPT, at, `${RECEIPT}@example.net`, ctx.id("cnv")).run();
    await testEnv.CATALOG.prepare("DELETE FROM message_search WHERE message_id = ?").bind(messageId).run();
    await indexMessage(testEnv, messageId).run();
    // `cabotage` is in no subject, so a match on it can only have come through the body arm.
    await indexBody(testEnv, messageId, "cabotage schedules attached").run();
  }

  async function pageFor(who: { orgId: string; userId: string; delegatorUserId?: string | null }, q: string | null = null) {
    const at = new Date(createSystemCtx().now()).toISOString();
    const query = messagePageQuery({
      orgId: who.orgId,
      subjects: await readableSubjects(testEnv, who),
      sponsor: await sponsorTerm(testEnv, who.orgId, who.userId, "t"),
      supervised: {
        metadata: liveGrantsBySubject(who.orgId, who.userId, at, SCOPES_FOR_METADATA),
        content: liveGrantsBySubject(who.orgId, who.userId, at, SCOPES_FOR_CONTENT),
      },
      page: { after: null, mailboxId: null, q },
      limit: 51,
    });
    const rows = await testEnv.CATALOG.prepare(query.sql).bind(...query.params).all<{ id: string }>();
    return rows.results.map((r) => r.id);
  }

  it("lists mail when the agent and sponsor both hold the relation, so a refusal below means something", async () => {
    await seedMail();
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "lister", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);
    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);

    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    expect(await pageFor(who!), "an agent whose sponsor holds the relation cannot list").toContain(RECEIPT);
  });

  it("lists nothing when the sponsor does not hold the relation", async () => {
    await seedMail();
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "overreach", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);
    // The sponsor holds nothing.

    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    expect(
      await pageFor(who!),
      "an agent paged a mailbox its sponsor cannot reach — a page of subject lines and sender addresses",
    ).toEqual([]);
  });

  it("finds nothing by search either, which is the plan the listing assertion does not reach", async () => {
    /*
     * The searched page is a different query — two arms over two FTS indexes, unioned. A fix applied to the
     * plain listing alone would leave *search* open, and search is the worse leak: an unauthorized page is a
     * list of what exists, while an unauthorized query is a question answered about content.
     */
    await seedBody();

    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "prober", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);
    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));

    // The control: the term is really in the index, so an empty result below is the authorization refusing.
    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);
    expect(await pageFor(who!, "restructuring"), "the term is not indexed at all").toContain(RECEIPT);

    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ?",
    ).bind(ORG, SPONSOR).run();
    expect(
      await pageFor(who!, "restructuring"),
      "an agent answered a question about the contents of mail its sponsor cannot read",
    ).toEqual([]);
  });

  it("does not let an agent's content.read ride on a sponsor holding only metadata.read", async () => {
    /*
     * The exact-relation half of the clause, on the listing path. The predicate takes a *set* of relations —
     * `[metadata.read, content.read]` for the subject arm — and matching the sponsor against that set rather
     * than against the agent's own relation is the escalation: a sponsor who may see subject lines would
     * license an agent to search bodies. Dropping `s.relation = t.relation` passed every other assertion in
     * this file, which is why this one exists.
     */
    await seedBody();
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "escalator", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);
    await tuple(SPONSOR, "mailbox.metadata.read", "mailbox", MAILBOX);
    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));

    expect(
      await pageFor(who!, "cabotage"),
      "an agent reached the body index on the strength of a sponsor who may only see subject lines",
    ).toEqual([]);

    // The control: the same agent, once the sponsor actually holds the relation the agent is exercising.
    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);
    expect(await pageFor(who!, "cabotage"), "the body term is not reachable even when both hold it")
      .toContain(RECEIPT);
  });

  it("licenses only the mailboxes the sponsor holds, not every mailbox once it holds one", async () => {
    /*
     * The clause is correlated on the object as well as the relation. Without `s.object_id = t.object_id` a
     * sponsor holding a relation on *any one* mailbox satisfies the `EXISTS` for *every* mailbox the agent
     * has a tuple on — so a sponsor with a single mailbox of their own would license an agent across the
     * whole organization. Every other assertion in this file passed with that term deleted, because they all
     * use one mailbox.
     */
    await seedBody();
    const other = "mbx_agents_other";
    const otherReceipt = "rcpt_agentsother000000000001";
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT OR IGNORE INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(other, ORG, "Accounts", at),
      testEnv.CATALOG.prepare(
        "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("addr"), ORG, "accounts@agents-list.example", other, at),
      testEnv.CATALOG.prepare(
        `INSERT OR IGNORE INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
           raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(otherReceipt, ORG, `evt_${otherReceipt}`, "x@y.example", "accounts@agents-list.example", 100,
        `${ORG}/raw/${otherReceipt}`, "0".repeat(64), at),
    ]);

    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "spreader", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", other);
    // The sponsor reaches one of the two.
    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);

    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    const seen = await pageFor(who!);
    expect(seen, "the mailbox the sponsor holds went missing, so the exclusion below proves nothing")
      .toContain(RECEIPT);
    expect(seen, "an agent read a mailbox its sponsor has no relation on, licensed by a different mailbox")
      .not.toContain(otherReceipt);
  });

  it("constrains the route itself, not only the query the route is supposed to build", async () => {
    /*
     * End to end through `listMessages`, because everything above builds the query by hand. A `listMessages`
     * that resolved no sponsor and passed an empty set would satisfy every assertion in this block — the
     * clause would be correct and unreached, which is the shape of the defect this whole file is about.
     */
    await seedBody();
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "router", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "mailbox.content.read", "mailbox", MAILBOX);

    const ids = async () => {
      const response = await listMessages(testEnv, createSystemCtx(), asAgent(minted.token));
      expect(response.status, "the route refused the agent outright, so an empty page proves nothing").toBe(200);
      const body = await response.json<{ messages: { id: string }[] }>();
      return body.messages.map((m) => m.id);
    };

    expect(await ids(), "an agent listed mail over the route with no sponsor relation at all").toEqual([]);

    // The control: the same request, once the sponsor holds what the agent is exercising.
    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);
    expect(await ids(), "the route returns nothing even when both hold the relation").toContain(RECEIPT);
  });

  it("bounds the dispatch sweep the same way the single-object check bounds a send", async () => {
    /*
     * `mailboxesWithRelation` is the many-objects form, and its own documentation promises that a sweep
     * bounded by it and a check made by `hasAnyRelation` "cannot disagree about what somebody holds". The
     * check gained the sponsor term first and the sweep did not, so for a while the promise was false: the
     * sweep would offer an agent a mailbox that the next check refused. Two answers to one question is how a
     * leak arrives later, when somebody trusts the cheaper answer.
     */
    await seedMail();
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "dispatcher", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "send.propose", "mailbox", MAILBOX);
    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));

    expect(
      await mailboxesWithRelation(testEnv, who!, "send.propose"),
      "an agent was offered a mailbox to send from that its sponsor cannot send from",
    ).toEqual([]);

    // The control, and it also proves the check and the sweep now agree.
    await tuple(SPONSOR, "send.propose", "mailbox", MAILBOX);
    expect(await mailboxesWithRelation(testEnv, who!, "send.propose")).toEqual([MAILBOX]);
    expect(await maySend(testEnv, who!, MAILBOX), "the sweep and the check disagree").toBe(true);
  });
});

describe("organization-admin is intersected with the sponsor as well", () => {
  /*
   * The fourth relation family the audit named, and the one that was not in `authz-read.ts`. `isAdmin` takes a
   * bare identifier rather than a `Principal`, so it could not see a delegator — and thirty call sites pass
   * `who.userId` into it. Two routes an agent may hold are gated on exactly this call: `POST /api/butlers` and
   * `POST /api/policies`. An agent granted `org.admin` created standing automation for the organization on the
   * authority of a sponsor who could not have.
   */
  it("refuses an agent holding org.admin whose sponsor does not hold it", async () => {
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "usurper", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "org.admin", "organization", ORG);

    expect(
      await isAdmin(testEnv, ORG, minted.agent.id),
      "an agent was an administrator of an organization its sponsor does not administer",
    ).toBe(false);
    await expect(assertAdmin(testEnv, ORG, minted.agent.id)).rejects.toThrow("E_NOT_AN_ADMINISTRATOR");
  });

  it("allows it once the sponsor holds it too", async () => {
    // The control. Without this, deleting the whole agent branch and returning false for every `agt_` would
    // pass the test above — a refusal that is right by accident is not the rule.
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "deputy", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, "org.admin", "organization", ORG);
    await tuple(SPONSOR, "org.admin", "organization", ORG);

    expect(await isAdmin(testEnv, ORG, minted.agent.id)).toBe(true);
  });

  it("refuses an agent that holds nothing, even under an administrator sponsor", async () => {
    // The other direction: the intersection is an AND, so the sponsor's relation alone confers nothing. If
    // the sponsor check were written as a fallback rather than a second term, this would pass.
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "borrower", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(SPONSOR, "org.admin", "organization", ORG);

    expect(
      await isAdmin(testEnv, ORG, minted.agent.id),
      "an agent inherited its sponsor's administration rather than intersecting with it",
    ).toBe(false);
  });

  it("leaves a human administrator exactly as they were", async () => {
    // The regression control. `ADMIN` is seeded by `beforeEach`, and a prefix test that matched too widely
    // would lock every administrator out of their own organization.
    expect(await isAdmin(testEnv, ORG, ADMIN)).toBe(true);
    expect(await isAdmin(testEnv, ORG, SPONSOR)).toBe(false);
  });
});

describe("the surfaces beyond the inbox are intersected too", () => {
  /*
   * `mayRead`, `maySend` and `mayExport` all land in `hasAnyRelation`, so fixing that one check covered three
   * of the four relation families the audit named. It covered **one route**. Forty-four routes are grantable
   * to an agent, and several answer from their own tuple predicate: the case queues, the sends listing, the
   * notifications feed. Each was a separate leak wearing the same shape.
   *
   * `test/node/delegated-authority-world.test.ts` is the half that generalizes — it fails on a *new* predicate
   * that has not decided. These are the half that proves the decisions actually bind.
   */
  const MAILBOX = "mbx_agents_wide";
  const ADDRESS = "wide@agents-wide.example";

  async function seedMailbox() {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT OR IGNORE INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(MAILBOX, ORG, "Wide", at),
      testEnv.CATALOG.prepare(
        "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ]);
  }

  async function agentOn(name: string, relation: string) {
    await seedMailbox();
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name, sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await tuple(minted.agent.id, relation, "mailbox", MAILBOX);
    const who = await principalFor(testEnv, createSystemCtx(), asAgent(minted.token));
    return who!;
  }

  it("offers no case queue in a mailbox the sponsor cannot send from", async () => {
    const who = await agentOn("queue-reader", "send.propose");
    expect(
      (await mailboxQueues(testEnv, ORG, who.userId)).map((q) => q.id),
      "an agent was offered work to claim in a mailbox its sponsor cannot send from — and claiming is an act",
    ).toEqual([]);

    await tuple(SPONSOR, "send.propose", "mailbox", MAILBOX);
    expect(
      (await mailboxQueues(testEnv, ORG, who.userId)).length,
      "no queue even when both hold send.propose, so the exclusion above proves nothing",
    ).toBe(1);
  });

  it("shows no mailbox-wide notice for a mailbox the sponsor cannot read", async () => {
    const who = await agentOn("notice-reader", "mailbox.content.read");
    const ctx = createSystemCtx();
    const noticeId = ctx.id("ntf");
    await testEnv.CATALOG.prepare(
      `INSERT INTO notifications (id, org_id, kind, subject_id, user_id, mailbox_id, created_at, delivered_at)
       VALUES (?,?,?,?,NULL,?,?,?)`,
    ).bind(noticeId, ORG, "matter.opened", MAILBOX, MAILBOX,
      new Date(ctx.now()).toISOString(), new Date(ctx.now()).toISOString()).run();

    const ids = async () => (await notificationsFor(testEnv, who, await readableSubjects(testEnv, who)))
      .map((n) => n.id);

    expect(
      await ids(),
      "an agent learned which mailboxes have matters open and what is due on them",
    ).toEqual([]);

    await tuple(SPONSOR, "mailbox.content.read", "mailbox", MAILBOX);
    expect(await ids(), "the notice is not reachable even when both hold the relation").toContain(noticeId);
  });
});

describe("the mint and revoke routes validate what they are handed", () => {
  it("writes no revocation entry for an agent that was not revoked", async () => {
    /*
     * The audit entry was unconditional while the `UPDATE` was conditional on `revoked_at IS NULL`, and a
     * comment beside it explained that zero changes is not an error — which is true, and not the question.
     * The trail recorded `agent.revoked` regardless, so a double-press wrote two entries for one withdrawal
     * and a revoke of an identifier that never existed wrote an entry about nothing at all. An administrator
     * probing identifiers would write themselves a trail of revocations that did not happen.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "twice", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await revokeAgent(testEnv, createSystemCtx(), ORG, ADMIN, minted.agent.id);
    await revokeAgent(testEnv, createSystemCtx(), ORG, ADMIN, minted.agent.id);
    await revokeAgent(testEnv, createSystemCtx(), ORG, ADMIN, "agt_neverexisted000000000001");

    const entries = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE org_id = ? AND action = 'agent.revoked'",
    ).bind(ORG).first<{ n: number }>();
    expect(Number(entries?.n), "the trail records revocations that did not happen").toBe(1);
  });

  it("refuses an action list longer than the number of grantable actions", async () => {
    /*
     * `actions` was unbounded. Every entry is deduplicated and checked against the curated list, so the
     * *stored* ceiling was always sane — but the checking happens after a `Set` is built from the raw input,
     * so the work is the caller's array length and not the ceiling's. The bound is derived from the curated
     * list rather than picked, because a list that grows past a hardcoded number would start refusing valid
     * ceilings and the failure would look like a permissions bug.
     */
    /*
     * **Valid actions, repeated.** An array of made-up route strings is caught by the withheld check already,
     * which is why the first draft of this test proved nothing: it failed with `E_AGENT_ACTION_WITHHELD` and
     * looked like a pass. The reachable hazard is a large array of *legitimate* entries, which deduplicates
     * to a ceiling of one and does all its work before that.
     */
    const tooMany = Array.from({ length: agentGrantableActions().length + 1 }, () => AGENT_READS);
    await expect(
      mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
        name: "greedy", sponsorUserId: SPONSOR, actions: tooMany,
      }),
    ).rejects.toThrow("E_AGENT_ACTIONS_UNBOUNDED");

    // The control: the whole curated list is a legitimate ceiling and must still mint.
    const all = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "everything", sponsorUserId: SPONSOR, actions: agentGrantableActions(),
    });
    expect(all.agent.actions.length).toBe(agentGrantableActions().length);
  });

  it("refuses a lifetime that is not a positive number of days", async () => {
    /*
     * `Math.min(input.lifetimeDays ?? DEFAULT, MAX)` accepts anything. `NaN` propagates through `Math.min`,
     * reaches `new Date(NaN).toISOString()` and throws a bare `RangeError` — a 500 with no `what`, `why` or
     * `fix`, for a request the caller could have been told about. Zero or a negative number is worse than an
     * error: it mints a credential that is already expired, so the operator holds a token that fails on first
     * use with no explanation of why.
     */
    for (const days of [0, -1, Number.NaN]) {
      await expect(
        mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
          name: `bad-${days}`, sponsorUserId: SPONSOR, actions: [AGENT_READS], lifetimeDays: days,
        }),
        `lifetimeDays ${days} was accepted`,
      ).rejects.toThrow("E_AGENT_LIFETIME_INVALID");
    }

    // The control: a sensible lifetime still mints, and is still capped at the maximum.
    const ok = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "sensible", sponsorUserId: SPONSOR, actions: [AGENT_READS], lifetimeDays: 3,
    });
    expect(Date.parse(ok.agent.expiresAt)).toBeGreaterThan(createSystemCtx().now());
  });
});

describe("an agent's act names its sponsor without the call site remembering to say so", () => {
  /*
   * Audit P1-1. `audit_entries.delegator_user_id` exists, is inside the hashed form, and was populated by
   * **four** call sites out of every audited act in the product. Everything else an agent does recorded
   * `agt_…` as the actor and nothing as the delegator — so the trail could name the machine and not the person
   * accountable for it, which is the exact gap the column was added to close.
   *
   * The audit's suggestion was a typed actor union threaded through every audited operation so the delegator
   * could not be omitted. This file takes the other route, and the argument is already written in `audit.ts`
   * beside `kindOfActor`: attribution derived from the identifier's typed prefix is *structural*, while a
   * design where each call site passes it "would be correct on the day it was written and wrong the first time
   * a new effect node called a fifth function". The delegator is the same shape of fact as the kind. Deriving
   * it needs no signature to change and no caller to remember.
   *
   * Derived **at write time and stored**, which is what keeps faith with the column's own reasoning: a trail
   * that re-derived the sponsor at *read* time would change its answer when somebody reassigned an agent
   * months later, and an audit trail whose answers move is what the hash chain exists to prevent.
   */
  it("derives the delegator from the actor when the call site does not pass one", async () => {
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "actor", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await auditedBatch(testEnv, createSystemCtx(), ORG, {
      action: "supervised.opened",
      outcome: "ok",
      actorUserId: minted.agent.id,
      subject: "rcpt_p1one000000000000000001",
    }, (entry) => [entry]);

    const row = await testEnv.CATALOG.prepare(
      `SELECT actor_user_id, actor_kind, delegator_user_id FROM audit_entries
        WHERE org_id = ? AND action = 'supervised.opened' ORDER BY seq DESC LIMIT 1`,
    ).bind(ORG).first<{ actor_user_id: string; actor_kind: string; delegator_user_id: string | null }>();

    expect(row?.actor_kind, "the kind is already derived and must stay so").toBe("agent");
    expect(
      row?.delegator_user_id,
      "an agent's act named the machine and not the person accountable for it",
    ).toBe(SPONSOR);
  });

  it("prefers a delegator the call site did pass, so the four existing ones do not change meaning", async () => {
    // A Butler's sponsor comes from its pinned ceiling rather than from a lookup, and `butler/effects.ts`
    // passes it. Derivation must not overwrite an answer a caller had better information for.
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "explicit", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await auditedBatch(testEnv, createSystemCtx(), ORG, {
      action: "supervised.opened",
      outcome: "ok",
      actorUserId: minted.agent.id,
      delegatorUserId: ADMIN,
      subject: "rcpt_p1two000000000000000001",
    }, (entry) => [entry]);

    const row = await testEnv.CATALOG.prepare(
      `SELECT delegator_user_id FROM audit_entries WHERE org_id = ? AND subject = ? LIMIT 1`,
    ).bind(ORG, "rcpt_p1two000000000000000001").first<{ delegator_user_id: string | null }>();
    expect(row?.delegator_user_id).toBe(ADMIN);
  });

  it("leaves a person's own act with no delegator, and asks the database nothing to find that out", async () => {
    /*
     * The control, and the cost. Nearly every audited act in this product is a person acting for themselves,
     * so a derivation that cost a query per entry would be paid on the p95 send path for a field that is
     * almost always null. A `usr_` prefix returns before any statement is prepared.
     */
    await auditedBatch(testEnv, createSystemCtx(), ORG, {
      action: "supervised.opened",
      outcome: "ok",
      actorUserId: ADMIN,
      subject: "rcpt_p1three00000000000000001",
    }, (entry) => [entry]);

    const row = await testEnv.CATALOG.prepare(
      `SELECT actor_kind, delegator_user_id FROM audit_entries WHERE org_id = ? AND subject = ? LIMIT 1`,
    ).bind(ORG, "rcpt_p1three00000000000000001")
      .first<{ actor_kind: string; delegator_user_id: string | null }>();
    expect(row?.actor_kind).toBe("user");
    expect(row?.delegator_user_id, "a person acting for themselves was given a delegator").toBeNull();
  });

  it("hands the delegator back over the route, not only into the column", async () => {
    /*
     * The route's own half. `GET /api/audit` selected `actor_user_id` and `actor_kind` and **not**
     * `delegator_user_id`, so the answer had been complete in the database and incomplete over the wire since
     * the column shipped. The client test for this asserts the rendering against a stubbed payload, which by
     * construction cannot notice a route that never sends the field — so the assertion has to be made here as
     * well, against the real Worker.
     *
     * Through `SELF.fetch` with the agent's own bearer token: `GET /api/audit` is inside the machine ceiling,
     * so an agent reading the trail and finding its own sponsor named is the real path rather than a
     * contrivance.
     */
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "routed", sponsorUserId: SPONSOR, actions: [AGENT_READS, "GET /api/audit"],
    });
    await auditedBatch(testEnv, createSystemCtx(), ORG, {
      action: "supervised.opened", outcome: "ok", actorUserId: minted.agent.id,
      subject: "rcpt_p1five00000000000000001",
    }, (entry) => [entry]);

    const response = await SELF.fetch("https://node.example/api/audit?action=supervised.opened", {
      headers: { authorization: `Bearer ${minted.token}` },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json<{ entries: { subject: string; delegator_user_id: string | null }[] }>();
    const entry = body.entries.find((row) => row.subject === "rcpt_p1five00000000000000001");
    expect(entry, "the entry did not come back at all").toBeDefined();
    expect(
      entry?.delegator_user_id,
      "the trail names the person in its own column and does not say so over the wire",
    ).toBe(SPONSOR);
  });

  it("still verifies the chain, because the delegator is inside the hashed form", async () => {
    // The derivation writes a field the hash covers, so a derived value that disagreed with what was hashed
    // would break verification rather than merely misreport. Asserted, because "it is in the hash" is the
    // reason the column is trustworthy at all.
    const minted = await mintAgent(testEnv, createSystemCtx(), ORG, ADMIN, {
      name: "chained", sponsorUserId: SPONSOR, actions: [AGENT_READS],
    });
    await auditedBatch(testEnv, createSystemCtx(), ORG, {
      action: "supervised.opened", outcome: "ok", actorUserId: minted.agent.id, subject: "rcpt_p1four00000000000000001",
    }, (entry) => [entry]);
    const outcome = await verifyChain(testEnv, ORG);
    expect(outcome.intact, `chain broken: ${JSON.stringify(outcome)}`).toBe(true);
  });
});
