import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { unwrapCredential } from "../src/auth/kek.ts";
import { auditedBatch } from "../src/audit.ts";
import { accessTokenFor } from "../src/provider/cloudflare-api.ts";
import {
  cloudflareGet, deliveryEventsState, forgetToken, onboardSending, PROVIDER_NOTE, PROVIDER_STATES,
  providerStatus, REQUIRED_PERMISSIONS, registerToken, boundAccount, operatorOf, provisionedFacts,
  withOperator, sendingProposalFor, subscribeDeliveryEvents, subscriptionProposalFor, STATUS_COLUMNS,
  type ProviderState,
} from "../src/provider/cloudflare-grant.ts";
import { holdToken } from "./support/provider-token.ts";

/**
 * The Node's own Cloudflare credential (#162 L1, ADR 42 as reopened on 26 September 2026).
 *
 * ## What these tests are about, which is not "does the API call work"
 *
 * Three properties, and all three are honesty rather than mechanism:
 *
 * 1. **A state means what it says.** `token_held` is written only after Cloudflare said the token is active
 *    and named the one account it sees. A token that failed either read leaves the Node in `no_token`,
 *    because a stored token that cannot act would report a connection that every act refuses.
 * 2. **No secret leaves.** The token is wrapped under the credential key, the status is read from a column
 *    list that does not select it, and the audit entry names the account and never the token.
 * 3. **A refusal is not a connection.** An inactive token, a token seeing two accounts, a token seeing none
 *    and an unreachable API are four different refusals, and every one of them leaves the row exactly as
 *    it was.
 */

const testEnv = env as unknown as Env;

const ORG = "org_provider";
const ADMIN = "usr_provider_admin";
const SEPTEMBER_3 = Date.parse("2026-09-03T10:00:00.000Z");
const ACCOUNT = "1e0170aaabc90ecf5f466128d1f0466a";
const OTHER = "2f1281bbbcd01fdf6f577239e2f1577b";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM provider_token"),
    testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(SEPTEMBER_3).toISOString()).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A `fetch` that records what it was asked and answers what the test wants. */
function answering(status: number, body: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls };
}

/**
 * Cloudflare answering the two reads a registration makes: the token's status, and the accounts it sees.
 * Anything else is refused, so a registration that reached a third endpoint fails here.
 */
function cloudflare(
  verify: { status?: number; body: unknown },
  accounts: Array<{ id: string; name: string }>,
): Array<{ url: string; authorization: string | undefined }> {
  const calls: Array<{ url: string; authorization: string | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
    calls.push({ url: path, authorization: (init?.headers as Record<string, string> | undefined)?.authorization });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (path === "/user/tokens/verify") return json(verify.status ?? 200, verify.body);
    if (path.startsWith("/accounts?")) return json(200, { success: true, result: accounts });
    return json(404, { success: false, errors: [{ code: 7003, message: `no route for ${path}` }] });
  });
  return calls;
}

const ACTIVE = { body: { success: true, result: { id: "tok_1", status: "active" } } };

async function register(input: { token: string; accountId?: string }, at = SEPTEMBER_3) {
  return registerToken(testEnv, atTime(at), ORG, ADMIN, input);
}

async function entries(action: string) {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT subject, detail, actor_user_id FROM audit_entries WHERE org_id = ? AND action = ? ORDER BY at",
  ).bind(ORG, action).all<{ subject: string; detail: string; actor_user_id: string | null }>();
  return results;
}

describe("the two states, and what makes token_held true", () => {
  it("reports no_token before anything, without inventing an account", async () => {
    const status = await providerStatus(testEnv);
    expect(status).toEqual({
      state: "no_token", accountId: null, accountName: null, registeredAt: null, verifiedAt: null,
    });
  });

  it("registers a token Cloudflare calls active and binds it to the one account it sees", async () => {
    const calls = cloudflare(ACTIVE, [{ id: ACCOUNT, name: "Whyme Labs" }]);
    const status = await register({ token: "cf-token-plain" });
    expect(status.state).toBe("token_held");
    expect(status.accountId).toBe(ACCOUNT);
    expect(status.accountName).toBe("Whyme Labs");
    expect(status.registeredAt).toBe(new Date(SEPTEMBER_3).toISOString());
    expect(status.verifiedAt).toBe(status.registeredAt);
    // Both reads, with the token being registered and nothing else.
    expect(calls.map((one) => one.url)).toEqual(["/user/tokens/verify", "/accounts?per_page=50"]);
    expect(calls.every((one) => one.authorization === "Bearer cf-token-plain")).toBe(true);
    expect(await boundAccount(testEnv)).toBe(ACCOUNT);
  });

  it("has a closed world of states, both reachable and named", async () => {
    const reached: Record<ProviderState, true> = { no_token: true, token_held: true };
    expect(PROVIDER_STATES).toEqual(Object.keys(reached));
    expect((await providerStatus(testEnv)).state).toBe("no_token");
    cloudflare(ACTIVE, [{ id: ACCOUNT, name: "A" }]);
    expect((await register({ token: "t" })).state).toBe("token_held");
  });

  it("replaces a held token with the next one registered, and rebinds the account", async () => {
    cloudflare(ACTIVE, [{ id: ACCOUNT, name: "A" }]);
    await register({ token: "first" });
    cloudflare(ACTIVE, [{ id: OTHER, name: "B" }]);
    await register({ token: "second" }, SEPTEMBER_3 + 1000);
    const status = await providerStatus(testEnv);
    expect(status.accountId).toBe(OTHER);
    expect(status.registeredAt).toBe(new Date(SEPTEMBER_3 + 1000).toISOString());
    expect(await accessTokenFor(testEnv, atTime(SEPTEMBER_3 + 2000), ORG)).toBe("second");
    const { count } = (await testEnv.CATALOG.prepare("SELECT COUNT(*) AS count FROM provider_token").first<{ count: number }>())!;
    expect(count).toBe(1);
  });
});

