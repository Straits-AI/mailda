import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
} from "../src/provider/cloudflare-grant.ts";
import { holdToken } from "./support/provider-token.ts";
import { BUDGETS } from "@mailda/budgets";
import { recordedInName } from "@mailda/contract/routing-rule-name";
import { putBackRule, routingRulesFor, takeOverRule } from "../src/provider/routing-rules.ts";
import { removeAddress } from "../src/provider/receiving.ts";

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
    testEnv.CATALOG.prepare("DELETE FROM provider_token"),
    testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
    testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM forward_destinations WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM mailboxes WHERE org_id = ?").bind(ORG),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(AT).toISOString()).run();
  await testEnv.CATALOG.prepare(
    "INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)",
  ).bind(MAILBOX, ORG, "Enquiries", new Date(AT).toISOString()).run();

  await holdToken(testEnv, "acc_rules", AT);
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

/**
 * Cloudflare's rules API, holding the rules in memory so a PUT is visible to the next GET.
 *
 * `settings` is the zone's Email Routing settings (`null` answers an error); `put` is what a PUT does: applies its
 * body, answers 200 and changes nothing, is refused, or applies its body and loses the answer.
 */
function serving(
  initial: Array<Record<string, unknown>>,
  {
    settings = { enabled: true, status: "ready", support_subaddress: false } as Record<string, unknown> | null,
    put = "apply" as "apply" | "ignore" | "refuse" | "lose" | "nameless",
    readBack = "answer" as "answer" | "lost",
    // The account's destination addresses (ADR 47), as Cloudflare lists them; null answers a refusal.
    destinations = [{ email: "somebody@gmail.test", verified: "2025-01-01T00:00:00Z" }] as Array<{ email: string; verified: string | null }> | null,
    // Each Worker's source, as `/workers/scripts/{name}/content/v2` answers it; a Worker not named here is refused.
    scripts = {} as Record<string, string>,
  } = {},
) {
  const rules = initial.map((one) => ({ ...one }));
  const puts: unknown[] = [];
  const refused = (code: number, message: string) =>
    new Response(JSON.stringify({ success: false, errors: [{ code, message }] }), { status: 400 });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
    const method = init?.method ?? "GET";
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    if (path.startsWith("/zones?name=example.test")) return ok([{ id: "zone_1", name: "example.test" }]);
    if (path.includes("/email/routing/addresses")) return destinations === null ? refused(10000, "Authentication error") : ok(destinations);
    const script = /^\/accounts\/acc_rules\/workers\/scripts\/([^/]+)\/content\/v2$/.exec(path);
    if (script !== null) return Object.hasOwn(scripts, script[1]!) ? new Response(scripts[script[1]!]) : refused(10000, "Authentication error");
    if (path.startsWith("/zones?name=")) return ok([]);
    if (path === "/zones/zone_1/email/routing") return settings === null ? refused(10000, "Authentication error") : ok(settings);
    const one = /\/email\/routing\/rules\/([^?]+)$/.exec(path);
    if (one !== null) {
      // The rule read back after a PUT, when the connection that lost the PUT's answer is still down.
      if (readBack === "lost" && method === "GET" && puts.length > 0) throw new TypeError("network connection lost again");
      const at = rules.findIndex((r) => r.id === one[1]);
      if (at < 0) return new Response(JSON.stringify({ success: false, errors: [{ code: 1, message: "no" }] }), { status: 404 });
      if (method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        puts.push(body);
        if (put === "refuse") return refused(2020, "destination address not verified");
        if (put === "apply" || put === "lose") rules[at] = { ...rules[at], ...body };
        // Applied, except the name, which stays as it was: what a name Cloudflare truncated or ignored would read as.
        if (put === "nameless") rules[at] = { ...rules[at], ...body, name: rules[at]!.name };
        // Applied, and the answer never arrives: what `cloudflareWrite` reports as refused.
        if (put === "lose") throw new TypeError("network connection lost");
      }
      return ok(rules[at]);
    }
    if (path.includes("/email/routing/rules")) return ok(rules);
    return ok(null);
  });
  return { rules, puts };
}

/** The entries of one action, oldest first. */
async function entries(action: string) {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT outcome, subject, detail FROM audit_entries WHERE org_id = ? AND action = ? ORDER BY seq",
  ).bind(ORG, action).all<{ outcome: string; subject: string; detail: string }>();
  return results.map((one) => ({ ...one, detail: JSON.parse(one.detail) as Record<string, unknown> }));
}

/**
 * Lists the rules and takes `ruleId` over with the digest shown, as the Setup button does, into the one mailbox
 * unless told otherwise: a forward rule is refused without one (`E_ROUTING_FORWARD_NEEDS_MAILBOX`).
 */
