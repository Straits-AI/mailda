import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
} from "../src/provider/cloudflare-grant.ts";
import { holdToken } from "./support/provider-token.ts";
import { CHECK_MAX, checkDomains, searchDomains } from "../src/provider/registrar.ts";

/**
 * What a domain costs, and what this Node will refuse to buy (#164 L3, read side).
 *
 * ## The three things worth testing, none of which is "does it fetch"
 *
 * 1. **`registrable` is not `buyable`.** Cloudflare's flag answers *may this be registered*; this Node's
 *    answers *may I register it*. A premium domain can be registrable and still be one the API cannot
 *    register at all, and a Node that read the first as the second would enter a `POST` that cannot succeed
 *    against a price the registry sets.
 * 2. **A refusal about the extension is not a refusal about the name.**
 *    `extension_not_supported_via_api` means Cloudflare sells the domain in its dashboard. Reporting it as
 *    *unavailable* would tell an operator a domain is taken when it is for sale.
 * 3. **Prices stay strings.** Cloudflare returns them as strings to preserve decimal precision, and the
 *    value is bound for an approval digest — a representation that round-trips differently is an approval
 *    nobody can confirm.
 */

const testEnv = env as unknown as Env;
const ORG = "org_registrar";
const ADMIN = "usr_registrar_admin";
const ACCOUNT = "acc_registrar";
const AT = Date.parse("2026-09-15T10:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM provider_token"),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(AT).toISOString()).run();

  await holdToken(testEnv, ACCOUNT, AT);
});

afterEach(() => vi.restoreAllMocks());

