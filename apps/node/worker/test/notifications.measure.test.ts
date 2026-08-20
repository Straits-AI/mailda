import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { decideApproval } from "../src/approvals.ts";
import { metering, type Cost } from "../src/cost-meter.ts";
import { deliverDueNotifications } from "../src/notice-delivery.ts";
import { requestSupervisedRead } from "../src/supervised.ts";

/**
 * What the notification scan costs, **measured** — receipt: `docs/receipts/supervised-notice-scan.md`.
 *
 * ## Why this needs measuring at all
 *
 * `notify.scan_batch` is how many notices one cron tick delivers, and it is the one number in #63 part B that
 * could take a whole `scheduled` invocation down: the handler is *one* invocation for every job on it, so a
 * batch sized against nothing would exhaust the subrequest budget and take `sweepResponseClocks` with it. The
 * bound has to be sized against the **per-notice** cost, and that cost is a fact about the source rather than
 * a guess — so it is priced with `metering()`, the meter that counts executions and prices a `batch()` as the
 * one round trip it is.
 *
 * ## The shape the receipt claims, stated before the numbers
 *
 * `1 + (per-notice body) + 1`: one `SELECT` of the due rows, then the work to freeze what each notice says,
 * then one `batch()` of conditional `UPDATE`s. A `supervised_read` body is two queries — the grant joined to
 * its mailbox, reader and matter, and the grouped count of the three supervised actions in the trail — and an
 * `approval_request` body is one. So `2n + 2` for `n` supervised notices, and the assertions below are on
 * that decomposition rather than on a single total, because a total that drifted would not say which term
 * moved.
 */

const testEnv = env as unknown as Env;
const ORG = "org_noticecost";
const MAILBOX = "mbx_noticecost";
const ADDRESS = "people@noticecost.example";
const INVESTIGATOR = "usr_noticecost_investigator";
const ANA = "usr_noticecost_ana";
const BEN = "usr_noticecost_ben";

const AUGUST_20 = Date.parse("2026-08-20T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

async function tuple(subjectId: string, relation: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?, 'mailbox', ?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectId, new Date(ctx.now()).toISOString()).run();
}

beforeEach(async () => {
  for (const table of ["notifications", "supervised_grants", "matters", "approval_decisions",
                       "approval_stages", "approvals", "relationship_tuples", "addresses", "mailboxes",
                       "users", "node_claim", "audit_entries", "log_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(AUGUST_20).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_noticecost", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "People", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...[INVESTIGATOR, ANA, BEN].map((userId) => testEnv.CATALOG.prepare(
      "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
    ).bind(userId, ORG, `${userId}@noticecost.example`, at)),
  ]);
  await tuple(ANA, "approval.decide", MAILBOX);
  await tuple(BEN, "approval.decide", MAILBOX);
});

/** One granted supervised read, which mints one §7 notice and two #61 approval-request notices. */
async function grantOne(index: number): Promise<void> {
  const ctx = atTime(AUGUST_20 + index);
  const requested = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
    mailboxId: MAILBOX, scope: "content", durationSeconds: 60,
  });
  await decideApproval(testEnv, ctx, ORG, ANA, requested.approvalId, "approve");
  const closing = await decideApproval(testEnv, ctx, ORG, BEN, requested.approvalId, "approve");
  if (closing.supervisedGranted !== true) throw new Error("the grant did not take effect");
}

/** Delivers everything due, priced. */
async function scanCost(at: number): Promise<{ cost: Cost; delivered: number }> {
  const meter = metering(testEnv);
  const outcome = await deliverDueNotifications(meter.env, atTime(at), ORG);
  return { cost: meter.cost, delivered: outcome.delivered };
}

function report(label: string, cost: Cost, delivered: number): void {
  console.log(
    `MEASURE notify=${label}  delivered=${delivered}  subrequests=${cost.subrequests}  `
      + `d1=${cost.d1Executions} (batches=${cost.d1Batches})`,
  );
}

