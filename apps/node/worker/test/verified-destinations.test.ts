import { SELF, env } from "cloudflare:test";
import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";
import { recordVerifiedDestinations, withOperator } from "../src/provider/cloudflare-grant.ts";
import { holdToken } from "./support/provider-token.ts";

/**
 * The read that records which of this Node's recipients were verified Email Routing destinations of its
 * account (28 September 2026; `src/provider/verified-destinations.ts`).
 *
 * What these tests hold is what the module promises beyond "the call works": only the intersection of the
 * account's list with the addresses this Node handed mail to is stored, never a removal; a failure is
 * recorded as could not read and changes no address row; the account is checked before anything is asked;
 * and the answer and the audit entry carry counts, never an address.
 */

const testEnv = env as unknown as Env;
const ORG = "org_verified_dest";
const ADMIN = "usr_verified_dest_admin";
const MEMBER = "usr_verified_dest_member";
const ACCOUNT = "1e0170aaabc90ecf5f466128d1f0466a";
const OTHER = "2f1281bbbcd01fdf6f577239e2f1577b";
const SEPTEMBER_28 = Date.parse("2026-09-28T06:00:00.000Z");
const NOW = new Date(SEPTEMBER_28).toISOString();
const HANDED = "2026-09-27T07:25:10.228Z";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM verified_destination_recipients"),
    testEnv.CATALOG.prepare("DELETE FROM verified_destination_read"),
    testEnv.CATALOG.prepare("DELETE FROM send_recipients WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM provider_token"),
    testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG),
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One recipient row, in the state the Node's own dispatch leaves it. */
async function handedTo(address: string, state = "handed_over", at = HANDED): Promise<void> {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_recipients (id, org_id, manifest_id, address, kind, submission_state,
                                  submission_state_at, attempts, delivery_state, created_at)
     VALUES (?,?,?,?, 'to', ?, ?, 1, NULL, ?)`,
  ).bind(ctx.id("srr"), ORG, ctx.id("snd"), address, state, at, at).run();
}

type Listed = { email: string; verified: string | null };
const VERIFIED_AT = "2024-11-21T10:00:00.000Z";

/**
 * Cloudflare's destination-address listing, paged the way Cloudflare pages it, or a refusal. Every call is
 * recorded, and anything but the listing is refused, so a read that reached another endpoint fails here.
 */
function cloudflare(answer: Listed[] | { status: number; errors: Array<{ message: string }> }) {
  const calls: Array<{ path: string; authorization: string | undefined }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const full = new URL(String(url));
    calls.push({
      path: `${full.pathname.replace("/client/v4", "")}${full.search}`,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (!full.pathname.endsWith("/email/routing/addresses")) {
      return json(404, { success: false, errors: [{ code: 7003, message: `no route for ${full.pathname}` }] });
    }
    if (!Array.isArray(answer)) return json(answer.status, { success: false, errors: answer.errors });
    const page = Number(full.searchParams.get("page"));
    const size = Number(full.searchParams.get("per_page"));
    return json(200, { success: true, result: answer.slice((page - 1) * size, page * size) });
  });
  return calls;
}

async function stored() {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT address, verified_from, verified_until FROM verified_destination_recipients WHERE org_id = ? ORDER BY address",
  ).bind(ORG).all<{ address: string; verified_from: string; verified_until: string }>();
  return results;
}

async function readRow() {
  return testEnv.CATALOG.prepare("SELECT * FROM verified_destination_read WHERE id = 1").first<{
    account_id: string | null; authority: string; read_at: string | null; attempted_at: string; error: string | null;
  }>();
}

async function entries() {
  const { results } = await testEnv.CATALOG.prepare(
    `SELECT outcome, subject, detail, actor_user_id FROM audit_entries
      WHERE org_id = ? AND action = 'provider.verified_destinations_read' ORDER BY seq`,
  ).bind(ORG).all<{ outcome: string; subject: string; detail: string; actor_user_id: string }>();
  return results;
}

async function read(at = SEPTEMBER_28, operator: { token: string; accountId: string } | null = null) {
  return recordVerifiedDestinations(testEnv, withOperator(atTime(at), operator), ORG, ADMIN);
}

describe("what a read stores", () => {
  it("keeps only the intersection with the addresses handed mail to, folded, with Cloudflare's own dates", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    for (const address of ["a@x.test", "b@y.test", "E@V.test", "c@z.test", "f@x.test", "g@x.test"]) {
      await handedTo(address);
    }
    await handedTo("d@x.test", "held");
    cloudflare([
      { email: "a@x.test", verified: VERIFIED_AT },
      // Mixed case on the list side, and on the send side below: SQL folds both, JavaScript neither.
      { email: "B@Y.test", verified: "2025-01-02T03:04:05.006Z" },
      { email: "e@v.test", verified: VERIFIED_AT },
      // Listed and unverified: `verified` null is Cloudflare's documented test.
      { email: "c@z.test", verified: null },
      // Verified, but the Node's only row for it is held: never handed over, so nothing to explain.
      { email: "d@x.test", verified: VERIFIED_AT },
      // Verified and never sent to: somebody else's address, which must never reach this Node's tables.
      { email: "outsider@w.test", verified: VERIFIED_AT },
      // No milliseconds: stored normalized, because it is compared as text with toISOString() output.
      { email: "f@x.test", verified: "2024-11-21T10:00:00Z" },
      // Unparseable: not stored, which errs toward alarm.
      { email: "g@x.test", verified: "not a date" },
    ]);

    const state = await read();

    expect(await stored()).toEqual([
      { address: "a@x.test", verified_from: VERIFIED_AT, verified_until: NOW },
      { address: "b@y.test", verified_from: "2025-01-02T03:04:05.006Z", verified_until: NOW },
      { address: "e@v.test", verified_from: VERIFIED_AT, verified_until: NOW },
      { address: "f@x.test", verified_from: "2024-11-21T10:00:00.000Z", verified_until: NOW },
    ]);
    expect(state).toEqual({
      accountId: ACCOUNT, readAt: NOW, attemptedAt: NOW, error: null, recipients: 6, verified: 4,
    });
  });

  it("never removes a row: an address the latest read no longer lists keeps the interval it proved", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await handedTo("a@x.test");
    await testEnv.CATALOG.prepare(
      "INSERT INTO verified_destination_recipients (org_id, address, verified_from, verified_until) VALUES (?,?,?,?)",
    ).bind(ORG, "z@q.test", VERIFIED_AT, "2026-09-20T00:00:00.000Z").run();
    cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);

    const state = await read();

    expect(await stored()).toEqual([
      { address: "a@x.test", verified_from: VERIFIED_AT, verified_until: NOW },
      { address: "z@q.test", verified_from: VERIFIED_AT, verified_until: "2026-09-20T00:00:00.000Z" },
    ]);
    // `verified` counts what the latest read listed, so the older row is kept and not counted.
    expect(state.verified).toBe(1);
  });

  it("follows the listing past its first page", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await handedTo("late@x.test");
    const listed: Listed[] = Array.from({ length: 50 }, (_, n) => ({ email: `n${n}@w.test`, verified: VERIFIED_AT }));
    listed.push({ email: "late@x.test", verified: VERIFIED_AT });
    const calls = cloudflare(listed);

    await read();

    expect(calls.map((one) => one.path)).toEqual([
      `/accounts/${ACCOUNT}/email/routing/addresses?page=1&per_page=50`,
      `/accounts/${ACCOUNT}/email/routing/addresses?page=2&per_page=50`,
    ]);
    expect((await stored()).map((one) => one.address)).toEqual(["late@x.test"]);
  });

  it("counts an address once however it was spelled, and answers zero on a Node that has sent nothing", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);
    expect((await read()).recipients).toBe(0);

    await handedTo("A@x.test");
    await handedTo("a@x.test");
    const state = await read(SEPTEMBER_28 + 1000);
    expect(state.recipients).toBe(1);
    expect(state.verified).toBe(1);
  });
});

describe("a failure is could not read, never none verified", () => {
  it("records the attempt and Cloudflare's words, and leaves the earlier read and every row alone", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await handedTo("a@x.test");
    cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);
    await read();
    const before = await stored();

    // Deliberately not `10000 Authentication error`, which docs/cloudflare-grant.md quotes for a rejected
    // token: a reader would take a quoted Cloudflare code as measured. No code, so `?` is cloudflareGet's.
    cloudflare({ status: 403, errors: [{ message: "fixture: refused for the test" }] });
    const later = new Date(SEPTEMBER_28 + 60_000).toISOString();
    const state = await read(SEPTEMBER_28 + 60_000);

    expect(state).toEqual({
      accountId: ACCOUNT, readAt: NOW, attemptedAt: later, error: "? fixture: refused for the test",
      recipients: 1, verified: 1,
    });
    expect(await stored()).toEqual(before);
    expect(await readRow()).toMatchObject({ account_id: ACCOUNT, read_at: NOW, attempted_at: later });
  });

  it("answers null for the read and the count when no read has ever succeeded", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await handedTo("a@x.test");
    cloudflare({ status: 403, errors: [{ message: "fixture: refused for the test" }] });

    const state = await read();

    expect(state).toEqual({
      accountId: null, readAt: null, attemptedAt: NOW, error: "? fixture: refused for the test",
      recipients: 1, verified: null,
    });
    expect(await stored()).toEqual([]);
  });
});

describe("the refusals, before anything is asked or recorded", () => {
  it("refuses a Node with no credential, recording nothing", async () => {
    const calls = cloudflare([]);
    const refused = read();
    await expect(refused).rejects.toMatchObject({ code: "E_PROVIDER_NO_TOKEN", status: 409 });
    // This module's own refusal, which names the ordinary path first, and not the credential seam's, which
    // answers with the same code and would be what a caller met if the guard were gone.
    await expect(refused).rejects.toThrow(/run `mailda setup`, which reads it with wrangler's login/);
    expect(calls).toEqual([]);
    expect(await readRow()).toBeNull();
    expect(await entries()).toEqual([]);
  });

  it("refuses an operator credential for another account than the token's, naming both", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await handedTo("a@x.test");
    const calls = cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);

    const refused = read(SEPTEMBER_28, { token: "wrangler-token", accountId: OTHER });

    await expect(refused).rejects.toMatchObject({ code: "E_PROVIDER_ACCOUNT_MISMATCH", status: 409 });
    await expect(refused).rejects.toThrow(new RegExp(`${OTHER}[\\s\\S]*${ACCOUNT}`));
    expect(calls).toEqual([]);
    expect(await readRow()).toBeNull();
    expect(await stored()).toEqual([]);
    expect(await entries()).toEqual([]);
  });

  it("reads with the operator credential when it names the token's account, or when no token is held", async () => {
    await handedTo("a@x.test");
    const calls = cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);
    expect((await read(SEPTEMBER_28, { token: "wrangler-token", accountId: ACCOUNT })).verified).toBe(1);
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    expect((await read(SEPTEMBER_28 + 1000, { token: "wrangler-token", accountId: ACCOUNT })).verified).toBe(1);
    expect(calls.every((one) => one.authorization === "Bearer wrangler-token")).toBe(true);
  });

  it("refuses an operator credential for another account than the last read's, when no token is held", async () => {
    // The ordinary path holds no token, and the rows a read writes are never removed, so the account the last
    // successful read named is what a later one is compared with.
    await handedTo("a@x.test");
    const calls = cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);
    await read(SEPTEMBER_28, { token: "wrangler-token", accountId: ACCOUNT });
    calls.length = 0;
    const before = { row: await readRow(), rows: await stored(), entries: await entries() };

    const refused = read(SEPTEMBER_28 + 1000, { token: "wrangler-token", accountId: OTHER });

    await expect(refused).rejects.toMatchObject({ code: "E_PROVIDER_ACCOUNT_MISMATCH", status: 409 });
    await expect(refused).rejects.toThrow(new RegExp(`${OTHER}[\\s\\S]*last read was of account ${ACCOUNT}`));
    expect(calls).toEqual([]);
    expect({ row: await readRow(), rows: await stored(), entries: await entries() }).toEqual(before);
  });

  it("reads another account once a token for it is registered, which is how a Node that moved says so", async () => {
    await handedTo("a@x.test");
    const calls = cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);
    await read(SEPTEMBER_28, { token: "wrangler-token", accountId: ACCOUNT });
    await holdToken(testEnv, OTHER, SEPTEMBER_28);

    const state = await read(SEPTEMBER_28 + 1000, { token: "wrangler-token", accountId: OTHER });

    expect(state.accountId).toBe(OTHER);
    expect(calls.at(-1)!.path).toContain(`/accounts/${OTHER}/email/routing/addresses`);
  });

  it("refuses to read when it cannot tell whether a token is held, rather than reading as if none were", async () => {
    // A token for ACCOUNT is held and the operator names OTHER: the mismatch refusal. If the read of the token's
    // account failed and passed for "no token held", the comparison would be skipped and OTHER's list recorded.
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await handedTo("a@x.test");
    const calls = cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);
    const catalog = new Proxy(testEnv.CATALOG, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property !== "prepare") return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        return (sql: string) => sql.includes("FROM provider_token")
          ? { first: () => Promise.reject(new Error("fixture: D1 is away")) }
          : target.prepare(sql);
      },
    });

    await expect(recordVerifiedDestinations(
      { ...testEnv, CATALOG: catalog } as Env, withOperator(atTime(SEPTEMBER_28), { token: "wrangler-token", accountId: OTHER }),
      ORG, ADMIN,
    )).rejects.toThrow("fixture: D1 is away");
    expect(calls).toEqual([]);
    expect(await readRow()).toBeNull();
    expect(await stored()).toEqual([]);
  });
});

describe("who read, with what, and never which addresses", () => {
  it("names the credential: operator for the carried login, token for the stored one", async () => {
    await handedTo("a@x.test");
    cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);
    await read(SEPTEMBER_28, { token: "wrangler-token", accountId: ACCOUNT });
    expect((await readRow())?.authority).toBe("operator");

    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await read(SEPTEMBER_28 + 1000);
    expect((await readRow())?.authority).toBe("token");
    expect((await entries()).map((one) => JSON.parse(one.detail).authority)).toEqual(["operator", "token"]);
  });

  it("writes one entry per attempt, with the caller as actor and counts in place of addresses", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await handedTo("a@x.test");
    await handedTo("b@x.test");
    cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }, { email: "outsider@w.test", verified: VERIFIED_AT }]);
    await read();
    cloudflare({ status: 403, errors: [{ message: "fixture: refused for the test" }] });
    await read(SEPTEMBER_28 + 1000);

    const trail = await entries();
    expect(trail.map((one) => [one.outcome, one.subject, one.actor_user_id])).toEqual([
      ["ok", ACCOUNT, ADMIN], ["failed", ACCOUNT, ADMIN],
    ]);
    expect(JSON.parse(trail[0]!.detail)).toEqual({ accountId: ACCOUNT, authority: "token", recipients: 2, kept: 1 });
    expect(JSON.parse(trail[1]!.detail)).toEqual({
      accountId: ACCOUNT, authority: "token", error: "? fixture: refused for the test",
    });
    expect(trail.map((one) => one.detail).join("")).not.toContain("@");
  });
});

describe("the route", () => {
  const ORIGIN = "https://node.example";

  async function cookieFor(userId: string): Promise<string> {
    const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId });
    return `${ACCESS_COOKIE}=${session.accessToken}`;
  }

  beforeEach(async () => {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE org_id = ?").bind(ORG),
      testEnv.CATALOG.prepare("DELETE FROM users WHERE org_id = ?").bind(ORG),
      testEnv.CATALOG.prepare("DELETE FROM node_claim"),
    ]);
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)")
        .bind(NOW, ORG),
      ...[ADMIN, MEMBER].map((id) => testEnv.CATALOG.prepare(
        "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
      ).bind(id, ORG, `${id}@example.test`, NOW)),
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'org.admin','organization',?,?)`,
      ).bind(ctx.id("rt"), ORG, ADMIN, ORG, NOW),
    ]);
  });

  async function post(userId: string): Promise<Response> {
    return SELF.fetch(`${ORIGIN}/api/provider/verified-destinations`, {
      method: "POST", headers: { cookie: await cookieFor(userId) },
    });
  }

  it("answers a member 404 and asks Cloudflare nothing", async () => {
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    const calls = cloudflare([]);
    const response = await post(MEMBER);
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
    expect(await readRow()).toBeNull();
  });

  it("answers an administrator with the recorded counts", async () => {
    // The positive control: a route broken in any way answers everybody 404 as well.
    await holdToken(testEnv, ACCOUNT, SEPTEMBER_28);
    await handedTo("a@x.test");
    cloudflare([{ email: "a@x.test", verified: VERIFIED_AT }]);
    const response = await post(ADMIN);
    expect(response.status).toBe(200);
    const body = await response.json<{ destinations: { recipients: number; verified: number } }>();
    expect(body.destinations).toMatchObject({ accountId: ACCOUNT, recipients: 1, verified: 1, error: null });
  });
});
