import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "@mailda/evidence";
import { BUDGETS } from "@mailda/budgets";
import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { grant } from "../src/access.ts";
import { metering } from "../src/cost-meter.ts";
import { interpret, type RunSteps } from "../src/butler/interpret.ts";
import { placeButlerPause } from "../src/butler/pause-acts.ts";
import { deliveryFacts, triggerButlers } from "../src/butler/trigger.ts";
import { createButlerDraft, publishButler } from "../src/butlers.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { putEvidence } from "../src/evidence-store.ts";

/**
 * What asking the Butler pause costs, **measured** (#75) — `docs/receipts/butler-pause.md`.
 *
 * ## Why this needed measuring rather than counting, and why the answer is zero
 *
 * The check asks five questions per published Butler at trigger time — is it paused, with what reason, since
 * when, how long a chain has it made itself, and is the delivery in front of us part of one — and three more
 * once per invocation of every live run. Read as prose that is two more statements on the ingress path, which
 * #50 had just measured at three subrequests in total.
 *
 * It is **none**, because both sets are correlated sub-selects on statements that were already being issued.
 * That is a claim about I/O, so it is measured rather than reasoned: `policy-evaluation-cost.md` records #60's
 * own resolution counting its cost by reading and being right about the ceiling and wrong about the cost.
 *
 * **How a zero is asserted without a before-and-after in one process.** The trigger's statements are
 * enumerable — the delivery facts, and the published-version listing — so the enforcement is that it issues
 * exactly two D1 executions **plus the budget**. Written that way, the figure is load-bearing rather than
 * decorative: splitting the pause read into a statement of its own fails this test until somebody edits
 * `docs/receipts/butler-pause.md` and re-runs `pnpm receipts`, which is the only way to change a number here.
 *
 * ## The instrument
 *
 * `src/cost-meter.ts`, which counts **executions** rather than `prepare`, prices a `batch()` as the one round
 * trip it is, and sees Durable Object and workflow calls — all of which `doctor`'s own meter gets wrong.
 *
 * Real `workerd` under `vitest-pool-workers`, against a real D1 and R2. **Not a deployed Node**: miniflare's
 * D1 is a local SQLite, so what is measured is the *number of operations Mailda performs*, which is what the
 * subrequest budget is spent in, and not their latency.
 */

const testEnv = env as unknown as Env;
const ORG = "org_bpcost";
const MAILBOX = "mbx_bpcost";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_admin_bpc";

const T0 = 2_700_000_000_000;
const ADDED = BUDGETS["butler.pause_check_added_subrequests"];

/** The trigger's own statements: the delivery facts, and the published-version listing. Nothing else. */
const TRIGGER_STATEMENTS = 2;

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (prefix) => system.id(prefix), random: (n) => system.random(n) };
}

function inlineSteps(): RunSteps {
  return {
    do: async <T>(_name: string, body: () => Promise<T>): Promise<T> => await body(),
    sleep: async (): Promise<void> => {},
    waitForEvent: async (): Promise<unknown> => ({ released: true }),
  };
}

async function aDelivery(ctx: Ctx, inReplyTo: string | null = null): Promise<string> {
  const at = new Date(ctx.now()).toISOString();
  const raw = utf8("Subject: Invoice\r\nFrom: customer@example.net\r\n\r\nWhere is it?\r\n");
  const stored = await putEvidence(testEnv, `${ORG}/raw/${ctx.id("k")}.eml`, raw);
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, "customer@example.net", ADDRESS, raw.byteLength, at,
    stored.blobKey, stored.plaintextSha256, ctx.id("pe")).run();
  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, `<r-${ctx.id("r")}@example.net>`);
  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id, parse_error, in_reply_to)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
    `in-${messageId}@example.net`, ctx.id("thr"), "Invoice", "customer@example.net",
    at, at, receiptId, at, conversationId, inReplyTo).run();
  return messageId;
}

const ACKNOWLEDGE = [
  {
    id: "reply", type: "draft", mailboxId: "${event.mailbox_id}",
    subject: "Re: ${event.subject}", body: "Thanks.", inReplyTo: "${event.message_id}",
    as: "ack", next: "propose",
  },
  { id: "propose", type: "mail.send.propose", draft: "${steps.ack}", next: null },
];

