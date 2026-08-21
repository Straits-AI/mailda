import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { utf8 } from "@mailda/evidence";
import { BUDGETS } from "@mailda/budgets";
import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { grant } from "../src/access.ts";
import { interpret, type RunSteps } from "../src/butler/interpret.ts";
import { isPauseReason, loopReading } from "../src/butler/pause.ts";
import { placeButlerPause, resumeButlerPause } from "../src/butler/pause-acts.ts";
import { runRow } from "../src/butler/record.ts";
import { deliveryFacts, triggerButlers } from "../src/butler/trigger.ts";
import { createButlerDraft, editButlerDraft, publishButler } from "../src/butlers.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { runDoctor } from "../src/doctor.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { capabilitiesFor } from "./butler-capabilities.ts";

/**
 * The Butler pause and the loop that places it (#75), end to end.
 *
 * ## What is real here and what is synthesized, said first because it decides what these tests prove
 *
 * Real: D1, R2, the key vault, `sealManifest`, `saveDraft`, `readDraft`, the audit chain, `checkButler`, the
 * published `butler_versions` rows, `triggerButlers`' own statement, and the causal join itself — every hop
 * of which is a column a real path wrote. A manifest's `rfc_message_id` is minted by `sealManifest`; the
 * effect row that ties it to a run is written by `interpret`.
 *
 * Synthesized: **the correspondent.** A self-provoked chain needs somebody on the other end replying to this
 * Node's mail, and no test can have one — so the reply is an inbound message whose `in_reply_to` carries the
 * Message-ID `sealManifest` actually minted, which is exactly the value a compliant mail agent would quote.
 * That is the one substitution, and it is the same one `test/sending-events.test.ts` makes for a provider's
 * webhook.
 *
 * Worth stating alongside it, because it bounds what this feature does today rather than what it looks like it
 * does: a Butler-proposed send is sealed `awaiting butler_release_required` and **cannot leave without a
 * person releasing it**, so a real chain of this shape needs an administrator clicking release at every hop.
 * `docs/receipts/butler-pause.md` records that, and records that this detector's reason to exist is the day
 * that gate moves.
 */

const testEnv = env as unknown as Env;
const ORG = "org_bpause";
const MAILBOX = "mbx_bpause";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_admin_bp";
const OTHER_ADMIN = "usr_admin_bp2";
const NOT_ADMIN = "usr_plain_bp";

const T0 = 2_600_000_000_000;
const LIMIT = BUDGETS["butler.loop_max_self_provoked_runs"];

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (prefix) => system.id(prefix), random: (n) => system.random(n) };
}

/** Executes every step body inline, and records a wait rather than performing it. */
function inlineSteps(): RunSteps & { waited: string[] } {
  const waited: string[] = [];
  return {
    waited,
    do: async <T>(_name: string, body: () => Promise<T>): Promise<T> => await body(),
    sleep: async (): Promise<void> => {},
    waitForEvent: async (name: string): Promise<unknown> => {
      waited.push(name);
      return { released: true };
    },
  };
}

/**
 * One Workflow instance across two invocations, which is what a suspended run actually is.
 *
 * `do` is served from a cache keyed on the step name, exactly as a Workflow serves a completed step. `sleep`
 * and `waitForEvent` return a promise that **never settles** while `suspend` is set: the invocation stops
 * existing, which is what suspension is. It matters that this is not a throw — `interpret` catches every
 * non-`ButlerFault` throw and closes the run `failed engine_fault` on purpose, because a Workflow that throws
 * is retried, so a thrown sentinel would measure that catch instead of the pause. Found by doing exactly that.
 */
class Instance {
  readonly cache = new Map<string, unknown>();
  suspend = true;
  steps(): RunSteps {
    return {
      do: async <T>(name: string, body: () => Promise<T>): Promise<T> => {
        if (this.cache.has(name)) return this.cache.get(name) as T;
        const value = await body();
        this.cache.set(name, value);
        return value;
      },
      sleep: async (): Promise<void> => {
        if (this.suspend) await new Promise<void>(() => {});
      },
      waitForEvent: async (): Promise<unknown> => {
        if (this.suspend) await new Promise<void>(() => {});
        return { released: true };
      },
    };
  }
}

/** Runs `work` and returns `null` if it is still pending after a beat — i.e. the instance suspended. */
async function suspendedOr<T>(work: Promise<T>): Promise<T | null> {
  const asleep = Symbol("asleep");
  const raced = await Promise.race([
    work,
    new Promise<typeof asleep>((resolve) => { setTimeout(() => resolve(asleep), 250); }),
  ]);
  return raced === asleep ? null : raced as T;
}

/**
 * Waits for a run to reach a state, rather than assuming a wall-clock window was long enough.
 *
 * ## The flake this replaces, because it is the interesting part
 *
 * `suspendedOr` above proves one thing: the invocation **did not finish** in 250 ms. The test below then read
 * the run row and asserted `awaiting_release` — which is a *different* claim, and one 250 ms does not
 * establish. On a loaded machine the walk had genuinely not reached its park yet, so the row said `running`
 * and the assertion failed on a run that was about to do exactly the right thing.
 *
 * It failed roughly one run in five once #87 added six fixture-heavy tests to `butler-run.test.ts`, which
 * executes in parallel with this file. The tests did not break it — they made an existing wall-clock
 * assumption visible, which is the same shape `docs/receipts/test-timeout-headroom.md` already records for
 * this suite: *"that is what made this suite look flaky rather than slow."*
 *
 * Polling is sound here precisely because the promise never settles: `waitForEvent` blocks for ever on a
 * parked instance, so there is no race between this loop and the run completing. What is being waited for is
 * a write the run has already committed or is about to.
 *
 * The bound is **half** `test.timeout_ms`, and the halving is the point rather than caution. `testTimeout`
 * is that same budget, so a poll bounded by the whole of it never gets to speak: vitest kills the test first
 * and reports its own generic timeout, and the message below — which names the state the run *did* reach —
 * is the one a person needs. Half is derived rather than chosen, so this file still holds no opinion of its
 * own about how long slow is.
 */
