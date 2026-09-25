import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
} from "../src/provider/cloudflare-grant.ts";
import { holdToken } from "./support/provider-token.ts";
import { buyDomain, purchaseProposalFor, purchaseStatus } from "../src/provider/purchase.ts";

/**
 * Buying a domain, and the charge that must not happen twice (#164 L3).
 *
 * ## What is being tested, given the probe is unpaid
 *
 * #164's gate is a measurement nobody has bought yet: does a retried registration buy a second domain?
 * Cloudflare's reference now *asserts* it does not — *"the domain name [is] a natural idempotency key"* —
 * and that is a claim about behaviour under a retry, which is the one kind this repository has learnt not
 * to spend money on. The reference has been silent or wrong six times in this flow, most recently about a
 * parameter it never named at all.
 *
 * So these tests do not check that the claim holds. They check that **nothing here depends on it**: no path
 * retries a registration, every uncertain state stops automation, and an unreadable "is it already
 * registered" answer forbids a purchase rather than permitting one. If the claim is true the guard is
 * redundant. If it is false the guard is what stops the second charge.
 *
 * `test/node/purchase-never-retries.test.ts` holds the same property lexically, because a retry added later
 * would pass every test below.
 */

const testEnv = env as unknown as Env;
const ORG = "org_purchase";
const ADMIN = "usr_purchase_admin";
const ACCOUNT = "acc_purchase";
const AT = Date.parse("2026-09-15T12:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM provider_token"),
    // Cleared per case: the audit table is append-only, and a `.first()` here would otherwise read the
    // previous test's attempt — which is how an assertion about `autoRenew: true` passed against a `false`.
    testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(AT).toISOString()).run();

  await holdToken(testEnv, ACCOUNT, AT);
});

afterEach(() => vi.restoreAllMocks());

const PRICED = {
  name: "mailda-probe.site", registrable: true, tier: "standard",
  pricing: { currency: "USD", registration_cost: "4.99", renewal_cost: "27.70" },
};

/**
 * Cloudflare, answering each of the three calls a purchase makes.
 *
 * `registration` is what `GET …/registrations/{name}` answers: `null` means Cloudflare says not found,
 * `"refuse"` means it answers something else entirely — which must **not** be read as absence.
 */
function serving(opts: {
  registration?: unknown | null | "refuse";
  status?: unknown;
  check?: unknown[];
} = {}) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
    calls.push({ url: path, method: init?.method ?? "GET", body: init?.body ? String(init.body) : null });

    const refuse = (code: number, message: string) => new Response(
      JSON.stringify({ success: false, errors: [{ code, message }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });

    if (path.endsWith("/registration-status")) return ok(opts.status ?? { state: "pending" });
    if (path.endsWith("/registrar/registrations") && init?.method === "POST") {
      return ok(opts.status ?? { state: "in_progress", completed: false });
    }
    if (path.includes("/registrar/registrations/")) {
      if (opts.registration === "refuse") return refuse(10000, "Authentication error");
      if (opts.registration === undefined || opts.registration === null) {
        return refuse(1003, "Registration not found");
      }
      return ok(opts.registration);
    }
    if (path.endsWith("/domain-check")) return ok({ domains: opts.check ?? [PRICED] });
    return refuse(7003, `no route for ${path}`);
  });
  return calls;
}

const posts = (calls: Array<{ url: string; method: string; body: string | null }>) =>
  calls.filter((one) => one.method === "POST" && one.url.endsWith("/registrar/registrations"));