async function takeOver(ruleId: string, mailboxId: string | null = MAILBOX, forward?: "keep" | "stop" | null) {
  const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules.find((r) => r.id === ruleId)!;
  // A forward rule names its choice (ADR 47); these tests are about the take-over itself, so it stops, as before ADR 47.
  const choice = forward !== undefined ? forward : listed.action === "forward" ? "stop" : null;
  return await takeOverRule(testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", ruleId, listed.digest, mailboxId, choice);
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

  it("offers on each rule what the act would do, and names the refusal where it would refuse (30 September 2026)", async () => {
    const twin = (id: string) => ({ ...FORWARD, id, name: id, matchers: [{ type: "literal", field: "to", value: "twin@example.test" }] });
    const literal = (id: string, to: string, over: Record<string, unknown>) =>
      ({ ...FORWARD, id, name: id, matchers: [{ type: "literal", field: "to", value: to }], ...over });
    serving([
      FORWARD, CATCH_ALL, twin("twin_1"), twin("twin_2"),
      literal("rule_two", "two@example.test", { actions: [{ type: "forward", value: ["a@gmail.test", "b@gmail.test"] }] }),
      literal("rule_off", "off@example.test", { enabled: false }),
      // Pointed here by the customer's own hand or written by onboarding: never taken over, so nothing to put back.
      literal("rule_own", "own@example.test", { actions: [{ type: "worker", value: ["mailda-test"] }] }),
    ]);
    await takeOver("rule_hello");
    const listing = await routingRulesFor(testEnv, atTime(AT + 5000), ORG, "example.test");
    expect(Object.fromEntries(listing.rules.map((r) => [r.id, [r.offer, r.refusal?.code ?? null]]))).toEqual({
      rule_hello: ["put_back", null],
      rule_all: [null, "E_ROUTING_RULE_NOT_AN_ADDRESS"],
      twin_1: [null, "E_ROUTING_RULE_DUPLICATE"],
      twin_2: [null, "E_ROUTING_RULE_DUPLICATE"],
      rule_two: [null, "E_ROUTING_RULE_MANY_DESTINATIONS"],
      rule_off: [null, "E_ROUTING_RULE_DISABLED"],
      rule_own: [null, "E_ROUTING_RULE_NEVER_TAKEN"],
    });
  });

  it("offers a take-over of a plain forward, and the act agrees", async () => {
    serving([FORWARD]);
    const [listed] = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules;
    expect([listed!.offer, listed!.refusal]).toEqual(["take_over", null]);
    await expect(takeOver("rule_hello")).resolves.toMatchObject({ to: "hello@example.test" });
  });
});

describe("taking a rule over", () => {
  it("registers the address, records the previous action, and PUTs the whole rule", async () => {
    const { puts } = serving([FORWARD]);
    const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules[0]!;
    const outcome = await takeOverRule(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listed.digest, MAILBOX, "stop",
    );
    expect(outcome.before).toEqual({ action: "forward", destinations: ["somebody@gmail.test"] });
    expect(outcome.after).toEqual({ action: "worker", destinations: ["mailda-test"] });
    expect(outcome.mailbox).toEqual({ id: MAILBOX, name: "Enquiries" });
    // The whole rule, because a partial PUT is refused (`2007 matchers: must have matchers`), named with what it was.
    expect(puts).toEqual([{
      name: "mailda mailda-test (was forward somebody@gmail.test, repointed 2026-09-19)", enabled: true, matchers: FORWARD.matchers,
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
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listing.rules[0]!.digest, MAILBOX, "stop",
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
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listed.digest, MAILBOX, "stop",
    );
    const back = await putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello");
    expect(back.after).toEqual({ action: "forward", destinations: ["somebody@gmail.test"] });
    expect(puts[1]).toMatchObject({ actions: [{ type: "forward", value: ["somebody@gmail.test"] }] });
    expect(rules[0]!.actions).toEqual([{ type: "forward", value: ["somebody@gmail.test"] }]);
    // The customer's rule comes back enabled, as it was taken: a put-back that disabled it would read back as sent.
    expect(rules[0]!.enabled).toBe(true);
  });

  it("does not overwrite a change somebody made after the take-over", async () => {
    const { rules } = serving([FORWARD]);
    const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules[0]!;
    await takeOverRule(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listed.digest, MAILBOX, "stop",
    );
    rules[0]!.actions = [{ type: "drop" }];
    await expect(putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello"))
      .rejects.toThrow(/E_ROUTING_RULE_NOT_OURS_NOW/);
  });
});

describe("a take-over that would route nothing, or not what it says, is refused by name (30 September 2026)", () => {
  it("refuses a disabled rule, which Cloudflare does not apply, and writes nothing", async () => {
    const { puts } = serving([{ ...FORWARD, enabled: false }]);
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_RULE_DISABLED[\s\S]*enable it in the Cloudflare dashboard/);
    expect(puts).toEqual([]);
    expect(await entries("provider.routing_rule_taken_over")).toEqual([]);
    expect(await testEnv.CATALOG.prepare("SELECT 1 FROM addresses WHERE org_id = ?").bind(ORG).first()).toBeNull();
  });

  it("says a disabled rule already naming this Node is to be enabled, not that there is nothing to take over", async () => {
    serving([{ ...FORWARD, enabled: false, actions: [{ type: "worker", value: ["mailda-test"] }] }]);
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_RULE_DISABLED[\s\S]*already names this Node/);
  });

  it("refuses a rule with more than one destination rather than keep only the first", async () => {
    const { puts } = serving([{ ...FORWARD, actions: [{ type: "forward", value: ["a@gmail.test", "b@gmail.test"] }] }]);
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_RULE_MANY_DESTINATIONS[\s\S]*a@gmail.test, b@gmail.test/);
    expect(puts).toEqual([]);
  });

  it("refuses either of two rules for one address, since the API does not say which one Cloudflare applies", async () => {
    const twin = { ...FORWARD, id: "rule_hello_2", name: "hello twin", matchers: [{ type: "literal", field: "to", value: "hello@example.test" }] };
    const { puts } = serving([FORWARD, twin]);
    await expect(takeOver("rule_hello_2")).rejects.toThrow(/E_ROUTING_RULE_DUPLICATE[\s\S]*rule_hello_2[\s\S]*rule_hello /);
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_RULE_DUPLICATE/);
    expect(puts).toEqual([]);
  });

  it("refuses on a zone with subaddressing on, where hello+tag@ would reach this Node and bounce", async () => {
    const { puts } = serving([FORWARD], { settings: { enabled: true, status: "ready", support_subaddress: true } });
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_SUBADDRESS_UNSERVED[\s\S]*hello\+anything@example.test/);
    expect(puts).toEqual([]);
  });

  it("refuses when the zone's settings cannot be read, since subaddressing decides whether mail bounces", async () => {
    const { puts } = serving([FORWARD], { settings: null });
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_SETTINGS_UNREADABLE[\s\S]*Authentication error/);
    expect(puts).toEqual([]);
  });
});

