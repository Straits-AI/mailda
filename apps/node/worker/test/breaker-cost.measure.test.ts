import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { evaluateBreakers } from "../src/breakers.ts";
import { metering } from "../src/cost-meter.ts";
import { requestDomainPause } from "../src/domain-pause.ts";
import { decideApproval } from "../src/approvals.ts";
import { sealManifest } from "../src/outbound/manifest.ts";

/**
 * What asking the breakers costs a send, **measured** (#66) — `docs/receipts/send-breakers.md`.
 *
 * ## Why this needed measuring rather than counting
 *
 * The evaluation asks four questions: how many recipients this Node handed over inside an hour, what fraction
 * of the outcomes it heard back were refusals, what fraction of its deliveries drew a complaint, and whether
 * this domain is paused — seven counts in all, since two of the rates need a numerator and a denominator, and
 * eight once `doctor`'s *are any domains paused* is included. Read as prose, that is four queries or more —
 * and four queries on the seal path *and* on both dispatch paths is a real cost:
 * `send.dispatch_unapproved_max_subrequests` is 20 against a measured 16, so four would have consumed the
 * entire headroom of a bound that exists to catch the cheap path becoming expensive.
 *
 * They are scalar sub-selects in one `SELECT`, so it is **one**. That is the figure this file exists to hold,
 * and the reason it is a measurement rather than a count is the reason `policy-evaluation-cost.md` gives:
 * #60's own resolution counted its cost by reading and was right about the ceiling and wrong about the cost.
 *
 * ## The instrument
 *
 * `src/cost-meter.ts`, which counts **executions** rather than `prepare`, prices a `batch()` as the one round
 * trip it is, and sees Durable Object RPCs — all three of which `doctor`'s own meter gets wrong.
 *
 * Real `workerd` under `vitest-pool-workers`, against a real D1 and a real R2. **Not a deployed Node**:
 * miniflare's D1 is a local SQLite, so what is measured is the *number of operations Mailda performs*, which
 * is what the subrequest budget is spent in, and not their latency.
 */

const testEnv = env as unknown as Env;
const ORG = "org_breakercost";
const MAILBOX = "mbx_breakercost";
const ADDRESS = "support@acme.example";
const AUTHOR = "usr_author_bc";
const ADMIN_A = "usr_admin_bc_a";
const ADMIN_B = "usr_admin_bc_b";
const ADMIN_C = "usr_admin_bc_c";

const AUGUST_20 = Date.parse("2026-08-20T12:00:00.000Z");
const MAX = BUDGETS["breaker.evaluate_max_subrequests"];

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

/** Rows in every table the breakers count over, so the "with rows" figure is not a scan of nothing. */
async function populate(): Promise<void> {
  const ctx = createSystemCtx();
  const when = new Date(AUGUST_20 - 60_000).toISOString();
  const statements = [];
  for (let index = 0; index < 40; index += 1) {
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO send_recipients
         (id, org_id, manifest_id, kind, address, submission_state, submission_state_at,
          delivery_state, delivery_state_at, bounce_type, last_error, last_event_id, created_at)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?)`,
    ).bind(ctx.id("srp"), ORG, ctx.id("snd"), "to", `r${index}@example.net`, "handed_over", when, when));
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO send_recipient_events
         (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload,
          received_at)
       VALUES (?,?,?,?,?,NULL,1,'{}',?)`,
    ).bind(ctx.id("evt"), ORG, ctx.id("snd"), `r${index}@example.net`,
      index % 3 === 0 ? "cf.email.sending.message.bounced" : "cf.email.sending.message.delivered", when));
  }
  await testEnv.CATALOG.batch(statements);
}