describe("proposing a purchase", () => {
  it("prices it and offers a digest when nothing stands in the way", async () => {
    serving();
    const proposal = await purchaseProposalFor(testEnv, atTime(AT + 3000), ORG, "mailda-probe.site");

    expect(proposal.refusal).toBeNull();
    expect(proposal.existing).toBeNull();
    expect(proposal.price.registrationCost).toBe("4.99");
    expect(proposal.digest).toHaveLength(64);
  });

  it("refuses when this account already holds the domain", async () => {
    // The duplicate #164 exists to prevent, caught by reading rather than by a failed write.
    serving({ registration: { status: "active" } });
    const proposal = await purchaseProposalFor(testEnv, atTime(AT + 3000), ORG, "mailda-probe.site");

    expect(proposal.existing).toBe("active");
    expect(proposal.refusal).toContain("already registered");
  });

  it("refuses when it could not find out whether the domain is already held", async () => {
    /*
     * **The direction that costs money.** Unreadable is not absent. A proposal that proceeded here would
     * buy a domain this account may already own, because the question could not be answered.
     */
    serving({ registration: "refuse" });
    const proposal = await purchaseProposalFor(testEnv, atTime(AT + 3000), ORG, "mailda-probe.site");

    expect(proposal.refusal).toContain("could not find out");
    expect(proposal.refusal).toContain("will not buy");
  });

  it("carries the registrar's own refusal through, so a premium domain is never proposed", async () => {
    serving({ check: [{ ...PRICED, tier: "premium" }] });
    const proposal = await purchaseProposalFor(testEnv, atTime(AT + 3000), ORG, "mailda-probe.site");
    expect(proposal.refusal).toContain("premium");
  });
});

describe("the charge", () => {
  async function digestFor(domain = "mailda-probe.site") {
    return (await purchaseProposalFor(testEnv, atTime(AT + 3000), ORG, domain)).digest;
  }

  it("returns the outcome when Cloudflare answers with a null error", async () => {
    // The buy path threw here too, so the charge landed and the caller saw a 500.
    serving();
    const digest = await digestFor();
    serving({ status: { state: "in_progress", completed: false, error: null } });

    const outcome = await buyDomain(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mailda-probe.site", digest, false,
    );
    expect(outcome.state).toBe("in_progress");
    expect(outcome.error).toBeNull();
  });

  it("posts exactly once, with auto-renew stated rather than omitted", async () => {
    serving();
    const digest = await digestFor();
    const calls = serving();

    await buyDomain(testEnv, atTime(AT + 4000), ORG, ADMIN, "mailda-probe.site", digest, false);

    const sent = posts(calls);
    expect(sent).toHaveLength(1);
    /*
     * `auto_renew: false` is in the body, not left to the documented default. Cloudflare calls `true` an
     * explicit opt-in to charge the account's payment method, and an opt-in nobody made is not one.
     */
    expect(JSON.parse(sent[0]!.body!)).toEqual({ domain_name: "mailda-probe.site", auto_renew: false });
  });

  it("refuses a digest taken against a different price", async () => {
    serving();
    const stale = await digestFor();
    // The price moves between the quote and the confirmation, which is the stale-quote case #164 names.
    const calls = serving({ check: [{ ...PRICED, pricing: { ...PRICED.pricing, registration_cost: "9.99" } }] });

    await expect(buyDomain(testEnv, atTime(AT + 4000), ORG, ADMIN, "mailda-probe.site", stale, false))
      .rejects.toThrow(/E_REGISTRAR_STALE/);
    expect(posts(calls)).toEqual([]);
  });

  it("does not charge when a registration already exists, whatever digest is offered", async () => {
    const calls = serving({ registration: { status: "active" } });
    await expect(buyDomain(testEnv, atTime(AT + 4000), ORG, ADMIN, "mailda-probe.site", "0".repeat(64), false))
      .rejects.toThrow(/E_REGISTRAR_WILL_NOT_BUY/);
    expect(posts(calls)).toEqual([]);
  });

  it("does not charge when it could not read whether one exists", async () => {
    const calls = serving({ registration: "refuse" });
    await expect(buyDomain(testEnv, atTime(AT + 4000), ORG, ADMIN, "mailda-probe.site", "0".repeat(64), false))
      .rejects.toThrow(/E_REGISTRAR_WILL_NOT_BUY/);
    expect(posts(calls)).toEqual([]);
  });

  it("records the attempt, at its price, before the money moves", async () => {
    /*
     * Written before the `POST`. A registration whose answer never arrives has still spent money, and an
     * entry written only on success would leave that charge with no record — the exact state an operator
     * would be trying to reconstruct.
     */
    serving();
    const digest = await digestFor();
    serving();
    await buyDomain(testEnv, atTime(AT + 4000), ORG, ADMIN, "mailda-probe.site", digest, true);

    const entry = await testEnv.CATALOG.prepare(
      "SELECT subject, detail FROM audit_entries WHERE org_id = ? AND action = ?",
    ).bind(ORG, "provider.domain_purchase_attempted").first<{ subject: string; detail: string }>();
    expect(entry?.subject).toBe("mailda-probe.site");
    const detail = JSON.parse(entry!.detail) as Record<string, unknown>;
    expect(detail.registrationCost).toBe("4.99");
    expect(detail.renewalCost).toBe("27.70");
    expect(detail.autoRenew).toBe(true);
    // No payment detail and no registrant contact, neither of which ever reaches this Node.
    expect(JSON.stringify(detail)).not.toMatch(/card|payment|street|postal/i);
  });
});