describe("the address a take-over registers files where its row says (30 September 2026)", () => {
  const OTHER = "mbx_rules_two";
  beforeEach(async () => {
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(OTHER, ORG, "Wei Meng", new Date(AT).toISOString()),
      testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
        .bind("addr_hello_before", ORG, "hello@example.test", OTHER, new Date(AT).toISOString()),
    ]);
  });

  it("uses and names the mailbox of a row already there, and records that one, with no mailbox chosen among two", async () => {
    serving([FORWARD]);
    // No mailbox, and a forward rule: the row decides, so `E_ROUTING_FORWARD_NEEDS_MAILBOX` does not apply.
    const outcome = await takeOver("rule_hello", null);
    expect(outcome.mailbox).toEqual({ id: OTHER, name: "Wei Meng" });
    const [entry] = await entries("provider.routing_rule_taken_over");
    expect(entry!.detail).toMatchObject({ mailboxId: OTHER, addressExisted: true });
    const rows = await testEnv.CATALOG.prepare("SELECT mailbox_id FROM addresses WHERE org_id = ?").bind(ORG).all<{ mailbox_id: string }>();
    expect(rows.results).toEqual([{ mailbox_id: OTHER }]);
  });

  it("refuses a different mailbox by name rather than record one the address does not file into", async () => {
    const { puts } = serving([FORWARD]);
    await expect(takeOver("rule_hello", MAILBOX)).rejects.toThrow(/E_ROUTING_ADDRESS_FILES_ELSEWHERE[\s\S]*"Wei Meng"/);
    expect(puts).toEqual([]);
    expect(await entries("provider.routing_rule_taken_over")).toEqual([]);
  });
});

describe("what a take-over or put-back's PUT did is recorded after it, read back (30 September 2026)", () => {
  it("records ok with the rule as read back, beside the intent", async () => {
    serving([FORWARD]);
    await takeOver("rule_hello");
    const [back] = await entries("provider.routing_rule_read_back");
    expect(back).toMatchObject({ outcome: "ok", subject: "rule_hello" });
    expect(back!.detail).toMatchObject({
      act: "take_over", readBack: { action: "worker", destinations: ["mailda-test"], enabled: true }, putError: null, readBackError: null,
    });
  });

  it("records refused and re-raises when Cloudflare refuses the PUT", async () => {
    serving([FORWARD], { put: "refuse" });
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_CLOUDFLARE_REFUSED/);
    const [back] = await entries("provider.routing_rule_read_back");
    expect(back).toMatchObject({ outcome: "refused", subject: "rule_hello" });
    expect(back!.detail.putError).toContain("destination address not verified");
    // What Cloudflare holds after the refusal, read rather than assumed.
    expect(back!.detail.readBack).toEqual({ action: "forward", destinations: ["somebody@gmail.test"], enabled: true });
  });

  it("records ok and succeeds when the PUT's answer is lost but the rule reads back as sent", async () => {
    serving([FORWARD], { put: "lose" });
    const outcome = await takeOver("rule_hello");
    expect(outcome.after).toEqual({ action: "worker", destinations: ["mailda-test"] });
    const [back] = await entries("provider.routing_rule_read_back");
    expect(back).toMatchObject({ outcome: "ok" });
    expect(back!.detail.putError).toContain("E_CLOUDFLARE_REFUSED");
  });

  it("records failed and says the change may be applied when the PUT's answer is lost and the rule cannot be read back", async () => {
    const { rules } = serving([FORWARD], { put: "lose", readBack: "lost" });
    // Both errors in the reason: the PUT's lost answer and the failed read-back.
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_RULE_NOT_CONFIRMED[\s\S]*may have applied[\s\S]*why +the PUT: [\s\S]*; the read-back: /);
    // Cloudflare did apply it: "refused" would have been false.
    expect(rules[0]!.actions).toEqual([{ type: "worker", value: ["mailda-test"] }]);
    const [back] = await entries("provider.routing_rule_read_back");
    expect(back).toMatchObject({ outcome: "failed" });
    expect(back!.detail).toMatchObject({ readBack: null, readBackError: expect.stringContaining("could not be reached") });
    expect(back!.detail.putError).toContain("E_CLOUDFLARE_REFUSED");
  });

  it("records failed when the PUT answers 200 and the rule cannot be read back, without claiming either way", async () => {
    serving([FORWARD], { readBack: "lost" });
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_RULE_NOT_CONFIRMED[\s\S]*could not be read back[\s\S]*why +the read-back failed: /);
    const [back] = await entries("provider.routing_rule_read_back");
    expect(back).toMatchObject({ outcome: "failed" });
    expect(back!.detail).toMatchObject({ readBack: null, putError: null, readBackError: expect.stringContaining("could not be reached") });
  });

  it("records failed and refuses by name when the PUT answers 200 and the rule reads back unchanged", async () => {
    serving([FORWARD], { put: "ignore" });
    await expect(takeOver("rule_hello")).rejects.toThrow(/E_ROUTING_RULE_NOT_CONFIRMED[\s\S]*reads back as forward → somebody@gmail.test/);
    const [back] = await entries("provider.routing_rule_read_back");
    expect(back).toMatchObject({ outcome: "failed" });
    expect(back!.detail.readBack).toEqual({ action: "forward", destinations: ["somebody@gmail.test"], enabled: true });
  });

  it("does the same for a put-back, whose PUT used to be trusted", async () => {
    const { rules } = serving([FORWARD]);
    await takeOver("rule_hello");
    // Cloudflare answers the put-back 200 and keeps the rule pointing here.
    const kept = structuredClone(rules[0]!);
    vi.stubGlobal("fetch", ((base) => async (url: string, init?: RequestInit) => {
      const answer = await base(url, init);
      if ((init?.method ?? "GET") === "PUT") rules[0] = structuredClone(kept);
      return answer;
    })(globalThis.fetch));
    await expect(putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello"))
      .rejects.toThrow(/E_ROUTING_RULE_NOT_CONFIRMED/);
    const backs = await entries("provider.routing_rule_read_back");
    expect(backs.map((one) => [one.detail.act, one.outcome])).toEqual([["take_over", "ok"], ["put_back", "failed"]]);
  });
});

