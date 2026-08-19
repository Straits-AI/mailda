import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { type Ctx, createSystemCtx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import {
  audit, type AuditAction, type AuditEvent, auditedBatch, log, trimLogs, verifyChain,
} from "../src/audit.ts";

// Real catalogue actions. The tests used to invent names like "t.0"; the catalogue now rejects those
// at compile time, which is the point of it — an audit trail whose categories drift is a filter that
// quietly returns half the truth.
/**
 * Appends one entry through a transaction, which is now the only way a non-standalone action can be
 * recorded — `audit` takes `StandaloneAction` and the compiler refuses the rest.
 */
async function append(ctx: Ctx, event: AuditEvent) {
  const { entry } = await auditedBatch(testEnv, ctx, ORG, event, (statement) => [statement]);
  return entry;
}

/**
 * The unit the budget key names. Written out here rather than reusing the Worker's own helper, so a test
 * that says "within the cap" cannot agree with a broken implementation by sharing its measurement.
 */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

const SAMPLE: readonly AuditAction[] = [
  "auth.signed_in", "send.sealed", "key.rotated", "send.handed_over", "auth.locked_out",
];

const testEnv = env as unknown as Env;
const ORG = "org_audit";

beforeEach(async () => {
  await testEnv.CATALOG.prepare("DELETE FROM audit_entries").run();
  await testEnv.CATALOG.prepare("DELETE FROM log_entries").run();
});

describe("the audit chain", () => {
  it("links each entry to the one before it", async () => {
    const ctx = createSystemCtx();
    const first = await append(ctx, { action: "auth.signed_in", outcome: "ok" });
    const second = await append(ctx, { action: "send.sealed", outcome: "ok" });

    expect(first?.seq).toBe(1);
    expect(second?.seq).toBe(2);

    const row = await testEnv.CATALOG.prepare("SELECT prev_hash FROM audit_entries WHERE seq = 2")
      .first<{ prev_hash: string }>();
    expect(row?.prev_hash).toBe(first?.hash);
  });

  it("starts from a stated genesis rather than an implicit one", async () => {
    await append(createSystemCtx(), { action: "key.rotated", outcome: "ok" });
    const row = await testEnv.CATALOG.prepare("SELECT prev_hash FROM audit_entries WHERE seq = 1")
      .first<{ prev_hash: string }>();
    expect(row?.prev_hash).toBe("0".repeat(64));
  });

  it("verifies an intact chain", async () => {
    const ctx = createSystemCtx();
    for (const action of SAMPLE) await append(ctx, { action, outcome: "ok" });

    const verdict = await verifyChain(testEnv, ORG);
    expect(verdict.intact).toBe(true);
    expect(verdict.checked).toBe(5);
    expect(verdict.brokenAt).toBeNull();
  });

  it("names where an entry was altered, not merely that one was", async () => {
    const ctx = createSystemCtx();
    for (const action of SAMPLE) await append(ctx, { action, outcome: "ok" });

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
    for (const action of SAMPLE) await append(ctx, { action, outcome: "ok" });
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE seq = 3").run();

    const verdict = await verifyChain(testEnv, ORG);
    expect(verdict.intact).toBe(false);
    expect(verdict.brokenAt?.reason).toContain("missing");
  });

  it("records successes too, so silence is not ambiguous", async () => {
    const ctx = createSystemCtx();
    await append(ctx, { action: "send.handed_over", outcome: "ok", subject: "snd_1" });
    const row = await testEnv.CATALOG.prepare("SELECT outcome FROM audit_entries WHERE subject = 'snd_1'")
      .first<{ outcome: string }>();
    // If only failures were recorded, an empty trail would mean either "nothing happened" or
    // "everything worked", and a reader could not tell which.
    expect(row?.outcome).toBe("ok");
  });

  it("distinguishes the Node acting from a person acting", async () => {
    const ctx = createSystemCtx();
    await append(ctx, { action: "send.handed_over", outcome: "ok" });
    await append(ctx, { action: "send.cancelled", outcome: "ok", actorUserId: "usr_1" });

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
    await append(ctx, {
      action: "send.sealed", outcome: "ok",
      detail: { blob: "x".repeat(BUDGETS["audit.max_detail_bytes"] + 5000) },
    });
    const row = await testEnv.CATALOG.prepare("SELECT detail FROM audit_entries WHERE action = 'send.sealed'")
      .first<{ detail: string }>();
    // Bytes, not `String.length`. An ASCII fixture cannot tell the two apart, which is why the cap read
    // as measured for months while enforcing code units — the three tests below carry that job.
    expect(utf8Length(row!.detail)).toBeLessThanOrEqual(BUDGETS["audit.max_detail_bytes"]);
    // Truncation is stated, not silent.
    expect(row!.detail).toContain("truncated");
  });

  it("counts the cap in UTF-8 bytes, not UTF-16 code units", async () => {
    const ctx = createSystemCtx();
    // 700 CJK characters: ~714 code units, comfortably under a 2,048 cap read as `String.length`, but
    // 2,114 bytes of UTF-8, over it. A Chinese subject line is the ordinary case here, not a contrived one.
    const subject = "中".repeat(700);
    expect(JSON.stringify({ subject }).length).toBeLessThan(BUDGETS["audit.max_detail_bytes"]);
    expect(utf8Length(JSON.stringify({ subject }))).toBeGreaterThan(BUDGETS["audit.max_detail_bytes"]);

    await append(ctx, { action: "send.sealed", outcome: "ok", detail: { subject } });
    const row = await testEnv.CATALOG.prepare("SELECT detail FROM audit_entries WHERE action = 'send.sealed'")
      .first<{ detail: string }>();

    // The disclosure bound holds in the unit its own key names, so a non-Latin script cannot walk 3x
    // past it.
    expect(utf8Length(row!.detail)).toBeLessThanOrEqual(BUDGETS["audit.max_detail_bytes"]);
    const record = JSON.parse(row!.detail) as { truncated: boolean; bytes: number; head: string };
    expect(record.truncated).toBe(true);
    // `bytes` says bytes. A code-unit count under that key would read 714 for a 2,114-byte detail.
    expect(record.bytes).toBe(utf8Length(JSON.stringify({ subject })));
  });

  // Between code points of the *already-escaped* JSON text, so no lone surrogate is ever stored — which is
  // what this asserts. It does not promise more than that: a `\uXXXX` escape sequence can still be cut, so a
  // head may end `…\u00`. That is ugly and harmless, and claiming "no character in half" would overstate it.
  it("cuts the head between code points, so no lone surrogate is stored", async () => {
    const ctx = createSystemCtx();
    // Emoji are surrogate pairs, so a cut counted in code units lands inside a character at every odd
    // offset. **Both key lengths are here on purpose**: one shifts the run of pairs by a single code unit,
    // so whatever offset a unit-counting cut chooses, exactly one of these two fixtures is cut in half.
    // A single fixture passes or fails on the parity of that offset, which is how a test like this can
    // agree with the bug.
    for (const key of ["e", "ee"] as const) {
      await append(ctx, {
        action: "send.sealed", outcome: "ok",
        detail: { [key]: "\u{1F600}".repeat(1200) },
      });
    }
    const rows = await testEnv.CATALOG.prepare(
      "SELECT detail FROM audit_entries WHERE action = 'send.sealed' ORDER BY seq",
    ).all<{ detail: string }>();
    expect(rows.results).toHaveLength(2);

    for (const row of rows.results) {
      const head = (JSON.parse(row.detail) as { head: string }).head;
      expect(head.length).toBeGreaterThan(0);
      // Half a character *is* an unpaired surrogate: iterating by code point, any element still inside
      // U+D800..U+DFFF is one half of a pair whose other half was cut off. Counted rather than compared
      // against the whole head, because a lone surrogate in an assertion message is not valid UTF-8 and
      // takes the test reporter's own socket down with it — the failure stops being readable.
      const halves = [...head].filter((c) => {
        const code = c.codePointAt(0)!;
        return code >= 0xd800 && code <= 0xdfff;
      }).length;
      expect(halves).toBe(0);
    }
  });

  it("keeps the truncation record itself inside the cap, escaping included", async () => {
    const ctx = createSystemCtx();
    // A control character reaches the record as the six characters of its own escape, and each backslash
    // among them costs two bytes again when the head is stringified. So a head sized against raw bytes
    // overflows the record it is placed in - a state no ordinary fixture reaches.
    await append(ctx, {
      action: "send.sealed", outcome: "ok",
      detail: { blob: "\u0001".repeat(3000) },
    });
    const row = await testEnv.CATALOG.prepare("SELECT detail FROM audit_entries WHERE action = 'send.sealed'")
      .first<{ detail: string }>();

    expect(row!.detail).toContain("truncated");
    expect(utf8Length(row!.detail)).toBeLessThanOrEqual(BUDGETS["audit.max_detail_bytes"]);
  });

  it("never throws, because logging that can fail a request gets removed", async () => {
    const ctx = createSystemCtx();
    const broken = { ...testEnv, CATALOG: { prepare: () => { throw new Error("db gone"); } } } as unknown as Env;
    await expect(audit(broken, ctx, ORG, { action: "auth.locked_out", outcome: "refused" }))
      .resolves.toBeNull();
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

  it("bounds its detail in bytes too, since the key says bytes", async () => {
    // The same defect lived in both caps, so it is held shut in both places. An error string carrying a
    // non-ASCII subject is the ordinary way a log line gets big.
    await log(testEnv, createSystemCtx(), {
      level: "error", event: "parse.failed", message: "boom",
      detail: { subject: "中".repeat(700) },
    });
    const row = await testEnv.CATALOG.prepare("SELECT detail FROM log_entries WHERE event = 'parse.failed'")
      .first<{ detail: string }>();
    expect(utf8Length(row!.detail)).toBeLessThanOrEqual(BUDGETS["log.max_detail_bytes"]);
    expect(row!.detail).toContain("truncated");
  });

  it("never throws either", async () => {
    const broken = { ...testEnv, CATALOG: { prepare: () => { throw new Error("db gone"); } } } as unknown as Env;
    await expect(log(broken, createSystemCtx(), { level: "error", event: "e", message: "m" }))
      .resolves.toBeUndefined();
  });

  it("trims logs but never audit entries", async () => {
    const ctx = createSystemCtx();
    await append(ctx, { action: "key.rotated", outcome: "ok" });

    // Below the retention bound, so nothing is trimmed and the call is a no-op rather than a scan.
    await log(testEnv, ctx, { level: "info", event: "t", message: "m" });
    expect(await trimLogs(testEnv)).toBe(0);

    // The asymmetry is the point: a chain with a hole in it is not a chain.
    const audits = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM audit_entries").first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });
});

describe("an entry and the change it records", () => {
  /** A statement guaranteed to fail: the primary key is already taken. */
  async function collidingInsert(id: string) {
    await testEnv.CATALOG.prepare("INSERT INTO login_attempts (id, org_id, email, at) VALUES (?,?,?,?)")
      .bind(id, ORG, "a@b.com", "2026-08-05T00:00:00.000Z").run();
    return testEnv.CATALOG.prepare("INSERT INTO login_attempts (id, org_id, email, at) VALUES (?,?,?,?)")
      .bind(id, ORG, "a@b.com", "2026-08-05T00:00:00.000Z");
  }

  async function entryCount(): Promise<number> {
    const row = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM audit_entries").first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("commits both or neither, so a change cannot outlive its record", async () => {
    const ctx = createSystemCtx();
    await append(ctx, { action: "auth.signed_in", outcome: "ok" });
    const before = await entryCount();

    const doomed = await collidingInsert("att_collide");
    await expect(
      auditedBatch(testEnv, ctx, ORG, { action: "send.sealed", outcome: "ok" }, (entry) => [entry, doomed]),
    ).rejects.toThrow();

    // The whole point: the accompanying write failed, so the entry claiming it happened is not there.
    expect(await entryCount()).toBe(before);
  });

  it("throws, where a bare append swallows — because nothing has happened yet", async () => {
    const ctx = createSystemCtx();
    const doomed = await collidingInsert("att_throws");

    // `audit` records something already done and must never fail its request. `auditedBatch` gates an
    // act that has not happened, so refusing to proceed is the honest outcome.
    await expect(
      auditedBatch(testEnv, ctx, ORG, { action: "key.rotated", outcome: "ok" }, (entry) => [entry, doomed]),
    ).rejects.toThrow();
    // The contrast: the bare append swallows the same class of failure and returns null rather than
    // throwing. Its action is a lockout because that is the only kind the compiler now lets through.
    await expect(audit(testEnv, ctx, ORG, { action: "auth.locked_out", outcome: "refused" }))
      .resolves.not.toBeNull();
  });

  it("leaves the chain contiguous when a gated entry does not fire", async () => {
    const ctx = createSystemCtx();
    await append(ctx, { action: "auth.signed_in", outcome: "ok" });

    const { results } = await auditedBatch<never>(
      testEnv, ctx, ORG,
      { action: "send.cancelled", outcome: "ok", subject: "snd_absent" },
      (entry) => [entry, testEnv.CATALOG.prepare(
        "UPDATE send_manifests SET state = 'cancelled' WHERE id = ? AND state = 'held'",
      ).bind("snd_absent")],
      { sql: "SELECT 1 FROM send_manifests WHERE id = ? AND state = 'held'", params: ["snd_absent"] },
    );

    // Neither statement did anything, and no sequence number was spent — so verification is unaffected.
    expect(results[0]?.meta.changes ?? 0).toBe(0);
    expect(await entryCount()).toBe(1);
    const verdict = await verifyChain(testEnv, ORG);
    expect(verdict.intact).toBe(true);
    expect(verdict.checked).toBe(1);
  });

  it("rolls the state change back with the entry, which is the assumption everything else rests on", async () => {
    const ctx = createSystemCtx();
    // A row standing in for state a real action would change.
    await testEnv.CATALOG.prepare("INSERT INTO login_attempts (id, org_id, email, at) VALUES (?,?,?,?)")
      .bind("att_state", ORG, "victim@example.com", "2026-08-05T00:00:00.000Z").run();

    const doomed = await collidingInsert("att_rollback");
    await expect(
      auditedBatch(testEnv, ctx, ORG, { action: "auth.revoked_all_sessions", outcome: "ok" }, (entry) => [
        entry,
        testEnv.CATALOG.prepare("DELETE FROM login_attempts WHERE id = ?").bind("att_state"),
        doomed,
      ]),
    ).rejects.toThrow();

    // If D1 did not run a batch as one transaction, the delete would have stuck and the entry would
    // not — a state change with no record, which is precisely the hole this design closes. The whole
    // argument for putting the entry in the caller's batch depends on this being true, so it is
    // asserted rather than assumed.
    const survivor = await testEnv.CATALOG.prepare("SELECT id FROM login_attempts WHERE id = ?")
      .bind("att_state").first<{ id: string }>();
    expect(survivor?.id).toBe("att_state");
    expect(await entryCount()).toBe(0);
  });

  it("gives concurrent writers distinct positions rather than losing one", async () => {
    const ctx = createSystemCtx();
    // Both read the same tip, so one loses on UNIQUE(org_id, seq) and retries against the new one.
    await Promise.all([
      auditedBatch(testEnv, ctx, ORG, { action: "send.handed_over", outcome: "ok" }, (e) => [e]),
      auditedBatch(testEnv, ctx, ORG, { action: "send.refused", outcome: "refused" }, (e) => [e]),
      auditedBatch(testEnv, ctx, ORG, { action: "send.throttled", outcome: "refused" }, (e) => [e]),
    ]);

    const rows = await testEnv.CATALOG.prepare("SELECT seq FROM audit_entries ORDER BY seq")
      .all<{ seq: number }>();
    expect(rows.results.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect((await verifyChain(testEnv, ORG)).intact).toBe(true);
  });
});