async function until(runId: string, state: string): Promise<Awaited<ReturnType<typeof runRow>>> {
  const patience = BUDGETS["test.timeout_ms"] / 2;
  const deadline = Date.now() + patience;
  for (;;) {
    const row = await runRow(testEnv, ORG, runId);
    if (row?.state === state) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `run ${runId} never reached ${state}; it is ${String(row?.state)} after ${patience}ms `
        + `(half test.timeout_ms=${BUDGETS["test.timeout_ms"]}, so this fires before vitest's own timeout)`,
      );
    }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
}

interface Delivery { messageId: string; conversationId: string }

/**
 * A real delivery: evidence in R2, a receipt, a message and a conversation.
 *
 * `inReplyTo` is what makes this a **reply** to something this Node sent. Stored bracket-stripped, which is
 * the form `mime.ts`'s `messageIds` produces on the real path and the form the causal join compares in.
 */
async function aDelivery(ctx: Ctx, inReplyTo: string | null = null): Promise<Delivery> {
  const at = new Date(ctx.now()).toISOString();
  const raw = utf8(
    `Message-ID: <${ctx.id("x")}@example.net>\r\nSubject: Invoice 4021 query\r\n`
    + "From: customer@example.net\r\n\r\nWhere is my invoice?\r\n",
  );
  const stored = await putEvidence(testEnv, `${ORG}/raw/${ctx.id("k")}.eml`, raw);
  const receiptId = ctx.id("ir");
  await testEnv.CATALOG.prepare(
    `INSERT INTO ingress_receipts (id, org_id, envelope_from, envelope_to, raw_bytes, accepted_at,
                                   blob_key, blob_sha256, provider_event_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(receiptId, ORG, "customer@example.net", ADDRESS, raw.byteLength, at,
    stored.blobKey, stored.plaintextSha256, ctx.id("pe")).run();

  const conversationId = await conversationForDelivery(testEnv, ctx, ORG, `<root-${ctx.id("r")}@example.net>`);
  const messageId = ctx.id("msg");
  await testEnv.CATALOG.prepare(
    `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
                           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id,
                           created_at, conversation_id, parse_error, in_reply_to)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
    `in-${messageId}@example.net`, ctx.id("thr"), "Invoice 4021 query", "customer@example.net",
    at, at, receiptId, at, conversationId, inReplyTo).run();

  return { messageId, conversationId };
}

/** The acknowledgement Butler: a draft and a proposed send, which is what mints a Message-ID to reply to. */
const ACKNOWLEDGE = [
  {
    id: "reply",
    type: "draft",
    mailboxId: "${event.mailbox_id}",
    subject: "Re: ${event.subject}",
    body: "Thanks for your message. Someone will reply shortly.",
    inReplyTo: "${event.message_id}",
    as: "acknowledgement",
    next: "propose",
  },
  { id: "propose", type: "mail.send.propose", draft: "${steps.acknowledgement}", next: null },
];

function sourceFor(name: string, nodes: unknown[], mailbox = ADDRESS, note = ""): string {
  return JSON.stringify({
    apiVersion: "mailda/v1",
    kind: "Butler",
    metadata: { name, owner: "team:support", ...(note === "" ? {} : { description: note }) },
    capabilities: capabilitiesFor(nodes, mailbox),
    trigger: { event: "mail.received", mailbox },
    entry: nodes[0] === undefined ? "stop" : (nodes[0] as { id: string }).id,
    nodes,
  });
}

async function published(ctx: Ctx, name: string, nodes: unknown[], mailbox = ADDRESS): Promise<{
  butlerId: string; versionId: string;
}> {
  const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, {
    name, source: sourceFor(name, nodes, mailbox),
  });
  const version = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
  return { butlerId: draft.butlerId, versionId: version.versionId };
}

/** Runs one Butler over one delivery through `interpret`, with the run id `triggerButlers` would have used. */
async function run(
  ids: { butlerId: string; versionId: string },
  delivery: Delivery,
  at: number,
): Promise<string> {
  const ctx = atTime(at);
  const runId = `${ids.versionId}-${delivery.messageId}`;
  const result = await interpret(testEnv, ctx, {
    orgId: ORG,
    butlerId: ids.butlerId,
    butlerVersionId: ids.versionId,
    trigger: { event: "mail.received", key: delivery.messageId, facts: await factsFor(delivery.messageId) },
  }, inlineSteps(), runId);
  // Asserted rather than assumed: a chain built out of runs that quietly refused would make every loop count
  // in this file a count of zero, which is the vacuous green a fixture is most likely to produce.
  expect(result.state, `run ${runId}: ${result.reason ?? ""}`).not.toBe("failed");
  return runId;
}

/**
 * The `event.*` root — from **the production function**, not a copy of its statement.
 *
 * It was a copy, and the comment above it claimed a fixture that fed the raw row would fault the run. True,
 * and not enough: #52 added `return_path`, the copy did not have it, and the fact a Butler's recipients are
 * derived from would have been absent in every test here. One reader of one statement.
 */