/**
 * The routing step (1 October 2026): the listing says, per rule, what taking it over changes, in the words every
 * channel prints, and refuses what the act would refuse, the zone's subaddressing included.
 */
describe("what the listing offers, per kind of rule", () => {
  const literal = (id: string, to: string, actions: unknown[]) =>
    ({ id, name: id, enabled: true, matchers: [{ type: "literal", field: "to", value: to }], actions });

  it("says what each kind stops, asks a mailbox only for a forward, and refuses an action it does not know", async () => {
    serving([
      FORWARD,
      literal("rule_sales", "sales@example.test", [{ type: "worker", value: ["info-worker"] }]),
      literal("rule_junk", "junk@example.test", [{ type: "drop" }]),
      literal("rule_odd", "odd@example.test", [{ type: "teleport", value: ["x"] }]),
    ]);
    const { rules } = await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test");
    const by = Object.fromEntries(rules.map((r) => [r.id, r]));
    expect(by.rule_hello!.takeOver).toEqual({
      label: "receive here only",
      says: "somebody@gmail.test gets nothing more for hello@example.test: it is stored here instead, and replies sent from somebody@gmail.test are not seen here",
      filesInto: null, asksMailbox: true,
      // The third choice on a forward (ADR 47), naming the three costs it accepts.
      keep: {
        label: "receive here and keep forwarding to somebody@gmail.test",
        says: expect.stringMatching(/^hello@example.test is stored here first, then this Node forwards each message to somebody@gmail.test, as the rule did\. The copy leaves before this Node scans the message; a forward that fails is shown on People and is not told to the sender; and Cloudflare reports no delivery/),
        // The fourth (ADR 47 amended): keep with copies, stating what a copy is and its limit, by the budget's name.
        copy: {
          label: "receive here, keep forwarding to somebody@gmail.test, and send a copy when that forward is refused as not verified",
          says: expect.stringContaining(`Up to ${BUDGETS["email.outbound.max_bytes"]} bytes (email.outbound.max_bytes)`),
        },
      },
      // A forward rule keeps its own destination; forwarding to addresses chosen is a Worker rule's choice.
      forwardTo: null,
    });
    expect(by.rule_hello!.takeOver!.keep!.copy.says).toContain('a copy is sent from hello@example.test: the recipient sees it from "<sender> via <mailbox>", and replies go to the sender');
    expect(by.rule_sales!.takeOver!.keep).toBeNull();
    expect(by.rule_junk!.takeOver!.forwardTo).toBeNull();
    expect(by.rule_junk!.takeOver!.keep).toBeNull();
    expect(by.rule_sales!.takeOver).toMatchObject({
      label: "receive here", filesInto: null, asksMailbox: false,
      says: expect.stringMatching(/^info-worker stops receiving mail for sales@example.test, and this Node cannot see what info-worker did with it/),
    });
    expect(by.rule_junk!.takeOver).toMatchObject({ label: "receive here", says: "mail Cloudflare was discarding for junk@example.test is kept from now on", asksMailbox: false });
    expect([by.rule_odd!.offer, by.rule_odd!.refusal?.code, by.rule_odd!.takeOver]).toEqual([null, "E_ROUTING_RULE_ACTION_UNKNOWN", null]);
  });

  it("names the mailbox an address already files into, and then asks none even for a forward", async () => {
    await testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
      .bind("addr_hello_row", ORG, "hello@example.test", MAILBOX, new Date(AT).toISOString()).run();
    serving([FORWARD]);
    const [rule] = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules;
    expect(rule!.takeOver).toMatchObject({ filesInto: { id: MAILBOX, name: "Enquiries" }, asksMailbox: false });
  });

  it("offers nothing on a zone with subaddressing on, or whose settings cannot be read, as the act refuses", async () => {
    serving([FORWARD], { settings: { enabled: true, status: "ready", support_subaddress: true } });
    const [on] = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules;
    expect([on!.offer, on!.refusal?.code, on!.takeOver]).toEqual([null, "E_ROUTING_SUBADDRESS_UNSERVED", null]);
    serving([FORWARD], { settings: null });
    const [unread] = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules;
    expect([unread!.offer, unread!.refusal?.code]).toEqual([null, "E_ROUTING_SETTINGS_UNREADABLE"]);
  });
});

describe("a forward rule files only into a mailbox chosen for it (critic M4, 1 October 2026)", () => {
  it("refuses a forward with no mailbox and no address row, even with one mailbox, and writes nothing", async () => {
    const { puts } = serving([FORWARD]);
    await expect(takeOver("rule_hello", null)).rejects.toThrow(/E_ROUTING_FORWARD_NEEDS_MAILBOX[\s\S]*somebody@gmail.test/);
    expect(puts).toEqual([]);
    expect(await entries("provider.routing_rule_taken_over")).toEqual([]);
    expect(await testEnv.CATALOG.prepare("SELECT 1 FROM addresses WHERE org_id = ?").bind(ORG).first()).toBeNull();
  });

  it("takes a Worker rule over into the only mailbox without asking, as before", async () => {
    serving([{ ...FORWARD, actions: [{ type: "worker", value: ["info-worker"] }] }]);
    await expect(takeOver("rule_hello", null)).resolves.toMatchObject({ mailbox: { id: MAILBOX } });
  });
});

