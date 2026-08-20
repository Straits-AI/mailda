import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { checkButler, RUN_BUDGET, SHIPPED_NODE_COST } from "@mailda/butler-ast";
import { utf8 } from "@mailda/evidence";
import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { grant } from "../src/access.ts";
import { readDraft, saveDraft } from "../src/drafts.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import { proposeSend } from "../src/butler/effects.ts";
import { interpret, RUN_NODE_COST, type RunSteps } from "../src/butler/interpret.ts";
import { deliveryFacts, triggerButlers } from "../src/butler/trigger.ts";
import { createButlerDraft, publishButler } from "../src/butlers.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { metering } from "../src/cost-meter.ts";
import { putEvidence } from "../src/evidence-store.ts";

/**
 * What a whole Butler **run** costs, measured — and what the affordability checker predicted for the same
 * AST (#50, #54).
 *
 * ## Why this file exists beside `butler-step-cost.measure.test.ts`
 *
 * That file priced the four *functions* a node calls, before an engine existed to call them: `case.assign` is
 * `claim`, `draft` is `saveDraft`, `mail.send.propose` is `sealManifest`. #54 then built a publication-time
 * refusal on those figures — sum the fixed nodes, add `maxItems × per-item` for each loop, refuse if the
 * total exceeds one Workflow instance's subrequest pot.
 *
 * **A node is strictly more than the function it calls**, and that gap is what this file measures. Around
 * each call the engine resolves expressions (free), checks the Butler's own authority where the function
 * checks somebody else's (a query, sometimes), and records what happened (a `batch`). Around the run it reads
 * the program, opens the record, reads what previous invocations spent, and writes a terminal state.
 *
 * So the comparison this file makes is the one that matters: **a measured run against the checker's
 * prediction for the same AST.** If they disagree, the disagreement is the finding, and it matters more than
 * either number.
 *
 * ## What it found, and why that needed a receipt of its own
 *
 * Four of the five nodes fit inside the headroom `butler-step-cost.md`'s bounds already carry. The fifth does
 * not: `mail.send.propose` measures **23** against that receipt's **20**, because the node reads the draft
 * back before sealing it. So a `foreach` of 500 sends prices at exactly the Paid pot and really costs 11,503
 * — the instance would be killed at about item 434 having already sealed 434 manifests, which is precisely
 * the failure #54's publication-time refusal exists to prevent.
 *
 * `docs/receipts/butler-run-cost.md` records the measurement and the engine's runtime guard reserves from
 * **it** rather than from #54's table. #54's figures are not edited from here: they are correct measurements
 * of the functions they name, and its receipt is the thing that would have to move.
 *
 * So this file asserts three different kinds of thing, and the third is the interesting one:
 *
 *   - each node inside the bound in **this** receipt (bounds with headroom, for the usual reason);
 *   - `butler.run_cost_engine_fixed` as an **equality**, because it is a count of three statements rather
 *     than a measurement of anything;
 *   - **the disagreement itself**, pinned. A sending run costs strictly more than the checker predicted, and
 *     that inequality is asserted so that the day somebody re-measures `butler-step-cost.md` and closes the
 *     gap, this fails and the paragraph above gets deleted rather than left describing a gap that has gone.
 */

const testEnv = env as unknown as Env;
const ORG = "org_runcost";
const MAILBOX = "mbx_runcost";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_admin";
const RESPONDER = "usr_responder";
const T0 = 2_600_000_000_000;

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (prefix) => system.id(prefix), random: (n) => system.random(n) };
}

/** Executes step bodies inline and releases every wait at once, so one run is one measurement. */
function inlineSteps(): RunSteps {
  return {
    do: async <T>(_name: string, body: () => Promise<T>): Promise<T> => await body(),
    sleep: async (): Promise<void> => {},
    waitForEvent: async (): Promise<unknown> => ({ released: true }),
  };
}

