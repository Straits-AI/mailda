import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { ROUTES, machineUseful, methodNameFor, type RouteSpec } from "@mailda/contract";

import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";
import { tools } from "../src/mcp.ts";

/**
 * The MCP server (#89, ADR 12).
 *
 * ## Driven as a client would, over the real endpoint
 *
 * Every call here is JSON-RPC over `POST /mcp` against the running Worker. A unit test of `handleMcp` would
 * skip the thing most worth checking: that a tool call goes through this Node's **own routes** — the
 * session check, the authorization, the audit entry, the refusal — rather than around them.
 *
 * That is the property, and it is why the handler calls `fetch` against its own origin instead of importing
 * the functions beneath. An MCP layer that reached past the routes would be a second way into this Node's
 * data with its own idea of who may do what.
 */

const testEnv = env as unknown as Env;
const ORG = "org_mcp";
const USER = createSystemCtx().id("usr");
const ORIGIN = "https://node";

beforeEach(async () => {
  for (const table of [
    "butler_versions", "butlers", "relationship_tuples", "users", "node_claim", "audit_entries",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(USER, ORG, "person@local.invalid", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)",
    ).bind(at, ORG),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, USER, ORG, at),
  ]);
});

async function cookie(): Promise<string> {
  const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId: USER });
  return `${ACCESS_COOKIE}=${session.accessToken}`;
}

async function rpc(method: string, params?: unknown, held?: string): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(held === undefined ? {} : { cookie: held }) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (response.status === 202) return {};
  return await response.json() as Record<string, unknown>;
}

describe("the handshake says what this server is and is not", () => {
  it("initializes, and the instructions name the absences", async () => {
    /*
     * The instructions repeat what the Skill says, and that repetition is deliberate: an agent that only
     * ever speaks MCP never reads the Skill, and an absence it has not been warned about is one it probes.
     */
    const answer = await rpc("initialize") as { result: { instructions: string; serverInfo: unknown } };
    expect(answer.result.serverInfo).toMatchObject({ name: "mailda" });
    expect(answer.result.instructions).toMatch(/they do not send/);
    expect(answer.result.instructions).toMatch(/two distinct\s+people/);
  });

  it("refuses a method it does not implement, as a protocol error", async () => {
    const answer = await rpc("resources/list") as { error: { code: number } };
    expect(answer.error.code).toBe(-32601);
  });
});

