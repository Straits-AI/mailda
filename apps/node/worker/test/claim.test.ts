import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createFrozenCtx } from "@mailda/runtime";

import { claimNode, seedClaimSecret } from "../src/claim.ts";
import { isAdmin } from "../src/access.ts";
import { verifyAccessToken } from "../src/auth/jwt.ts";
import { clearKeyCache } from "../src/auth/keys.ts";
import { drainOutbox, pendingEvents } from "../src/outbox.ts";

const SECRET = "bootstrap-secret-from-install";
const PASSWORD = "a-long-enough-owner-passphrase";

// Every table the claim flow writes, so each test starts from a genuinely unclaimed Node.
// Storage is isolated per test *file*, not per test, so this has to be explicit.
beforeEach(async () => {
  const tables = [
    "node_claim", "sessions", "users", "mailboxes", "relationship_tuples", "outbox",
    "signing_keys", "refresh_tokens", "login_attempts",
  ];
  for (const table of tables) {
    await env.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  // Keys are cached per isolate; clearing the table without clearing the cache would let one
  // test verify a token against a key another test deleted.
  clearKeyCache();
});

describe("node claim (§5A)", () => {
  it("refuses before install has seeded a secret", async () => {
    const r = await claimNode(env, createFrozenCtx(), SECRET, "owner@example.com", PASSWORD, "Acme");
    expect(r.status).toBe("not_installed");
  });

  it("consumes the one-time secret and issues a signed session", async () => {
    const ctx = createFrozenCtx(1_800_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);

    const r = await claimNode(env, ctx, SECRET, "Owner@Example.com", PASSWORD, "Acme");
    expect(r.status).toBe("claimed");
    expect(r.orgId).toMatch(/^org_/);
    // An ES256 access token, verifiable on the spot, plus an opaque refresh token.
    const verified = await verifyAccessToken(env, r.session!.accessToken, ctx.now());
    expect(verified.ok).toBe(true);
    expect(r.session!.refreshToken).toMatch(/^[0-9a-f]{64}$/);

    // The owner's read grant is a live relationship row, not a token claim (§7).
    const grant = await env.CATALOG.prepare(
      "SELECT relation FROM relationship_tuples WHERE org_id = ? AND subject_id = ?",
    ).bind(r.orgId, r.userId).first<{ relation: string }>();
    expect(grant?.relation).toBe("mailbox.content.read");

    // Email is normalised, so a differently-cased sign-in resolves to the same user.
    const user = await env.CATALOG.prepare("SELECT email FROM users WHERE id = ?")
      .bind(r.userId).first<{ email: string }>();
    expect(user?.email).toBe("owner@example.com");
  });

  it("makes the owner an administrator, which is what the whole admin surface rests on", async () => {
    /*
     * **The deadlock this closes (#129).** The claim granted three relations, all on the first mailbox, and no
     * `org.admin`. That relation is `conferredBy: "admin_grant"` and `grant()` calls `assertAdmin` first — so
     * with no tuple in existence nobody held it and nobody could confer it. Every administrator route was
     * unreachable on every Node ever claimed.
     *
     * Measured on a live Node before the fix: the owner got 403 on `/api/audit`, `/api/logs` and
     * `/api/agents`, and 404 on `/api/people` and `/api/policies` — §5C answering as though they did not
     * exist. An operator who claimed a Node could read one mailbox and send from it.
     *
     * It went unnoticed because every other test inserts this tuple directly, so the admin routes were always
     * exercised with an administrator the claim would never have produced. This is the one test that asks
     * whether a **claimed** Node has one, which is the property an install actually depends on.
     */
    const ctx = createFrozenCtx(1_800_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    const claimed = await claimNode(env, ctx, SECRET, "owner@example.test", PASSWORD, "Acme");
    expect(claimed.status).toBe("claimed");

    // From the claim's own return rather than from a table lookup: it reports both ids, and querying for
    // them would be a second source that can disagree with the rows it just wrote.
    expect(claimed.orgId).toBeDefined();
    expect(claimed.userId).toBeDefined();

    /*
     * Asked through `isAdmin` rather than by counting tuples, because that function is what every route
     * consults — a test reading the row directly would pass against a tuple shaped wrongly for the query
     * (the object type, or the object id being the mailbox rather than the organization).
     */
    expect(await isAdmin(env, claimed.orgId!, claimed.userId!)).toBe(true);
  });

  it("grants nothing on the organization beyond that, so the claim is not a blanket", async () => {
    /*
     * The other direction, and the reason this is a separate assertion: "the owner can do everything" is a
     * fix that would also pass the test above. What the claim should produce is one organization-scoped
     * relation and the mailbox grants it already made — not every relation in the registry.
     */
    const ctx = createFrozenCtx(1_800_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    await claimNode(env, ctx, SECRET, "owner@example.test", PASSWORD, "Acme");

    const rows = await env.CATALOG.prepare(
      "SELECT relation FROM relationship_tuples WHERE object_type = 'organization' ORDER BY relation",
    ).all<{ relation: string }>();
    expect(rows.results.map((one) => one.relation)).toEqual(["org.admin"]);
  });

  it("is one-time: a second claim is refused even with the right secret", async () => {
    const ctx = createFrozenCtx(1_810_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    expect((await claimNode(env, ctx, SECRET, "a@example.com", PASSWORD, "Acme")).status).toBe("claimed");
    expect((await claimNode(env, ctx, SECRET, "b@example.com", PASSWORD, "Acme")).status).toBe("already_claimed");
  });

  it("rejects a wrong secret without revealing anything", async () => {
    const ctx = createFrozenCtx(1_820_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    const r = await claimNode(env, ctx, "wrong", "a@example.com", PASSWORD, "Acme");
    expect(r.status).toBe("bad_secret");
    expect(r.session).toBeUndefined();
    // Nothing was created, so a failed guess leaves no trace to enumerate.
    const users = await env.CATALOG.prepare("SELECT COUNT(*) n FROM users").first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it("stores the refresh token hashed, so a D1 dump yields no usable session", async () => {
    const ctx = createFrozenCtx(1_830_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    const r = await claimNode(env, ctx, SECRET, "a@example.com", PASSWORD, "Acme");
    const row = await env.CATALOG.prepare("SELECT token_hash FROM refresh_tokens LIMIT 1")
      .first<{ token_hash: string }>();
    expect(row?.token_hash).not.toBe(r.session!.refreshToken);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores a password verifier, never the password", async () => {
    const ctx = createFrozenCtx(1_835_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    const r = await claimNode(env, ctx, SECRET, "a@example.com", PASSWORD, "Acme");
    const row = await env.CATALOG.prepare(
      "SELECT password_hash, password_iterations FROM users WHERE id = ?",
    ).bind(r.userId).first<{ password_hash: string; password_iterations: number }>();

    expect(row?.password_hash).not.toContain(PASSWORD);
    // Self-describing: algorithm, rounds, per-round iterations and salt all travel with the hash,
    // so raising the cost later cannot silently reinterpret this row.
    expect(row?.password_hash).toMatch(/^pbkdf2-sha256\$r=6\$i=100000\$/);
    expect(row?.password_iterations).toBe(600_000);
  });

  it("rejects a weak password *before* spending the one-time secret", async () => {
    const ctx = createFrozenCtx(1_838_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);

    const rejected = await claimNode(env, ctx, SECRET, "a@example.com", "short", "Acme");
    expect(rejected.status).toBe("weak_password");
    expect(rejected.problem).toContain("E_PASSWORD_TOO_SHORT");

    // The decisive assertion: the secret is still spendable. Consuming it on a rejected password
    // would leave the Node permanently unclaimable.
    const accepted = await claimNode(env, ctx, SECRET, "a@example.com", PASSWORD, "Acme");
    expect(accepted.status).toBe("claimed");
  });
});

describe("outbox publisher (§22, #9)", () => {
  it("does not advance the flag when the handler fails", async () => {
    const ctx = createFrozenCtx(1_840_000_000_000);
    const at = new Date(ctx.now() - 60_000).toISOString();
    await env.CATALOG.prepare(
      "INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at) VALUES (?,?,?,?,NULL,?)",
    ).bind(ctx.id("evt"), "org_x", "mail.ingress.accepted", "{}", at).run();

    const failed = await drainOutbox(env, ctx, async () => {
      throw new Error("consumer exploded");
    });
    expect(failed.drained).toBe(0);
    // Still pending — a failed handler must never silently lose the event (§24).
    expect((await pendingEvents(env, ctx)).length).toBeGreaterThan(0);

    const ok = await drainOutbox(env, ctx, async () => {});
    expect(ok.drained).toBeGreaterThan(0);
  });

  it("ignores rows too fresh to be considered stranded", async () => {
    const ctx = createFrozenCtx(1_850_000_000_000);
    await env.CATALOG.prepare(
      "INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at) VALUES (?,?,?,?,NULL,?)",
    ).bind(ctx.id("evt"), "org_y", "t", "{}", new Date(ctx.now()).toISOString()).run();

    // The fast path may still be in flight; sweeping immediately would duplicate for nothing.
    const events = await pendingEvents(env, ctx);
    expect(events.some((e) => e.orgId === "org_y")).toBe(false);
  });
});