async function aDelivery(ctx: Ctx): Promise<{ messageId: string; caseId: string }> {
  const at = new Date(ctx.now()).toISOString();
  const raw = utf8(`Message-ID: <${ctx.id("x")}@example.net>\r\nSubject: Q\r\n\r\nbody\r\n`);
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
                           created_at, conversation_id, parse_error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).bind(messageId, ORG, "2026-08", stored.blobKey, stored.plaintextSha256, raw.byteLength,
    `<in-${messageId}@example.net>`, ctx.id("thr"), "Q", "customer@example.net", at, at, receiptId, at,
    conversationId).run();
  const caseId = ctx.id("cas");
  await testEnv.CATALOG.prepare(
    `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
                        created_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
  ).bind(caseId, ORG, conversationId, MAILBOX, at, at).run();
  return { messageId, caseId };
}

async function publish(ctx: Ctx, name: string, nodes: unknown[], entry: string): Promise<{
  butlerId: string; versionId: string;
}> {
  const source = JSON.stringify({
    apiVersion: "mailda/v1", kind: "Butler",
    metadata: { name, owner: "team:support" },
    trigger: { event: "mail.received", mailbox: ADDRESS },
    entry, nodes,
  });
  const draft = await createButlerDraft(testEnv, ctx, ORG, ADMIN, { name, source });
  const version = await publishButler(testEnv, ctx, ORG, ADMIN, draft.butlerId);
  return { butlerId: draft.butlerId, versionId: version.versionId };
}

async function facts(messageId: string): Promise<Record<string, unknown>> {
  // The production function, so a measured run reads the same delivery a real one does. A copy of its
  // statement is a fixture that stops matching the fact set the moment it grows (#52 and `return_path`).
  const row = await deliveryFacts(testEnv, ORG, messageId);
  if (row === null) throw new Error(`no delivery facts for ${messageId}`);
  return row;
}

/** The checker's own prediction for one AST, from the same code publication uses. */
function predicted(nodes: unknown[], entry: string): number {
  const checked = checkButler({
    apiVersion: "mailda/v1", kind: "Butler",
    metadata: { name: "priced", owner: "team:support" },
    trigger: { event: "mail.received", mailbox: ADDRESS },
    entry, nodes,
  });
  if (!checked.ok) throw new Error(`the AST under measurement does not check: ${JSON.stringify(checked.findings)}`);
  return checked.cost.total;
}

const REPLY = [
  {
    id: "reply", type: "draft", mailboxId: "${event.mailbox_id}",
    subject: "Re: ${event.subject}", body: "Thanks.", inReplyTo: "${event.message_id}",
    as: "acknowledgement", next: "propose",
  },
  { id: "propose", type: "mail.send.propose", draft: "${steps.acknowledgement}", next: null },
];

const TRIAGE = [
  { id: "pick", type: "transform", as: "target", value: RESPONDER, next: "assign" },
  { id: "assign", type: "case.assign", caseId: "${event.case_id}", assignee: "${steps.target}", next: "shut" },
  { id: "shut", type: "case.close", caseId: "${event.case_id}", next: null },
];

const LOOK = [
  { id: "read", type: "lookup", entity: "message", entityId: "${event.message_id}", as: "original", next: null },
];

beforeEach(async () => {
  for (const table of [
    "butler_run_effects", "butler_runs", "butler_versions", "butlers", "cases", "conversations", "messages",
    "ingress_receipts", "relationship_tuples", "mailboxes", "addresses", "drafts", "send_manifests",
    "send_recipients", "send_counters", "audit_entries", "log_entries", "outbox", "users",
    "policies", "policy_versions", "policy_stages", "approvals", "approval_stages", "approval_decisions",
    "domain_pauses", "notifications",
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
    ...[ADMIN, RESPONDER].map((user) =>
      testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
        .bind(user, ORG, `${user}@local.invalid`, at)),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, ADMIN, ORG, at),
  ]);
});

async function armed(ctx: Ctx, butlerId: string): Promise<void> {
  for (const relation of ["send.propose", "mailbox.content.read"] as const) {
    await grant(testEnv, ctx, ORG, ADMIN, { subjectId: butlerId, relation, objectId: MAILBOX });
  }
  await grant(testEnv, ctx, ORG, ADMIN, {
    subjectId: RESPONDER, relation: "send.propose", objectId: MAILBOX,
  });
}

async function measured(
  ids: { butlerId: string; versionId: string },
  delivery: { messageId: string; caseId: string },
  now: number,
): Promise<{ subrequests: number; d1: number; batches: number; r2: number; doRpcs: number; state: string }> {
  const { env: metered, cost } = metering(testEnv);
  const outcome = await interpret(
    metered, atTime(now),
    {
      orgId: ORG, butlerId: ids.butlerId, butlerVersionId: ids.versionId,
      trigger: { event: "mail.received", key: delivery.messageId, facts: await facts(delivery.messageId) },
    },
    inlineSteps(), `${ids.versionId}-${delivery.messageId}`,
  );
  /*
   * Two meters, and only the outer one is the answer.
   *
   * `interpret` wraps whatever env it is handed in a meter of its own — that is how the live budget guard
   * works — so the inner `outcome.cost` counts the same operations. The outer one is read here because it is
   * the one a caller could see, and because the two agreeing is itself worth knowing.
   */
  expect(outcome.cost.subrequests).toBe(cost.subrequests);
  return {
    subrequests: cost.subrequests, d1: cost.d1Executions, batches: cost.d1Batches,
    r2: cost.r2Operations, doRpcs: cost.doRpcs, state: outcome.state,
  };
}

function report(label: string, m: { subrequests: number; d1: number; batches: number; r2: number; doRpcs: number }): void {
  console.log(
    `MEASURE run=${label}  subrequests=${m.subrequests}  d1=${m.d1} (batches=${m.batches})`
    + `  r2=${m.r2}  do_rpc=${m.doRpcs}`,
  );
}

describe("what a whole Butler run costs (#50)", () => {
  it("prices the engine's fixed overhead on a run that performs no effect", async () => {
    // A Butler that stops immediately. Whatever this costs is the engine and nothing else, which is what
    // `butler.run_cost_engine_fixed` claims to be — a count of three statements rather than a measurement of
    // anything, which is why it is pinned as an equality and not as a bound with headroom.
    const ctx = atTime(T0);
    const ids = await publish(ctx, "inert", [{ id: "halt", type: "stop", reason: "nothing to do" }], "halt");
    const delivery = await aDelivery(ctx);

    const m = await measured(ids, delivery, T0 + 1000);
    report("stop-only (engine overhead)", m);
    expect(m.state).toBe("stopped");
    // load+open (one batch), the spend read, the terminal write.
    expect(m.subrequests).toBe(BUDGETS["butler.run_cost_engine_fixed"]);
    expect(m.batches).toBe(1);
    console.log(`MEASURE engine_fixed_subrequests=${m.subrequests} `
      + `budget=${BUDGETS["butler.run_cost_engine_fixed"]}`);
  });

  it("prices a draft-and-propose run against the checker's prediction for the same AST", async () => {
    const ctx = atTime(T0);
    const ids = await publish(ctx, "acknowledge", REPLY, "reply");
    await armed(ctx, ids.butlerId);
    const delivery = await aDelivery(ctx);

    const forecast = predicted(REPLY, "reply");
    const m = await measured(ids, delivery, T0 + 1000);
    report("draft + mail.send.propose (a reply)", m);
    console.log(
      `MEASURE comparison ast=draft+propose  checker_prediction=${forecast}  measured=${m.subrequests}`
      + `  engine_fixed=${BUDGETS["butler.run_cost_engine_fixed"]}`
      + `  difference=${m.subrequests - forecast}`,
    );

    /*
     * **The finding, asserted rather than printed.** A real run of this AST costs strictly more than the
     * checker predicted for its nodes, because a node is more than the function it calls.
     *
     * Pinned as a `>` on purpose. If somebody re-measures `butler-step-cost.md` so that its figures price
     * the *nodes* rather than the functions, this fails — and the right response is to delete this assertion
     * and the paragraph in `docs/receipts/butler-run-cost.md` that describes the gap, rather than to leave a
     * receipt explaining a disagreement that has closed.
     */
    expect(
      m.subrequests,
      "the checker's prediction has caught up with a real run — see docs/receipts/butler-run-cost.md",
    ).toBeGreaterThan(forecast);

    // And the bound that is actually enforced: the engine's own table, which the runtime guard reserves from.
    expect(m.subrequests).toBeLessThanOrEqual(
      BUDGETS["butler.run_cost_max_draft"] + BUDGETS["butler.run_cost_max_send_propose"]
      + BUDGETS["butler.run_cost_engine_fixed"],
    );
    expect(m.state).toBe("finished");
  });

  it("prices each effect node inside the bound this receipt carries for it", async () => {
    /*
     * Isolated by subtraction: what a node costs is what a run containing it costs more than a run without
     * it, which is the quantity the pot is actually spent in. Instrumenting `interpret` internally would
     * measure something else — the operations attributable to a line of it — and would go stale the first
     * time one moved.
     */
    const ctx = atTime(T0);
    const fixed = BUDGETS["butler.run_cost_engine_fixed"];

    const draftOnly = await publish(ctx, "d", [{ ...REPLY[0], next: null }], "reply");
    await armed(ctx, draftOnly.butlerId);
    const draftRun = await measured(draftOnly, await aDelivery(ctx), T0 + 1000);
    const draftNode = draftRun.subrequests - fixed;

    const both = await publish(ctx, "dp", REPLY, "reply");
    await armed(ctx, both.butlerId);
    const bothRun = await measured(both, await aDelivery(ctx), T0 + 2000);
    const sendNode = bothRun.subrequests - fixed - draftNode;

    const assignOnly = await publish(ctx, "a", [TRIAGE[0], { ...TRIAGE[1], next: null }], "pick");
    await armed(ctx, assignOnly.butlerId);
    const assignRun = await measured(assignOnly, await aDelivery(ctx), T0 + 3000);
    const assignNode = assignRun.subrequests - fixed;

    const withClose = await publish(ctx, "ac", TRIAGE, "pick");
    await armed(ctx, withClose.butlerId);
    const closeRun = await measured(withClose, await aDelivery(ctx), T0 + 4000);
    const closeNode = closeRun.subrequests - fixed - assignNode;

    const lookOnly = await publish(ctx, "l", LOOK, "read");
    await armed(ctx, lookOnly.butlerId);
    const lookRun = await measured(lookOnly, await aDelivery(ctx), T0 + 5000);
    const lookupNode = lookRun.subrequests - fixed;

    /*
     * The bounds come from `RUN_NODE_COST` — the table the runtime guard actually reserves from — rather
     * than from the budget keys directly. Reading the keys would test the receipt; reading the table tests
     * what the engine does with it, which is the half that can be wired up wrongly.
     */
    const table: Array<[keyof typeof SHIPPED_NODE_COST, number]> = [
      ["draft", draftNode],
      ["mail.send.propose", sendNode],
      ["case.assign", assignNode],
      ["case.close", closeNode],
      ["lookup", lookupNode],
    ];
    for (const [node, cost] of table) {
      const bound = RUN_NODE_COST[node];
      console.log(
        `MEASURE node=${node}  as_the_engine_performs_it=${cost}  run_cost_bound=${bound}`
        + `  step_cost_bound=${SHIPPED_NODE_COST[node]}`,
      );
      expect(cost, `${node} costs more than docs/receipts/butler-run-cost.md says`)
        .toBeLessThanOrEqual(bound);
    }

    // The one node whose engine cost exceeds #54's figure, named so the gap is a check rather than a note.
    expect(
      sendNode,
      "mail.send.propose no longer costs more than butler.step_cost_max_send_propose — re-read "
      + "docs/receipts/butler-run-cost.md before trusting either receipt",
    ).toBeGreaterThan(SHIPPED_NODE_COST["mail.send.propose"]);
  });

  it("decomposes the send node, so the receipt attributes the difference rather than asserting it", async () => {
    /*
     * `butler-step-cost.md` measured a reply seal at 14 and this engine measures the *node* at 23. Saying
     * "the operations are not in the seal" would be an attribution, and an attribution is a hypothesis —
     * which is the exact mistake that receipt records twice ("a figure read off the source is a
     * hypothesis"). So the three parts are measured separately, here, against the same fixture the node
     * measurement used.
     */
    const ctx = atTime(T0);
    const ids = await publish(ctx, "acknowledge", REPLY, "reply");
    await armed(ctx, ids.butlerId);
    const delivery = await aDelivery(ctx);
    const butler = {
      orgId: ORG, butlerId: ids.butlerId, versionId: ids.versionId, name: "acknowledge",
    };

    // A draft for the Butler to send, written outside the meter.
    const written = await saveDraft(testEnv, ctx, ORG, ids.butlerId, null, {
      mailboxId: MAILBOX, to: ["customer@example.net"], subject: "Re: Q", body: "Thanks.",
      inReplyToMessageId: delivery.messageId,
    });

    const read = metering(testEnv);
    const draft = await readDraft(read.env, ORG, ids.butlerId, written.id);
    expect(draft, "the draft must resolve, or this measures a miss").not.toBeNull();

    const seal = metering(testEnv);
    await sealManifest(seal.env, atTime(T0 + 1000), ORG, {
      mailboxId: draft!.mailboxId, authorUserId: butler.butlerId,
      inReplyToMessageId: draft!.inReplyToMessageId ?? undefined,
      to: draft!.to, subject: draft!.subject, bodyTyped: draft!.body,
      fidelity: "authored", releaseRequired: true,
    });

    // And the effect function the node actually calls, which is the two above plus whatever else it does.
    const effect = metering(testEnv);
    const outcome = await proposeSend(
      effect.env, atTime(T0 + 2000), butler,
      { id: "propose", type: "mail.send.propose", draft: "${steps.d}", next: null },
      { event: {}, butler: {}, steps: { d: { id: written.id } } },
    );
    expect(outcome.outcome).toBe("ok");

    console.log(
      `MEASURE send_node_decomposition  readDraft=${read.cost.subrequests}`
      + `  sealManifest_reply=${seal.cost.subrequests}`
      + `  proposeSend=${effect.cost.subrequests}  record_batch=1  gate_resume=1`
      + `  node=${effect.cost.subrequests + 2}`,
    );
    /*
     * The whole 23, attributed rather than asserted:
     *
     *   5   readDraft — a row read, an authority re-check at 2, an R2 get and a vault opening key
     *  16   sealManifest, a reply, with no policy published
     *   1   the record batch: the effect row, the accumulated spend and the park, in one round trip
     *   1   un-parking the run when the release arrives
     *
     * The last one is the release gate rather than the send, and the subtraction above attributes it to
     * this node because this node is what parks. Worth having measured: `readDraft` is the largest single
     * item and the one to attack first if a Butler ever needs a cheaper send, and the seal at 16 says
     * plainly that `sealManifest` is **not** where the difference from `butler-step-cost.md`'s 14 comes
     * from either — that receipt measured a reply with no policy plane consulted twice, and this Node's
     * seal has since grown the recheck and the breaker query it records in its own corrections.
     */
    expect(effect.cost.subrequests + 2).toBe(23);
    expect(read.cost.subrequests).toBe(5);
    expect(effect.cost.subrequests).toBe(read.cost.subrequests + seal.cost.subrequests);
  });

  it("prices case.assign and case.close together, on the path that costs the most", async () => {
    const ctx = atTime(T0);
    const ids = await publish(ctx, "triage", TRIAGE, "pick");
    await armed(ctx, ids.butlerId);
    const delivery = await aDelivery(ctx);

    const forecast = predicted(TRIAGE, "pick");
    const m = await measured(ids, delivery, T0 + 1000);
    report("case.assign + case.close", m);
    console.log(
      `MEASURE comparison ast=assign+close  checker_prediction=${forecast}  measured=${m.subrequests}`
      + `  difference=${m.subrequests - forecast}`,
    );
    // `case.assign` succeeds and `case.close` then finds the Butler is not holding the case, which is the
    // dearer path for the pair: an authority query plus the function plus the record batch, twice.
    expect(m.subrequests).toBeLessThanOrEqual(
      BUDGETS["butler.run_cost_max_case_assign"] + BUDGETS["butler.run_cost_max_case_close"]
      + BUDGETS["butler.run_cost_engine_fixed"],
    );
  });

  it("prices a lookup, and shows the authority check the step receipt reserved room for", async () => {
    const ctx = atTime(T0);
    const ids = await publish(ctx, "verify", LOOK, "read");
    await armed(ctx, ids.butlerId);
    const delivery = await aDelivery(ctx);

    const m = await measured(ids, delivery, T0 + 1000);
    report("lookup (message)", m);
    // The node's own cost, net of the engine's fixed three: one bounded read plus one record batch. The
    // step bound is 4 against a measured 1 for the bare row read, and `butler-step-cost.md` says in as many
    // words that the headroom is there for "an authority re-check of the caller's authority over the
    // looked-up object". This is that re-check, folded into the same statement rather than added beside it —
    // which is why this is the one node whose engine cost still fits its original figure.
    const node = m.subrequests - BUDGETS["butler.run_cost_engine_fixed"];
    console.log(`MEASURE node=lookup with_record=${node} bound=${BUDGETS["butler.run_cost_max_lookup"]}`);
    expect(node).toBeLessThanOrEqual(BUDGETS["butler.run_cost_max_lookup"]);
    expect(m.doRpcs).toBe(0);
    expect(m.r2).toBe(0);
  });

  it("prices the trigger, which spends from the sweeper's invocation and not from any run's pot", async () => {
    const ctx = atTime(T0);
    const ids = await publish(ctx, "acknowledge", REPLY, "reply");
    await armed(ctx, ids.butlerId);
    const delivery = await aDelivery(ctx);

    const { env: metered, cost } = metering(testEnv);
    const outcome = await triggerButlers(metered, ctx, ORG, delivery.messageId);
    expect(outcome.started).toHaveLength(1);
    console.log(
      `MEASURE trigger butlers_published=1  subrequests=${cost.subrequests}`
      + `  d1=${cost.d1Executions}  workflow_calls=${cost.workflowCalls}`,
    );
    // The facts query, the published-version query, and one `create` per matching Butler. The create is the
    // reason `BUTLER_RUNS` is metered at all (#55 left that decision here by name): a fan-out of instances
    // is the whole reason a per-instance budget exists, and it lands in the caller's invocation.
    expect(cost.workflowCalls).toBe(1);
    expect(cost.subrequests).toBe(3);
  });

  it("states the sending loop's real bound, which is not the one publication divides", () => {
    /*
     * Not an assertion about code but about the budgets, so a change to any figure fails here and forces the
     * arithmetic to be redone — the shape `butler-step-cost.measure.test.ts` uses for the same reason.
     *
     * Three numbers, and the distance between the first and the last is the whole finding:
     *
     *   500  what #54 admits at publication, dividing the pot by the *function's* bound
     *   434  what a run really affords at the measured node cost of 23
     *   357  what the runtime guard permits, reserving this receipt's bound of 28
     *
     * The guard being the strictest of the three is the correct direction: refusing one send too early costs
     * a Butler a run it could have finished, and refusing one too late means it has already been sent.
     */
    const bySeal = Math.floor(RUN_BUDGET / SHIPPED_NODE_COST["mail.send.propose"]);
    const measuredNode = 23;
    const byMeasurement = Math.floor((RUN_BUDGET - BUDGETS["butler.run_cost_engine_fixed"]) / measuredNode);
    const byGuard = Math.floor(
      (RUN_BUDGET - BUDGETS["butler.run_cost_engine_fixed"]) / BUDGETS["butler.run_cost_max_send_propose"],
    );
    console.log(
      `MEASURE sending_loop_bound  pot=${RUN_BUDGET}  admitted_at_publication=${bySeal}`
      + `  affordable_at_measured_23=${byMeasurement}  permitted_by_runtime_guard=${byGuard}`,
    );
    expect(bySeal).toBe(500);
    expect(byMeasurement).toBe(434);
    expect(byGuard).toBe(357);
    // The publication-time refusal admits more than a run can afford. Asserted so that closing the gap is a
    // test failure rather than a silent improvement nobody notices.
    expect(bySeal).toBeGreaterThan(byMeasurement);
  });
});