describe("the tool list is the curated one, and nothing else", () => {
  it("lists the capabilities and none of the withheld acts", async () => {
    const answer = await rpc("tools/list") as {
      result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
    };
    const names = answer.result.tools.map((tool) => tool.name);

    /*
     * 24 today, down from 46. The catalogue used to be filtered by exposure tier alone, so it offered every
     * organization-scoped read as a tool an agent token could never satisfy. The floor is well below the
     * count and well above zero, which is what a floor is for.
     */
    expect(names.length).toBeGreaterThan(15);
    // The reads and the reversible acts.
    expect(names).toContain("getMessages");
    expect(names).toContain("putDrafts");

    /*
     * And none of the acts that need a person — or two. This is the property the whole curation exists for:
     * an agent inside somebody's session is that person, so a tool it can never complete would only teach
     * it to try.
     */
    for (const withheld of [
      "postSends", "postSendsBySendIdRelease", "postApprovalsByApprovalIdDecide",
      "postButlersByButlerIdPublish", "postHolds", "postAccess", "postAuthPasskeys",
    ]) {
      expect(names, `${withheld} is offered`).not.toContain(withheld);
    }

    // And not itself: a surface is not a capability on itself.
    expect(names).not.toContain("postMcp");
  });

  it("lists no tool that no agent credential could ever satisfy", async () => {
    /*
     * The property the catalogue is *for*, asserted against the registry rather than against a handful of
     * names I happened to think of.
     *
     * `tools()` was built from the exposure tier alone while `agentGrantableActions()` — the set a mint may
     * actually confer — also asked whether a machine can be provisioned for the route. Two filters, one
     * question, different answers: twenty-two organization-scoped routes were published as tools that every
     * agent token is refused on. Not a bypass, since the route still says no; a broken contract, and worse
     * than a missing tool, because the tool list is what teaches an agent what to attempt. It retries against
     * a door that cannot open and the operator sees a broken agent rather than a catalogue that lied.
     *
     * Written as a set intersection so that the *next* unreachable route fails this too, rather than only the
     * ones already known.
     */
    const answer = await rpc("tools/list") as { result: { tools: Array<{ name: string }> } };
    const listed = new Set(answer.result.tools.map((tool) => tool.name));

    const unreachable = (ROUTES as readonly RouteSpec[])
      .filter((spec) => !machineUseful(spec.authority))
      .map((spec) => methodNameFor(spec).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, ""));

    expect(
      unreachable.filter((name) => listed.has(name)),
      "these tools are published to agents and no mint can confer what their routes require, so every call "
      + "is refused — the catalogue is teaching an agent to retry against a door that cannot open:",
    ).toEqual([]);

    /*
     * The control, in both directions. An empty `unreachable` would satisfy the assertion above without
     * proving anything, and an empty `listed` would mean the surface had been filtered away entirely.
     */
    expect(unreachable.length, "no unreachable routes exist — has machineUseful stopped discriminating?")
      .toBeGreaterThan(20);
    expect(listed.size, "no tools are listed at all").toBeGreaterThan(15);
  });

  it("publishes no internal metadata in a tool's input schema", async () => {
    /*
     * `.meta({ refusal: "E_…" })` tells `request-shape.ts` which code to refuse a closed set with (#93), and
     * `z.toJSONSchema` copied it straight into the published schema — so the MCP tool for `postPolicies`
     * advertised `"refusal":"E_POLICY_FIELD_UNKNOWN"` inside a description of its *input*. Not a secret, and
     * not the caller's: a wire format carrying a server's internal wiring is one callers start depending on.
     *
     * Asserted over **every** tool rather than the one that had it, because the next `.meta()` will be added
     * for a different reason by somebody who has not read this.
     */
    const answer = await rpc("tools/list") as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> };
    };
    const leaking = answer.result.tools
      .filter((tool) => /"refusal"/.test(JSON.stringify(tool.inputSchema)))
      .map((tool) => tool.name);
    expect(leaking).toEqual([]);
    // Non-vacuity: the tool that carries the metadata is on the list, so an empty result above is the
    // stripping working rather than the schema being absent.
    const drafts = answer.result.tools.find((tool) => tool.name === "putDrafts");
    expect(drafts, "putDrafts is not offered, so this proves nothing").toBeDefined();
    expect(JSON.stringify(drafts!.inputSchema)).toMatch(/mailboxId/);
  });

  it("gives each tool a JSON Schema with its path parameters required", async () => {
    const answer = await rpc("tools/list") as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }> };
    };
    /*
     * A path parameter and a body, on two tools rather than one.
     *
     * `postButlersByButlerIdSimulate` carried both and is no longer offered — it needs `org.admin`, which no
     * mint confers, so publishing it taught an agent to attempt a call that could only be refused. Nothing in
     * the offered set has both today, which is worth knowing rather than working around: the parameterised
     * tools are reads, and the one writing tool takes a body and no segment.
     */
    const one = answer.result.tools.find((tool) => tool.name === "getMessagesByReceiptIdBody")!;
    expect(one.inputSchema.required, "a path parameter is not required").toEqual(["receiptId"]);

    const drafts = answer.result.tools.find((tool) => tool.name === "putDrafts")!;
    expect(
      drafts.inputSchema.required,
      "the one act an agent is offered publishes no body, so it cannot say what the draft says",
    ).toEqual(["body"]);

    // A parameterless read takes nothing, rather than an empty object it has to be told to omit.
    const messages = answer.result.tools.find((tool) => tool.name === "getMessages")!;
    expect(messages.inputSchema.required).toEqual([]);
  });
});