describe("polling a purchase", () => {
  const states: Array<[string, boolean]> = [
    ["pending", true], ["in_progress", true], ["blocked", true],
    ["action_required", false], ["succeeded", false], ["failed", false],
  ];

  for (const [state, mayPoll] of states) {
    it(`${mayPoll ? "keeps polling" : "stops polling"} on ${state}`, async () => {
      serving({ status: { state, completed: state === "succeeded" || state === "failed" } });
      const outcome = await purchaseStatus(testEnv, atTime(AT + 5000), ORG, "mailda-probe.site");
      expect(outcome.state).toBe(state);
      expect(outcome.mayPoll).toBe(mayPoll);
    });
  }

  it("survives an explicit null error, which is what a successful workflow returns", async () => {
    /*
     * **The defect that cost a real $4.99.** Cloudflare returns `"error": null` rather than omitting the
     * key, and the check was `status.error === undefined`. It threw *after* the registration was created
     * and billed: the Node answered 500, the operator was told the purchase had failed, and the domain was
     * registered. The status route carried the same fault, so asking how it went failed too.
     *
     * Every fixture here omitted `error`, which is the one shape the provider never sends.
     */
    serving({ status: { state: "succeeded", completed: true, error: null } });
    const outcome = await purchaseStatus(testEnv, atTime(AT + 5000), ORG, "mailda-probe.site");
    expect(outcome.state).toBe("succeeded");
    expect(outcome.error).toBeNull();
  });

  it("stops on a lifecycle state it has never seen", async () => {
    /*
     * Cloudflare may add one. The safe reading of an unfamiliar state is to stop and show a person — a
     * default of *keep asking* would poll forever against a state that may mean somebody must act.
     */
    serving({ status: { state: "some_new_state" } });
    const outcome = await purchaseStatus(testEnv, atTime(AT + 5000), ORG, "mailda-probe.site");
    expect(outcome.mayPoll).toBe(false);
    expect(outcome.next).toContain("does not recognise");
  });

  it("tells a person not to re-run the purchase when the state cannot be read", async () => {
    // The moment a retry is most tempting and least safe.
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const outcome = await purchaseStatus(testEnv, atTime(AT + 5000), ORG, "mailda-probe.site");
    expect(outcome.mayPoll).toBe(false);
    expect(outcome.next).toContain("Do not re-run");
  });

  it("says a person must review a failure rather than retrying it", async () => {
    serving({ status: { state: "failed", completed: true, error: { code: "x", message: "registry said no" } } });
    const outcome = await purchaseStatus(testEnv, atTime(AT + 5000), ORG, "mailda-probe.site");
    expect(outcome.error).toContain("registry said no");
    expect(outcome.next).toContain("will not retry");
  });
});
