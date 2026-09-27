import {
  createExecutionContext, env, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFrozenCtx, createSystemCtx } from "@mailda/runtime";

import { STALLED_OUTBOX_MS } from "../src/doctor/evidence.ts";
import worker from "../src/index.ts";
import { drainOutbox, nextWake, pendingEvents, retryDelay } from "../src/outbox.ts";
import { dispatch } from "../src/pipeline.ts";
import { armSweeper } from "../src/routes/support.ts";

/**
 * The outbox publisher (`src/outbox.ts`): one publisher, the sweeper's alarm, armed for now on acceptance; a
 * failed event backs off on its own row; the minute cron re-arms a sweeper that lost its alarm.
 */

const testEnv = env as unknown as Env;
const ORG = "org_outbox";
const MAILBOX = "mbx_outbox";
const ADDRESS = "desk@outbox.example";
/** Registered, and its handler finds no receipt and returns: an event that publishes cleanly. */
const CLEAN = { topic: "mail.ingress.accepted", payload: '{"receiptId":"rcpt_absent"}' };
/** No handler: `dispatch` throws, so the event fails every time. */
const POISON = { topic: "probe.unregistered", payload: "{}" };

const sweeper = () => testEnv.OUTBOX_SWEEPER.getByName("node");
const alarmAt = () => runInDurableObject(sweeper(), (_instance, state) => state.storage.getAlarm());
/**
 * One pass, called directly. The platform fires an alarm set for now on its own, so a test that armed one and
 * then ran it could race that firing; calling the handler is the same pass without the race.
 */
const pass = () => runInDurableObject(sweeper(), (instance) => instance.alarm!());

/**
 * Armed for now, or already fired and done its work: the two states a correct arm can be observed in. An alarm
 * set later than now, or none that ever published the event, is the failure.
 */
async function wokeNowFor(id: string): Promise<boolean> {
  const armed = await alarmAt();
  return armed === null ? publishedWithin(id, 2_000) : armed <= Date.now();
}

async function enqueue(
  kind: { topic: string; payload: string },
  options: { ageMs?: number; attempts?: number; retryAt?: string | null } = {},
): Promise<string> {
  const ctx = createSystemCtx();
  const id = ctx.id("evt");
  await testEnv.CATALOG.prepare(
    `INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at, attempts, retry_at)
     VALUES (?,?,?,?,NULL,?,?,?)`,
  ).bind(
    id, ORG, kind.topic, kind.payload, new Date(ctx.now() - (options.ageMs ?? 0)).toISOString(),
    options.attempts ?? 0, options.retryAt ?? null,
  ).run();
  return id;
}

async function row(id: string) {
  return testEnv.CATALOG.prepare("SELECT published_at, attempts, retry_at FROM outbox WHERE id = ?")
    .bind(id).first<{ published_at: string | null; attempts: number; retry_at: string | null }>();
}

/** Published, by the alarm this test ran or by the platform firing the same alarm first. */
async function publishedWithin(id: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await row(id))?.published_at != null) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function cron(): Promise<void> {
  const execution = createExecutionContext();
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: "* * * * *", noRetry: () => undefined } as ScheduledController,
    testEnv, execution,
  );
  await waitOnExecutionContext(execution);
}

async function logged(event: string) {
  return (await testEnv.CATALOG.prepare("SELECT detail FROM log_entries WHERE event = ? ORDER BY at")
    .bind(event).all<{ detail: string | null }>()).results.map((entry) => JSON.parse(entry.detail ?? "{}"));
}

beforeEach(async () => {
  for (const table of ["outbox", "log_entries", "messages", "mailbox_items", "ingress_receipts", "addresses",
    "mailboxes", "node_claim", "cases"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = new Date().toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)")
      .bind(at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Desk", at),
    testEnv.CATALOG.prepare("INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)")
      .bind("adr_outbox", ORG, ADDRESS, MAILBOX, at),
  ]);
  // Alarms outlive a test's storage, so each test starts with none.
  await runInDurableObject(sweeper(), (_instance, state) => state.storage.deleteAlarm());
});

afterEach(async () => {
  /*
   * A test that armed the sweeper for now leaves an alarm the platform fires on its own, and a pass still running
   * when the next test seeds its rows would re-arm for them. Run what is pending, then give a firing already in
   * progress time to finish (a pass here takes tens of milliseconds).
   */
  await runDurableObjectAlarm(sweeper());
  await new Promise((resolve) => setTimeout(resolve, 150));
});