describe("what never leaves", () => {
  it("stores the token wrapped and returns it from no surface", async () => {
    cloudflare(ACTIVE, [{ id: ACCOUNT, name: "A" }]);
    const status = await register({ token: "cf-token-plain" });
    expect(JSON.stringify(status)).not.toContain("cf-token-plain");

    const row = await testEnv.CATALOG.prepare("SELECT token FROM provider_token WHERE id = 1")
      .first<{ token: string }>();
    expect(row!.token).not.toBe("cf-token-plain");
    expect(row!.token.startsWith("v")).toBe(true);
    expect(await unwrapCredential(testEnv, row!.token)).toBe("cf-token-plain");
  });

  it("reads the status from a column list holding no secret", () => {
    expect(STATUS_COLUMNS.split(",").map((one) => one.trim())).not.toContain("token");
  });

  it("audits the registration with the account and never the token", async () => {
    cloudflare(ACTIVE, [{ id: ACCOUNT, name: "Whyme Labs" }]);
    await register({ token: "cf-token-plain" });
    const [entry] = await entries("provider.token_registered");
    expect(entry!.subject).toBe(ACCOUNT);
    expect(entry!.actor_user_id).toBe(ADMIN);
    expect(JSON.parse(entry!.detail)).toEqual({ accountId: ACCOUNT, accountName: "Whyme Labs" });
    expect(entry!.detail).not.toContain("cf-token-plain");
  });
});

describe("the four refusals, and none of them writes a row", () => {
  async function nothingHeld() {
    expect((await providerStatus(testEnv)).state).toBe("no_token");
    expect(await entries("provider.token_registered")).toEqual([]);
  }

  it("refuses a token Cloudflare does not call active, in Cloudflare's own word", async () => {
    cloudflare({ body: { success: true, result: { id: "tok_1", status: "expired" } } }, [{ id: ACCOUNT, name: "A" }]);
    await expect(register({ token: "t" })).rejects.toThrow(/E_PROVIDER_TOKEN_INVALID.*expired/s);
    await nothingHeld();
  });

  it("refuses a token verify rejects, carrying Cloudflare's error rather than a status code", async () => {
    cloudflare({ status: 400, body: { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] } }, []);
    await expect(register({ token: "t" })).rejects.toThrow(/E_PROVIDER_TOKEN_INVALID.*1000 Invalid API Token/s);
    await nothingHeld();
  });

  it("refuses rather than guesses between two accounts, naming them, and accepts one named back", async () => {
    cloudflare(ACTIVE, [{ id: ACCOUNT, name: "A" }, { id: OTHER, name: "B" }]);
    await expect(register({ token: "t" })).rejects.toThrow(new RegExp(`E_PROVIDER_ACCOUNT_AMBIGUOUS.*A \\(${ACCOUNT}\\).*B \\(${OTHER}\\)`, "s"));
    await nothingHeld();

    const status = await register({ token: "t", accountId: OTHER });
    expect(status.accountId).toBe(OTHER);
    expect(status.accountName).toBe("B");
  });

  it("refuses an accountId the token does not see", async () => {
    cloudflare(ACTIVE, [{ id: ACCOUNT, name: "A" }]);
    await expect(register({ token: "t", accountId: OTHER })).rejects.toThrow(/E_PROVIDER_ACCOUNT_AMBIGUOUS.*does not see/s);
    await nothingHeld();
  });

  it("refuses a token that sees no account at all", async () => {
    cloudflare(ACTIVE, []);
    await expect(register({ token: "t" })).rejects.toThrow(/E_PROVIDER_TOKEN_INVALID.*sees no account/s);
    await nothingHeld();
  });

  it("refuses when the accounts cannot be listed, and says which permission that is", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      const body = path === "/user/tokens/verify"
        ? { success: true, result: { status: "active" } }
        : { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(register({ token: "t" })).rejects.toThrow(/E_PROVIDER_TOKEN_INVALID.*9109.*Account Settings: Read/s);
    await nothingHeld();
  });

  it("refuses when Cloudflare cannot be reached, as an unknown rather than as an invalid token", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    await expect(register({ token: "t" })).rejects.toThrow(/E_PROVIDER_TOKEN_INVALID.*could not be reached/s);
    await nothingHeld();
  });

  it("leaves a held token in place when a replacement is refused", async () => {
    cloudflare(ACTIVE, [{ id: ACCOUNT, name: "A" }]);
    await register({ token: "first" });
    cloudflare({ body: { success: true, result: { status: "disabled" } } }, []);
    await expect(register({ token: "second" })).rejects.toThrow(/E_PROVIDER_TOKEN_INVALID/);
    expect(await accessTokenFor(testEnv, atTime(SEPTEMBER_3), ORG)).toBe("first");
  });
});

describe("forgetting the token", () => {
  it("deletes the row, records the act with the account, and reports no_token", async () => {
    cloudflare(ACTIVE, [{ id: ACCOUNT, name: "Whyme Labs" }]);
    await register({ token: "t" });
    const status = await forgetToken(testEnv, atTime(SEPTEMBER_3 + 1000), ORG, ADMIN);
    expect(status.state).toBe("no_token");
    expect(await boundAccount(testEnv)).toBeNull();
    const [entry] = await entries("provider.token_forgotten");
    expect(entry!.subject).toBe(ACCOUNT);
    expect(JSON.parse(entry!.detail)).toEqual({ accountId: ACCOUNT, accountName: "Whyme Labs" });
    await expect(accessTokenFor(testEnv, atTime(SEPTEMBER_3 + 2000), ORG)).rejects.toThrow(/E_PROVIDER_NO_TOKEN/);
  });

  it("refuses to forget what is not held, rather than recording an act that changed nothing", async () => {
    await expect(forgetToken(testEnv, atTime(SEPTEMBER_3), ORG, ADMIN)).rejects.toThrow(/E_PROVIDER_NO_TOKEN/);
    expect(await entries("provider.token_forgotten")).toEqual([]);
  });
});

