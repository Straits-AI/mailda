import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { clockOnInbound, stopClockForConversation, sweepResponseClocks } from "../src/response-clock.ts";

/**
 * The first-response clock (#41, decided in migration 0017).
 *
 * One clock, from the oldest unanswered inbound message to the first hand-over. No pause, no
 * `waiting-on-customer`, and **no default target** — a mailbox that promises nothing carries no clock, which
 * is the shipped state.
 *
 * The properties worth pinning are the ones a careless refactor breaks: a second unanswered message must not
 * push the deadline out, a mailbox with no target must stay out of the sweep entirely, and the sweep must be
 * a scan that survives being run twice or skipped.
 */

const testEnv = env as unknown as Env;
const ORG = "org_clock";
const PROMISED = "mbx_promised";     // first_response_minutes = 60
const UNPROMISED = "mbx_unpromised"; // NULL — no service level

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

/** A case, and its conversation, in one mailbox. */
async function aCase(mailboxId: string, root: string): Promise<{ caseId: string; conversationId: string }> {
  const ctx = createSystemCtx();
  const conversationId = ctx.id("cnv");
  const caseId = ctx.id("cas");
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      `INSERT INTO conversations (id, org_id, root_rfc_id, grouped_by, merged_into, created_at)
       VALUES (?,?,?, 'root', NULL, ?)`,
    ).bind(conversationId, ORG, root, at),
    testEnv.CATALOG.prepare(
      `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
         created_at) VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
    ).bind(caseId, ORG, conversationId, mailboxId, at, at),
  ]);
  return { caseId, conversationId };
}

async function clockOf(caseId: string) {
  return await testEnv.CATALOG.prepare(
    "SELECT response_due_at, first_response_at, response_breached_at FROM cases WHERE id = ?",
  ).bind(caseId).first<{
    response_due_at: string | null;
    first_response_at: string | null;
    response_breached_at: string | null;
  }>();
}

beforeEach(async () => {
  for (const table of ["cases", "conversations", "mailboxes", "log_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = "2026-08-01T00:00:00.000Z";
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      "INSERT INTO mailboxes (id, org_id, name, created_at, first_response_minutes) VALUES (?,?,?,?,60)",
    ).bind(PROMISED, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO mailboxes (id, org_id, name, created_at, first_response_minutes) VALUES (?,?,?,?,NULL)",
    ).bind(UNPROMISED, ORG, "Archive", at),
  ]);
});

describe("a mailbox that promises nothing carries no clock", () => {
  it("leaves the due time NULL, so the case never enters the sweep", async () => {
    const { caseId } = await aCase(UNPROMISED, "<a@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();

    // The shipped state. A default would be this Node inventing a service level nobody promised.
    expect((await clockOf(caseId))?.response_due_at).toBeNull();
    expect((await sweepResponseClocks(testEnv, atTime(4_000_000_000_000), ORG)).breached).toEqual([]);
  });
});

describe("the clock starts from the oldest unanswered message", () => {
  it("sets the due time from the mailbox's target", async () => {
    const { caseId } = await aCase(PROMISED, "<b@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();

    const clock = await clockOf(caseId);
    // 60 minutes after arrival, in the same shape as every other instant this Node stores — see the
    // format test below for why that matters.
    expect(clock?.response_due_at).toBe("2026-08-10T10:00:00.000Z");
    expect(clock?.first_response_at).toBeNull();
  });

  it("does not push the deadline out when a second message arrives unanswered", async () => {
    const { caseId } = await aCase(PROMISED, "<c@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();
    const first = (await clockOf(caseId))?.response_due_at;

    // The customer chases. They have been waiting since 09:00, not since now — a clock that reset here would
    // reward a busy correspondent with a later deadline, which is backwards.
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:30:00.000Z").run();
    expect((await clockOf(caseId))?.response_due_at).toBe(first);
  });

  it("starts a fresh clock once the case has been answered", async () => {
    const { caseId, conversationId } = await aCase(PROMISED, "<d@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();
    await stopClockForConversation(testEnv, ORG, conversationId, "2026-08-10T09:20:00.000Z");

    // They write again. This is a new wait, and the previous answer does not cover it.
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-11T14:00:00.000Z").run();
    const clock = await clockOf(caseId);
    expect(clock?.response_due_at).toBe("2026-08-11T15:00:00.000Z");
    expect(clock?.first_response_at).toBeNull();
  });
});

describe("hand-over stops it, and only the first one", () => {
  it("records the answer", async () => {
    const { caseId, conversationId } = await aCase(PROMISED, "<e@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();

    const stopped = await stopClockForConversation(testEnv, ORG, conversationId, "2026-08-10T09:41:00.000Z");
    expect(stopped).toBe(1);
    expect((await clockOf(caseId))?.first_response_at).toBe("2026-08-10T09:41:00.000Z");
  });

  it("ignores a second reply, because the column is the first response", async () => {
    const { caseId, conversationId } = await aCase(PROMISED, "<f@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();
    await stopClockForConversation(testEnv, ORG, conversationId, "2026-08-10T09:41:00.000Z");

    expect(await stopClockForConversation(testEnv, ORG, conversationId, "2026-08-10T11:00:00.000Z")).toBe(0);
    expect((await clockOf(caseId))?.first_response_at).toBe("2026-08-10T09:41:00.000Z");
  });
});

describe("the sweep is a scan, which is the only reason cron's missing retry is acceptable", () => {
  it("records a breach when the due time passes unanswered", async () => {
    const { caseId } = await aCase(PROMISED, "<g@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();

    // 11:00 — an hour past the 10:00 deadline.
    const outcome = await sweepResponseClocks(testEnv, atTime(Date.parse("2026-08-10T11:00:00.000Z")), ORG);
    expect(outcome.breached).toEqual([caseId]);

    const clock = await clockOf(caseId);
    expect(clock?.response_breached_at).not.toBeNull();
    // A breach is an observation about a clock, not a judgement about a person, so it does not change state.
    const state = await testEnv.CATALOG.prepare("SELECT state FROM cases WHERE id = ?")
      .bind(caseId).first<{ state: string }>();
    expect(state?.state).toBe("open");
  });

  it("changes nothing when run twice", async () => {
    const { caseId } = await aCase(PROMISED, "<h@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();
    const at = atTime(Date.parse("2026-08-10T11:00:00.000Z"));

    const first = await sweepResponseClocks(testEnv, at, ORG);
    const recorded = (await clockOf(caseId))?.response_breached_at;
    const second = await sweepResponseClocks(testEnv, at, ORG);

    expect(first.breached).toEqual([caseId]);
    // Already recorded, so not breached again — and the timestamp is the first observation, not the latest.
    expect(second.breached).toEqual([]);
    expect((await clockOf(caseId))?.response_breached_at).toBe(recorded);
  });

  it("does not breach a case that was answered in time", async () => {
    const { caseId, conversationId } = await aCase(PROMISED, "<i@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();
    await stopClockForConversation(testEnv, ORG, conversationId, "2026-08-10T09:30:00.000Z");

    const outcome = await sweepResponseClocks(testEnv, atTime(Date.parse("2026-08-10T11:00:00.000Z")), ORG);
    expect(outcome.breached).toEqual([]);
    expect((await clockOf(caseId))?.response_breached_at).toBeNull();
  });

  it("catches up after being skipped, rather than depending on the last run", async () => {
    // Cron documents no retry. A week of missed invocations must be repaired by the next one — which is true
    // of a query over due rows and false of a cursor.
    const cases = [];
    for (let i = 0; i < 3; i++) {
      const { caseId } = await aCase(PROMISED, `<j${i}@example.net>`);
      await clockOnInbound(testEnv, ORG, caseId, `2026-08-0${i + 1}T09:00:00.000Z`).run();
      cases.push(caseId);
    }
    const outcome = await sweepResponseClocks(testEnv, atTime(Date.parse("2026-08-20T00:00:00.000Z")), ORG);
    expect(outcome.breached.sort()).toEqual(cases.sort());
  });

  it("does not breach a case answered between the read and the write", async () => {
    const { caseId, conversationId } = await aCase(PROMISED, "<k@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T09:00:00.000Z").run();
    // Simulating the race: the answer lands, then the sweep's UPDATE runs with its predicate still requiring
    // `first_response_at IS NULL`. The conflict is the signal, again.
    await stopClockForConversation(testEnv, ORG, conversationId, "2026-08-10T10:59:00.000Z");
    await sweepResponseClocks(testEnv, atTime(Date.parse("2026-08-10T11:00:00.000Z")), ORG);
    expect((await clockOf(caseId))?.response_breached_at).toBeNull();
  });
});

describe("the due time is stored in the same format the sweep compares against", () => {
  it("does not breach a case whose deadline is later today", async () => {
    const { caseId } = await aCase(PROMISED, "<l@example.net>");
    // Arrives at 22:00 with a 60-minute target, so it is due at 23:00 — twelve hours in the future.
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T22:00:00.000Z").run();

    const outcome = await sweepResponseClocks(testEnv, atTime(Date.parse("2026-08-10T11:00:00.000Z")), ORG);

    // The sweep compares `response_due_at <= now` as strings, and `now` is an ISO-8601 instant with a 'T'.
    // SQLite's `datetime()` returns 'YYYY-MM-DD HH:MM:SS' with a space — and ' ' (0x20) sorts before 'T'
    // (0x54), so every same-day deadline compares as already past. This case would be reported breached
    // twelve hours before its deadline.
    expect(outcome.breached).toEqual([]);
    expect((await clockOf(caseId))?.response_breached_at).toBeNull();
  });

  it("stores an instant a string comparison can order correctly", async () => {
    const { caseId } = await aCase(PROMISED, "<m@example.net>");
    await clockOnInbound(testEnv, ORG, caseId, "2026-08-10T22:00:00.000Z").run();
    const due = (await clockOf(caseId))?.response_due_at;
    // Same shape as `new Date(...).toISOString()`, which is the other side of every comparison.
    expect(due).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(due! <= new Date(Date.parse("2026-08-10T11:00:00.000Z")).toISOString()).toBe(false);
  });
});