describe("one publisher, and it starts at once", () => {
  it("arms the sweeper for now when a message is accepted, and that alarm lists it", async () => {
    /*
     * The email handler's whole part in publication. It used to arm the alarm five seconds out beside a comment
     * promising an in-request fast path that did not exist, so every message waited at least five seconds.
     */
    const message = {
      from: "customer@example.net",
      to: ADDRESS,
      headers: new Headers({ "message-id": "<outbox-now@example.net>" }),
      raw: new Response("From: customer@example.net\r\nSubject: Where is it\r\n\r\nhello\r\n").body,
      setReject: () => { throw new Error("a routed address was refused"); },
    } as unknown as ForwardableEmailMessage;
    const execution = createExecutionContext();
    await worker.email!(message, testEnv, execution);
    await waitOnExecutionContext(execution);

    const event = await testEnv.CATALOG.prepare("SELECT id FROM outbox LIMIT 1").first<{ id: string }>();
    expect(await wokeNowFor(event!.id)).toBe(true);

    await pass();
    expect(await publishedWithin(event!.id, 2_000)).toBe(true);
    const listed = await testEnv.CATALOG.prepare(
      "SELECT m.subject FROM messages m JOIN ingress_receipts r ON r.id = m.ingress_receipt_id WHERE r.envelope_to = ?",
    ).bind(ADDRESS).first<{ subject: string }>();
    expect(listed?.subject).toBe("Where is it");
  });

  it("publishes an event however young, so an alarm armed just before the message still takes it", async () => {
    /*
     * The lapse. Found in the round-3 Chromium flow (receipts delivered 0.5 s after a page load, unpublished
     * minutes later) and reproduced on a local Node on 27 September 2026: not in the inbox after 40 s. The page
     * load's alarm fired with the message younger than the five-second claim cutoff, claimed nothing, and did
     * not re-arm. With no cutoff there is no window in which an accepted event is deliberately left alone.
     */
    const id = await enqueue(CLEAN);
    await pass();
    expect((await row(id))?.published_at).not.toBeNull();
  });

  it("pulls a distant alarm in rather than waiting for it", async () => {
    // A send held for an hour sets the alarm an hour out; a message arriving now must not wait for it.
    const later = Date.now() + 60 * 60 * 1000;
    await runInDurableObject(sweeper(), (_instance, state) => state.storage.setAlarm(later));
    await armSweeper(testEnv);
    const armed = await alarmAt();
    // Now, or already fired and gone: either way not the hour-away alarm.
    expect(armed === null || armed <= Date.now()).toBe(true);
  });

  it("keeps a wake set during a pass rather than overwriting it with its own later one", async () => {
    /*
     * While `alarm()` runs, an acceptance sets an alarm for now. The pass then re-arms for its failed event's
     * backoff, five seconds out, and a plain `setAlarm` there would drop the acceptance's wake. Called directly
     * so the earlier wake is visible to it, as the platform makes one set mid-pass visible.
     */
    await enqueue(POISON);
    const earlier = Date.now() + 2_000;
    const after = await runInDurableObject(sweeper(), async (instance, state) => {
      await state.storage.setAlarm(earlier);
      await instance.alarm!();
      return state.storage.getAlarm();
    });
    expect(after).toBe(earlier);
  });

  it("re-arms at a failed event's backoff, not sooner and not never", async () => {
    const id = await enqueue(POISON);
    await pass();

    const failed = await row(id);
    expect(failed?.attempts).toBe(1);
    expect(failed?.published_at).toBeNull();
    expect(await alarmAt()).toBe(Date.parse(failed!.retry_at!));
  });

  it("lets the alarm lapse once nothing is left", async () => {
    const id = await enqueue(CLEAN);
    await pass();
    expect((await row(id))?.published_at).not.toBeNull();
    expect(await alarmAt()).toBeNull();
  });

  it("wakes for the sooner of its two kinds of work, and never at once for a send it could not move", () => {
    const now = Date.now();
    // A due send the pass could not move (throttled, or past the dispatch limit) reports its own time.
    expect(nextWake(null, now - 1, now)).toBe(now + retryDelay(1));
    // A claimable inbound event is taken as it is: the pass that finds it leaves less claimable than it found.
    expect(nextWake(now - 1, null, now)).toBe(now - 1);
    expect(nextWake(now + 60_000, now + 3_600_000, now)).toBe(now + 60_000);
    expect(nextWake(now + 3_600_000, now + 60_000, now)).toBe(now + 60_000);
    expect(nextWake(null, null, now)).toBeNull();
  });
});