async function published(ctx: Ctx, name: string): Promise<{ butlerId: string; versionId: string }> {
  const source = JSON.stringify({
    apiVersion: "mailda/v1", kind: "Butler",
    metadata: { name, owner: "team:support" },
    trigger: { event: "mail.received", mailbox: ADDRESS },
    entry: "reply", nodes: ACKNOWLEDGE,
  });
  const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, { name, source });
  const version = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
  return { butlerId: draft.butlerId, versionId: version.versionId };
}

async function factsFor(messageId: string): Promise<Record<string, unknown>> {
  // The production function. A copy of its statement is a fixture that stops matching the fact set the
  // moment it grows — which is what #52 found in all four of these files when `return_path` arrived.
  const facts = await deliveryFacts(testEnv, ORG, messageId);
  if (facts === null) throw new Error(`no delivery facts for ${messageId}`);
  return facts;
}

/** Runs the Butler over one delivery and returns the Message-ID its proposed send carries. */
async function runAndReply(
  ids: { butlerId: string; versionId: string }, messageId: string, at: number,
): Promise<string> {
  await interpret(testEnv, atTime(at), {
    orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
    trigger: { event: "mail.received", key: messageId, facts: await factsFor(messageId) },
  }, inlineSteps(), `${ids.versionId}-${messageId}`);
  const row = await testEnv.CATALOG.prepare(
    `SELECT s.rfc_message_id FROM butler_run_effects e
       JOIN send_manifests s ON s.org_id = e.org_id AND s.id = e.subject
      WHERE e.org_id = ? AND e.run_id = ? LIMIT 1`,
  ).bind(ORG, `${ids.versionId}-${messageId}`).first<{ rfc_message_id: string }>();
  return row!.rfc_message_id;
}

beforeEach(async () => {
  for (const table of [
    "butler_pauses", "butler_run_effects", "butler_runs", "butler_versions", "butlers", "cases",
    "conversations", "messages", "ingress_receipts", "relationship_tuples", "mailboxes", "addresses",
    "drafts", "send_manifests", "send_recipients", "send_counters", "audit_entries", "log_entries", "outbox",
    "users", "policies", "policy_versions", "policy_stages", "approvals", "approval_stages",
    "approval_decisions", "domain_pauses", "notifications",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = atTime(T0);
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(ADMIN, ORG, "admin@local.invalid", at),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, ADMIN, ORG, at),
  ]);
});