describe("the take-over is recorded in the rule's own name (critic H1, 1 October 2026)", () => {
  it("writes what the rule did into its name, which reads back as the action a put-back restores", async () => {
    const { rules } = serving([FORWARD]);
    const outcome = await takeOver("rule_hello");
    expect(recordedInName(String(rules[0]!.name))).toEqual({ ...outcome.before, worker: "mailda-test", at: "2026-09-19" });
    const [entry] = await entries("provider.routing_rule_taken_over");
    expect(entry!.detail).toMatchObject({ name: "hello to gmail", nameWritten: rules[0]!.name });
  });

  it("puts the rule's own name back with its action", async () => {
    const { rules } = serving([FORWARD]);
    await takeOver("rule_hello");
    await putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello");
    expect([rules[0]!.name, rules[0]!.actions]).toEqual(["hello to gmail", FORWARD.actions]);
  });

  it("says whether the name reads back as written, since `--without-node` restores from nothing else", async () => {
    serving([FORWARD]);
    expect((await takeOver("rule_hello")).nameRecorded).toBe(true);
    await testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG).run();
    serving([FORWARD], { put: "nameless" });
    const outcome = await takeOver("rule_hello");
    expect([outcome.after.action, outcome.nameRecorded]).toEqual(["worker", false]);
  });

  it("keeps an earlier take-over's record when taking over a rule another Mailda Worker took (review, 1 October 2026)", async () => {
    // Node A (Worker `mailda-a`) took hello@ over from a forward, and was deleted without a put-back.
    const earlier = { ...FORWARD, name: "mailda mailda-a (was forward somebody@gmail.test, repointed 2026-09-01)", actions: [{ type: "worker", value: ["mailda-a"] }] };
    const { rules } = serving([earlier]);
    const [listed] = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules;
    expect(listed!.takeOver!.says).toMatch(/its name records that it was forward somebody@gmail.test, and that record is kept$/);
    const outcome = await takeOver("rule_hello");
    // The audit entry restores what this Node replaced; the name keeps what the address did before any Node.
    expect(outcome.before).toEqual({ action: "worker", destinations: ["mailda-a"] });
    expect(recordedInName(String(rules[0]!.name))).toEqual({ action: "forward", destinations: ["somebody@gmail.test"], worker: "mailda-test", at: "2026-09-19" });
    // And this Node's put-back restores the rule exactly as it found it, name and all.
    await putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello");
    expect([rules[0]!.name, rules[0]!.actions]).toEqual([earlier.name, earlier.actions]);
  });

  it("offers and makes the put-back from the name when this Node's audit entry is gone", async () => {
    const { rules } = serving([FORWARD]);
    await takeOver("rule_hello");
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();
    const [listed] = (await routingRulesFor(testEnv, atTime(AT + 5000), ORG, "example.test")).rules;
    expect([listed!.offer, listed!.refusal]).toEqual(["put_back", null]);
    const back = await putBackRule(testEnv, atTime(AT + 6000), ORG, ADMIN, "example.test", "rule_hello");
    expect(back.after).toEqual({ action: "forward", destinations: ["somebody@gmail.test"] });
    // The name it had before is only on the audit trail that is gone, so the record is cleared rather than left.
    expect([rules[0]!.name, rules[0]!.actions]).toEqual(["", FORWARD.actions]);
    const [entry] = await entries("provider.routing_rule_put_back");
    expect(entry!.detail).toMatchObject({ restoredFrom: "name" });
  });

  it("keeps a name somebody gave the rule since, rather than restore the one it had", async () => {
    const { rules } = serving([FORWARD]);
    await takeOver("rule_hello");
    rules[0]!.name = "renamed in the dashboard";
    await putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello");
    expect([rules[0]!.name, rules[0]!.actions]).toEqual(["renamed in the dashboard", FORWARD.actions]);
  });
});