describe("a tool call goes through this Node's own routes", () => {
  it("carries the caller's session, so the act is theirs", async () => {
    /*
     * The audit trail is the assertion. `postMatters` writes a `matter.opened` entry naming an actor, and
     * that actor is the **person** whose cookie the MCP request carried — not a machine identity. An
     * MCP-specific credential would have put a machine there, and every act an agent performed would have
     * been unattributable to whoever set it going.
     *
     * `postButlers` until the catalogue was corrected — it needs `org.admin`, so it was a tool no agent
     * credential could ever have completed, and this test proved attribution through a door that was shut.
     */
    const held = await cookie();

    const answer = await rpc("tools/call", {
      name: "postMatters",
      arguments: { body: { type: "security_incident", description: "opened via mcp" } },
    }, held) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(answer.result.isError, answer.result.content[0]?.text).toBe(false);
    expect(answer.result.content[0]!.text).toContain("security_incident");

    const audited = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, action FROM audit_entries WHERE org_id = ? ORDER BY seq DESC LIMIT 1",
    ).bind(ORG).first<{ actor_user_id: string; action: string }>();
    expect(audited).toMatchObject({ actor_user_id: USER, action: "matter.opened" });
  });

  it("is refused when the caller has no session, by the route rather than by this layer", async () => {
    /*
     * No cookie, so `principalFor` refuses — and the refusal comes back as a **tool result** with `isError`,
     * not a JSON-RPC error. The tool ran and the answer was no, which is information an agent should reason
     * about rather than a protocol fault.
     */
    const answer = await rpc("tools/call", { name: "getMessages", arguments: {} }) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0]!.text).toContain("unauthenticated");
  });

  it("passes a refusal through with its four parts intact", async () => {
    /*
     * The whole reason a refusal is a tool result rather than an error code: this Node's refusals say what
     * happened, why, and what would change it, and that is exactly what a retrying agent needs. Flattening
     * one into `-32603` would throw away the only part it can act on.
     */
    const held = await cookie();
    const answer = await rpc("tools/call", {
      name: "postMatters",
      arguments: { body: { type: "not-a-matter-type", description: "broken" } },
    }, held) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(answer.result.isError).toBe(true);
    const text = answer.result.content[0]!.text;
    expect(text).toContain("E_MATTER_TYPE_UNKNOWN");
    expect(text).toContain("why");
    expect(text).toContain("fix");
  });

  it("refuses an unknown tool as a protocol error, not a tool result", async () => {
    /*
     * The distinction: a tool that is not on the list the caller was given is a mistake about *this server*,
     * where a refusal is an answer *from* it. An agent should retry neither, and telling them apart is how
     * it learns which.
     */
    const answer = await rpc("tools/call", { name: "postSends", arguments: {} }, await cookie()) as {
      error: { code: number; message: string };
    };
    // `postSends` exists as a route and is deliberately withheld, so it is unknown *here* — which is the
    // answer an agent that went looking for it should get.
    expect(answer.error.code).toBe(-32602);
    expect(answer.error.message).toContain("postSends");
  });

  it("refuses a call missing a path parameter, before making a request", async () => {
    // `getButlersByButlerId` until the catalogue was corrected — it needs `org.admin` and is no longer a tool.
    const answer = await rpc("tools/call", {
      name: "getDraftsByDraftId", arguments: {},
    }, await cookie()) as { error: { code: number; message: string } };
    expect(answer.error.code).toBe(-32602);
    expect(answer.error.message).toContain("draftId");
  });
});

describe("a paged read carries its position, and a bad one is refused by the route", () => {
  /*
   * The machine half of #91, which shipped **untested**: replacing the forwarding condition with `if (false)`
   * pinned MCP's `getMessages` to page one for ever — the exact defect #91 exists to fix, in a surface the
   * change claimed to have fixed — and the whole of this file still passed.
   */
  it("accepts a well-formed cursor rather than refusing everything", async () => {
    /*
     * **This does not prove forwarding, and the first version claimed it did.** This Node has no mail in
     * this suite, so a cursor page and page one are both empty and read identically — the assertion held
     * with the forwarding replaced by `if (false)`, which is the exact defect it was written against.
     *
     * What it does prove is the other direction, which still needs proving: a *valid* cursor is not refused,
     * so the refusal below is about the value and not about paging being broken. The witness for forwarding
     * is that test, because a value that never reaches the route cannot be refused by it.
     */
    const answer = await rpc("tools/call", {
      name: "getMessages",
      arguments: { cursor: "2026-08-20T09:00:00.000Z rcpt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ" },
    }, await cookie()) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(answer.result.isError, answer.result.content[0]?.text).toBe(false);
    expect(answer.result.content[0]!.text).toContain("next_cursor");
  });

  it("forwards a mailbox filter", async () => {
    const answer = await rpc("tools/call", {
      name: "getMessages", arguments: { mailbox: "mbx_nothing_here" },
    }, await cookie()) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(answer.result.isError).toBe(false);
  });

  it("lets the route refuse a malformed cursor rather than dropping it", async () => {
    /*
     * The property the forwarding exists for. A non-string was silently omitted before, so an agent that
     * sent `cursor: 7` received **the newest page** and no sign it had asked for anything else — a wrong
     * answer indistinguishable from the right one, which is what `E_PAGE_CURSOR_MALFORMED` is for.
     */
    for (const cursor of [7, "", "yesterday"] as unknown[]) {
      const answer = await rpc("tools/call", {
        name: "getMessages", arguments: { cursor },
      }, await cookie()) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(answer.result.isError, `cursor ${JSON.stringify(cursor)} was dropped`).toBe(true);
      expect(answer.result.content[0]!.text).toContain("E_PAGE_CURSOR_MALFORMED");
    }
  });

  it("omits an absent cursor, because absent is the newest page", async () => {
    // The other side: `undefined` must stay absent or every unpaged read becomes a refusal.
    const answer = await rpc("tools/call", {
      name: "getMessages", arguments: {},
    }, await cookie()) as { result: { isError: boolean } };
    expect(answer.result.isError).toBe(false);
  });
});