describe("what the Butler pause costs the ingress path", () => {
  it("adds nothing at all to the trigger, paused or not", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge");
    for (const relation of ["send.propose", "mailbox.content.read"] as const) {
      await grant(testEnv, ctx, ORG, ADMIN, { subjectId: ids.butlerId, relation, objectId: MAILBOX });
    }

    const clean = await aDelivery(atTime(T0 + 1000));
    const live = metering(testEnv);
    const outcome = await triggerButlers(live.env, atTime(T0 + 1000), ORG, clean.length === 0 ? "" : clean);
    expect(outcome.started).toHaveLength(1);
    console.log(`MEASURE trigger scenario=no-pause-no-loop subrequests=${live.cost.subrequests} `
      + `d1=${live.cost.d1Executions} workflow=${live.cost.workflowCalls} added_budget=${ADDED}`);
    // Two statements plus one `create`. The pause and both loop counts are sub-selects on the second, so the
    // budget below is what a split would have to raise before this passes again.
    expect(live.cost.d1Executions).toBe(TRIGGER_STATEMENTS + ADDED);
    expect(live.cost.workflowCalls).toBe(1);
    expect(live.cost.subrequests).toBe(TRIGGER_STATEMENTS + ADDED + 1);

    await placeButlerPause(testEnv, atTime(T0 + 2000), ORG, {
      butlerId: ids.butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "measured", trippedBy: clean,
    });
    const second = await aDelivery(atTime(T0 + 3000));
    const stopped = metering(testEnv);
    const refused = await triggerButlers(stopped.env, atTime(T0 + 3000), ORG, second);
    expect(refused.paused).toEqual([ids.butlerId]);
    console.log(`MEASURE trigger scenario=paused subrequests=${stopped.cost.subrequests} `
      + `d1=${stopped.cost.d1Executions} workflow=${stopped.cost.workflowCalls}`);
    /*
     * **Cheaper than the live path**, and that is a design property rather than an accident: a paused Butler
     * starts no run, so the `create` never happens. A control that exists to stop a runaway making the
     * runaway's own path more expensive would be the wrong direction.
     */
    expect(stopped.cost.workflowCalls).toBe(0);
    expect(stopped.cost.subrequests).toBe(TRIGGER_STATEMENTS + ADDED);
    expect(stopped.cost.subrequests).toBeLessThan(live.cost.subrequests);
  });

  it("prices the one delivery that places a pause, which is paid once and never per delivery", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge");
    for (const relation of ["send.propose", "mailbox.content.read"] as const) {
      await grant(testEnv, ctx, ORG, ADMIN, { subjectId: ids.butlerId, relation, objectId: MAILBOX });
    }

    // A real chain: one ordinary delivery, then a reply to each proposed send in turn, until one more
    // self-provoked delivery would go over the limit.
    let clock = T0 + 1000;
    let latest = await runAndReply(ids, await aDelivery(atTime(clock)), clock);
    for (let link = 0; link < BUDGETS["butler.loop_max_self_provoked_runs"]; link += 1) {
      clock += 60_000;
      latest = await runAndReply(ids, await aDelivery(atTime(clock), latest), clock);
    }

    const tripper = await aDelivery(atTime(clock + 60_000), latest);
    const trip = metering(testEnv);
    const outcome = await triggerButlers(trip.env, atTime(clock + 60_000), ORG, tripper);
    expect(outcome.looped).toEqual([ids.butlerId]);
    console.log(`MEASURE trigger scenario=places-a-pause subrequests=${trip.cost.subrequests} `
      + `d1=${trip.cost.d1Executions} batches=${trip.cost.d1Batches} `
      + `workflow=${trip.cost.workflowCalls}`);
    /*
     * The two the trigger always issues, plus `auditedBatch`'s two: the read of the chain's tip, and the one
     * `batch()` carrying the entry and the insert. No `create`, because no run starts.
     *
     * Asserted structurally rather than against a budget, because it is not a bound on anything: it happens
     * once in a Butler's life, and every delivery after it pays the cheaper paused figure above.
     */
    expect(trip.cost.workflowCalls).toBe(0);
    expect(trip.cost.d1Batches).toBe(1);
    expect(trip.cost.d1Executions).toBe(TRIGGER_STATEMENTS + ADDED + 2);
  });

  it("adds nothing to a run's own invocation either, which is what covers a sleeping instance", async () => {
    /*
     * The second evaluation point. A pause placed while a run is asleep is caught on the read of
     * `subrequests_spent` that already happens once per invocation and already must not be cached — so the
     * engine's fixed cost is unchanged, and `butler.run_cost_engine_fixed` is the figure that says so.
     *
     * Measured here on a `stop`-only Butler, which is the same fixture `butler-run-cost.measure.test.ts` uses
     * for that budget: three statements, and the pause question is inside the second of them.
     */
    const ctx = atTime(T0);
    const source = JSON.stringify({
      apiVersion: "mailda/v1", kind: "Butler", metadata: { name: "halt", owner: "team:support" },
      trigger: { event: "mail.received", mailbox: ADDRESS },
      entry: "halt", nodes: [{ id: "halt", type: "stop", reason: "nothing to do" }],
    });
    const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, { name: "halt", source });
    const version = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
    const messageId = await aDelivery(atTime(T0 + 1000));

    const { env: metered, cost } = metering(testEnv);
    const result = await interpret(metered, atTime(T0 + 1000), {
      orgId: ORG, butlerId: draft.butlerId, butlerVersionId: version.versionId,
      trigger: { event: "mail.received", key: messageId, facts: await factsFor(messageId) },
    }, inlineSteps(), `${version.versionId}-${messageId}`);
    expect(result.state).toBe("stopped");
    console.log(`MEASURE run scenario=stop-only-with-pause-question subrequests=${cost.subrequests} `
      + `d1=${cost.d1Executions} engine_fixed=${BUDGETS["butler.run_cost_engine_fixed"]}`);
    expect(cost.subrequests).toBe(BUDGETS["butler.run_cost_engine_fixed"] + ADDED);
  });
});