describe("a failed event waits, and nothing else does", () => {
  it("doubles the wait from five seconds and caps it at five minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(retryDelay))
      .toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  });

  it("keeps its longest wait inside doctor's stalled threshold, so an event reported as failing is still tried", () => {
    expect(retryDelay(100)).toBeLessThan(STALLED_OUTBOX_MS);
  });

  it("records the attempt before the handler runs, so a pass killed mid-handler leaves a lease", async () => {
    const ctx = createFrozenCtx(Date.now());
    const id = await enqueue(CLEAN);
    let during: Awaited<ReturnType<typeof row>> = null;
    await drainOutbox(testEnv, ctx, async () => { during = await row(id); });
    expect(during!.attempts).toBe(1);
    expect(Date.parse(during!.retry_at!)).toBe(ctx.now() + 5_000);
    // And the lease holds: until then, no pass claims it again.
    expect((await pendingEvents(testEnv, ctx)).map((event) => event.id)).not.toContain(id);
  });

  it("runs an event once when two drains race for it: the claim is a write, not a read", async () => {
    const id = await enqueue(CLEAN);
    const ctx = createSystemCtx();
    let runs = 0;
    const slow = async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 50)); };
    const [first, second] = await Promise.all([drainOutbox(testEnv, ctx, slow), drainOutbox(testEnv, ctx, slow)]);
    expect(runs).toBe(1);
    expect(first.drained + second.drained).toBe(1);
    expect((await row(id))?.attempts).toBe(1);
  });

  it("reaches a new event past 25 older ones that keep failing", async () => {
    /*
     * The claim used to be the 25 oldest unpublished rows. Twenty-five events that always fail (a missing
     * evidence object, a handler bug) were then the whole of every pass, and no mail behind them was ever
     * published.
     */
    const backingOff = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 25; i += 1) await enqueue(POISON, { ageMs: 60_000, attempts: 1, retryAt: backingOff });
    const fresh = await enqueue(CLEAN);

    const ctx = createSystemCtx();
    const { drained } = await drainOutbox(testEnv, ctx, (event) => dispatch(testEnv, ctx, event));
    expect(drained).toBe(1);
    expect((await row(fresh))?.published_at).not.toBeNull();
  });

  it("claims the events with fewest attempts first, so one that kills its pass cannot head the next", async () => {
    /*
     * A pass killed outright (CPU, memory) never reaches a `catch`, and its lease can run out before the next
     * pass starts. Ordered by age alone, the killer, older than everything behind it, would head every pass.
     */
    const due = new Date(Date.now() - 1_000).toISOString();
    const killedThrice = await enqueue(CLEAN, { ageMs: 120_000, attempts: 3, retryAt: due });
    const killedOnce = await enqueue(CLEAN, { ageMs: 60_000, attempts: 1, retryAt: due });
    const fresh = await enqueue(CLEAN);

    const order: string[] = [];
    await drainOutbox(testEnv, createSystemCtx(), async (event) => { order.push(event.id); });
    expect(order).toEqual([fresh, killedOnce, killedThrice]);
  });

  it("backs off a failing event and logs it at each doubling of its attempts", async () => {
    const ctx = createFrozenCtx(Date.now());
    const id = await enqueue(POISON);
    for (let pass = 1; pass <= 5; pass += 1) {
      const { failed } = await drainOutbox(testEnv, ctx, (event) => dispatch(testEnv, ctx, event));
      expect(failed).toBe(1);
      const after = await row(id);
      expect(after?.attempts).toBe(pass);
      expect(Date.parse(after!.retry_at!)).toBe(ctx.now() + retryDelay(pass));
      ctx.advance(retryDelay(pass));
    }
    const lines = await logged("outbox.handler_failed");
    expect(lines.map((detail) => detail.attempts)).toEqual([1, 2, 4]);
    expect(lines[0]).toMatchObject({ eventId: id, topic: POISON.topic });
  });
});