beforeEach(async () => {
  for (const table of ["send_manifests", "send_recipients", "send_recipient_events", "domain_pauses",
                       "approvals", "approval_stages", "approval_decisions", "notifications",
                       "relationship_tuples", "mailboxes", "addresses", "users", "audit_entries",
                       "policies", "policy_versions", "conversations", "cases", "outbox", "messages",
                       "ingress_receipts", "send_counters"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
    .bind(MAILBOX, ORG, "Support", at).run();
  await testEnv.CATALOG.prepare(
    "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
  ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at).run();
  for (const id of [AUTHOR, ADMIN_A, ADMIN_B, ADMIN_C]) {
    await testEnv.CATALOG.prepare(
      "INSERT OR IGNORE INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
    ).bind(id, ORG, `${id}@local.invalid`, at).run();
  }
  for (const id of [ADMIN_A, ADMIN_B, ADMIN_C]) await tuple(id, "org.admin", "organization", ORG);
  await tuple(AUTHOR, "send.propose", "mailbox", MAILBOX);
  await tuple(AUTHOR, "mailbox.content.read", "mailbox", MAILBOX);
});

describe("what asking every breaker costs", () => {
  it("costs one subrequest, empty or full, paused or not", async () => {
    const scenarios: Array<[string, () => Promise<void>]> = [
      ["nothing sent, nothing observed, no pause", async () => {}],
      ["all three rates with rows inside the window", populate],
      ["a pause in force on the sending domain", async () => {
        await populate();
        const requested = await requestDomainPause(
          testEnv, atTime(AUGUST_20 - 10_000), ORG, ADMIN_A, "acme.example", "measurement fixture",
        );
        await decideApproval(
          testEnv, atTime(AUGUST_20 - 9_000), ORG, ADMIN_B, requested.approvalId, "approve",
        );
        await decideApproval(
          testEnv, atTime(AUGUST_20 - 8_000), ORG, ADMIN_C, requested.approvalId, "approve",
        );
      }],
    ];

    for (const [name, setUp] of scenarios) {
      for (const table of ["send_recipients", "send_recipient_events", "domain_pauses", "approvals",
                           "approval_stages", "approval_decisions", "notifications", "audit_entries"]) {
        await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
      }
      await setUp();

      const { env: metered, cost: spent } = metering(testEnv);
      const decision = await evaluateBreakers(metered, atTime(AUGUST_20), ORG, "acme.example");
      console.log(`MEASURE breakers scenario=${name}  subrequests=${spent.subrequests}  `
        + `d1=${spent.d1Executions} (batches=${spent.d1Batches})  r2=${spent.r2Operations}`);

      // The bound rather than an equality, for the reason `butler-step-cost.md` states: an equality on an
      // I/O count fails on every harmless refactor and gets deleted. Two catches the one change that
      // matters — somebody splitting the statement into four — and nothing else.
      expect(spent.subrequests, `${name} must stay inside ${MAX}`).toBeLessThanOrEqual(MAX);
      // Anti-vacuity: a meter reading zero would satisfy the bound above while measuring nothing at all.
      expect(spent.subrequests, `${name} must actually ask something`).toBeGreaterThan(0);
      // And the answer is a real one, not an empty object that happened to cost nothing.
      expect(decision.rates).toHaveLength(3);
    }
  });

  it("costs the seal exactly one more than it did", async () => {
    await populate();
    const { env: metered, cost: spent } = metering(testEnv);
    await sealManifest(metered, atTime(AUGUST_20), ORG, {
      mailboxId: MAILBOX,
      authorUserId: AUTHOR,
      to: ["customer@example.net"],
      subject: "Hello",
      bodyTyped: "Body.",
      fidelity: "authored",
    });
    console.log(`MEASURE seal scenario=no-policies+breakers  subrequests=${spent.subrequests}  `
      + `d1=${spent.d1Executions} (batches=${spent.d1Batches})  r2=${spent.r2Operations}  `
      + `do_rpc=${spent.doRpcs}`);

    // `policy-evaluation-cost.md` measured a seal with no policies at **11** on 20 August, before this
    // ticket. The breaker adds one statement, unconditionally, so 12 is the figure — and this is a bound
    // with one of headroom rather than an equality, for the same reason every other cost figure here is.
    expect(spent.subrequests).toBeLessThanOrEqual(13);
    expect(spent.subrequests).toBeGreaterThanOrEqual(12);
  });
});
