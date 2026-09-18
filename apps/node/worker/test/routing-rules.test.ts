import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginAuthorization, completeAuthorization, registerClient,
} from "../src/provider/cloudflare-grant.ts";
import { putBackRule, routingRulesFor, takeOverRule } from "../src/provider/routing-rules.ts";

/**
 * Taking over a routing rule that already points somewhere, and putting it back (#258).
 *
 * The measured facts these rest on (`docs/receipts/email-routing-rule-takeover.md`): a rule holds one
 * action, a `PUT` needs the whole rule, and the catch-all is listed among the rules as a `type: all` matcher.
 */

const testEnv = env as unknown as Env;
const ORG = "org_rules";
const ADMIN = "usr_rules_admin";
const MAILBOX = "mbx_rules_one";
const AT = Date.parse("2026-09-19T10:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM provider_authorizations"),
    testEnv.CATALOG.prepare("DELETE FROM provider_binding"),
    testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
    testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM mailboxes WHERE org_id = ?").bind(ORG),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(AT).toISOString()).run();
  await testEnv.CATALOG.prepare(
    "INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)",
  ).bind(MAILBOX, ORG, "Enquiries", new Date(AT).toISOString()).run();

  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    access_token: "an-access", refresh_token: "a-refresh", expires_in: 3600, scope: "a",
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await registerClient(testEnv, atTime(AT), ORG, ADMIN, {
    clientId: "a-client", clientSecret: "a-secret",
    redirectUri: "https://node.example.test/oauth/cloudflare/callback",
  });
  const { state } = await beginAuthorization(testEnv, atTime(AT + 1000), ADMIN, ["a"]);
  await completeAuthorization(testEnv, atTime(AT + 2000), ORG, {
    state, code: "the-code", error: null, errorDescription: null,
  });
  await testEnv.CATALOG.prepare("UPDATE provider_binding SET account_id = ? WHERE id = 1")
    .bind("acc_rules").run();
  vi.restoreAllMocks();
});

afterEach(() => vi.restoreAllMocks());

const FORWARD = {
  id: "rule_hello", name: "hello to gmail", enabled: true,
  matchers: [{ type: "literal", field: "to", value: "Hello@example.test" }],
  actions: [{ type: "forward", value: ["somebody@gmail.test"] }],
};
const CATCH_ALL = {
  id: "rule_all", name: "", enabled: true, matchers: [{ type: "all" }],
  actions: [{ type: "forward", value: ["ops@gmail.test"] }],
};

/** Cloudflare's rules API, holding the rules in memory so a PUT is visible to the next GET. */
function serving(initial: Array<Record<string, unknown>>) {
  const rules = initial.map((one) => ({ ...one }));
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
    const method = init?.method ?? "GET";
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    if (path.startsWith("/zones?name=example.test")) return ok([{ id: "zone_1", name: "example.test" }]);
    if (path.startsWith("/zones?name=")) return ok([]);
    const one = /\/email\/routing\/rules\/([^?]+)$/.exec(path);
    if (one !== null) {
      const at = rules.findIndex((r) => r.id === one[1]);
      if (at < 0) return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "no" }] }), { status: 404 });
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        puts.push(body);
        rules[at] = { ...rules[at], ...body };
      }
      return ok(rules[at]);
    }
    if (path.includes("/email/routing/rules")) return ok(rules);
    return ok(null);
  });
  return { rules, puts };
}

describe("listing a zone's routing rules", () => {
  it("names the catch-all and which rule already points here", async () => {
    serving([FORWARD, CATCH_ALL, {
      id: "rule_ours", name: "mailda", enabled: true,
      matchers: [{ type: "literal", field: "to", value: "in@example.test" }],
      actions: [{ type: "worker", value: ["mailda-test"] }],
    }]);
    const listing = await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test");
    expect(listing.error).toBeNull();
    expect(listing.rules.map((r) => [r.to, r.action, r.catchAll, r.ours])).toEqual([
      ["hello@example.test", "forward", false, false],
      ["*", "forward", true, false],
      ["in@example.test", "worker", false, true],
    ]);
    expect(listing.rules.every((r) => r.digest.length === 64)).toBe(true);
  });
});

describe("taking a rule over", () => {
  it("registers the address, records the previous action, and PUTs the whole rule", async () => {
    const { puts } = serving([FORWARD]);
    const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules[0]!;
    const outcome = await takeOverRule(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listed.digest, null,
    );
    expect(outcome.before).toEqual({ action: "forward", destinations: ["somebody@gmail.test"] });
    expect(outcome.after).toEqual({ action: "worker", destinations: ["mailda-test"] });
    // The whole rule, because a partial PUT is refused (`2007 matchers: must have matchers`).
    expect(puts).toEqual([{
      name: "hello to gmail", enabled: true, matchers: FORWARD.matchers,
      actions: [{ type: "worker", value: ["mailda-test"] }],
    }]);
    const address = await testEnv.CATALOG.prepare(
      "SELECT mailbox_id FROM addresses WHERE org_id = ? AND address = ?",
    ).bind(ORG, "hello@example.test").first<{ mailbox_id: string }>();
    expect(address?.mailbox_id).toBe(MAILBOX);
    const entry = await testEnv.CATALOG.prepare(
      "SELECT detail FROM audit_entries WHERE org_id = ? AND action = 'provider.routing_rule_taken_over'",
    ).bind(ORG).first<{ detail: string }>();
    expect(JSON.parse(entry!.detail).before).toEqual(outcome.before);
  });

  it("refuses a stale digest, the catch-all, and a rule already here", async () => {
    serving([FORWARD, CATCH_ALL]);
    const listing = await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test");
    await expect(takeOverRule(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", "0".repeat(64), null,
    )).rejects.toThrow(/E_ROUTING_RULE_STALE/);
    await expect(takeOverRule(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_all", listing.rules[1]!.digest, null,
    )).rejects.toThrow(/E_ROUTING_RULE_NOT_AN_ADDRESS/);
    await takeOverRule(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listing.rules[0]!.digest, null,
    );
    const again = await routingRulesFor(testEnv, atTime(AT + 5000), ORG, "example.test");
    await expect(takeOverRule(
      testEnv, atTime(AT + 6000), ORG, ADMIN, "example.test", "rule_hello", again.rules[0]!.digest, null,
    )).rejects.toThrow(/E_ROUTING_RULE_ALREADY_OURS/);
  });
});

describe("putting a rule back", () => {
  it("restores what the take-over recorded, and refuses a rule this Node never took", async () => {
    const { puts, rules } = serving([FORWARD]);
    await expect(putBackRule(testEnv, atTime(AT + 3000), ORG, ADMIN, "example.test", "rule_hello"))
      .rejects.toThrow(/E_ROUTING_RULE_NEVER_TAKEN/);
    const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules[0]!;
    await takeOverRule(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listed.digest, null,
    );
    const back = await putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello");
    expect(back.after).toEqual({ action: "forward", destinations: ["somebody@gmail.test"] });
    expect(puts[1]).toMatchObject({ actions: [{ type: "forward", value: ["somebody@gmail.test"] }] });
    expect(rules[0]!.actions).toEqual([{ type: "forward", value: ["somebody@gmail.test"] }]);
  });

  it("does not overwrite a change somebody made after the take-over", async () => {
    const { rules } = serving([FORWARD]);
    const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules[0]!;
    await takeOverRule(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listed.digest, null,
    );
    rules[0]!.actions = [{ type: "drop" }];
    await expect(putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello"))
      .rejects.toThrow(/E_ROUTING_RULE_NOT_OURS_NOW/);
  });
});