async function factsFor(messageId: string): Promise<Record<string, unknown>> {
  const facts = await deliveryFacts(testEnv, ORG, messageId);
  if (facts === null) throw new Error(`no delivery facts for ${messageId}`);
  return facts;
}

/** The `Message-ID` the run's proposed send actually carries, read off the manifest the effect row names. */
async function messageIdSealedBy(runId: string): Promise<string> {
  const row = await testEnv.CATALOG.prepare(
    `SELECT s.rfc_message_id FROM butler_run_effects e
       JOIN send_manifests s ON s.org_id = e.org_id AND s.id = e.subject
      WHERE e.org_id = ? AND e.run_id = ? LIMIT 1`,
  ).bind(ORG, runId).first<{ rfc_message_id: string }>();
  expect(row, `run ${runId} sealed nothing to reply to`).not.toBeNull();
  return row!.rfc_message_id;
}

/**
 * Builds a chain of `links` self-provoked runs and returns the Message-ID of the newest send in it.
 *
 * Link 0 is an ordinary delivery, so the run it starts is **not** self-provoked; every link after it is a
 * reply to the previous link's send. That means `links` self-provoked runs exist afterwards.
 */
async function chain(ids: { butlerId: string; versionId: string }, links: number): Promise<string> {
  let clock = T0;
  const first = await aDelivery(atTime(clock));
  let latest = await messageIdSealedBy(await run(ids, first, clock));
  for (let link = 0; link < links; link += 1) {
    clock += 60_000;
    const reply = await aDelivery(atTime(clock), latest);
    latest = await messageIdSealedBy(await run(ids, reply, clock));
  }
  return latest;
}

async function armed(ctx: Ctx, butlerId: string): Promise<void> {
  for (const relation of ["send.propose", "mailbox.content.read"] as const) {
    await grant(testEnv, ctx, ORG, ADMIN, { subjectId: butlerId, relation, objectId: MAILBOX });
  }
}

beforeEach(async () => {
  for (const table of [
    "butler_pauses", "butler_run_effects", "butler_runs", "butler_versions", "butlers", "cases",
    "conversations", "messages", "ingress_receipts", "relationship_tuples", "mailboxes", "addresses",
    "drafts", "send_manifests", "send_recipients", "send_counters", "audit_entries", "log_entries", "outbox",
    "users", "node_claim", "policies", "policy_versions", "policy_stages", "approvals", "approval_stages",
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
    ...[ADMIN, OTHER_ADMIN, NOT_ADMIN].map((user) =>
      testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
        .bind(user, ORG, `${user}@local.invalid`, at)),
    ...[ADMIN, OTHER_ADMIN].map((user) => testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, user, ORG, at)),
    /*
     * The **sponsor's** own relations on the mailbox (#51).
     *
     * `publishButler` records the publisher as `published_by`, and that is the sponsor whose live authority
     * caps every version they publish — so a Butler cannot reach a mailbox its publisher cannot reach. An
     * administrator who publishes a Butler that sends from a mailbox holds `send.propose` on it, which is
     * what this seeds. Tests that are *about* the sponsor term revoke it and watch the Butler stop.
     */
    ...(["send.propose", "mailbox.content.read", "mailbox.metadata.read"] as const).map((relation) =>
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, ADMIN, relation, MAILBOX, at)),
  ]);
});

/* ------------------------------------------------------------- the loop and its threshold ---------- */

