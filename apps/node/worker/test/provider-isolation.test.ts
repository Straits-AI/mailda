import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginAuthorization, completeAuthorization, deliveryEventsState, onboardSending, registerClient,
  sendingProposalFor,
} from "../src/provider/cloudflare-grant.ts";

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
 * ## Why the multi-account case is a refusal and not a default
 *
 * `resolveAccount` records nothing when a grant covers several accounts, calling that *"a real answer and
 * not an error"*. So `account_id` is null exactly when the ambiguity is real — and a null that meant *search
 * all of them* would turn the one case that needs a boundary into the one case with none.
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
    testEnv.CATALOG.prepare("DELETE FROM provider_authorizations"),
    testEnv.CATALOG.prepare("DELETE FROM provider_binding"),
    testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(AT).toISOString()).run();
});

afterEach(() => vi.restoreAllMocks());

/** A grant good for an hour. `accountId` null is the multi-account case `resolveAccount` leaves behind. */
async function granted(accountId: string | null) {
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
  if (accountId !== null) {
    await testEnv.CATALOG.prepare("UPDATE provider_binding SET account_id = ? WHERE id = 1")
      .bind(accountId).run();
  }
  vi.restoreAllMocks();
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

  it("refuses rather than searching every account when the grant covers more than one", async () => {
    /*
     * `account_id` is null exactly when a grant spans several accounts, which `resolveAccount` treats as a
     * real answer. Falling back to an unfiltered search here would give the one case that needs a boundary
     * no boundary at all.
     */
    await granted(null);
    const calls = serving(THEIRS);

    const proposal = await sendingProposalFor(testEnv, atTime(AT + 3000), ORG, "theirs.test");
    expect(proposal.zone).toBeNull();
    expect(proposal.error).toContain("/api/provider/resolve-account");
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
    expect(seen!.error).toContain("/api/provider/resolve-account");
  });
});
