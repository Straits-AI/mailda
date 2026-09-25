import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deliveryEventsState, onboardSending, ownershipFacts, sendingProposalFor,
} from "../src/provider/cloudflare-grant.ts";
import { holdToken } from "./support/provider-token.ts";

/**
 * A Node acts on **its own** Cloudflare account and no other (#165).
 *
 * ## The hole this was written against, which was real
 *
 * `GET /zones?name=x` does not answer within an account. It returns zones from **every account the grant can
 * see** — measured on 14 September 2026 at fifteen zones across four accounts, one of them a client's. The
 * zone walk carried no account filter, so a Node whose grant covered two accounts would resolve a name in
 * either, and everything downstream inherits that: routing state read from somebody else's zone, a proposal
 * built against their DNS, and `onboardSending` **writing records into a zone this Node is not bound to**.
 *
 * The live Node was never wrong, because its consent happened to cover one account. That is the distinction
 * #108 asks for — *"mutation-proven"* rather than observed — and the reason this file exists: the safety was
 * a property of one consent, not of the code.
 *
 * ## Why the no-credential case is a refusal and not a default
 *
 * Since 26 September 2026 a stored token is bound to one account at registration, so the bound account is
 * null exactly when the Node holds no credential at all — and a null that meant *search all of them* would
 * turn the one case that needs a boundary into the one case with none.
 */

const testEnv = env as unknown as Env;

const ORG = "org_isolation";
const ADMIN = "usr_isolation_admin";
const OURS = "acc_ours";
const THEIRS = "acc_theirs";
const AT = Date.parse("2026-09-14T10:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM provider_token"),
    testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(AT).toISOString()).run();
});

afterEach(() => vi.restoreAllMocks());

/** A token bound to `accountId`. Null is the no-credential case: nothing is held at all. */
async function granted(accountId: string | null) {
  if (accountId !== null) await holdToken(testEnv, accountId, AT);
}

/**
 * A Cloudflare that answers **honestly across accounts**, which is the point.
 *
 * `/zones?name=` returns the zone whatever account is asked for *unless* the request carries a matching
 * `account.id` — which is what the real API does, and what a stub returning one account's zones would have
 * hidden. A fixture kinder than the provider proves nothing.
 */
function serving(zoneOwnedBy: string) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
    calls.push({ url: path, method: init?.method ?? "GET" });

    let result: unknown = null;
    if (path.startsWith("/zones?name=theirs.test")) {
      const asked = new URL(`https://x${path}`).searchParams.get("account.id");
      // No filter: the zone comes back regardless of whose it is. With one: only its owner's.
      result = asked === null || asked === zoneOwnedBy ? [{ id: "zone_theirs", name: "theirs.test" }] : [];
    } else if (path.startsWith("/zones?name=")) {
      result = [];
    } else if (path.endsWith("/email/sending/subdomains")) {
      result = [];
    } else if (path.endsWith("/email/routing")) {
      result = { enabled: true, status: "ready" };
    }
    if (init?.method === "POST") result = { id: "created" };

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

describe("a Node resolves zones only inside the account it is bound to", () => {
  it("asks Cloudflare for the bound account, so another account's zone is not found", async () => {
    await granted(OURS);
    const calls = serving(THEIRS);

    const proposal = await sendingProposalFor(testEnv, atTime(AT + 3000), ORG, "theirs.test");
    expect(proposal.zone).toBeNull();
    expect(proposal.error).toBe("no zone in this account carries theirs.test");

    /*
     * The assertion that survives a refactor: every zone lookup carried the boundary. Checking only the
     * outcome would pass against a stub that happened to return nothing.
     */
    const lookups = calls.filter((one) => one.url.startsWith("/zones?name="));
    expect(lookups.length).toBeGreaterThan(0);
    for (const one of lookups) expect(one.url).toContain(`account.id=${OURS}`);
  });

  it("finds the same zone when it is this Node's own", async () => {
    // The other half: the filter must not refuse everything, which a broken one would also do.
    await granted(THEIRS);
    serving(THEIRS);

    const proposal = await sendingProposalFor(testEnv, atTime(AT + 3000), ORG, "theirs.test");
    expect(proposal.zone).toBe("theirs.test");
    expect(proposal.error).toBeNull();
  });

  it("refuses to write into a zone it could not resolve within its account", async () => {
    /*
     * The consequence, stated as its own test because it is the one that costs something: a `POST` into a
     * zone belonging to another Cloudflare account writes DNS records into somebody else's customer's
     * domain.
     */
    await granted(OURS);
    const calls = serving(THEIRS);

    await expect(onboardSending(testEnv, atTime(AT + 3000), ORG, ADMIN, "theirs.test", "0".repeat(64)))
      .rejects.toThrow(/E_PROVIDER_SENDING_UNREADABLE/);
    expect(calls.filter((one) => one.method === "POST")).toEqual([]);
  });

  it("refuses rather than searching every account when it holds no credential", async () => {
    /*
     * The bound account is null exactly when no credential is held. Falling back to an unfiltered search
     * here would give the one case that needs a boundary no boundary at all.
     */
    await granted(null);
    const calls = serving(THEIRS);

    const proposal = await sendingProposalFor(testEnv, atTime(AT + 3000), ORG, "theirs.test");
    expect(proposal.zone).toBeNull();
    expect(proposal.error).toContain("PUT /api/provider/token");
    // And it spent nothing finding out — no zone lookup happened at all.
    expect(calls.filter((one) => one.url.startsWith("/zones?name="))).toEqual([]);
  });

  it("says the same thing on the delivery read, from the same sentence", async () => {
    await granted(null);
    await testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind("addr_iso", ORG, "inbox@theirs.test", "mbx_x", new Date(AT).toISOString()).run();
    serving(THEIRS);

    const [seen] = await deliveryEventsState(testEnv, atTime(AT + 3000), ORG);
    expect(seen!.error).toContain("PUT /api/provider/token");
  });
});