describe("the permissions an operator ticks", () => {
  it("names each in the dashboard's form, says why, and marks exactly the registrar read optional", () => {
    for (const one of REQUIRED_PERMISSIONS) {
      expect(one.name).toMatch(/^[A-Z][A-Za-z ]+: (Read|Edit)$/);
      expect(one.why.length).toBeGreaterThan(20);
      expect(["account", "zone"]).toContain(one.scope);
    }
    expect(REQUIRED_PERMISSIONS.filter((one) => one.optional).map((one) => one.name))
      .toEqual(["Registrar Domains: Read"]);
    expect(new Set(REQUIRED_PERMISSIONS.map((one) => one.name)).size).toBe(REQUIRED_PERMISSIONS.length);
    // The admission travels with the list: verify reports no permissions, so a missing one is found late.
    expect(PROVIDER_NOTE).toContain("does not report permissions");
  });
});

describe("spending the token", () => {
  it("sends the unwrapped token as the bearer, and nothing else first", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_3, "held-token");
    const stub = answering(200, { success: true, result: [{ id: ACCOUNT, name: "One" }] });
    const answer = await cloudflareGet(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "/accounts");
    expect(answer.ok).toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url).toContain("/client/v4/accounts");
    expect((stub.calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer held-token");
  });

  it("carries Cloudflare's own error rather than a status code", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_3);
    // The shape that matters: a missing permission and a missing resource must be tellable apart.
    answering(403, { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] });
    const answer = await cloudflareGet(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "/accounts");
    expect(answer.ok).toBe(false);
    expect((answer as { error: string }).error).toContain("9109");
    expect((answer as { error: string }).error).toContain("Unauthorized");
  });
});

