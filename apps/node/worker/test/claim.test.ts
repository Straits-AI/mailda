import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createFrozenCtx } from "@mailda/runtime";

import { claimNode, seedClaimSecret, sessionCookie } from "../src/claim.ts";
import { drainOutbox, pendingEvents } from "../src/outbox.ts";

const SECRET = "bootstrap-secret-from-install";

// Every table the claim flow writes, so each test starts from a genuinely unclaimed Node.
// Storage is isolated per test *file*, not per test, so this has to be explicit.
beforeEach(async () => {
  for (const table of ["node_claim", "sessions", "users", "mailboxes", "relationship_tuples", "outbox"]) {
    await env.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("node claim (§5A)", () => {
  it("refuses before install has seeded a secret", async () => {
    const r = await claimNode(env, createFrozenCtx(), SECRET, "owner@example.com", "Acme");
    expect(r.status).toBe("not_installed");
  });

  it("consumes the one-time secret and issues a session", async () => {
    const ctx = createFrozenCtx(1_800_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);

    const r = await claimNode(env, ctx, SECRET, "Owner@Example.com", "Acme");
    expect(r.status).toBe("claimed");
    expect(r.orgId).toMatch(/^org_/);
    expect(r.sessionToken).toMatch(/^[0-9a-f]{64}$/);

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

  it("is one-time: a second claim is refused even with the right secret", async () => {
    const ctx = createFrozenCtx(1_810_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    expect((await claimNode(env, ctx, SECRET, "a@example.com", "Acme")).status).toBe("claimed");
    expect((await claimNode(env, ctx, SECRET, "b@example.com", "Acme")).status).toBe("already_claimed");
  });

  it("rejects a wrong secret without revealing anything", async () => {
    const ctx = createFrozenCtx(1_820_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    const r = await claimNode(env, ctx, "wrong", "a@example.com", "Acme");
    expect(r.status).toBe("bad_secret");
    expect(r.sessionToken).toBeUndefined();
    // Nothing was created, so a failed guess leaves no trace to enumerate.
    const users = await env.CATALOG.prepare("SELECT COUNT(*) n FROM users").first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it("stores the session token hashed, so a D1 dump yields no live sessions", async () => {
    const ctx = createFrozenCtx(1_830_000_000_000);
    await seedClaimSecret(env, ctx, SECRET);
    const r = await claimNode(env, ctx, SECRET, "a@example.com", "Acme");
    const row = await env.CATALOG.prepare("SELECT token_hash FROM sessions LIMIT 1").first<{ token_hash: string }>();
    expect(row?.token_hash).not.toBe(r.sessionToken);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets a cookie that a cross-site POST cannot use", () => {
    const cookie = sessionCookie("abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
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