describe("the loop detector trips at its threshold and not below it", () => {
  it("counts a chain this Butler made itself, and starts a run right up to the limit", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    await armed(ctx, ids.butlerId);

    // `LIMIT - 1` self-provoked runs already happened. The next self-provoked delivery reads LIMIT, and
    // `tripped` is `>` rather than `>=`, so it is allowed: the budget is what is permitted.
    const newest = await chain(ids, LIMIT - 1);
    const atLimit = await aDelivery(atTime(T0 + 600_000), newest);

    const outcome = await triggerButlers(testEnv, atTime(T0 + 600_000), ORG, atLimit.messageId);
    expect(outcome.looped).toEqual([]);
    expect(outcome.paused).toEqual([]);
    expect(outcome.started).toEqual([`${ids.versionId}-${atLimit.messageId}`]);
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM butler_pauses").first<{ n: number }>())
      .toEqual({ n: 0 });
  });

  it("pauses the Butler on the delivery that goes over, and starts no run for it", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    await armed(ctx, ids.butlerId);

    const newest = await chain(ids, LIMIT);
    const overTheLimit = await aDelivery(atTime(T0 + 600_000), newest);

    const outcome = await triggerButlers(testEnv, atTime(T0 + 600_000), ORG, overTheLimit.messageId);
    expect(outcome.looped).toEqual([ids.butlerId]);
    // The whole of what an abuse breaker means: no run at all, not a run that refuses itself.
    expect(outcome.started).toEqual([]);
    expect(await runRow(testEnv, ORG, `${ids.versionId}-${overTheLimit.messageId}`)).toBeNull();

    const pause = await testEnv.CATALOG.prepare(
      "SELECT id, butler_id, reason, detail, tripped_by, placed_at, resumed_at FROM butler_pauses",
    ).first<Record<string, unknown>>();
    expect(pause?.butler_id).toBe(ids.butlerId);
    expect(pause?.reason).toBe("loop_detected");
    // The stored reason is inside the declared vocabulary, which is what stops that list being a declaration
    // nothing reads. `doctor` asks the same question of a row it read back.
    expect(isPauseReason(String(pause?.reason))).toBe(true);
    expect(isPauseReason("something_else")).toBe(false);
    expect(pause?.tripped_by).toBe(overTheLimit.messageId);
    // `placed_at` is not nullable, because there is no request state to distinguish from a pause.
    expect(pause?.placed_at).not.toBeNull();
    expect(pause?.resumed_at).toBeNull();

    // AGENTS.md §3's four parts, in the column an administrator reads before deciding to resume.
    const detail = String(pause?.detail);
    expect(detail).toContain(`butler.loop_max_self_provoked_runs=${LIMIT}`);
    expect(detail).toContain(String(LIMIT + 1));
    expect(detail).toContain(ids.butlerId);
    expect(detail).toContain("docs/receipts/butler-pause.md");
    expect(detail).toContain("Republishing it does NOT clear this");
  });

  it("does not count a reply to another Butler's send, nor an unthreaded delivery", async () => {
    /*
     * Non-vacuity for both halves of the join, and they fail differently if either is dropped.
     *
     * `prior.butler_id = v.butler_id` is what makes the chain *this* Butler's. Without it, a Node with two
     * busy Butlers would pause both for each other's correspondence.
     *
     * `sm.rfc_message_id = m.in_reply_to` is what makes it causal at all. Without it, every delivery would
     * count and this would be a runs-per-window breaker wearing a causal name — the exact conflation
     * `docs/receipts/butler-pause.md` refuses.
     */
    const ctx = atTime(T0);
    const mine = await published(ctx, "acknowledge", ACKNOWLEDGE);
    const theirs = await published(ctx, "also-acknowledge", ACKNOWLEDGE);
    await armed(ctx, mine.butlerId);
    await armed(ctx, theirs.butlerId);

    /*
     * A long chain driven entirely by **their** sends, with **my** Butler running on every one of the same
     * deliveries — which is what really happens, because both listen on the same mailbox.
     *
     * That is the fixture the clause is load-bearing for, and getting it wrong once is why it is spelled out:
     * a first version gave my Butler no runs at all, so dropping `prior.butler_id = v.butler_id` from the
     * chain changed nothing and the test passed against the mutation. Here my Butler has `LIMIT + 2` runs
     * whose triggers are all replies to somebody else's send, so without the clause my count is over the limit
     * and with it my count is zero.
     */
    let clock = T0;
    let delivery = await aDelivery(atTime(clock));
    let newest = await messageIdSealedBy(await run(theirs, delivery, clock));
    await run(mine, delivery, clock);
    for (let link = 0; link <= LIMIT; link += 1) {
      clock += 60_000;
      delivery = await aDelivery(atTime(clock), newest);
      newest = await messageIdSealedBy(await run(theirs, delivery, clock));
      await run(mine, delivery, clock);
    }

    // A reply to their newest send, plus an ordinary unthreaded delivery. Neither is my chain.
    const replyToTheirs = await aDelivery(atTime(T0 + 600_000), newest);
    const outcome = await triggerButlers(testEnv, atTime(T0 + 600_000), ORG, replyToTheirs.messageId);
    // Both listen on the same mailbox, so both were considered. Only theirs is over.
    expect(outcome.looped).toEqual([theirs.butlerId]);
    expect(outcome.started).toEqual([`${mine.versionId}-${replyToTheirs.messageId}`]);

    const unthreaded = await aDelivery(atTime(T0 + 700_000));
    const second = await triggerButlers(testEnv, atTime(T0 + 700_000), ORG, unthreaded.messageId);
    // Theirs is now paused rather than looping again — one pause per Butler, latched.
    expect(second.paused).toEqual([theirs.butlerId]);
    expect(second.looped).toEqual([]);
    expect(second.started).toEqual([`${mine.versionId}-${unthreaded.messageId}`]);
  });

  it("walks the causal chain through indexes rather than scanning every manifest ever sealed", async () => {
    /*
     * Read from the planner rather than asserted in a comment, for the reason 0020 records: an index written
     * on reasoning earned nothing when the plan was finally read. This one matters more than most, because
     * the join sits on the **ingress path** — every delivery asks it, once per published Butler.
     *
     * `sm_by_rfc_message_id` leads on `rfc_message_id` and not on `org_id`, which is a deliberate break with
     * every other index in this schema: written the usual way round it displaced `sm_evidence_changed` in the
     * planner for `doctor`'s evidence check, turning a seek into an empty partial index into a scan of every
     * manifest. Migration 0029 records the observed plan.
     */
    const plan = await testEnv.CATALOG.prepare(
      `EXPLAIN QUERY PLAN
         SELECT 1 FROM messages m
           JOIN send_manifests sm ON sm.org_id = m.org_id AND sm.rfc_message_id = m.in_reply_to
           JOIN butler_run_effects e ON e.org_id = sm.org_id AND e.subject = sm.id
           JOIN butler_runs prior ON prior.org_id = e.org_id AND prior.id = e.run_id
          WHERE m.org_id = ? AND m.id = ? AND prior.butler_id = ?`,
    ).bind(ORG, "msg_anything", "btl_anything").all<{ detail: string }>();
    const plans = plan.results.map((row) => row.detail).join(" | ");
    console.log(`PLAN butler_loop_chain: ${plans}`);
    expect(plans).toContain("sm_by_rfc_message_id");
    expect(plans).toContain("bre_by_subject");
    // The one shape that would make this proportional to the table rather than to the chain.
    expect(plans).not.toContain("SCAN send_manifests");
  });

  it("compares with `>` rather than `>=`, which is the one arithmetic claim worth pinning", () => {
    // Pure arithmetic, so it needs no fixture — and it is the line a refactor is most likely to move by one.
    expect(loopReading({ loop_prior: LIMIT - 1, loop_this: 1 }).tripped).toBe(false);
    expect(loopReading({ loop_prior: LIMIT, loop_this: 1 }).tripped).toBe(true);
    // `loop_this` is a 0/1 from SQL's `EXISTS`, and the reading has to add it rather than ignore it.
    expect(loopReading({ loop_prior: LIMIT, loop_this: 0 }).selfProvoked).toBe(LIMIT);
    expect(loopReading({ loop_prior: LIMIT, loop_this: 1 }).selfProvoked).toBe(LIMIT + 1);
  });
});

