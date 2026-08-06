import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { runDoctor, type Finding } from "../src/doctor.ts";
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

/** Everything migrations created, removed. Leaves `sqlite_master` readable and empty, as a fresh D1 is. */
async function dropTheSchema(): Promise<number> {
  const rows = await testEnv.CATALOG.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'`,
  ).all<{ name: string }>();
  for (const row of rows.results) {
    await testEnv.CATALOG.prepare(`DROP TABLE IF EXISTS ${row.name}`).run();
  }
  return rows.results.length;
}

describe("a Node with no schema, which is what a fresh install is", () => {
  it("still produces a doctor report, naming the missing tables and the fix", async () => {
    expect(await dropTheSchema()).toBeGreaterThan(0);

    const report = await runDoctor(testEnv, createSystemCtx());

    // That this returns at all is the point. It used to throw.
    expect(report.verdict).toBe("refuse");
    const schema = report.findings.find((f) => f.check === "migrations_applied");
    expect(schema?.ok).toBe(false);
    expect(schema?.fix).toContain("migrations apply");
  });

  it("answers /health with the reason and the fix, not an opaque 500", async () => {
    await dropTheSchema();

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
    await dropTheSchema();

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
    await dropTheSchema();

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
});