describe("a forward rule's third choice: receive here and keep forwarding (ADR 47)", () => {
  const kept = async () => await testEnv.CATALOG.prepare(
    `SELECT f.destination AS too, f.verified FROM addresses a
       LEFT JOIN forward_destinations f ON f.org_id = a.org_id AND f.address = a.address WHERE a.org_id = ? AND a.address = ?`,
  ).bind(ORG, "hello@example.test").first<{ too: string | null; verified: string | null }>();

  it("refuses a forward rule taken over with no choice made, and writes nothing", async () => {
    const { puts } = serving([FORWARD]);
    await expect(takeOver("rule_hello", MAILBOX, null)).rejects.toThrow(/E_ROUTING_FORWARD_NEEDS_CHOICE[\s\S]*somebody@gmail.test/);
    expect(puts).toEqual([]);
    expect(await kept()).toBeNull();
  });

  it("refuses a choice on a rule that is not a forward", async () => {
    serving([{ ...FORWARD, actions: [{ type: "worker", value: ["info-worker"] }] }]);
    await expect(takeOver("rule_hello", MAILBOX, "keep")).rejects.toThrow(/E_ROUTING_FORWARD_NOT_A_FORWARD/);
  });

  it("keeps the rule's own destination on the address, read verified, and says so on the outcome and the entry", async () => {
    serving([FORWARD], { destinations: [{ email: "Somebody@Gmail.test", verified: "2025-01-01T00:00:00Z" }] });
    const outcome = await takeOver("rule_hello", MAILBOX, "keep");
    expect(outcome.keptForward).toBe("somebody@gmail.test");
    expect(await kept()).toEqual({ too: "somebody@gmail.test", verified: "verified" });
    const [entry] = await entries("provider.routing_rule_taken_over");
    expect(entry!.detail).toMatchObject({ forward: "keep", keptForwardVerified: "verified" });
  });

  it("keeps nothing when the choice is stop", async () => {
    serving([FORWARD]);
    expect((await takeOver("rule_hello", MAILBOX, "stop")).keptForward).toBeNull();
    expect(await kept()).toEqual({ too: null, verified: null });
  });

  it("refuses to keep a forward to a destination the account lists unverified or not at all, and writes nothing", async () => {
    const { puts } = serving([FORWARD], { destinations: [{ email: "somebody@gmail.test", verified: null }] });
    await expect(takeOver("rule_hello", MAILBOX, "keep")).rejects.toThrow(/E_FORWARD_DESTINATION_NOT_VERIFIED[\s\S]*registered but not yet verified/);
    serving([FORWARD], { destinations: [] });
    await expect(takeOver("rule_hello", MAILBOX, "keep")).rejects.toThrow(/E_FORWARD_DESTINATION_NOT_VERIFIED[\s\S]*mailda provider --add-destination somebody@gmail.test/);
    expect(puts).toEqual([]);
    expect(await kept()).toBeNull();
  });

  it("keeps it as not checked when the list cannot be read: the first forward is then the check", async () => {
    serving([FORWARD], { destinations: null });
    expect((await takeOver("rule_hello", MAILBOX, "keep")).keptForward).toBe("somebody@gmail.test");
    expect(await kept()).toEqual({ too: "somebody@gmail.test", verified: null });
  });

  it("drops the kept forward when Cloudflare refuses the PUT, so the address is neither stuck nor forwarding", async () => {
    serving([FORWARD], { put: "refuse" });
    await expect(takeOver("rule_hello", MAILBOX, "keep")).rejects.toThrow();
    expect(await kept()).toEqual({ too: null, verified: null });
  });

  it("keeps it when the outcome of the PUT is unknown, since the rule may route here now", async () => {
    serving([FORWARD], { put: "lose", readBack: "lost" });
    await expect(takeOver("rule_hello", MAILBOX, "keep")).rejects.toThrow(/E_ROUTING_RULE_NOT_CONFIRMED/);
    expect((await kept())?.too).toBe("somebody@gmail.test");
  });

  it("clears the kept forward with a confirmed put-back, which restores the forward in Cloudflare", async () => {
    const { rules } = serving([FORWARD]);
    await takeOver("rule_hello", MAILBOX, "keep");
    const back = await putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello");
    expect(back.keptForward).toBeNull();
    expect(rules[0]!.actions).toEqual(FORWARD.actions);
    expect(await kept()).toEqual({ too: null, verified: null });
  });

  it("keeps the forward when the put-back is refused, since mail still reaches this Node", async () => {
    serving([FORWARD]);
    await takeOver("rule_hello", MAILBOX, "keep");
    serving([{ ...FORWARD, name: "mailda mailda-test (was forward somebody@gmail.test, repointed 2026-09-19)", actions: [{ type: "worker", value: ["mailda-test"] }] }], { put: "refuse" });
    await expect(putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello")).rejects.toThrow();
    expect((await kept())?.too).toBe("somebody@gmail.test");
  });

  it("stops keeping the forward when the rule was re-pointed by hand, so the address is not left stuck", async () => {
    const { rules } = serving([FORWARD]);
    await takeOver("rule_hello", MAILBOX, "keep");
    rules[0]!.actions = FORWARD.actions;
    await expect(putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello"))
      .rejects.toThrow(/E_ROUTING_RULE_NOT_OURS_NOW[\s\S]*stopped forwarding hello@example.test/);
    expect(await kept()).toEqual({ too: null, verified: null });
  });

  it("refuses to remove an address that keeps a forward, naming the put-back", async () => {
    serving([FORWARD]);
    await takeOver("rule_hello", MAILBOX, "keep");
    await expect(removeAddress(testEnv, atTime(AT + 5000), ORG, ADMIN, "hello@example.test"))
      .rejects.toThrow(/E_ADDRESS_KEEPS_A_FORWARD[\s\S]*put its rule back/);
  });
});

describe("a kept forward with copies turned on at the take-over (ADR 47, amended 3 October 2026)", () => {
  const copyOf = async () => await testEnv.CATALOG.prepare(
    `SELECT f.destination AS too, a.copy_by AS by, a.copy_at AS at FROM addresses a
       LEFT JOIN forward_destinations f ON f.org_id = a.org_id AND f.address = a.address WHERE a.org_id = ? AND a.address = ?`,
  ).bind(ORG, "hello@example.test").first<{ too: string | null; by: string | null; at: string | null }>();
  const takeOverCopying = async (forward: "keep" | "stop") => {
    const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules[0]!;
    return await takeOverRule(testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listed.digest, MAILBOX, forward, true);
  };
  const mayPropose = async () => await testEnv.CATALOG.prepare(
    "INSERT OR IGNORE INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at) VALUES ('rt_copy', ?, ?, 'send.propose', 'mailbox', ?, ?)",
  ).bind(ORG, ADMIN, MAILBOX, new Date(AT).toISOString()).run();

  it("refuses copy without keep, and writes nothing", async () => {
    const { puts } = serving([FORWARD]);
    await expect(takeOverCopying("stop")).rejects.toThrow(/E_COPY_NEEDS_KEEP/);
    expect(puts).toEqual([]);
  });

  it("keeps a destination the account lists unverified, records who turned copies on, and says so", async () => {
    await mayPropose();
    serving([FORWARD], { destinations: [{ email: "somebody@gmail.test", verified: null }] });
    const outcome = await takeOverCopying("keep");
    expect(outcome).toMatchObject({ keptForward: "somebody@gmail.test", copy: true });
    expect(await copyOf()).toMatchObject({ too: "somebody@gmail.test", by: ADMIN });
    const [entry] = await entries("provider.routing_rule_taken_over");
    expect(entry!.detail).toMatchObject({ forward: "keep", copy: true });
  });

  it("refuses copies when the administrator may not send as the mailbox, and writes nothing", async () => {
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE id = 'rt_copy'").run();
    const { puts } = serving([FORWARD]);
    await expect(takeOverCopying("keep")).rejects.toThrow(/E_COPY_NEEDS_SEND_PROPOSE/);
    expect(puts).toEqual([]);
  });

  it("clears copies with the forward when the rule is put back", async () => {
    await mayPropose();
    serving([FORWARD]);
    await takeOverCopying("keep");
    await putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_hello");
    expect(await copyOf()).toMatchObject({ too: null, by: null, at: null });
  });
});

/**
 * A Worker rule's forward to addresses chosen at the take-over (ADR 47, amended 7 October 2026): offered from what the
 * Worker's code names, never applied by itself, and checked as People's setter checks them.
 */
describe("a Worker rule's choice: receive here and forward to addresses you choose", () => {
  const WORKER = { ...FORWARD, id: "rule_sales", name: "sales", matchers: [{ type: "literal", field: "to", value: "sales@example.test" }],
    actions: [{ type: "worker", value: ["info-worker"] }] };
  const CODE = 'const recipients = ["Somebody@gmail.test", "other@gmail.test", "unlisted@gmail.test"]; // sales@example.test';
  const LISTED = [
    { email: "somebody@gmail.test", verified: "2025-01-01T00:00:00Z" },
    { email: "other@gmail.test", verified: null },
  ];
  const forwards = async () => (await testEnv.CATALOG.prepare(
    "SELECT destination, verified FROM forward_destinations WHERE org_id = ? AND address = ? ORDER BY destination",
  ).bind(ORG, "sales@example.test").all<{ destination: string; verified: string | null }>()).results;
  const takeOverTo = async (to: string[], copy = false) => {
    const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules.find((r) => r.id === "rule_sales")!;
    return await takeOverRule(testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_sales", listed.digest, MAILBOX, null, copy, to);
  };

  it("offers the addresses the Worker's code names that the account lists, each with its state, and no other", async () => {
    serving([WORKER], { destinations: LISTED, scripts: { "info-worker": CODE } });
    const [rule] = (await routingRulesFor(testEnv, atTime(AT), ORG, "example.test")).rules;
    expect(rule!.takeOver!.forwardTo).toMatchObject({
      found: [{ to: "other@gmail.test", verified: "waiting" }, { to: "somebody@gmail.test", verified: "verified" }], foundError: null,
    });
    expect(rule!.takeOver!.forwardTo!.says).toContain(`up to ${BUDGETS["forward.max_destinations"]}`);
  });

  it("says why when the Worker's code cannot be read, naming the permission", async () => {
    serving([WORKER], { destinations: LISTED });
    const [rule] = (await routingRulesFor(testEnv, atTime(AT), ORG, "example.test")).rules;
    expect(rule!.takeOver!.forwardTo).toMatchObject({ found: null });
    expect(rule!.takeOver!.forwardTo!.foundError).toMatch(/info-worker's code could not be read \(it needs Workers Scripts Read\): 10000 Authentication error/);
  });

  it("offers it on a Worker rule only", async () => {
    serving([FORWARD], { scripts: { "info-worker": CODE } });
    expect((await routingRulesFor(testEnv, atTime(AT), ORG, "example.test")).rules[0]!.takeOver!.forwardTo).toBeNull();
  });

  it("forwards to the addresses chosen, folded, and the trail counts them without naming one", async () => {
    serving([WORKER], { destinations: LISTED });
    const outcome = await takeOverTo(["Somebody@Gmail.test", "somebody@gmail.test"]);
    expect(outcome).toMatchObject({ keptForward: null, forwards: ["somebody@gmail.test"], after: { action: "worker" } });
    expect(await forwards()).toEqual([{ destination: "somebody@gmail.test", verified: "verified" }]);
    const [entry] = await entries("provider.routing_rule_taken_over");
    expect(entry!.detail).toMatchObject({ forward: null, forwardTo: 1 });
    expect(JSON.stringify(entry!.detail)).not.toContain("somebody@gmail.test");
  });

  it("refuses addresses on a rule that is not a Worker's, and writes nothing", async () => {
    const { puts } = serving([FORWARD]);
    const listed = (await routingRulesFor(testEnv, atTime(AT + 3000), ORG, "example.test")).rules[0]!;
    await expect(takeOverRule(testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", "rule_hello", listed.digest, MAILBOX, "keep", false,
      ["somebody@gmail.test"])).rejects.toThrow(/E_ROUTING_FORWARD_TO_NOT_A_WORKER/);
    expect(puts).toEqual([]);
  });

  it("refuses one the account lists unverified, unless copies are on", async () => {
    const { puts } = serving([WORKER], { destinations: LISTED });
    await expect(takeOverTo(["somebody@gmail.test", "other@gmail.test"])).rejects.toThrow(/E_FORWARD_DESTINATION_NOT_VERIFIED[\s\S]*other@gmail.test is registered but not yet verified/);
    expect(puts).toEqual([]);
    await testEnv.CATALOG.prepare(
      "INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at) VALUES ('rt_to', ?, ?, 'send.propose', 'mailbox', ?, ?)",
    ).bind(ORG, ADMIN, MAILBOX, new Date(AT).toISOString()).run();
    expect(await takeOverTo(["somebody@gmail.test", "other@gmail.test"], true)).toMatchObject({ copy: true });
    expect(await forwards()).toEqual([
      { destination: "other@gmail.test", verified: "waiting" }, { destination: "somebody@gmail.test", verified: "verified" },
    ]);
  });

  it("refuses an address on a domain this organisation receives at", async () => {
    serving([WORKER], { destinations: LISTED });
    await expect(takeOverTo(["boss@example.test"])).rejects.toThrow(/E_FORWARD_WOULD_LOOP[\s\S]*boss@example.test is on example.test/);
  });

  it("refuses more than forward.max_destinations, naming the budget, the limit and the ask", async () => {
    serving([WORKER], { destinations: LISTED });
    const many = Array.from({ length: BUDGETS["forward.max_destinations"] + 1 }, (_, i) => `n${i}@gmail.test`);
    await expect(takeOverTo(many)).rejects.toThrow(
      `forward.max_destinations=${BUDGETS["forward.max_destinations"]}, this asked for ${BUDGETS["forward.max_destinations"] + 1}`,
    );
  });

  it("stops forwarding when the rule is put back", async () => {
    serving([WORKER], { destinations: LISTED });
    await takeOverTo(["somebody@gmail.test"]);
    await putBackRule(testEnv, atTime(AT + 5000), ORG, ADMIN, "example.test", "rule_sales");
    expect(await forwards()).toEqual([]);
  });
});

describe("setting where an address forwards (POST /api/forwards)", () => {
  const ADDRESS = "hello@example.test";
  beforeEach(async () => {
    await testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES ('addr_set', ?, ?, ?, ?)")
      .bind(ORG, ADDRESS, MAILBOX, new Date(AT).toISOString()).run();
  });
  const set = async (to: string[]) => {
    const { setForwards } = await import("../src/kept-forward.ts");
    return await setForwards(testEnv, atTime(AT), ORG, ADMIN, ADDRESS, to);
  };
  const now = async () => (await testEnv.CATALOG.prepare(
    "SELECT destination, verified FROM forward_destinations WHERE org_id = ? AND address = ? ORDER BY destination",
  ).bind(ORG, ADDRESS).all<{ destination: string; verified: string | null }>()).results;

  it("replaces the list, folded and each once, with what the account's list says of each added one", async () => {
    serving([], { destinations: [{ email: "a@gmail.test", verified: "2025-01-01T00:00:00Z" }, { email: "b@gmail.test", verified: "2025-01-01T00:00:00Z" }] });
    expect(await set(["B@gmail.test", "a@gmail.test", "b@gmail.test"])).toEqual({ address: ADDRESS, to: ["a@gmail.test", "b@gmail.test"] });
    expect(await set(["b@gmail.test"])).toEqual({ address: ADDRESS, to: ["b@gmail.test"] });
    expect(await now()).toEqual([{ destination: "b@gmail.test", verified: "verified" }]);
    const trail = await entries("forward.destinations_set");
    expect(trail.map((one) => one.detail)).toMatchObject([{ count: 2, added: 2, removed: 0 }, { count: 1, added: 0, removed: 1 }]);
    expect(JSON.stringify(trail)).not.toContain("gmail.test");
  });

  it("stops forwarding with an empty list, and turns copies off with it", async () => {
    serving([], { destinations: [{ email: "a@gmail.test", verified: "2025-01-01T00:00:00Z" }] });
    await set(["a@gmail.test"]);
    await testEnv.CATALOG.prepare("UPDATE addresses SET copy_by = ?, copy_at = ? WHERE address = ?").bind(ADMIN, new Date(AT).toISOString(), ADDRESS).run();
    expect(await set([])).toEqual({ address: ADDRESS, to: [] });
    expect(await now()).toEqual([]);
    expect(await testEnv.CATALOG.prepare("SELECT copy_by FROM addresses WHERE address = ?").bind(ADDRESS).first()).toEqual({ copy_by: null });
  });

  it("keeps a destination as not checked when the account's list cannot be read", async () => {
    serving([], { destinations: null });
    await set(["a@gmail.test"]);
    expect(await now()).toEqual([{ destination: "a@gmail.test", verified: null }]);
  });

  it("refuses one listed unverified or not at all, an address this Node does not have, and too many", async () => {
    serving([], { destinations: [{ email: "a@gmail.test", verified: null }] });
    await expect(set(["a@gmail.test"])).rejects.toThrow(/E_FORWARD_DESTINATION_NOT_VERIFIED[\s\S]*turn copies on for hello@example.test/);
    await expect(set(["z@gmail.test"])).rejects.toThrow(/E_FORWARD_DESTINATION_NOT_VERIFIED[\s\S]*not a destination address of this account/);
    await expect(set(["not an address"])).rejects.toThrow(/E_FORWARD_DESTINATION_INVALID/);
    const { setForwards } = await import("../src/kept-forward.ts");
    await expect(setForwards(testEnv, atTime(AT), ORG, ADMIN, "nobody@example.test", [])).rejects.toThrow(/E_NO_SUCH_ADDRESS/);
    await expect(set(Array.from({ length: BUDGETS["forward.max_destinations"] + 1 }, (_, i) => `n${i}@gmail.test`)))
      .rejects.toThrow(/E_BUDGET_EXCEEDED[\s\S]*forward.max_destinations/);
    expect(await now()).toEqual([]);
  });

  it("keeps a destination already there without checking it again", async () => {
    serving([], { destinations: [{ email: "a@gmail.test", verified: "2025-01-01T00:00:00Z" }] });
    await set(["a@gmail.test"]);
    serving([], { destinations: [] });
    expect(await set(["a@gmail.test"])).toEqual({ address: ADDRESS, to: ["a@gmail.test"] });
  });
});