/* ------------------------------------------------------------- a paused Butler does not run ------- */

describe("a paused Butler does not run", () => {
  async function paused(ctx: Ctx): Promise<{ butlerId: string; versionId: string; pauseId: string }> {
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    await armed(ctx, ids.butlerId);
    const placed = await placeButlerPause(testEnv, ctx, ORG, {
      butlerId: ids.butlerId,
      butlerName: "acknowledge",
      reason: "loop_detected",
      detail: "placed by the test, with the shape describeLoopTrip produces",
      trippedBy: "msg_placeholder",
    });
    expect(placed).not.toBeNull();
    return { ...ids, pauseId: placed!.pauseId };
  }

  it("starts nothing, seals nothing, and leaves no run record at all", async () => {
    const ctx = atTime(T0);
    const ids = await paused(ctx);
    const delivery = await aDelivery(atTime(T0 + 1000));

    const outcome = await triggerButlers(testEnv, atTime(T0 + 1000), ORG, delivery.messageId);
    expect(outcome.paused).toEqual([ids.butlerId]);
    expect(outcome.started).toEqual([]);
    /*
     * Silence is the observable: no run, no effect row, no manifest. Which is why `doctor` grew a check.
     *
     * Counted **for this Butler** rather than over the whole table, and that is not fussiness: other tests in
     * this file drive `triggerButlers` through the real workflow binding, whose instances run asynchronously
     * and can still be writing rows after a later `beforeEach` has cleared them. A global count here failed
     * for that reason before it was scoped, which is worth recording because it looks like a product defect
     * and is not.
     */
    expect(await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM butler_runs WHERE org_id = ? AND butler_id = ?",
    ).bind(ORG, ids.butlerId).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await testEnv.CATALOG.prepare(
      `SELECT COUNT(*) AS n FROM butler_run_effects e
        WHERE e.org_id = ? AND EXISTS (SELECT 1 FROM butler_runs r
                                        WHERE r.id = e.run_id AND r.butler_id = ?)`,
    ).bind(ORG, ids.butlerId).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses a run genuinely suspended on its release gate when the pause lands under it", async () => {
    /*
     * The case a trigger-time check structurally cannot cover, and #50's measurement is why it matters: a
     * workflow outlives the Worker that declared it, and a `wait` node reaches 365 days. So the pause is
     * re-asked once per invocation, on the read of `subrequests_spent` that already happens and already must
     * not be cached.
     *
     * **Driven through a real suspension rather than a manufactured one.** The first invocation drafts,
     * proposes — which parks the run `awaiting_release` and seals the manifest `awaiting` — and then blocks on
     * the release gate for ever, which is what a parked instance is. The pause is placed under it. The second
     * invocation replays with the cached steps and meets the pause before walking anything.
     *
     * An earlier version of this test ran the Butler to completion and then `UPDATE`d the row back to
     * `awaiting_release`, and that fixture was wrong in a way that mattered: it left `effects = 2` on the row,
     * which made the assertion below read `2` and made the `closeRun`-instead-of-`abandonRun` mutation fail —
     * for a state no real run ever reaches, since `closeRun` only fires once and only on a live row. Recorded
     * because it is the vacuous green this file's house rule exists for.
     */
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    await armed(ctx, ids.butlerId);
    const delivery = await aDelivery(ctx);
    const runId = `${ids.versionId}-${delivery.messageId}`;
    const facts = await factsFor(delivery.messageId);
    const instance = new Instance();

    const stillAsleep = await suspendedOr(interpret(testEnv, atTime(T0), {
      orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
      trigger: { event: "mail.received", key: delivery.messageId, facts },
    }, instance.steps(), runId));
    expect(stillAsleep, "the first invocation should still be parked on its release gate").toBeNull();

    // Waited for, not assumed: see `until`. The promise above never settles, so this cannot race it.
    const parked = await until(runId, "awaiting_release");
    expect(parked?.state).toBe("awaiting_release");
    const effectRows = async (): Promise<number> => (await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM butler_run_effects WHERE org_id = ? AND run_id = ?",
    ).bind(ORG, runId).first<{ n: number }>())!.n;
    const manifests = async (): Promise<number> => (await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM send_manifests WHERE org_id = ?",
    ).bind(ORG).first<{ n: number }>())!.n;
    expect(await effectRows()).toBe(2);
    const manifestsBefore = await manifests();
    expect(manifestsBefore).toBe(1);

    await placeButlerPause(testEnv, atTime(T0 + 5000), ORG, {
      butlerId: ids.butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "placed while a run was parked", trippedBy: delivery.messageId,
    });

    // It wakes: the gate no longer blocks, the completed steps replay from cache.
    instance.suspend = false;
    const result = await interpret(testEnv, atTime(T0 + 6000), {
      orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
      trigger: { event: "mail.received", key: delivery.messageId, facts },
    }, instance.steps(), runId);

    expect(result.state).toBe("refused");
    expect(result.reason).toBe("butler_paused");
    // Nothing happened on the way out: no new effect row, no second manifest.
    expect(await effectRows()).toBe(2);
    expect(await manifests()).toBe(manifestsBefore);

    const after = await runRow(testEnv, ORG, runId);
    expect(after?.state).toBe("refused");
    expect(after?.outcome_reason).toBe("butler_paused");
    expect(after?.finished_at).not.toBeNull();
    /*
     * **And the count columns read zero, which is the honest figure and not the one the obvious reading
     * expects.** `nodes_executed`, `effects` and `refusals` are written by `closeRun` alone, and `abandonRun`
     * can only match a run that has never closed — so on this path they were zero before and are zero after.
     * `abandonRun` is still the right call, but the reason is that it does not *state* a count, not that it
     * rescues one. What this run performed is the two `butler_run_effects` rows asserted above, which is what
     * `GET /api/butler-runs/:id` returns beside the row. Pinned so the discrepancy cannot be quietly closed in
     * one place and left open in the other: #53's ledger owns it, and `abandonRun`'s header says so.
     */
    expect(after?.effects).toBe(0);
    expect(after?.nodes_executed).toBe(0);

    // And it says why, where `doctor` looks.
    const complaint = await testEnv.CATALOG.prepare(
      "SELECT event, message FROM log_entries WHERE event = 'butler.paused' LIMIT 1",
    ).first<{ event: string; message: string }>();
    expect(complaint?.message).toContain("E_BUTLER_PAUSED");
  });
});