describe("the minute cron's backstop", () => {
  it("arms the sweeper for an event that is due and has no alarm", async () => {
    // The arming RPC after acceptance failed, or the platform gave up on the alarm: the row is due, nothing wakes.
    const id = await enqueue(CLEAN, { ageMs: 90_000 });
    expect(await alarmAt()).toBeNull();
    await cron();
    expect(await wokeNowFor(id)).toBe(true);
  });

  it("does not cost the jobs after it their run when it fails", async () => {
    // An unreadable outbox fails the backstop, which must not end the sweep and take the first-response clock,
    // the job after it, with it.
    const due = new Date(Date.now() - 60_000).toISOString();
    await testEnv.CATALOG.prepare(
      `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, created_at, response_due_at)
       VALUES ('cas_outbox', ?, 'cnv_outbox', ?, 'open', ?, ?, ?)`,
    ).bind(ORG, MAILBOX, due, due, due).run();
    await testEnv.CATALOG.prepare("ALTER TABLE outbox RENAME TO outbox_hidden").run();
    try {
      await cron();
    } finally {
      await testEnv.CATALOG.prepare("ALTER TABLE outbox_hidden RENAME TO outbox").run();
    }
    expect(await logged("outbox.backstop_failed")).toHaveLength(1);
    expect((await testEnv.CATALOG.prepare("SELECT response_breached_at FROM cases WHERE id = 'cas_outbox'")
      .first<{ response_breached_at: string | null }>())?.response_breached_at).not.toBeNull();
  });

  it("leaves a failing event to its backoff rather than waking every minute for it", async () => {
    await enqueue(POISON, { ageMs: 90_000, attempts: 3, retryAt: new Date(Date.now() + 60_000).toISOString() });
    await cron();
    // Waits out a pass the cron might have started: while one runs, `getAlarm()` answers null to every caller,
    // so a wrongful arm checked mid-pass would look like none. After it, that pass re-arms for the backoff.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await alarmAt()).toBeNull();
  });
});

describe("a failure on the publication path is logged, not swallowed", () => {
  it("logs an arm that could not reach the sweeper", async () => {
    const unreachable = {
      ...testEnv,
      OUTBOX_SWEEPER: { getByName: () => { throw new Error("sweeper unreachable"); } },
    } as unknown as Env;
    await armSweeper(unreachable);
    expect((await testEnv.CATALOG.prepare("SELECT message FROM log_entries WHERE event = 'outbox.arm_failed'")
      .first<{ message: string }>())?.message).toBe("sweeper unreachable");
  });

  it("logs an outbound sweep that failed in the alarm, and still re-arms for inbound work", async () => {
    const id = await enqueue(POISON);
    await testEnv.CATALOG.prepare("ALTER TABLE node_claim RENAME TO node_claim_hidden").run();
    try {
      await pass();
    } finally {
      await testEnv.CATALOG.prepare("ALTER TABLE node_claim_hidden RENAME TO node_claim").run();
    }
    expect(await logged("outbound.sweep_failed")).toEqual([{ via: "alarm" }]);
    expect(await alarmAt()).toBe(Date.parse((await row(id))!.retry_at!));
  });
});

describe("doctor tells a failing event from a sweeper that is not running", () => {
  it("counts the two apart and gives each its own fix", async () => {
    const { checkOutbox } = await import("../src/doctor/evidence.ts");
    const hourAgo = 60 * 60 * 1000;
    await enqueue(CLEAN, { ageMs: hourAgo });
    await enqueue(POISON, { ageMs: hourAgo, attempts: 12, retryAt: new Date(Date.now() + 60_000).toISOString() });

    const [finding] = await checkOutbox(testEnv, createSystemCtx());
    expect(finding!.ok).toBe(false);
    expect(finding!.detail).toContain("2 unpublished event(s) older than 600s (1 tried and failing, 1 never tried)");
    expect(finding!.fix).toContain("outbox.handler_failed");
    // A pass the platform killed leaves an attempt and no log entry, so the log is not the whole answer.
    expect(finding!.fix).toContain("no entry");
    expect(finding!.fix).toContain("alarm is not firing");
  });

  it("fails the finding, rather than reporting a clean outbox, when the outbox cannot be read", async () => {
    const { checkOutbox } = await import("../src/doctor/evidence.ts");
    await testEnv.CATALOG.prepare("ALTER TABLE outbox RENAME TO outbox_hidden").run();
    let finding: Awaited<ReturnType<typeof checkOutbox>>[number] | undefined;
    try {
      [finding] = await checkOutbox(testEnv, createSystemCtx());
    } finally {
      await testEnv.CATALOG.prepare("ALTER TABLE outbox_hidden RENAME TO outbox").run();
    }
    expect(finding!.ok).toBe(false);
    expect(finding!.detail).toContain("could not be read");
    // A catalog outage lands in the same branch as a missing migration, so the fix names both.
    expect(finding!.fix).toContain("catalog_reachable");
  });
});