describe("delivery events, read through the token", () => {
  /** A token bound to `acc_1`, and one routed address. */
  async function ready(address: string) {
    await holdToken(testEnv, "acc_1", SEPTEMBER_3);
    await testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG).run();
    await testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind("addr_delivery", ORG, address, "mbx_x", new Date(SEPTEMBER_3).toISOString()).run();
  }

  /** A path this stub answers with Cloudflare's own kind of refusal rather than with a result. */
  const REFUSE = Symbol("refused");
  const ZONE = { id: "zone_1", name: "example.test" };
  const SENDING = "/zones/zone_1/email/sending/subdomains";

  /**
   * Answers each Cloudflare path from `answers`, and records what was asked.
   *
   * The zone lookup and the sending list are answered by default, because every test here is about one of
   * the four objects and would otherwise have to restate the other three.
   */
  function serving(answers: Record<string, unknown>) {
    answers = {
      "/zones?name=example.test": [ZONE],
      "/zones?name=": [],
      [SENDING]: [{
        id: "snd_1", name: "example.test", enabled: true,
        return_path_domain: "cf-bounce.example.test", dkim_selector: "cf-bounce",
      }],
      [`${SENDING}/snd_1/dns`]: [
        { type: "TXT", name: "_dmarc.example.test", content: "\"v=DMARC1; p=reject;\"" },
      ],
      ...answers,
    };
    // An explicit `undefined` removes a default, which is how a test asks for a path nobody answers.
    for (const [at, value] of Object.entries(answers)) if (value === undefined) delete answers[at];
    /*
     * `REFUSE` is not the same as removing the key: a path nested under one that *is* answered would
     * otherwise fall back to its parent's answer rather than being refused.
     */
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      asked.push(path);
      const key = Object.keys(answers).filter((one) => path.startsWith(one))
        .sort((a, b) => b.length - a.length)[0];
      return new Response(
        JSON.stringify(
          key === undefined || answers[key] === REFUSE
            ? { success: false, errors: [{ code: 7003, message: `no route for ${path}` }] }
            : { success: true, result: answers[key] },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    return asked;
  }

  const SUBSCRIPTIONS = "/accounts/acc_1/event_subscriptions/subscriptions";

  function subscription(domain: string, over: Record<string, unknown> = {}) {
    return {
      id: "sub_1", name: "mailda-sending-events", enabled: true,
      events: ["message.delivered", "message.bounced"],
      source: { type: "email.sending", domain },
      destination: { queue_id: "q_1" },
      ...over,
    };
  }

  it("names the subscription, its queue and the consumers reading it", async () => {
    await ready("inbox@mailda-test.example.test");
    serving({
      [SUBSCRIPTIONS]: [subscription("mailda-test.example.test")],
      "/accounts/acc_1/queues/q_1": {
        queue_name: "mailda-sending-events", consumers: [{ script: "mailda", type: "worker" }],
      },
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen).toEqual({
      domain: "mailda-test.example.test",
      zone: "example.test",
      /*
       * The apex is the onboarded sending domain and this Node sends from a subdomain of it, which is the
       * real shape on the live account — `whymelabs.com` is onboarded and `mailda-test.whymelabs.com` is
       * onboarded separately beside it.
       */
      sending: {
        name: "example.test", enabled: true,
        returnPath: "cf-bounce.example.test", dkimSelector: "cf-bounce",
        required: [{
          type: "TXT", name: "_dmarc.example.test", content: "\"v=DMARC1; p=reject;\"", priority: null,
        }],
        error: null,
      },
      subscription: "mailda-sending-events",
      subscriptionId: "sub_1",
      enabled: true,
      events: ["message.delivered", "message.bounced"],
      queueId: "q_1",
      queueName: "mailda-sending-events",
      consumers: ["mailda"],
      error: null,
    });
  });

  it("counts an apex sending domain as covering a subdomain sending under it", async () => {
    /*
     * The same dot-boundary rule as the subscription match, and it needs its own test because the two are
     * separate lines: Cloudflare onboards `whymelabs.com` and `mailda-test.whymelabs.com` as distinct
     * sending domains, so a Node under either has to be found under the one that is actually there.
     */
    await ready("inbox@deep.example.test");
    serving({ [SUBSCRIPTIONS]: [] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.sending?.name).toBe("example.test");
    expect(seen!.sending?.required).toHaveLength(1);
  });

  it("prefers the most specific sending domain when an apex is onboarded too", async () => {
    /*
     * **Found by a live run, not by a stub.** `whymelabs.com` and `mailda-test.whymelabs.com` are both
     * onboarded, and taking the first match reported the apex — so the records shown were the apex's, every
     * one of them correct about a domain nobody had asked about. Proposing those would have meant writing
     * into a zone carrying live mail.
     */
    await ready("inbox@deep.example.test");
    serving({
      [SENDING]: [
        { id: "snd_apex", name: "example.test", enabled: true },
        { id: "snd_deep", name: "deep.example.test", enabled: true },
      ],
      [`${SENDING}/snd_deep/dns`]: [
        { type: "TXT", name: "_dmarc.deep.example.test", content: "\"v=DMARC1; p=reject;\"" },
      ],
      [SUBSCRIPTIONS]: [],
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.sending?.name).toBe("deep.example.test");
    expect(seen!.sending?.required[0]?.name).toBe("_dmarc.deep.example.test");
  });

  it("prefers the most specific subscription when an apex one covers the domain too", async () => {
    await ready("inbox@deep.example.test");
    serving({
      [SUBSCRIPTIONS]: [
        subscription("example.test", { id: "sub_apex", name: "apex-events" }),
        subscription("deep.example.test", { id: "sub_deep", name: "deep-events" }),
      ],
      "/accounts/acc_1/queues/q_1": { queue_name: "q", consumers: [{ script: "mailda" }] },
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBe("deep-events");
  });

  it("does not count a sending domain that merely ends the same way", async () => {
    await ready("inbox@notexample.test");
    // A zone exists for it, so the walk succeeds and only the sending-list match decides.
    serving({
      "/zones?name=notexample.test": [{ id: "zone_1", name: "notexample.test" }],
      [SUBSCRIPTIONS]: [],
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.zone).toBe("notexample.test");
    expect(seen!.sending).toBeNull();
  });

  it("reports an unreadable sending list as unknown rather than as not onboarded", async () => {
    /*
     * The dangerous direction. `null` means *this domain may not send*, and an operator meeting that about a
     * working sender would re-onboard a domain that was already fine — or read the three lines below it as
     * irrelevant when they are the actual fault.
     */
    await ready("inbox@example.test");
    serving({ [SENDING]: REFUSE, [SUBSCRIPTIONS]: [] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.sending).not.toBeNull();
    expect(seen!.sending!.enabled).toBeNull();
    expect(seen!.sending!.error).toContain("7003");
  });

  it("keeps an unreadable record list apart from a sending domain that needs nothing", async () => {
    /*
     * `required: []` twice over, and only `error` says which. This is `emailRoutingFor`'s hazard on the
     * sending side: a proposal built from an unreadable list would tell an operator their DNS was complete
     * because a request failed.
     */
    await ready("inbox@example.test");
    serving({ [`${SENDING}/snd_1/dns`]: REFUSE, [SUBSCRIPTIONS]: [] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.sending!.required).toEqual([]);
    expect(seen!.sending!.error).toContain("7003");
  });

  it("never asks Cloudflare about a single label", async () => {
    /*
     * The walk stops at two labels. A single label is a public suffix rather than a zone anybody owns, so
     * `GET /zones?name=test` is a request whose every possible answer is wrong — an empty one wastes a call,
     * and a non-empty one would attach this Node's mail to somebody else's registry entry.
     */
    await ready("inbox@deep.example.test");
    const asked = serving({ "/zones?name=deep.example.test": [], [SUBSCRIPTIONS]: [] });

    await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    /*
     * `startsWith` rather than equality, because every lookup now carries `&account.id=` — the isolation
     * boundary #165 added. A test pinned to the exact URL would fail on a change that made it safer.
     */
    const lookups = asked.filter((one) => one.startsWith("/zones?name="));
    expect(lookups.some((one) => one.startsWith("/zones?name=example.test&"))).toBe(true);
    expect(lookups.some((one) => one.startsWith("/zones?name=test&"))).toBe(false);
  });

  it("resolves the innermost zone carrying a domain, not the outermost", async () => {
    /*
     * A subdomain that is **its own zone** must be found as itself. Email Sending and Email Routing are both
     * configured per zone, so resolving `deep.b.example.test` to `example.test` when `b.example.test` is a
     * zone would report a different zone's configuration as this domain's — records for the wrong name, and
     * a verdict about somebody else's mail.
     */
    await ready("inbox@deep.b.example.test");
    serving({
      "/zones?name=b.example.test": [{ id: "zone_inner", name: "b.example.test" }],
      "/zones/zone_inner/email/sending/subdomains": [{ id: "snd_2", name: "b.example.test", enabled: true }],
      "/zones/zone_inner/email/sending/subdomains/snd_2/dns": [],
      [SUBSCRIPTIONS]: [],
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.zone).toBe("b.example.test");
    expect(seen!.sending?.name).toBe("b.example.test");
  });

  it("counts an apex subscription as covering a subdomain it sends from", async () => {
    /*
     * Cloudflare scopes a subscription to one sending domain: the zone apex, **or** a verified sending
     * subdomain. So a Node sending from `mailda-test.example.test` under an apex subscription is covered,
     * and an equality match would report it as having none — sending an operator to create a second
     * subscription for a domain that already has one.
     */
    await ready("inbox@mailda-test.example.test");
    serving({
      [SUBSCRIPTIONS]: [subscription("example.test")],
      "/accounts/acc_1/queues/q_1": { queue_name: "q", consumers: [{ script: "mailda" }] },
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBe("mailda-sending-events");
  });

  it("does not count a subscription on a different domain that merely ends the same way", async () => {
    // `notexample.test` ends with `example.test` as a *string*. The dot is what makes it a label boundary.
    await ready("inbox@notexample.test");
    serving({ [SUBSCRIPTIONS]: [subscription("example.test")] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBeNull();
    expect(seen!.error).toBeNull();
  });

  it("ignores subscriptions from other sources on the same domain", async () => {
    await ready("inbox@example.test");
    serving({ [SUBSCRIPTIONS]: [subscription("example.test", { source: { type: "r2", domain: "example.test" } })] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBeNull();
  });

  it("reports a queue nobody consumes as empty rather than as absent", async () => {
    /*
     * The failure this whole route exists for: the subscription is there, the queue is there, events are
     * published — into a queue no Worker reads. Nothing errors, and nothing arrives.
     */
    await ready("inbox@example.test");
    serving({
      [SUBSCRIPTIONS]: [subscription("example.test")],
      "/accounts/acc_1/queues/q_1": { queue_name: "orphan", consumers: [] },
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.queueName).toBe("orphan");
    expect(seen!.consumers).toEqual([]);
    expect(seen!.error).toBeNull();
  });

  it("keeps an unreadable queue apart from one with no consumers", async () => {
    // Both are `consumers: []`. Only `error` says which, and a surface that read the first as the second
    // would report a working Node as blind.
    await ready("inbox@example.test");
    serving({ [SUBSCRIPTIONS]: [subscription("example.test")] });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.consumers).toEqual([]);
    expect(seen!.error).toContain("7003");
  });

  it("follows every page rather than trusting the first", async () => {
    /*
     * A subscription on page two is a subscription a single read would miss — and the report would be that
     * the domain has none, which is the way round that sends somebody to create a duplicate. `deploy --plan`
     * called a healthy Node broken on exactly this, over R2's page of twenty.
     */
    await ready("inbox@example.test");
    const filler = Array.from({ length: 50 }, (_, at) => subscription("other.test", { id: `pad_${at}` }));
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      asked.push(path);
      const result = path.startsWith(SUBSCRIPTIONS)
        ? (path.includes("page=1") ? filler : [subscription("example.test")])
        : { queue_name: "q", consumers: [{ script: "mailda" }] };
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    });

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.subscription).toBe("mailda-sending-events");
    expect(asked.filter((one) => one.startsWith(SUBSCRIPTIONS))).toHaveLength(2);
  });

  it("says no credential is held rather than blaming Cloudflare", async () => {
    // No token and no operator headers: the error names the two ways to give one, not the provider.
    await ready("inbox@example.test");
    await testEnv.CATALOG.prepare("DELETE FROM provider_token").run();
    const asked = serving({});

    const [seen] = await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG);
    expect(seen!.error).toContain("PUT /api/provider/token");
    // And it spent nothing finding out.
    expect(asked).toEqual([]);
  });

  it("answers nothing, and asks nothing, for a Node that routes no domains", async () => {
    await ready("inbox@example.test");
    await testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG).run();
    const asked = serving({});

    expect(await deliveryEventsState(testEnv, atTime(SEPTEMBER_3 + 3000), ORG)).toEqual([]);
    expect(asked).toEqual([]);
  });
});


/**
 * Onboarding a domain for sending: the proposal, and the apply bound to it (#163 L2 write side).
 *
 * ## What these are actually defending
 *
 * Not "does the POST work" — one live drill settles that better than any stub. The property here is that
 * **the thing applied is the thing that was shown**, which is the failure this route really has: the read
 * side matched an apex and printed six perfectly correct records about a domain nobody had asked about. Two
 * administrators would have approved that, so the defence is a binding rather than a signature.
 *
 * The second property is that every refusal is a refusal to *act*. Nothing may reach Cloudflare after this
 * Node has decided not to.
 */
describe("onboarding a domain for sending", () => {
  const ZONE = { id: "zone_1", name: "example.test" };

  async function granted() {
    await holdToken(testEnv, "acc_1", SEPTEMBER_3);
  }

  /** Records every request, and answers the two reads a proposal makes. */
  function serving(onboarded: Array<{ name: string }>, postAnswers?: unknown) {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      calls.push({ url: path, method: init?.method ?? "GET" });
      if (init?.method === "POST") {
        return new Response(JSON.stringify(postAnswers ?? { success: true, result: { id: "new" } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      const result = path.startsWith("/zones?name=example.test") ? [ZONE]
        : path.startsWith("/zones?name=") ? []
        : path.endsWith("/email/sending/subdomains") ? onboarded
        : null;
      return new Response(
        JSON.stringify(
          result === null
            ? { success: false, errors: [{ code: 7003, message: `no route for ${path}` }] }
            : { success: true, result },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    return calls;
  }

  it("proposes what onboarding would create, and what backing out would leave", async () => {
    await granted();
    serving([]);

    const proposal = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.zone).toBe("example.test");
    expect(proposal.onboarded).toBe(false);
    expect(proposal.creates).toEqual([
      "cf-bounce.mail.example.test", "cf-bounce._domainkey.mail.example.test", "_dmarc.mail.example.test",
    ]);
    /*
     * The measured half. `DELETE` removes five of six records and keeps this one, so an operator has to be
     * told before confirming rather than after finding it on a name Cloudflare no longer manages.
     */
    expect(proposal.leavesBehind).toEqual(["_dmarc.mail.example.test"]);
    expect(proposal.digest).toHaveLength(64);
  });

  it("treats a domain covered by its apex as still un-onboarded", async () => {
    /*
     * The read side matches an apex as *covering* a subdomain, because for sending it does. Onboarding is
     * per exact name, so reusing that match here would refuse a real act as already done — and the operator
     * would never get the subdomain's own DKIM key or bounce domain.
     */
    await granted();
    serving([{ name: "example.test" }]);

    const proposal = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.onboarded).toBe(false);
    expect(proposal.coveredBy).toBe("example.test");
    expect(proposal.creates).not.toEqual([]);
  });

  it("says already onboarded, without a covering domain, for the exact name", async () => {
    await granted();
    serving([{ name: "example.test" }, { name: "mail.example.test" }]);

    const proposal = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.onboarded).toBe(true);
    expect(proposal.coveredBy).toBeNull();
    expect(proposal.creates).toEqual([]);
  });

  it("applies when the digest matches what it would now do", async () => {
    await granted();
    const calls = serving([]);

    const proposal = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    await onboardSending(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    );

    const posted = calls.filter((one) => one.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("/zones/zone_1/email/sending/subdomains");
  });

  it("refuses a digest from a different domain, and reaches Cloudflare with no write", async () => {
    /*
     * **The one this route exists for.** A proposal computed for one name, confirmed against another, is
     * exactly the shape the read side produced when it matched an apex — and it is the shape a second
     * approver would have signed off too.
     */
    await granted();
    const calls = serving([]);
    const other = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "other.example.test");

    await expect(onboardSending(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", other.digest,
    )).rejects.toThrow(/E_PROVIDER_SENDING_STALE/);
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);
  });

  it("refuses a proposal that has gone stale under it", async () => {
    await granted();
    serving([]);
    const proposal = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");

    // Somebody else onboards the apex in between, so what applying would do is no longer what was shown.
    const calls = serving([{ name: "example.test" }]);
    await expect(onboardSending(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    )).rejects.toThrow(/E_PROVIDER_SENDING_STALE/);
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);
  });

  it("records a domain already onboarded as observed, and reaches Cloudflare with no write", async () => {
    /*
     * This used to refuse, as `E_PROVIDER_SENDING_ALREADY`, and the live Node showed the cost on 26
     * September 2026: whymelabs.com was onboarded before the install, the install never posted, and the
     * Node's own record said sending was never set up. Cloudflare's `2040` still never gets asked for.
     */
    await granted();
    const calls = serving([{ name: "mail.example.test" }]);
    const proposal = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");

    const answered = await onboardSending(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    );
    expect(answered.onboarded).toBe(true);
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);

    const entries = await testEnv.CATALOG.prepare(
      "SELECT action, subject, detail FROM audit_entries WHERE org_id = ? AND action LIKE 'provider.sending_%'",
    ).bind(ORG).all<{ action: string; subject: string; detail: string }>();
    expect(entries.results.map((one) => one.action)).toEqual(["provider.sending_observed"]);
    expect(entries.results[0]!.subject).toBe("mail.example.test");
    expect(JSON.parse(entries.results[0]!.detail)).toEqual({ zone: "example.test", onboarded: true, authority: "token" });
    // And the sighting is what the Node's record now reports, saying it is one.
    expect((await provisionedFacts(testEnv, ORG)).sending).toMatchObject({ domain: "mail.example.test", observed: true });
  });

  it("still refuses a stale digest for a domain already onboarded, and records nothing", async () => {
    await granted();
    serving([{ name: "mail.example.test" }]);
    await expect(onboardSending(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", "0".repeat(64),
    )).rejects.toThrow(/E_PROVIDER_SENDING_STALE/);
    expect((await provisionedFacts(testEnv, ORG)).sending).toBeNull();
  });

  it("refuses rather than guesses when the proposal could not be read", async () => {
    await granted();
    const calls = serving([]);

    await expect(onboardSending(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "nowhere.example.invalid", "0".repeat(64),
    )).rejects.toThrow(/E_PROVIDER_SENDING_UNREADABLE/);
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);
  });

  it("carries Cloudflare's own refusal out rather than a paraphrase", async () => {
    await granted();
    serving([], { success: false, errors: [{ code: 2040, message: "Subdomain already exists" }] });
    const proposal = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");

    await expect(onboardSending(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    )).rejects.toThrow(/2040 Subdomain already exists/);
  });

  it("records the act, the zone, and the record that will outlive it", async () => {
    await granted();
    serving([]);
    const proposal = await sendingProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    await onboardSending(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    );

    const entry = await testEnv.CATALOG.prepare(
      "SELECT action, subject, detail FROM audit_entries WHERE org_id = ? AND action = ?",
    ).bind(ORG, "provider.sending_onboarded").first<{ subject: string; detail: string }>();
    expect(entry?.subject).toBe("mail.example.test");
    const detail = JSON.parse(entry!.detail) as { zone: string; leavesBehind: string[] };
    expect(detail.zone).toBe("example.test");
    // Written while somebody can still connect it to an act, rather than found later on an unlisted name.
    expect(detail.leavesBehind).toEqual(["_dmarc.mail.example.test"]);
  });
});


describe("subscribing a sending domain's delivery events to this Node's queue (#222)", () => {
  const ZONE = { id: "zone_1", name: "example.test" };
  const QUEUE = { queue_id: "q_own", queue_name: "mailda-test-sending-events" };
  const OTHER = { queue_id: "q_other", queue_name: "somebody-elses" };

  async function granted() {
    await holdToken(testEnv, "acc_1", SEPTEMBER_3);
  }

  /**
   * Answers the reads a proposal makes — the zone, the sending domains, the subscriptions, the queue pages —
   * and records every request. `queues` is paged at a hundred, so a second page is answered when asked.
   */
  function serving(options: {
    onboarded: Array<{ name: string }>;
    subscriptions?: Array<{ name: string; source: { type: string; domain: string }; destination: { queue_id: string } }>;
    queues?: Array<{ queue_id: string; queue_name: string }>;
    /** Who consumes the Node's queue. Defaults to this Worker, which is the state a `mailda deploy` leaves. */
    consumers?: Array<{ script: string; type: string }>;
    postAnswer?: unknown;
  }) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      calls.push({ url: path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === "POST") {
        return new Response(JSON.stringify(options.postAnswer ?? { success: true, result: { id: "sub_new" } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
      const queues = options.queues ?? [QUEUE];
      const result = path.startsWith("/zones?name=example.test") ? [ZONE]
        : path.startsWith("/zones?name=") ? []
        // A real listing carries an id, which is what the DNS read below is keyed by.
        : path.endsWith("/email/sending/subdomains") ? options.onboarded.map((one, i) => ({ id: `sd_${i}`, ...one }))
        : /\/email\/sending\/subdomains\/[^/]+\/dns$/.test(path) ? []
        : path.includes("/event_subscriptions/subscriptions") ? (page === 1 ? (options.subscriptions ?? []) : [])
        : path.includes("/queues?") ? (page === 1 ? queues.slice(0, 100) : queues.slice(100))
        : /\/queues\/[^/?]+$/.test(path)
          ? { queue_name: QUEUE.queue_name, consumers: options.consumers ?? [{ script: "mailda-test", type: "worker" }] }
        : null;
      return new Response(
        JSON.stringify(
          result === null
            ? { success: false, errors: [{ code: 7003, message: `no route for ${path}` }] }
            : { success: true, result },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    return calls;
  }

  it("proposes the subscription for an onboarded domain, naming this Node's own queue", async () => {
    await granted();
    serving({ onboarded: [{ name: "mail.example.test" }], queues: [OTHER, QUEUE] });

    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.error).toBeNull();
    expect(proposal.sendingDomain).toBe("mail.example.test");
    expect(proposal.subscribed).toBeNull();
    // The queue is found by the name wrangler derived from this Worker's, not the first queue listed.
    expect(proposal.queueId).toBe("q_own");
    expect(proposal.queueName).toBe("mailda-test-sending-events");
    expect(proposal.consumerAttached).toBe(true);
    expect(proposal.events).toHaveLength(6);
    expect(proposal.digest).toHaveLength(64);
  });

  it("finds the queue on a later page, because the account this was measured on holds sixty-six", async () => {
    await granted();
    const filler = Array.from({ length: 100 }, (_, i) => ({ queue_id: `q_${i}`, queue_name: `other-${i}` }));
    serving({ onboarded: [{ name: "mail.example.test" }], queues: [...filler, QUEUE] });

    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.queueId).toBe("q_own");
  });

  it("says onboard first, because Cloudflare refuses a subscription for a domain that is not", async () => {
    // Measured (`email-sending-events.md`): the API's own words are "domain is not an enabled sending
    // subdomain". The proposal says so before a write is attempted, and the write refuses on the same reason.
    await granted();
    const calls = serving({ onboarded: [] });

    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.error).toContain("not onboarded for sending");
    expect(proposal.error).toContain("POST /api/provider/sending");
    await expect(subscribeDeliveryEvents(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    )).rejects.toThrow(/E_PROVIDER_SUBSCRIPTION_UNREADABLE/);
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);
  });

  it("uses the apex's sending domain when that is what covers the name", async () => {
    await granted();
    serving({ onboarded: [{ name: "example.test" }] });

    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.error).toBeNull();
    expect(proposal.sendingDomain).toBe("example.test");
  });

  it("records a subscription already covering the domain, with this Worker consuming, as observed and writes nothing", async () => {
    // Was `E_PROVIDER_SUBSCRIPTION_ALREADY`; see the sending sibling for why a sighting is recorded instead.
    await granted();
    const calls = serving({
      onboarded: [{ name: "mail.example.test" }],
      subscriptions: [{ name: "already", source: { type: "email.sending", domain: "example.test" }, destination: { queue_id: "q_own" } }],
    });

    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.subscribed).toBe("already");
    const answered = await subscribeDeliveryEvents(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    );
    expect(answered.subscribed).toBe("already");
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);

    const entries = await testEnv.CATALOG.prepare(
      "SELECT action, subject, detail FROM audit_entries WHERE org_id = ? AND action LIKE 'provider.delivery_events_%'",
    ).bind(ORG).all<{ action: string; subject: string; detail: string }>();
    expect(entries.results.map((one) => one.action)).toEqual(["provider.delivery_events_observed"]);
    expect(JSON.parse(entries.results[0]!.detail)).toMatchObject({ subscriptionId: "already", consumerAttached: "already", queue: "mailda-test-sending-events" });
    expect((await provisionedFacts(testEnv, ORG)).deliveryEvents).toMatchObject({ domain: "mail.example.test", observed: true });
  });

  it("creates it with the measured shape when the digest matches, and records the act", async () => {
    await granted();
    const calls = serving({ onboarded: [{ name: "mail.example.test" }] });

    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    await subscribeDeliveryEvents(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    );

    const posted = calls.filter((one) => one.method === "POST");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("/accounts/acc_1/event_subscriptions/subscriptions");
    // The undocumented shape, exactly as the account's existing subscription carries it.
    expect(posted[0]!.body).toEqual({
      name: "mailda-test-sending-events-mail.example.test",
      enabled: true,
      source: { type: "email.sending", zone_id: "zone_1", domain: "mail.example.test" },
      destination: { type: "queues.queue", queue_id: "q_own" },
      events: [
        "message.delivered", "message.deferred", "message.bounced",
        "message.failed", "message.rejected", "message.complained",
      ],
    });

    const entry = await testEnv.CATALOG.prepare(
      "SELECT subject, detail FROM audit_entries WHERE org_id = ? AND action = ? ORDER BY seq DESC LIMIT 1",
    ).bind(ORG, "provider.delivery_events_subscribed").first<{ subject: string; detail: string }>();
    expect(entry?.subject).toBe("mail.example.test");
    expect(JSON.parse(entry?.detail ?? "{}")).toMatchObject({ queue: "mailda-test-sending-events", subscriptionId: "sub_new" });
  });

  it("attaches this Worker as the queue's consumer when nothing consumes it (measured 16 September 2026)", async () => {
    /*
     * The third object, and the one a button-only install never had: `queue:attach-consumer` was a wrangler
     * call an operator ran afterwards. `POST /accounts/{id}/queues/{id}/consumers` attaches a Worker
     * consumer — measured on a throwaway queue — so the confirm does it when the proposal found none.
     */
    await granted();
    const calls = serving({ onboarded: [{ name: "mail.example.test" }], consumers: [] });

    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    expect(proposal.consumerAttached).toBe(false);
    await subscribeDeliveryEvents(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    );
    const posted = calls.filter((one) => one.method === "POST");
    expect(posted.map((one) => one.url)).toEqual([
      "/accounts/acc_1/event_subscriptions/subscriptions",
      "/accounts/acc_1/queues/q_own/consumers",
    ]);
    // No `settings`: the two batch numbers this used to carry were never measured, so the platform's defaults
    // are the platform's to choose (AGENTS.md §2).
    expect(posted[1]!.body).toEqual({ type: "worker", script_name: "mailda-test" });
  });

  it("attaches only the consumer when the subscription already exists, rather than refusing the whole act", async () => {
    await granted();
    const calls = serving({
      onboarded: [{ name: "mail.example.test" }],
      subscriptions: [{ name: "already", source: { type: "email.sending", domain: "example.test" }, destination: { queue_id: "q_own" } }],
      consumers: [],
    });
    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    await subscribeDeliveryEvents(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    );
    const posted = calls.filter((one) => one.method === "POST");
    expect(posted.map((one) => one.url)).toEqual(["/accounts/acc_1/queues/q_own/consumers"]);
  });

  it("refuses a stale digest, and reaches Cloudflare with no write", async () => {
    await granted();
    const calls = serving({ onboarded: [{ name: "mail.example.test" }] });

    await expect(subscribeDeliveryEvents(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", "0".repeat(64),
    )).rejects.toThrow(/E_PROVIDER_SUBSCRIPTION_STALE/);
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);
  });

  it("surfaces Cloudflare's refusal in its own words, which is how a missing scope will read", async () => {
    await granted();
    serving({
      onboarded: [{ name: "mail.example.test" }],
      postAnswer: { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
    });

    const proposal = await subscriptionProposalFor(testEnv, atTime(SEPTEMBER_3 + 3000), ORG, "mail.example.test");
    await expect(subscribeDeliveryEvents(
      testEnv, atTime(SEPTEMBER_3 + 4000), ORG, ADMIN, "mail.example.test", proposal.digest,
    )).rejects.toThrow(/10000 Authentication error/);
  });
});


/**
 * The Node creates its own client from a token it spends once (24 September 2026).
 *
 * What would render plausibly and be wrong: a client registered with scopes typed somewhere other than the
 * ceremony; `offline_access` sent as a scope Cloudflare then refuses; the token surviving anywhere; and a
 * token seeing two accounts being guessed at rather than refused.
 */

describe("an operator's credential on the request", () => {
  const ACCOUNT = "1e0170aaabc90ecf5f466128d1f0466a";
  const operator = withOperator(atTime(SEPTEMBER_3), { token: "wrangler-token", accountId: ACCOUNT });

  it("is absent from an ordinary context, so a Node without a token still refuses", async () => {
    expect(operatorOf(atTime(SEPTEMBER_3))).toBeNull();
    await expect(accessTokenFor(testEnv, atTime(SEPTEMBER_3), ORG)).rejects.toThrow(/E_PROVIDER_NO_TOKEN/);
    expect(await boundAccount(testEnv, atTime(SEPTEMBER_3))).toBeNull();
  });

  it("answers the operator's token and account with no token row at all", async () => {
    expect(await accessTokenFor(testEnv, operator, ORG)).toBe("wrangler-token");
    // And over a stored one: the credential on the request is the operator's choice for this call.
    await holdToken(testEnv, OTHER, SEPTEMBER_3, "stored-token");
    expect(await accessTokenFor(testEnv, operator, ORG)).toBe("wrangler-token");
    expect(await boundAccount(testEnv, operator)).toBe(ACCOUNT);
    await testEnv.CATALOG.prepare("DELETE FROM provider_token").run();
    expect(await boundAccount(testEnv, operator)).toBe(ACCOUNT);
    // And the context still keeps time and mints ids, so nothing downstream notices the wrapping.
    expect(operator.now()).toBe(SEPTEMBER_3);
    expect(operator.id("x").startsWith("x_")).toBe(true);
  });

  it("reaches Cloudflare with that token, for a read that would otherwise need the stored one", async () => {
    const { calls } = answering(200, { success: true, result: [] });
    const zones = await cloudflareGet(testEnv, operator, ORG, "/zones?name=example.test");
    expect(zones.ok).toBe(true);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer wrangler-token");
  });
});

/**
 * What the audit trail says was set up, as `GET /api/provider` reports it. A record of an act, dated and
 * naming the credential; null when nothing was ever done, "unknown" for an entry from before the field.
 */
describe("provisioned facts from the audit trail", () => {
  beforeEach(async () => {
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();
  });

  it("is all null on a Node nothing has set up", async () => {
    expect(await provisionedFacts(testEnv, ORG)).toEqual({ receiving: null, sending: null, deliveryEvents: null });
  });

  it("reports the latest act per kind, with who acted and the address", async () => {
    const record = (at: number, action: "provider.receiving_onboarded" | "provider.sending_onboarded", subject: string, detail: Record<string, unknown>) =>
      auditedBatch(testEnv, atTime(at), ORG, { action, outcome: "ok", actorUserId: ADMIN, subject, detail }, (entry) => [entry]);
    await record(SEPTEMBER_3, "provider.receiving_onboarded", "old.example.test", { address: "a@old.example.test", authority: "grant" });
    await record(SEPTEMBER_3 + 1000, "provider.receiving_onboarded", "mail.example.test", { address: "hello@mail.example.test", authority: "operator" });
    await record(SEPTEMBER_3 + 2000, "provider.sending_onboarded", "mail.example.test", {});
    const facts = await provisionedFacts(testEnv, ORG);
    expect(facts.receiving).toEqual({
      domain: "mail.example.test", at: new Date(SEPTEMBER_3 + 1000).toISOString(), authority: "operator", address: "hello@mail.example.test", observed: false,
    });
    // An entry written before `authority` existed says so rather than guessing.
    expect(facts.sending?.authority).toBe("unknown");
    expect(facts.deliveryEvents).toBeNull();
  });

  it("takes the latest of an act and a sighting, and says which it was", async () => {
    const record = (at: number, action: "provider.sending_onboarded" | "provider.sending_observed", detail: Record<string, unknown>) =>
      auditedBatch(testEnv, atTime(at), ORG, { action, outcome: "ok", actorUserId: ADMIN, subject: "mail.example.test", detail }, (entry) => [entry]);
    await record(SEPTEMBER_3, "provider.sending_observed", { authority: "operator" });
    expect((await provisionedFacts(testEnv, ORG)).sending).toMatchObject({ observed: true, authority: "operator" });
    // A later act outranks the sighting, and reads as an act.
    await record(SEPTEMBER_3 + 1000, "provider.sending_onboarded", { authority: "token" });
    expect((await provisionedFacts(testEnv, ORG)).sending).toMatchObject({ observed: false, authority: "token", at: new Date(SEPTEMBER_3 + 1000).toISOString() });
  });

  it("lets a broken read surface rather than answering 'nothing set up'", async () => {
    // The query used to end in `.catch(() => ({ results: [] }))`: an unreadable trail read as an unset-up
    // Node, which is the swallow AGENTS.md §3 forbids.
    // Rejected at `.all()`, where the swallow sat: a throw from `prepare` never reached it and proved nothing.
    const broken = {
      ...testEnv,
      CATALOG: { prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("D1 is away")) }) }) },
    } as unknown as typeof testEnv;
    await expect(provisionedFacts(broken, ORG)).rejects.toThrow("D1 is away");
  });
});