/* ------------------------------------------------------------- republishing does not clear it ----- */

describe("republishing a Butler does NOT clear a pause the machine placed", () => {
  /*
   * The loudest test in this file, because it is the whole reason the pause is keyed on `butler_id` rather
   * than on `butler_versions.id`. With a version-keyed pause, an operator who changed one comment and
   * published would have re-armed a Butler the machine stopped, with nobody deciding it was safe.
   *
   * The cost is accepted deliberately: a fix needs an explicit resume as well as a publish, and that is the
   * act somebody should have to perform.
   */
  it("survives an edit and a new published version, and the new version still starts nothing", async () => {
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    await armed(ctx, ids.butlerId);
    const placed = await placeButlerPause(testEnv, ctx, ORG, {
      butlerId: ids.butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "the machine stopped it", trippedBy: "msg_whatever",
    });

    // A real edit through the real authoring path, and a real publication. The AST changes, so this is not a
    // no-op publish being refused for an unrelated reason.
    await editButlerDraft(testEnv, atTime(T0 + 1000), ORG, ADMIN, ids.butlerId, {
      source: sourceFor("acknowledge", ACKNOWLEDGE, ADDRESS, "fixed the loop"),
    });
    const republished = await publishButler(testEnv, atTime(T0 + 2000), ORG, ADMIN, ids.butlerId);
    expect(republished.version).toBe(2);
    expect(republished.versionId).not.toBe(ids.versionId);

    // The pause row is untouched, and it is the *same* row rather than a re-placed one.
    const still = await testEnv.CATALOG.prepare(
      "SELECT id, resumed_at FROM butler_pauses WHERE org_id = ? AND butler_id = ?",
    ).bind(ORG, ids.butlerId).all<{ id: string; resumed_at: string | null }>();
    expect(still.results).toEqual([{ id: placed!.pauseId, resumed_at: null }]);

    // And the new version does not run, which is the part that actually matters.
    const delivery = await aDelivery(atTime(T0 + 3000));
    const outcome = await triggerButlers(testEnv, atTime(T0 + 3000), ORG, delivery.messageId);
    expect(outcome.paused).toEqual([ids.butlerId]);
    expect(outcome.started).toEqual([]);
  });

  it("stops the *new* version too, so the pause is not being read off the old version by accident", async () => {
    // Non-vacuity for the test above: it would pass identically if the trigger simply never matched the new
    // version. So this one proves the new version *would* have run — by resuming and watching it start.
    const ctx = atTime(T0);
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    await armed(ctx, ids.butlerId);
    const placed = await placeButlerPause(testEnv, ctx, ORG, {
      butlerId: ids.butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "the machine stopped it", trippedBy: "msg_whatever",
    });
    await editButlerDraft(testEnv, atTime(T0 + 1000), ORG, ADMIN, ids.butlerId, {
      source: sourceFor("acknowledge", ACKNOWLEDGE, ADDRESS, "fixed the loop"),
    });
    const republished = await publishButler(testEnv, atTime(T0 + 2000), ORG, ADMIN, ids.butlerId);

    await resumeButlerPause(testEnv, atTime(T0 + 4000), ORG, ADMIN, placed!.pauseId, "the loop is fixed");

    const delivery = await aDelivery(atTime(T0 + 5000));
    const outcome = await triggerButlers(testEnv, atTime(T0 + 5000), ORG, delivery.messageId);
    expect(outcome.paused).toEqual([]);
    expect(outcome.started).toEqual([`${republished.versionId}-${delivery.messageId}`]);
  });
});

/* ------------------------------------------------------------- the resume ------------------------- */