/** Cloudflare answering `domain-check` or `domain-search` with the shape its reference documents. */
function serving(domains: unknown[]) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url).replace("https://api.cloudflare.com/client/v4", ""),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? null : String(init.body),
    });
    return new Response(JSON.stringify({ success: true, result: { domains } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const priced = (name: string, over: Record<string, unknown> = {}) => ({
  name, registrable: true, tier: "standard",
  /*
   * **`10.40`, not `10.44`, and the trailing zero is the whole point.** `String(Number("10.44"))` is
   * `"10.44"`, so a mutation that parsed the price and rendered it back survived every assertion here. A
   * value that round-trips identically cannot prove a claim about round-tripping. `"10.40"` becomes
   * `"10.4"`, and `"1234.5678"` loses nothing but is checked too, because the failure this guards has two
   * shapes: dropped precision and gained precision.
   */
  pricing: { currency: "USD", registration_cost: "10.40", renewal_cost: "1234.5678" },
  ...over,
});

describe("pricing a domain", () => {
  it("carries the price through as a string, untouched", async () => {
    /*
     * `10.44` must arrive as `"10.44"`. Parsing and re-rendering is how a price becomes
     * `10.440000000000001`, and this value is what an approval digest is taken over.
     */
    serving([priced("mailda.com")]);
    const [one] = await checkDomains(testEnv, atTime(AT + 3000), ORG, ["mailda.com"]);

    expect(one!.registrationCost).toBe("10.40");
    expect(one!.renewalCost).toBe("1234.5678");
    expect(one!.currency).toBe("USD");
    expect(one!.buyable).toBe(true);
    expect(one!.refusal).toBeNull();
  });

  it("refuses a premium domain even when Cloudflare calls it registrable", async () => {
    // The API does not register premium domains at all, so `registrable: true` is not an invitation.
    serving([priced("mailda.com", { tier: "premium" })]);
    const [one] = await checkDomains(testEnv, atTime(AT + 3000), ORG, ["mailda.com"]);

    expect(one!.registrable).toBe(true);
    expect(one!.buyable).toBe(false);
    expect(one!.refusal).toContain("premium");
  });

  it("does not report a dashboard-only extension as unavailable", async () => {
    /*
     * The confusion that matters. `extension_not_supported_via_api` means Cloudflare **sells** this domain,
     * just not through this API — so an operator told it is unavailable would stop looking for something
     * they could have bought.
     */
    serving([{ name: "mailda.sh", registrable: false, reason: "extension_not_supported_via_api" }]);
    const [one] = await checkDomains(testEnv, atTime(AT + 3000), ORG, ["mailda.sh"]);

    expect(one!.buyable).toBe(false);
    expect(one!.refusal).toContain("dashboard");
    /*
     * Not `not.toContain("taken")` — the sentence deliberately says *"this is not the same as the domain
     * being taken"*, which is the useful half. What must not appear is the wording the genuinely
     * unavailable case uses, so the two cannot be skimmed as the same outcome.
     */
    expect(one!.refusal).not.toContain("already registered");
    // Cloudflare's own token survives beside the sentence, so a surface can tell the cases apart.
    expect(one!.reason).toBe("extension_not_supported_via_api");
  });

  it("separates a taken name from an extension nobody can sell", async () => {
    serving([
      { name: "mailda.com", registrable: false, reason: "domain_unavailable" },
      { name: "mailda.zz", registrable: false, reason: "extension_disallows_registration" },
    ]);
    const [taken, frozen] = await checkDomains(
      testEnv, atTime(AT + 3000), ORG, ["mailda.com", "mailda.zz"],
    );
    expect(taken!.refusal).toContain("already registered");
    expect(frozen!.refusal).toContain("frozen");
  });

  it("reports a name Cloudflare omitted rather than dropping it", async () => {
    /*
     * The reference says the response **may omit malformed names**. Assembling the answer from what came
     * back would return a shorter list with no indication which name went missing — and a caller comparing
     * lengths would learn only that something did.
     */
    serving([priced("mailda.com")]);
    const answer = await checkDomains(testEnv, atTime(AT + 3000), ORG, ["mailda.com", "mailda"]);

    expect(answer).toHaveLength(2);
    expect(answer[1]!.name).toBe("mailda");
    expect(answer[1]!.buyable).toBe(false);
    expect(answer[1]!.refusal).toContain("no result");
  });

  it("names a reason Cloudflare invents later rather than mapping it to the nearest one", async () => {
    serving([{ name: "mailda.com", registrable: false, reason: "some_future_reason" }]);
    const [one] = await checkDomains(testEnv, atTime(AT + 3000), ORG, ["mailda.com"]);
    expect(one!.refusal).toContain("some_future_reason");
    expect(one!.refusal).toContain("does not recognise");
  });

  it("refuses more than Cloudflare accepts rather than checking the first twenty", async () => {
    // Slicing would answer a different question from the one asked, and quietly.
    const calls = serving([]);
    const many = Array.from({ length: CHECK_MAX + 1 }, (_, at) => `mailda${at}.com`);

    await expect(checkDomains(testEnv, atTime(AT + 3000), ORG, many))
      .rejects.toThrow(/E_REGISTRAR_TOO_MANY/);
    expect(calls).toEqual([]);
  });

  it("asks the bound account, by POST, with the names in the body", async () => {
    const calls = serving([priced("mailda.com")]);
    await checkDomains(testEnv, atTime(AT + 3000), ORG, ["mailda.com"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`/accounts/${ACCOUNT}/registrar/domain-check`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ domains: ["mailda.com"] });
  });
});

describe("searching for a domain", () => {
  it("refuses an empty keyword, which Cloudflare does not accept either", async () => {
    const calls = serving([]);
    await expect(searchDomains(testEnv, atTime(AT + 3000), ORG, "  "))
      .rejects.toThrow(/E_REGISTRAR_NO_QUERY/);
    expect(calls).toEqual([]);
  });

  it("reads suggestions through the same mapping as the authoritative check", async () => {
    /*
     * One mapping for both, because the fields are the same and two copies would drift — and the drift that
     * matters is the `buyable` rule, which is the one a purchase depends on.
     */
    serving([priced("mailda.dev", { tier: "premium" })]);
    const [one] = await searchDomains(testEnv, atTime(AT + 3000), ORG, "mailda");
    expect(one!.buyable).toBe(false);
    expect(one!.registrationCost).toBe("10.40");
  });
});
