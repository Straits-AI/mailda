import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { issueSession } from "../src/auth/session.ts";

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
  return `mailda_at=${session.accessToken}`;
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

    expect(names.length).toBeGreaterThan(40);
    // The reads and the reversible acts.
    expect(names).toContain("getMessages");
    expect(names).toContain("putDrafts");
    expect(names).toContain("postButlersByButlerIdSimulate");

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

  it("gives each tool a JSON Schema with its path parameters required", async () => {
    const answer = await rpc("tools/list") as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }> };
    };
    const simulate = answer.result.tools.find((tool) => tool.name === "postButlersByButlerIdSimulate")!;
    expect(Object.keys(simulate.inputSchema.properties)).toEqual(["butlerId", "body"]);
    expect(simulate.inputSchema.required).toEqual(["butlerId", "body"]);

    // A parameterless read takes nothing, rather than an empty object it has to be told to omit.
    const messages = answer.result.tools.find((tool) => tool.name === "getMessages")!;
    expect(messages.inputSchema.required).toEqual([]);
  });
});

describe("a tool call goes through this Node's own routes", () => {
  it("carries the caller's session, so the act is theirs", async () => {
    /*
     * The audit trail is the assertion. `postButlers` writes a `butler.drafted` entry naming an actor, and
     * that actor is the **person** whose cookie the MCP request carried — not a machine identity. An
     * MCP-specific credential would have put a machine there, and every act an agent performed would have
     * been unattributable to whoever set it going.
     */
    const held = await cookie();
    const source = JSON.stringify({
      apiVersion: "mailda/v1", kind: "Butler", metadata: { name: "via mcp", owner: "team:support" },
      capabilities: [], trigger: { event: "mail.received", mailbox: "support@example.com" },
      entry: "halt", nodes: [{ id: "halt", type: "stop", reason: "nothing yet" }],
    });

    const answer = await rpc("tools/call", {
      name: "postButlers",
      arguments: { body: { name: "via mcp", source, sourceFormat: "json" } },
    }, held) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(answer.result.isError).toBe(false);
    expect(answer.result.content[0]!.text).toContain("butlerId");

    const audited = await testEnv.CATALOG.prepare(
      "SELECT actor_user_id, action FROM audit_entries WHERE org_id = ? ORDER BY seq DESC LIMIT 1",
    ).bind(ORG).first<{ actor_user_id: string; action: string }>();
    expect(audited).toMatchObject({ actor_user_id: USER, action: "butler.drafted" });
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
      name: "postButlers",
      arguments: { body: { name: "broken", source: "{not json", sourceFormat: "json" } },
    }, held) as { result: { isError: boolean; content: Array<{ text: string }> } };

    expect(answer.result.isError).toBe(true);
    const text = answer.result.content[0]!.text;
    expect(text).toContain("E_BUTLER_SOURCE_NOT_JSON");
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
    const answer = await rpc("tools/call", {
      name: "getButlersByButlerId", arguments: {},
    }, await cookie()) as { error: { code: number; message: string } };
    expect(answer.error.code).toBe(-32602);
    expect(answer.error.message).toContain("butlerId");
  });
});