describe("who may resume, and what it records", () => {
  async function aPause(ctx: Ctx): Promise<{ butlerId: string; pauseId: string }> {
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    const placed = await placeButlerPause(testEnv, ctx, ORG, {
      butlerId: ids.butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "the machine stopped it", trippedBy: "msg_whatever",
    });
    return { butlerId: ids.butlerId, pauseId: placed!.pauseId };
  }

  it("takes one administrator, alone, and is audited naming the person", async () => {
    const ctx = atTime(T0);
    const { butlerId, pauseId } = await aPause(ctx);

    const resumed = await resumeButlerPause(
      testEnv, atTime(T0 + 1000), ORG, ADMIN, pauseId, "the trigger was wrong; fixed in v2",
    );
    expect(resumed.butlerId).toBe(butlerId);

    const row = await testEnv.CATALOG.prepare(
      "SELECT resumed_at, resumed_by, resumed_reason FROM butler_pauses WHERE id = ?",
    ).bind(pauseId).first<{ resumed_at: string; resumed_by: string; resumed_reason: string }>();
    expect(row?.resumed_by).toBe(ADMIN);
    expect(row?.resumed_reason).toBe("the trigger was wrong; fixed in v2");

    const entry = await testEnv.CATALOG.prepare(
      `SELECT actor_user_id, actor_kind, subject, detail FROM audit_entries
        WHERE action = 'butler.resumed' LIMIT 1`,
    ).first<{ actor_user_id: string; actor_kind: string; subject: string; detail: string }>();
    // The **person**, and the Butler as the subject so one filter answers everything about it.
    expect(entry?.actor_user_id).toBe(ADMIN);
    expect(entry?.actor_kind).toBe("user");
    expect(entry?.subject).toBe(butlerId);
    expect(JSON.parse(entry!.detail).reason).toBe("the trigger was wrong; fixed in v2");
  });

  it("records the placement as this Node's own act, not the Butler's and not its publisher's", async () => {
    const ctx = atTime(T0);
    const { butlerId } = await aPause(ctx);
    const entry = await testEnv.CATALOG.prepare(
      `SELECT actor_user_id, actor_kind, subject FROM audit_entries WHERE action = 'butler.paused' LIMIT 1`,
    ).first<{ actor_user_id: string | null; actor_kind: string; subject: string }>();
    expect(entry?.actor_user_id).toBeNull();
    expect(entry?.actor_kind).toBe("node");
    expect(entry?.subject).toBe(butlerId);
    // Non-vacuity: `user` would be the wrong answer and it is what a careless `actorUserId` would produce.
    expect(entry?.actor_kind).not.toBe("user");
  });

  it("refuses a blank reason, because it is the only human judgement in the whole lifecycle", async () => {
    const ctx = atTime(T0);
    const { pauseId } = await aPause(ctx);
    await expect(resumeButlerPause(testEnv, atTime(T0 + 1000), ORG, ADMIN, pauseId, "   "))
      .rejects.toThrow(/E_BUTLER_PAUSE_REASON_REQUIRED/);
    // Nothing written, so the pause still stands — a refusal must leave the world as it was.
    const row = await testEnv.CATALOG.prepare(
      "SELECT resumed_at FROM butler_pauses WHERE id = ?",
    ).bind(pauseId).first<{ resumed_at: string | null }>();
    expect(row?.resumed_at).toBeNull();
    expect(await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'butler.resumed'",
    ).first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses somebody who is not an administrator, and refuses a second resume", async () => {
    const ctx = atTime(T0);
    const { pauseId } = await aPause(ctx);

    await expect(resumeButlerPause(testEnv, atTime(T0 + 1000), ORG, NOT_ADMIN, pauseId, "let me"))
      .rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);

    // One administrator, alone: the *other* admin needs no agreement from the first.
    await resumeButlerPause(testEnv, atTime(T0 + 2000), ORG, OTHER_ADMIN, pauseId, "I checked it");
    await expect(resumeButlerPause(testEnv, atTime(T0 + 3000), ORG, ADMIN, pauseId, "again"))
      .rejects.toThrow(/E_BUTLER_PAUSE_ALREADY_RESUMED/);
    // Two entries for one resume would say two administrators restarted a Butler, and one of them did not.
    expect(await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'butler.resumed'",
    ).first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("refuses to place a second pause on one Butler, so one resume is enough to restart it", async () => {
    const ctx = atTime(T0);
    const { butlerId, pauseId } = await aPause(ctx);
    const second = await placeButlerPause(testEnv, atTime(T0 + 1000), ORG, {
      butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "a concurrent delivery", trippedBy: "msg_other",
    });
    // `null` rather than a throw: the Butler is paused either way, which is what the caller wanted, and an
    // outbox handler must not fail over a race whose outcome was the desired one.
    expect(second).toBeNull();
    expect(await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM butler_pauses").first<{ n: number }>())
      .toEqual({ n: 1 });
    // The audit entry is gated on the same predicate as the insert, so the refused placement recorded nothing.
    expect(await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM audit_entries WHERE action = 'butler.paused'",
    ).first<{ n: number }>()).toEqual({ n: 1 });

    await resumeButlerPause(testEnv, atTime(T0 + 2000), ORG, ADMIN, pauseId, "fixed");
    // And once resumed, a fresh pause is representable again: the partial index only holds live ones.
    const third = await placeButlerPause(testEnv, atTime(T0 + 3000), ORG, {
      butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "it looped again", trippedBy: "msg_again",
    });
    expect(third).not.toBeNull();
  });
});

/* ------------------------------------------------------------- doctor ---------------------------- */

describe("doctor distinguishes a stopped Butler from a quiet one", () => {
  async function claimed(): Promise<void> {
    await testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim', 'x', ?, ?)",
    ).bind(new Date(T0).toISOString(), ORG).run();
  }

  function finding(report: Awaited<ReturnType<typeof runDoctor>>, check: string) {
    return report.findings.find((one) => one.check === check);
  }

  it("reports a paused Butler with the figure behind it and how to resume it", async () => {
    const ctx = atTime(T0);
    await claimed();
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    const placed = await placeButlerPause(testEnv, ctx, ORG, {
      butlerId: ids.butlerId, butlerName: "acknowledge", reason: "loop_detected",
      detail: "E_BUTLER_LOOP butler.loop_max_self_provoked_runs=3, four times in the last 60 minutes",
      trippedBy: "msg_tripper",
    });

    const report = await runDoctor(testEnv, atTime(T0 + 1000));
    const paused = finding(report, "butler_paused");
    expect(paused?.ok).toBe(false);
    expect(paused?.severity).toBe("degraded");
    expect(paused?.detail).toContain(ids.butlerId);
    expect(paused?.detail).toContain("E_BUTLER_LOOP");
    expect(paused?.fix).toContain(`${placed!.pauseId}/resume`);
    expect(paused?.fix).toContain("Publishing a new version does not resume it");
    expect(report.verdict).not.toBe("ok");

    // A paused Butler's silence is explained by the finding above, so the second one must not fail on it too:
    // a check that fails on every Node with a pause is a permanent WARN, which is a muted check.
    expect(finding(report, "butler_run_silence")?.ok).toBe(true);
    console.log(`MEASURE doctor with-butler-pause subrequests=${report.cost.subrequests} `
      + `d1=${report.cost.d1Queries} findings=${report.findings.length}`);
  });

  it("says nothing has triggered a Butler when no mail has arrived at its address", async () => {
    const ctx = atTime(T0);
    await claimed();
    await published(ctx, "acknowledge", ACKNOWLEDGE);

    const report = await runDoctor(testEnv, atTime(T0 + 1000));
    const silence = finding(report, "butler_run_silence");
    expect(silence?.ok).toBe(true);
    expect(silence?.severity).toBe("report");
    expect(silence?.detail).toContain("nothing has triggered them");
    expect(finding(report, "butler_paused")?.ok).toBe(true);
  });

  it("fails when mail arrived at the address and no run started, which is the whole point", async () => {
    const ctx = atTime(T0);
    await claimed();
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    // Mail arrives after publication and nothing runs — the state a renamed mailbox or a stalled outbox
    // produces, and the one indistinguishable from a quiet Butler without this second read.
    await aDelivery(atTime(T0 + 1000));

    const report = await runDoctor(testEnv, atTime(T0 + 2000));
    const silence = finding(report, "butler_run_silence");
    expect(silence?.ok).toBe(false);
    expect(silence?.severity).toBe("degraded");
    expect(silence?.detail).toContain(ids.butlerId);
    expect(silence?.detail).toContain(ADDRESS);
    expect(silence?.fix).toContain("no longer matches any address");

    // Non-vacuity, and it is the discriminator itself: give the Butler a run over that delivery and the same
    // Node reports ok. If the check ignored `runs_since_published` this second half would still fail.
    await armed(ctx, ids.butlerId);
    await run(ids, { messageId: (await lastMessageId()), conversationId: "" }, T0 + 1500);
    const after = await runDoctor(testEnv, atTime(T0 + 3000));
    expect(finding(after, "butler_run_silence")?.ok).toBe(true);
  });

  it("refuses to call the loop detector armed on a Node whose inbound mail is not threaded", async () => {
    const ctx = atTime(T0);
    await claimed();
    const ids = await published(ctx, "acknowledge", ACKNOWLEDGE);
    await armed(ctx, ids.butlerId);

    // A Butler has proposed a send, and nothing coming back carries an In-Reply-To. That is the state where
    // a reply provoked by that send would be invisible, and reporting "no loops" would be a reassuring zero.
    const delivery = await aDelivery(atTime(T0 + 1000));
    await run(ids, delivery, T0 + 1500);

    const blind = await runDoctor(testEnv, atTime(T0 + 2000));
    const detection = finding(blind, "butler_loop_detection");
    expect(detection?.ok).toBe(false);
    expect(detection?.severity).toBe("degraded");
    expect(detection?.detail).toContain("no_threaded_replies");
    expect(detection?.detail).toContain("It is NOT a clean bill of health");

    // Non-vacuity: one threaded inbound message arms it, and the same Node then reports ok.
    await aDelivery(atTime(T0 + 3000), await messageIdSealedBy(`${ids.versionId}-${delivery.messageId}`));
    const armedReport = await runDoctor(testEnv, atTime(T0 + 4000));
    expect(finding(armedReport, "butler_loop_detection")?.ok).toBe(true);
    expect(finding(armedReport, "butler_loop_detection")?.detail).toContain("armed=true");
  });

  it("costs one extra statement on a Node with no Butlers, and two when it has one", async () => {
    // The receipt's claim, held here rather than only written down: the delivery scan is issued only when the
    // first read found a published Butler.
    await claimed();
    const bare = await runDoctor(testEnv, atTime(T0 + 1000));
    console.log(`MEASURE doctor no-butlers subrequests=${bare.cost.subrequests} d1=${bare.cost.d1Queries}`);
    expect(finding(bare, "butler_run_silence")).toBeUndefined();
    expect(finding(bare, "butler_loop_detection")).toBeUndefined();

    await published(atTime(T0), "acknowledge", ACKNOWLEDGE);
    const withOne = await runDoctor(testEnv, atTime(T0 + 2000));
    console.log(`MEASURE doctor one-butler subrequests=${withOne.cost.subrequests} `
      + `d1=${withOne.cost.d1Queries}`);
    expect(withOne.cost.subrequests - bare.cost.subrequests).toBe(1);
    expect(finding(withOne, "butler_run_silence")).toBeDefined();
    expect(withOne.cost.subrequests).toBeLessThanOrEqual(BUDGETS["doctor.max_subrequests_per_run"]);
  });
});

/** The newest inbound message, for a test that made one without keeping the id. */
async function lastMessageId(): Promise<string> {
  const row = await testEnv.CATALOG.prepare(
    "SELECT id FROM messages WHERE org_id = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(ORG).first<{ id: string }>();
  return row!.id;
}
