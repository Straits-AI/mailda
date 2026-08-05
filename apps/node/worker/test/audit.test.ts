import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { audit, log, trimLogs, verifyChain } from "../src/audit.ts";

const testEnv = env as unknown as Env;
const ORG = "org_audit";

beforeEach(async () => {
  await testEnv.CATALOG.prepare("DELETE FROM audit_entries").run();
  await testEnv.CATALOG.prepare("DELETE FROM log_entries").run();
});

describe("the audit chain", () => {
  it("links each entry to the one before it", async () => {
    const ctx = createSystemCtx();
    const first = await audit(testEnv, ctx, ORG, { action: "auth.signed_in", outcome: "ok" });
    const second = await audit(testEnv, ctx, ORG, { action: "send.sealed", outcome: "ok" });

    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);

    const row = await testEnv.CATALOG.prepare("SELECT prev_hash FROM audit_entries WHERE seq = 2")
      .first<{ prev_hash: string }>();
    expect(row?.prev_hash).toBe(first?.hash);
  });

  it("starts from a stated genesis rather than an implicit one", async () => {
    await audit(testEnv, createSystemCtx(), ORG, { action: "node.claimed", outcome: "ok" });
    const row = await testEnv.CATALOG.prepare("SELECT prev_hash FROM audit_entries WHERE seq = 1")
      .first<{ prev_hash: string }>();
    expect(row?.prev_hash).toBe("0".repeat(64));
  });

  it("verifies an intact chain", async () => {
    const ctx = createSystemCtx();
    for (let i = 0; i < 5; i++) await audit(testEnv, ctx, ORG, { action: `t.${i}`, outcome: "ok" });

    const verdict = await verifyChain(testEnv, ORG);
    expect(verdict.intact).toBe(true);
    expect(verdict.checked).toBe(5);
    expect(verdict.brokenAt).toBeNull();
  });

  it("names where an entry was altered, not merely that one was", async () => {
    const ctx = createSystemCtx();
    for (let i = 0; i < 5; i++) await audit(testEnv, ctx, ORG, { action: `t.${i}`, outcome: "ok" });

    // Someone edits an action after the fact — the realistic tampering, not a wholesale rewrite.
    await testEnv.CATALOG.prepare("UPDATE audit_entries SET action = 'innocent' WHERE seq = 3").run();

    const verdict = await verifyChain(testEnv, ORG);
    expect(verdict.intact).toBe(false);
    // An investigation needs the bad link, not the news that one exists.
    expect(verdict.brokenAt?.seq).toBe(3);
    expect(verdict.brokenAt?.reason).toContain("altered after it was written");
  });

  it("names a deletion as missing entries", async () => {
    const ctx = createSystemCtx();
    for (let i = 0; i < 5; i++) await audit(testEnv, ctx, ORG, { action: `t.${i}`, outcome: "ok" });
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE seq = 3").run();

    const verdict = await verifyChain(testEnv, ORG);
    expect(verdict.intact).toBe(false);
    expect(verdict.brokenAt?.reason).toContain("missing");
  });

  it("records successes too, so silence is not ambiguous", async () => {
    const ctx = createSystemCtx();
    await audit(testEnv, ctx, ORG, { action: "send.handed_over", outcome: "ok", subject: "snd_1" });
    const row = await testEnv.CATALOG.prepare("SELECT outcome FROM audit_entries WHERE subject = 'snd_1'")
      .first<{ outcome: string }>();
    // If only failures were recorded, an empty trail would mean either "nothing happened" or
    // "everything worked", and a reader could not tell which.
    expect(row?.outcome).toBe("ok");
  });

  it("distinguishes the Node acting from a person acting", async () => {
    const ctx = createSystemCtx();
    await audit(testEnv, ctx, ORG, { action: "send.dispatched", outcome: "ok" });
    await audit(testEnv, ctx, ORG, { action: "send.cancelled", outcome: "ok", actorUserId: "usr_1" });

    const rows = await testEnv.CATALOG.prepare(
      "SELECT actor_kind, actor_user_id FROM audit_entries ORDER BY seq",
    ).all<{ actor_kind: string; actor_user_id: string | null }>();

    // A sweeper acting on its own is a real and distinct case from an unknown actor.
    expect(rows.results[0]?.actor_kind).toBe("node");
    expect(rows.results[0]?.actor_user_id).toBeNull();
    expect(rows.results[1]?.actor_kind).toBe("user");
  });

  it("bounds detail, because this table is read more widely than the mail", async () => {
    const ctx = createSystemCtx();
    await audit(testEnv, ctx, ORG, {
      action: "t.big", outcome: "ok",
      detail: { blob: "x".repeat(BUDGETS["audit.max_detail_bytes"] + 5000) },
    });
    const row = await testEnv.CATALOG.prepare("SELECT detail FROM audit_entries WHERE action = 't.big'")
      .first<{ detail: string }>();
    expect(row!.detail.length).toBeLessThanOrEqual(BUDGETS["audit.max_detail_bytes"]);
    // Truncation is stated, not silent.
    expect(row!.detail).toContain("truncated");
  });

  it("never throws, because logging that can fail a request gets removed", async () => {
    const ctx = createSystemCtx();
    const broken = { ...testEnv, CATALOG: { prepare: () => { throw new Error("db gone"); } } } as unknown as Env;
    await expect(audit(broken, ctx, ORG, { action: "t.x", outcome: "ok" })).resolves.toBeNull();
  });
});

describe("the operational log", () => {
  it("records where the Node itself can read it", async () => {
    const ctx = createSystemCtx();
    await log(testEnv, ctx, {
      level: "error", event: "request.unhandled", message: "boom", requestId: "req_1",
    });
    const row = await testEnv.CATALOG.prepare("SELECT level, event, request_id FROM log_entries")
      .first<{ level: string; event: string; request_id: string }>();
    expect(row?.level).toBe("error");
    // The request id is the smallest thing that is a trace: it ties records from one request together.
    expect(row?.request_id).toBe("req_1");
  });

  it("never throws either", async () => {
    const broken = { ...testEnv, CATALOG: { prepare: () => { throw new Error("db gone"); } } } as unknown as Env;
    await expect(log(broken, createSystemCtx(), { level: "error", event: "e", message: "m" }))
      .resolves.toBeUndefined();
  });

  it("trims logs but never audit entries", async () => {
    const ctx = createSystemCtx();
    await audit(testEnv, ctx, ORG, { action: "keep.me", outcome: "ok" });

    // Below the retention bound, so nothing is trimmed and the call is a no-op rather than a scan.
    await log(testEnv, ctx, { level: "info", event: "t", message: "m" });
    expect(await trimLogs(testEnv)).toBe(0);

    // The asymmetry is the point: a chain with a hole in it is not a chain.
    const audits = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM audit_entries").first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });
});