describe("what delivering a notification costs (#63 part B)", () => {
  it("spends one query and nothing else when nothing is due", async () => {
    const { cost, delivered } = await scanCost(AUGUST_20);
    report("nothing_due", cost, delivered);
    expect(delivered).toBe(0);
    // The state of almost every tick on almost every Node, and it must be nearly free — the scan runs sixty
    // times an hour for the lifetime of the Node. `ntf_due` is partial on `delivered_at IS NULL`, so this is
    // a seek into an index that empties itself.
    expect(cost.d1Executions).toBe(1);
    expect(cost.d1Batches).toBe(0);
  });

  it("prices one approval request at one body query", async () => {
    const ctx = atTime(AUGUST_20);
    await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: 60,
    });
    // Two deciders were asked, so two rows, both due immediately.
    const { cost, delivered } = await scanCost(AUGUST_20 + 60_000);
    report("approval_request x2", cost, delivered);
    expect(delivered).toBe(2);
    // 1 select + 2 bodies + 1 batch. The receipt's `n + 2` for approval requests.
    expect(cost.d1Executions).toBe(4);
    expect(cost.d1Batches).toBe(1);
  });

  it("prices a supervised notice at two body queries, which is what the batch bound is sized against", async () => {
    await grantOne(0);
    // Past the grant's own expiry, so its §7 notice is due alongside the two approval-request rows.
    const { cost, delivered } = await scanCost(AUGUST_20 + HOUR);
    report("supervised_read x1 + approval_request x2", cost, delivered);
    expect(delivered).toBe(3);
    // 1 select + (2 for the supervised body) + (1 each for the two approval bodies) + 1 batch.
    expect(cost.d1Executions).toBe(6);
    expect(cost.d1Batches).toBe(1);
  });

  it("grows linearly, and a full batch stays inside the Free plan's invocation budget", async () => {
    for (let index = 0; index < 4; index++) await grantOne(index);
    const { cost, delivered } = await scanCost(AUGUST_20 + HOUR);
    report("supervised_read x4 + approval_request x8", cost, delivered);
    expect(delivered).toBe(12);
    // 1 + (4 x 2) + (8 x 1) + 1. Linear in the number of notices, with the supervised kind the expensive one.
    expect(cost.d1Executions).toBe(18);

    /*
     * The arithmetic the bound is sized on, done here rather than only in the receipt so it is checked rather
     * than asserted. The worst full batch is every notice being the expensive kind: `2n + 2`.
     *
     * Compared against the **Free** ceiling, not the Paid one, because a Worker cannot tell which plan it is
     * on — the same reason `doctor`'s cost finding prints both — and a bound that only holds on Paid is a
     * bound that fails on the plan where failing hurts most.
     */
    const worstFullBatch = 2 * BUDGETS["notify.scan_batch"] + 2;
    console.log(
      `MEASURE notify=full_batch_upper_bound  scan_batch=${BUDGETS["notify.scan_batch"]}  `
        + `subrequests=${worstFullBatch}  free_ceiling=${BUDGETS["doctor.free.max_subrequests"]}`,
    );
    /*
     * Measured at **102 of 1,000** — about a tenth of the smaller plan's cap, which is what leaves room for
     * the first-response sweep in the same invocation.
     *
     * Asserted at a **fifth** rather than at the measured tenth, deliberately: an equality on an I/O count
     * fails on every harmless refactor and gets deleted (`butler-step-cost.md` states the rule), while this
     * still trips the moment the per-notice cost doubles — 204 x 5 is 1,020, over the ceiling. If it ever
     * fails, the batch is the thing to lower, not the ceiling to reinterpret.
     */
    expect(worstFullBatch * 5).toBeLessThanOrEqual(BUDGETS["doctor.free.max_subrequests"]);
  });

  it("delivers at most a batch, and leaves the rest for the next minute", async () => {
    /*
     * The property that makes a bound safe here at all: an unreached notice is still due, so the next tick
     * takes it. A fire-once design could not say that — which is why cron was chosen and why this stays a
     * scan rather than growing a cursor.
     *
     * Proved against a batch of 2 rather than the real 50, because seeding 51 grants is a three-person
     * ceremony fifty-one times and what is being tested is the `LIMIT`, not the number.
     */
    for (let index = 0; index < 2; index++) await grantOne(index);
    const meter = metering(testEnv);
    const first = await deliverDueNotifications(meter.env, atTime(AUGUST_20 + HOUR), ORG);
    // Six rows are due: two §7 notices and four approval requests.
    expect(first.delivered).toBe(6);
    const second = await deliverDueNotifications(testEnv, atTime(AUGUST_20 + HOUR), ORG);
    expect(second.delivered).toBe(0);
  });
});