describe("the catalogue depends on which class of caller is asking", () => {
  /*
   * One static catalogue treated every machine alike, and the cost was a tool #87 built to be offered.
   *
   * `POST /api/butlers/:butlerId/simulate` walks a Butler over a real past delivery, causes nothing and
   * cannot write — the curation says *"offering this to an agent is the point of having built it"*. Its
   * handler requires `org.admin`. A delegated `agt_` credential can never hold that, so a single list had to
   * withhold the dry run from **everybody**, including the administrator whose assistant is the caller it was
   * built for.
   *
   * Two classes, because there are two:
   *
   * - a person's live session acts with that person's current authority;
   * - a delegated credential acts within the ceiling pinned when it was minted, and a tool outside that
   *   ceiling is one it will be refused on — advertising it teaches a retry loop.
   *
   * **Nothing was weakened.** The handler still calls `isAdmin` first, which the third assertion below proves
   * by driving the tool as an agent and watching the route refuse.
   */
  async function toolNames(headers: Record<string, string>): Promise<string[]> {
    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const answer = await response.json() as { result: { tools: { name: string }[] } };
    return answer.result.tools.map((one) => one.name);
  }

  /** A delegated credential whose ceiling is exactly `mail.read`'s routes. */
  async function agentToken(): Promise<string> {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const mailbox = "mbx_mcpagent0000000000000000";
    await testEnv.CATALOG.prepare(
      "INSERT OR IGNORE INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)",
    ).bind(mailbox, ORG, "Enquiries", at).run();
    for (const relation of ["mailbox.content.read", "message.export"]) {
      await testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, relation, mailbox, at).run();
    }
    const { mintAgent } = await import("../src/agents.ts");
    const minted = await mintAgent(testEnv as never, createSystemCtx(), ORG, USER, {
      name: "mcp catalogue", sponsorUserId: USER, capabilities: ["mail.read"],
      grants: [
        { mailboxId: mailbox, relation: "mailbox.content.read" },
        { mailboxId: mailbox, relation: "message.export" },
      ],
    });
    return minted.token;
  }

  const SIMULATE = "postButlersByButlerIdSimulate";

  it("offers the Butler dry run to an administrator's session", async () => {
    const offered = await toolNames({ cookie: await cookie() });
    expect(
      offered,
      "the tool #87 built to be offered is withheld from the administrator whose assistant is asking",
    ).toContain(SIMULATE);
  });

  it("refuses a delegated credential the endpoint itself, which is why the agent branch is unreachable", async () => {
    /*
     * **The finding that came out of building this**, recorded rather than papered over.
     *
     * `POST /mcp` is tier `surface` — *"a surface is not a capability on itself"* — so it is in no agent's
     * pinned ceiling and `authz-read.ts` refuses the token before any catalogue is consulted. A delegated
     * credential cannot list MCP tools at all today.
     *
     * So the agent branch of `tools()` is correct and currently **unreachable**. It is kept rather than
     * deleted because the intersection it performs — machine-useful ∩ pinned ceiling — is the right answer
     * the moment somebody decides `/mcp` should be reachable by a credential, and that is a product decision
     * about what a long-lived machine identity may do, not something to settle inside a catalogue. This test
     * is what will fail on the day it changes, with the reason attached.
     */
    const response = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await agentToken()}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status, "a delegated credential reached /mcp, so the agent catalogue is now live and "
      + "needs the offered/ceiling assertions this test replaced").toBe(403);
    expect((await response.json() as { error: string }).error).toBe("E_AGENT_ACTION_NOT_PERMITTED");
  });

  it("intersects a delegated ceiling with the machine-useful set, for when the endpoint opens", () => {
    /*
     * The agent branch driven at the seam instead of over HTTP, since the endpoint refuses the credential.
     * Asserting it directly is weaker than an integration test and stronger than nothing: it proves the
     * intersection is real, so the unreachable branch is not quietly wrong.
     */
    const ceiling = ["GET /api/messages", "GET /api/messages/:receiptId/body"];
    const offered = tools({ kind: "agent", ceiling }).map((one) => one.name);
    expect(offered.sort(), "the agent catalogue is not its ceiling intersected with the machine-useful set")
      .toEqual(["getMessages", "getMessagesByReceiptIdBody"]);

    // The control: a session is offered more than that, so the intersection is doing something.
    expect(
      tools({ kind: "session" }).length,
      "a session is offered no more than a two-route agent, so the split is not splitting",
    ).toBeGreaterThan(offered.length);
  });
});
