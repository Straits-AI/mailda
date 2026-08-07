import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { runDoctor, type Finding } from "../src/doctor.ts";
import { migrate, migrationNames } from "../src/migrate.ts";
import worker from "../src/index.ts";

/**
 * The state a Deploy to Cloudflare install actually leaves behind.
 *
 * `wrangler deploy` provisions the D1 database but does not migrate it, and the build's deploy command
 * was `npx wrangler deploy` rather than this repository's `deploy` script — so a real button install
 * finished with a green build, an empty catalog, and every request answering HTTP 500. Measured on one
 * (receipt: `deploy-button-install.md`).
 *
 * The worst part was not the missing schema. It was that `doctor` — the one tool whose job is to say
 * what is wrong — was among the things returning 500, so the Node could not report the most likely way
 * for a Node to be broken. These tests exist so that cannot return.
 *
 * **This lives in its own file on purpose.** Dropping tables is DDL, and isolated storage does not undo
 * it; done inside `doctor.test.ts` it broke that file's `beforeEach` for every later test. A file is the
 * isolation boundary that actually holds.
 */

const testEnv = env as unknown as Env;

/**
 * Puts the catalog back to what `wrangler deploy` leaves: readable, and empty of anything migrations
 * made — including `d1_migrations` itself, or the ledger would claim a schema that is not there.
 *
 * Every test calls this rather than relying on the one before it. Dropping a table is DDL and isolated
 * storage does not undo it, so state leaks forward inside a file; the first version of these tests
 * asserted "something was dropped" and failed on every test after the first, because by then there was
 * nothing left to drop. A precondition each test establishes for itself is the only kind that holds.
 */
async function withNoSchema(): Promise<void> {
  const rows = await testEnv.CATALOG.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'`,
  ).all<{ name: string }>();
  for (const row of rows.results) {
    await testEnv.CATALOG.prepare(`DROP TABLE IF EXISTS ${row.name}`).run();
  }
}

describe("a Node with no schema, which is what a fresh install is", () => {
  it("still produces a doctor report, naming the missing tables and the fix", async () => {
    await withNoSchema();

    const report = await runDoctor(testEnv, createSystemCtx());

    // That this returns at all is the point. It used to throw.
    expect(report.verdict).toBe("refuse");
    const schema = report.findings.find((f) => f.check === "migrations_applied");
    expect(schema?.ok).toBe(false);
    expect(schema?.fix).toContain("migrations apply");
  });

  it("answers /health with the reason and the fix, not an opaque 500", async () => {
    await withNoSchema();

    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://node.example/health"), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(503);
    const body = await response.json<{ healthy: boolean; reason: string; fix: string }>();
    expect(body.healthy).toBe(false);
    // A reader has to learn what to do, not merely that something is wrong (§5C).
    expect(body.reason).toContain("no schema");
    expect(body.fix).toContain("migrations apply");
  });

  it("serves /api/doctor rather than failing the request that would explain the failure", async () => {
    await withNoSchema();

    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://node.example/api/doctor"), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    // 503 because the verdict refuses — the Node tells a load balancer and a human the same thing.
    // What matters is that the body is a *report* rather than an internal error.
    expect(response.status).toBe(503);
    const report = await response.json<{ verdict: string; findings: Finding[] }>();
    expect(report.verdict).toBe("refuse");
    expect(report.findings.some((f) => f.check === "migrations_applied" && !f.ok)).toBe(true);
  });

  it("rejects inbound mail cleanly instead of throwing at the transport", async () => {
    await withNoSchema();

    let rejected: string | null = null;
    const message = {
      from: "sender@example.com",
      to: "anyone@example.com",
      headers: new Headers({ "message-id": "<fresh@example.com>" }),
      raw: new Response("From: sender@example.com\r\n\r\nhi\r\n").body,
      setReject: (reason: string) => { rejected = reason; },
    } as unknown as ForwardableEmailMessage;

    const ctx = createExecutionContext();
    await worker.email!(message, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    // §13 forbids losing an accepted message. An unclaimed *or* unmigrated Node has nowhere to put
    // one, so it must refuse at the transport rather than throw — a throw is an opaque failure that
    // tells the sending server nothing about whether the mail was taken.
    expect(rejected).not.toBeNull();
  });

  it("migrates itself back to a working schema", async () => {
    await withNoSchema();

    const outcome = await migrate(testEnv);
    expect(outcome.alreadyCurrent).toBe(false);
    expect(outcome.applied.length).toBe(migrationNames().length);

    // The proof is not the count, it is that doctor — which knows what every migration creates — now
    // agrees the schema is complete.
    const report = await runDoctor(testEnv, createSystemCtx());
    const schema = report.findings.find((f) => f.check === "migrations_applied");
    expect(schema?.ok).toBe(true);
  });

  it("is a no-op the second time, so it is safe on any path", async () => {
    await withNoSchema();
    await migrate(testEnv);

    const again = await migrate(testEnv);
    expect(again.alreadyCurrent).toBe(true);
    expect(again.applied).toEqual([]);
  });

  it("writes wrangler's own ledger, so the CLI and the Node agree", async () => {
    await withNoSchema();
    await migrate(testEnv);

    const rows = await testEnv.CATALOG.prepare("SELECT name FROM d1_migrations ORDER BY id")
      .all<{ name: string }>();
    // Same table, same column, same names wrangler records. A private ledger would have made
    // `wrangler d1 migrations apply` re-run everything on a self-migrated Node.
    // Compared against the bundled list rather than a copy of it. A literal here is a second place for
    // the migration set to be recorded, and it went stale the moment 0009 landed.
    expect(rows.results.map((r) => r.name)).toEqual(migrationNames());
  });

  it("survives two callers racing, applying each migration exactly once", async () => {
    await withNoSchema();

    // No lease and no Durable Object on this path: `name TEXT UNIQUE` settles it, and the loser reads
    // its own constraint violation as "already applied" — which it is. #9's shape.
    const [first, second] = await Promise.all([migrate(testEnv), migrate(testEnv)]);
    const applied = [...first.applied, ...second.applied];
    const raced = [...first.raced, ...second.raced];

    expect(new Set(applied).size).toBe(applied.length);
    expect(applied.length + raced.length).toBeGreaterThanOrEqual(migrationNames().length);

    const rows = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM d1_migrations")
      .first<{ n: number }>();
    expect(rows?.n).toBe(migrationNames().length);
  });

  it("serves POST /api/prepare on a Node where nothing else works", async () => {
    await withNoSchema();

    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://node.example/api/prepare", { method: "POST" }), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = await response.json<{ applied: string[]; alreadyCurrent: boolean }>();
    expect(body.alreadyCurrent).toBe(false);
    expect(body.applied.length).toBe(migrationNames().length);

    // And the Node is genuinely usable afterwards, not merely reporting success.
    const health = createExecutionContext();
    const after = await worker.fetch(new Request("https://node.example/health"), testEnv, health);
    await waitOnExecutionContext(health);
    expect(after.status).toBe(200);
  });
});