/**
 * The ownership answers say where they came from (#165, #108).
 *
 * ## What is actually being tested
 *
 * Not the wording. The property is that **no answer is reported as `provider` unless Cloudflare was asked on
 * this request**, which is the whole of #108's *"a cache pretending to be a fact"*. The dangerous direction
 * is a field that is really this Node's setup record wearing the provider's label — so the tests are about
 * the `source` column and what happens to it when the provider cannot be reached.
 */
describe("who owns this installation, and where each answer came from", () => {
  /** Cloudflare answering about one account, with whatever `type` and settings a case needs. */
  function account(over: Record<string, unknown> = {}, ok = true) {
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      if (!path.startsWith(`/accounts/${OURS}`)) {
        return new Response(JSON.stringify({ success: true, result: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify(ok
          ? {
            success: true,
            result: {
              id: OURS, name: "A Customer", type: "standard", created_on: "2022-10-12T14:20:15Z",
              settings: { enforce_twofactor: false, oauth_app_access_enabled: true },
              ...over,
            },
          }
          : { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  }

  const answerTo = (facts: Awaited<ReturnType<typeof ownershipFacts>>, part: string) =>
    facts.find((one) => one.question.includes(part))!;

  it("labels the account read as the provider's, and everything else as what it is", async () => {
    await granted(OURS);
    account();

    const facts = await ownershipFacts(testEnv, atTime(AT + 3000), ORG);
    expect(answerTo(facts, "Cloudflare account holds").source).toBe("provider");
    expect(answerTo(facts, "Cloudflare account holds").answer).toContain("A Customer");
    // This Node's own record of its own act — true about the Node, not confirmed by the account.
    expect(answerTo(facts, "given its token").source).toBe("node");
    // True by construction rather than by configuration.
    expect(answerTo(facts, "Mailda holds").source).toBe("structural");

    /*
     * Every non-provider answer carries its reason, and every provider one does not need to. Asserted as a
     * rule rather than per field, so a tenth fact cannot be added without one.
     */
    for (const fact of facts) {
      if (fact.source === "provider") expect(fact.because, fact.question).toBeNull();
      else expect(fact.because, fact.question).not.toBeNull();
    }
  });

  it("names what this token cannot answer instead of leaving it out", async () => {
    /*
     * Billing. `/accounts/{id}/subscriptions` answers 403 on a token with these permissions, and a page that silently
     * omitted *who pays* would be a page whose completeness is a claim.
     */
    await granted(OURS);
    account();

    const facts = await ownershipFacts(testEnv, atTime(AT + 3000), ORG);
    const payer = answerTo(facts, "Who pays");
    expect(payer.source).toBe("unreadable");
    expect(payer.answer).toBeNull();
    expect(payer.because).toContain("403");
  });

  it("refuses to call a tenant-managed account customer-owned", async () => {
    /*
     * #108: *"`tenant_managed` must never be labelled customer-owned. Ownership is a factual relationship,
     * not a pricing-plan name."* The claim is derived from Cloudflare's `type`, so an account held by a
     * reseller says so.
     */
    await granted(OURS);
    account({ type: "tenant" });

    const model = answerTo(await ownershipFacts(testEnv, atTime(AT + 3000), ORG), "ownership model");
    expect(model.source).toBe("provider");
    expect(model.answer).toContain("NOT customer-owned");
    expect(model.answer).toContain("tenant");
  });

  it("does not wave through an account type it has never seen", async () => {
    // A new `type` string must not default to customer-owned, which is the direction that matters.
    await granted(OURS);
    account({ type: "something-cloudflare-added-later" });

    const model = answerTo(await ownershipFacts(testEnv, atTime(AT + 3000), ORG), "ownership model");
    expect(model.answer).not.toContain("customer-owned (");
    expect(model.answer).toContain("NOT customer-owned");
  });

  it("stops reporting as the provider's the moment Cloudflare cannot be read", async () => {
    /*
     * **The test this file exists for.** A page that fell back to its setup record and kept the provider's
     * label would be exactly the cache #108 forbids — and it would look right, because the id it printed
     * would be correct.
     */
    await granted(OURS);
    account({}, false);

    const facts = await ownershipFacts(testEnv, atTime(AT + 3000), ORG);
    const holder = answerTo(facts, "Cloudflare account holds");
    expect(holder.source).toBe("node");
    expect(holder.answer).toBe(OURS);
    expect(holder.because).toContain("9109");
    // And nothing else is asserted at all, rather than asserted from a stale record.
    expect(facts.every((one) => one.source !== "provider")).toBe(true);
  });

  it("says nothing about an account it has not determined", async () => {
    await granted(null);
    account();

    const facts = await ownershipFacts(testEnv, atTime(AT + 3000), ORG);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.source).toBe("node");
    expect(facts[0]!.because).toContain("Nothing below could be");
  });
});
