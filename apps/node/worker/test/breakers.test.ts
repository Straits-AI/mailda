import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { BREAKER_REASONS, evaluateBreakers, isBreakerReason, RATE_BREAKERS } from "../src/breakers.ts";
import { DISPATCH_REASONS } from "../src/outbound/recheck.ts";
import { createPolicyDraft, publishPolicy } from "../src/policy.ts";
import { applySendingEvent } from "../src/outbound/events.ts";
import { recordDeliveryReport } from "../src/outbound/delivery-report.ts";
import { cancelSend, dispatchDue, dispatchOne, type SendState } from "../src/outbound/dispatch.ts";
import { sealManifest } from "../src/outbound/manifest.ts";
import type { SubmitOutcome, TransportAdapter } from "../src/outbound/transport.ts";
import { runDoctor } from "../src/doctor.ts";

/**
 * The three windowed rate breakers (#66), and the landmine they were built around.
 *
 * ## What this file is actually protecting
 *
 * **`send_recipient_events` has a second writer.** `recordDeliveryReport` inserts
 * `event_type = "inbound.delivery_report"` with `terminal = 1` and `manifest_id` **NULL** for delivery reports
 * about *other systems' mail* — its own header says so. A naive `COUNT(*)` over that table would trip this
 * Node's bounce breaker on somebody else's bounces, disabling a working Node on a number it read wrong, which
 * is the exact inversion a circuit breaker exists to prevent.
 *
 * So the tests below are a matched set: the same number of terminal failure rows, over the same window, one
 * set attributed to this Node's own sends and two sets foreign. One trips and neither of the others does.
 *
 * ## There are **two** kinds of foreign row, and only one of them is what the ticket named
 *
 * This distinction was found by mutating the source rather than by reasoning about it, and it is the reason
 * this file has three fixtures instead of two.
 *
 *   `inbound.delivery_report` with a NULL manifest_id — `recordDeliveryReport`'s row, the one #66's landmine
 *   comment names. It is excluded by the **event-type** filter, because it is not one of Cloudflare's type
 *   strings. Deleting the attribution clause does not change this case at all, so a test built only from
 *   these rows passes against a breaker with no attribution clause — measured: it did.
 *
 *   `cf.email.sending.message.bounced` with a NULL manifest_id — `applySendingEvent`'s row, written when an
 *   event arrives that this Node cannot tie to anything it sent. `doctor` already reports these as
 *   `delivery_attribution`, and its fix names the usual cause: *"a subscription covering a domain sent from
 *   elsewhere, whose events arrive here with no matching manifest"*. **This** is the row the attribution
 *   clause is load-bearing for, and deleting the clause counts somebody else's bounces into this Node's rate.
 *
 * Both are foreign, both are `terminal = 1`, and each is excluded by a different predicate. Writing down only
 * the first would have left the second uncovered while reading as though it were handled.
 *
 * Both fixtures go through the **writers that actually produce those rows** rather than through an INSERT
 * this file composes — the difference between testing the breaker against a fixture somebody wrote to match
 * it and testing it against reality.
 */

const testEnv = env as unknown as Env;
const ORG = "org_breakers";
const MAILBOX = "mbx_breakers";
const ADDRESS = "support@acme.example";
const AUTHOR = "usr_author_bk";

const AUGUST_20 = Date.parse("2026-08-20T12:00:00.000Z");

const VOLUME_WINDOW = BUDGETS["breaker.volume_window_seconds"];
const VOLUME_MAX = BUDGETS["breaker.volume_max_recipients"];
const BOUNCE_WINDOW = BUDGETS["breaker.bounce_window_seconds"];
const BOUNCE_FLOOR = BUDGETS["breaker.bounce_min_observations"];
const BOUNCE_MAX = BUDGETS["breaker.bounce_max_percent"];
const COMPLAINT_WINDOW = BUDGETS["breaker.complaint_window_seconds"];
const COMPLAINT_FLOOR = BUDGETS["breaker.complaint_min_observations"];

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

/** A transport that always accepts, so a dispatch that is *not* stopped is visibly not stopped. */
const acceptingTransport: TransportAdapter = {
  name: "test-accepting",
  capability: async () => ({
    canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "test",
  }),
  submit: async (): Promise<SubmitOutcome> =>
    ({ kind: "handed_over", transportMessageId: "<x@acme.example>" }),
};

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

/**
 * One hand-over, `n` recipients, at an instant — the volume breaker's substrate, written the way dispatch
 * writes it.
 *
 * Per recipient, because that is the grain the provider counts in and the grain the breaker counts in. A
 * manifest-level fixture would have passed against a breaker that called one message to four hundred people
 * a single send.
 */
async function handedOver(count: number, at: number): Promise<void> {
  const ctx = createSystemCtx();
  const when = new Date(at).toISOString();
  const manifestId = ctx.id("snd");
  const statements = [];
  for (let index = 0; index < count; index += 1) {
    statements.push(testEnv.CATALOG.prepare(
      `INSERT INTO send_recipients
         (id, org_id, manifest_id, kind, address, submission_state, submission_state_at,
          delivery_state, delivery_state_at, bounce_type, last_error, last_event_id, created_at)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?)`,
    ).bind(ctx.id("srp"), ORG, manifestId, "to", `r${index}@example.net`, "handed_over", when, when));
  }
  await testEnv.CATALOG.batch(statements);
}

/**
 * One delivery event of this Node's own, **attributed**: `manifest_id` is not null.
 *
 * Written through the same columns `applySendingEvent` writes, and deliberately not through that function:
 * it needs a matching `send_recipients` row to attribute against, and what this file is testing is the
 * *counting*, not the joining. That the counting SQL carries `manifest_id IS NOT NULL` on **every** one of
 * its sub-selects is pinned separately, by reading the source, in
 * `test/node/breaker-attribution-world.test.ts` — a behavioural test can only show that today's six
 * sub-selects are attributed, and a seventh added tomorrow would slip past it.
 */
async function ownEvent(type: string, at: number): Promise<void> {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT INTO send_recipient_events
       (event_id, org_id, manifest_id, recipient, event_type, transport_message_id, terminal, payload,
        received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).bind(ctx.id("evt"), ORG, ctx.id("snd"), "someone@example.net", type, null,
    type.endsWith("deferred") ? 0 : 1, "{}", new Date(at).toISOString()).run();
}

/**
 * A delivery report about **somebody else's** mail, written by the writer that actually produces them.
 *
 * `recordDeliveryReport` matches `Original-Message-ID` against this Node's manifests and writes NULL when it
 * finds none — which is what an unattributable report is. No manifest here carries this id, so the row lands
 * unattributed, exactly as it would for a bounce forwarded by a person or relayed before Mailda existed.
 */
async function foreignReport(index: number, at: number): Promise<void> {
  const recorded = await recordDeliveryReport(
    testEnv, atTime(at), ORG, `rcp_foreign_${index}`,
    `Content-Type: message/delivery-status\r\n`
    + `Final-Recipient: rfc822; stranger${index}@somewhere.example\r\n`
    + `Original-Message-ID: <not-ours-${index}@elsewhere.example>\r\n`
    + `Diagnostic-Code: smtp; 550 5.1.1 User unknown\r\n`,
  );
  // The premise of every "does not trip" assertion below. If this ever came back attributed, the tests that
  // follow would be asserting something else entirely and would still pass.
  expect(recorded.recorded, "the report must be recorded").toBe(true);
  expect(recorded.manifestId, "the report must be UNattributed, or this fixture proves nothing").toBeNull();
}

/**
 * A delivery event this Node **cannot attribute**: Cloudflare's own type, and no manifest to tie it to.
 *
 * Written by `applySendingEvent`, which stores an unattributable event with a NULL `manifest_id` rather than
 * dropping it — *"a bounce nobody can attribute is still a bounce, and it must be visible"*. That is exactly
 * right for the ledger and exactly wrong for a rate, and it is the row `manifest_id IS NOT NULL` exists for.
 */
async function unattributableBounce(index: number, at: number): Promise<void> {
  const outcome = await applySendingEvent(testEnv, atTime(at), ORG, {
    type: "cf.email.sending.message.bounced",
    payload: {
      eventId: `evt_foreign_${index}`,
      recipient: `stranger${index}@somewhere.example`,
      // Matches no manifest and no recipient row in this organization, which is what makes it unattributable.
      messageId: `<not-ours-${index}@elsewhere.example>`,
      terminal: true,
    },
  });
  // The premise of the assertion that follows. If this ever came back attributed the test would be about
  // something else and would still pass.
  expect(outcome.applied, "the event must be recorded").toBe(true);
  expect(outcome.manifestId, "the event must be UNattributed, or this fixture proves nothing").toBeNull();
}

async function seal(at: number) {
  return sealManifest(testEnv, atTime(at), ORG, {
    mailboxId: MAILBOX,
    authorUserId: AUTHOR,
    to: ["customer@example.net"],
    subject: "Hello",
    bodyTyped: "Body.",
    fidelity: "authored",
  });
}

async function manifestRow(id: string) {
  return testEnv.CATALOG.prepare(
    "SELECT state, state_reason, last_error, release_at FROM send_manifests WHERE org_id = ? AND id = ?",
  ).bind(ORG, id).first<{
    state: SendState; state_reason: string | null; last_error: string | null; release_at: string;
  }>();
}

beforeEach(async () => {
  for (const table of ["send_manifests", "send_recipients", "send_recipient_events", "send_counters",
                       "domain_pauses", "approvals", "approval_stages", "approval_decisions",
                       "notifications", "policies", "policy_versions", "relationship_tuples", "mailboxes",
                       "addresses", "users", "audit_entries", "node_claim", "ingress_receipts",
                       "messages", "conversations", "cases", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(AUTHOR, ORG, "author@local.invalid", at),
  ]);
  await tuple(AUTHOR, "send.propose", "mailbox", MAILBOX);
  await tuple(AUTHOR, "mailbox.content.read", "mailbox", MAILBOX);
});

/* ---------------------------------------------------- the classification ---------------------------- */

describe("a breaker gates or refuses, and the two vocabularies cannot overlap", () => {
  it("keeps the gate reasons and the refusal reasons disjoint", () => {
    // #66 requires the classification to be **per breaker and explicit in code**, not inferred from a
    // severity or a threshold. It is explicit as a *mechanism*: a gate is declared in `RATE_BREAKERS` and
    // mints a reason here; a refusal is declared in `WITHHOLDING` and mints one there. This is what makes
    // that a property rather than a convention — a fourth breaker declared in both lists, or moved from one
    // to the other without its reason moving, fails here.
    const gates = new Set(BREAKER_REASONS);
    const refusals = new Set<string>(DISPATCH_REASONS);
    expect([...gates].filter((reason) => refusals.has(reason)),
      "a reason cannot mean both 'wait' and 'never'").toEqual([]);

    // Anti-vacuity in both directions: two empty sets are trivially disjoint.
    expect(gates.size).toBe(3);
    expect(refusals.size).toBeGreaterThanOrEqual(7);
  });

  it("mints exactly one reason per declared rate breaker", () => {
    // `BREAKER_REASONS` is derived from `RATE_BREAKERS` rather than written out, so this pins the derivation:
    // a fourth breaker with no reason, or a reason with no breaker, is not representable.
    expect([...BREAKER_REASONS].sort()).toEqual(
      Object.values(RATE_BREAKERS).map((spec) => spec.reason).sort(),
    );
    expect(BREAKER_REASONS).toHaveLength(Object.keys(RATE_BREAKERS).length);
    for (const reason of BREAKER_REASONS) expect(isBreakerReason(reason)).toBe(true);
    expect(isBreakerReason("policy_hold"),
      "a policy gate must never be readmitted to the sweep as a breaker reason").toBe(false);
    expect(isBreakerReason("policy_approval_required")).toBe(false);
    expect(isBreakerReason(null)).toBe(false);
  });
});

/* ---------------------------------------------------- the landmine ---------------------------------- */

describe("a rate counts this Node's own outcomes and nobody else's", () => {
  it("trips on this Node's own bounces", async () => {
    // Enough observations to arm it, and a rate well past the limit: 20 of 20 refused is 100%.
    for (let index = 0; index < BOUNCE_FLOOR; index += 1) {
      await ownEvent("cf.email.sending.message.bounced", AUGUST_20 - 60_000);
    }

    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const bounce = decision.rates.find((rate) => rate.breaker === "bounce_rate")!;
    expect(bounce.armed).toBe(true);
    expect(bounce.observations).toBe(BOUNCE_FLOOR);
    expect(bounce.percent).toBe(100);
    expect(bounce.tripped).toBe(true);
    expect(decision.gate?.breaker).toBe("bounce_rate");
  });

  it("does not trip on the same number of FOREIGN delivery reports", async () => {
    // The matched half. Same count, same window, same `terminal = 1`, same table — and every one of them is
    // a report about mail some other system sent, which `recordDeliveryReport` records with a NULL
    // manifest_id. A breaker without `manifest_id IS NOT NULL` sees twenty terminal failures and stops a
    // Node that has not sent a single bad message.
    for (let index = 0; index < BOUNCE_FLOOR; index += 1) {
      await foreignReport(index, AUGUST_20 - 60_000);
    }

    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const bounce = decision.rates.find((rate) => rate.breaker === "bounce_rate")!;
    // Not "0% and fine" — **unarmed**, because there is nothing to rate. Those two readings look the same on
    // a dashboard and mean opposite things, which is why `armed` exists.
    expect(bounce.observations).toBe(0);
    expect(bounce.armed).toBe(false);
    expect(bounce.unarmedReason).toBe("no_observations");
    expect(bounce.tripped).toBe(false);
    expect(decision.gate).toBeNull();

    // And the rows really are there: this is not passing because nothing was written.
    const rows = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM send_recipient_events WHERE org_id = ? AND terminal = 1",
    ).bind(ORG).first<{ n: number }>();
    expect(rows?.n).toBe(BOUNCE_FLOOR);
  });

  it("does not trip on unattributable events of Cloudflare's OWN bounce type", async () => {
    // The case the event-type filter cannot catch, and the one the attribution clause is load-bearing for: a
    // real `cf.email.sending.message.bounced` that this Node could not tie to anything it sent. `doctor`
    // reports these as `delivery_attribution`, whose fix names the usual cause — a subscription scoped to a
    // domain somebody else sends from. Without `manifest_id IS NOT NULL`, twenty of them stop a Node that has
    // sent nothing at all.
    for (let index = 0; index < BOUNCE_FLOOR; index += 1) {
      await unattributableBounce(index, AUGUST_20 - 60_000);
    }

    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const bounce = decision.rates.find((rate) => rate.breaker === "bounce_rate")!;
    expect(bounce.observations, "not in the denominator").toBe(0);
    expect(bounce.observed, "not in the numerator").toBe(0);
    expect(bounce.armed).toBe(false);
    expect(bounce.tripped).toBe(false);
    expect(decision.gate).toBeNull();

    // The rows are there, of the right type, and unattributed: three separate facts, because the assertion
    // above is only meaningful if all three hold.
    const rows = await testEnv.CATALOG.prepare(
      `SELECT COUNT(*) AS n FROM send_recipient_events
        WHERE org_id = ? AND event_type = 'cf.email.sending.message.bounced' AND manifest_id IS NULL`,
    ).bind(ORG).first<{ n: number }>();
    expect(rows?.n).toBe(BOUNCE_FLOOR);
  });

  it("counts a mix as the rate over the attributed half only", async () => {
    // Ten of this Node's own outcomes, two of them refusals — 20%, under the 30% limit — and forty foreign
    // bounces on top. The foreign rows must move neither the numerator nor the denominator.
    for (let index = 0; index < 2; index += 1) {
      await ownEvent("cf.email.sending.message.bounced", AUGUST_20 - 60_000);
    }
    for (let index = 0; index < BOUNCE_FLOOR - 2; index += 1) {
      await ownEvent("cf.email.sending.message.delivered", AUGUST_20 - 60_000);
    }
    for (let index = 0; index < 20; index += 1) {
      await foreignReport(index, AUGUST_20 - 60_000);
      await unattributableBounce(index, AUGUST_20 - 60_000);
    }

    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const bounce = decision.rates.find((rate) => rate.breaker === "bounce_rate")!;
    expect(bounce.observations).toBe(BOUNCE_FLOOR);
    expect(bounce.observed).toBe(2);
    expect(bounce.percent).toBe(Math.round((2 / BOUNCE_FLOOR) * 100));
    expect(bounce.percent).toBeLessThan(BOUNCE_MAX);
    expect(bounce.tripped).toBe(false);
  });

  it("leaves failed and rejected out of both halves, because they are not a receiving server refusing", async () => {
    // `events.ts` keeps `failed` and `rejected` as their own words precisely because they are the provider's
    // internal problems rather than a refusal — telling somebody their recipients are bouncing when
    // Cloudflare had an outage is a false statement about a third party's mail server. So they move neither
    // the numerator nor the denominator, and this asserts both halves: a rate that counted them in the
    // denominator would read artificially healthy, and one that counted them in the numerator would trip a
    // Node whose addresses are all fine.
    for (let index = 0; index < BOUNCE_FLOOR; index += 1) {
      await ownEvent("cf.email.sending.message.failed", AUGUST_20 - 60_000);
      await ownEvent("cf.email.sending.message.rejected", AUGUST_20 - 60_000);
    }
    const only = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const bounce = only.rates.find((rate) => rate.breaker === "bounce_rate")!;
    expect(bounce.observations, "not in the denominator").toBe(0);
    expect(bounce.observed, "not in the numerator").toBe(0);
    expect(bounce.armed).toBe(false);

    // And the rows are genuinely there, so this is not passing on an empty table.
    const rows = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM send_recipient_events WHERE org_id = ?",
    ).bind(ORG).first<{ n: number }>();
    expect(rows?.n).toBe(BOUNCE_FLOOR * 2);
    // The limit these events would have been rated against, named so a reader can find it.
    expect(RATE_BREAKERS.bounce_rate.limitBudget).toBe("breaker.bounce_max_percent");
  });
});

/* ---------------------------------------------------- windows and retryAfter ------------------------ */

describe("the window slides, so recovery needs nothing to be re-armed", () => {
  it("stops counting a bounce once it is older than the window", async () => {
    for (let index = 0; index < BOUNCE_FLOOR; index += 1) {
      await ownEvent("cf.email.sending.message.bounced", AUGUST_20 - 60_000);
    }
    expect((await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example")).gate?.breaker)
      .toBe("bounce_rate");

    // One second past the window's far edge, with nothing reset, nothing swept and no timer having fired.
    const later = AUGUST_20 - 60_000 + BOUNCE_WINDOW * 1000 + 1_000;
    const cleared = await evaluateBreakers(testEnv, atTime(later), ORG, "acme.example");
    const bounce = cleared.rates.find((rate) => rate.breaker === "bounce_rate")!;
    expect(bounce.observations).toBe(0);
    expect(bounce.tripped).toBe(false);
    expect(cleared.gate).toBeNull();
  });

  it("computes retryAfter from the oldest row still inside the window, exactly, for volume", async () => {
    // The oldest hand-over is 600s old; the window is an hour. So the count falls in 3600 - 600 = 3000s, and
    // it falls *exactly* then, because volume is a count rather than a rate.
    const oldest = AUGUST_20 - 600_000;
    await handedOver(VOLUME_MAX + 1, oldest);

    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const volume = decision.rates.find((rate) => rate.breaker === "volume")!;
    expect(volume.tripped).toBe(true);
    expect(volume.observed).toBe(VOLUME_MAX + 1);
    expect(volume.retryAfterSeconds).toBe(VOLUME_WINDOW - 600);
    // The claim about the claim: for a count this figure is when it clears, not a lower bound on it.
    expect(volume.retryAfterExact).toBe(true);
  });

  it("calls a rate's retryAfter a lower bound rather than an answer", async () => {
    for (let index = 0; index < BOUNCE_FLOOR; index += 1) {
      await ownEvent("cf.email.sending.message.bounced", AUGUST_20 - 900_000);
    }
    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const bounce = decision.rates.find((rate) => rate.breaker === "bounce_rate")!;
    expect(bounce.retryAfterSeconds).toBe(BOUNCE_WINDOW - 900);
    // **False**, and this is the honest half: the oldest bounce leaving the window drops the numerator, but
    // the denominator moves with it, so the rate may still be over. Claiming otherwise would be a number
    // that ends a question wrongly, which AGENTS.md rates worse than a blank.
    expect(bounce.retryAfterExact).toBe(false);
  });

  it("reports no retryAfter at all when nothing is inside the window", async () => {
    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    for (const rate of decision.rates) expect(rate.retryAfterSeconds).toBeNull();
  });
});

/* ---------------------------------------------------- the volume and complaint breakers ------------- */

describe("volume counts recipients, and the complaint rate is over deliveries", () => {
  it("does not trip at the limit, only above it — the budget is what is allowed", async () => {
    await handedOver(VOLUME_MAX, AUGUST_20 - 60_000);
    const at = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    expect(at.rates.find((rate) => rate.breaker === "volume")!.tripped).toBe(false);

    await handedOver(1, AUGUST_20 - 60_000);
    const over = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    expect(over.rates.find((rate) => rate.breaker === "volume")!.tripped).toBe(true);
  });

  it("stays unarmed on a complaint rate with too few deliveries to divide by", async () => {
    // Two complaints and two deliveries is 100%, and it means nothing at all: this is the floor doing its
    // job. A breaker without one would stop a Node on the second annoyed recipient it ever had.
    await ownEvent("cf.email.sending.message.delivered", AUGUST_20 - 60_000);
    await ownEvent("cf.email.sending.message.delivered", AUGUST_20 - 60_000);
    await ownEvent("cf.email.sending.message.complained", AUGUST_20 - 60_000);
    await ownEvent("cf.email.sending.message.complained", AUGUST_20 - 60_000);

    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const complaint = decision.rates.find((rate) => rate.breaker === "complaint_rate")!;
    expect(complaint.observations).toBe(2);
    expect(complaint.armed).toBe(false);
    expect(complaint.tripped).toBe(false);
    // **Blank, not a number.** 100% here would be true arithmetic and a false statement, and `0` — which is
    // what an unarmed reading with no events at all used to serve — would be the reassuring figure this whole
    // mechanism refuses. `GET /api/breakers` serves this field, so a client reading `percent` without reading
    // `armed` must be handed a blank that prompts a question rather than a number that ends one.
    expect(complaint.percent, "an unarmed rate has no trustworthy percentage").toBeNull();

    const nothing = await evaluateBreakers(testEnv, atTime(AUGUST_20 + COMPLAINT_WINDOW * 1000 * 2),
      ORG, "acme.example");
    for (const rate of nothing.rates) {
      expect(rate.observations).toBe(0);
      expect(rate.percent, `${rate.breaker} must not report 0% on nothing`).toBeNull();
    }
  });

  it("trips once there are enough deliveries for the percentage to mean something", async () => {
    for (let index = 0; index < COMPLAINT_FLOOR; index += 1) {
      await ownEvent("cf.email.sending.message.delivered", AUGUST_20 - 60_000);
    }
    for (let index = 0; index < COMPLAINT_FLOOR / 2; index += 1) {
      await ownEvent("cf.email.sending.message.complained", AUGUST_20 - 60_000);
    }
    const decision = await evaluateBreakers(testEnv, atTime(AUGUST_20), ORG, "acme.example");
    const complaint = decision.rates.find((rate) => rate.breaker === "complaint_rate")!;
    expect(complaint.armed).toBe(true);
    expect(complaint.percent).toBe(50);
    expect(complaint.tripped).toBe(true);
    expect(complaint.windowSeconds).toBe(COMPLAINT_WINDOW);
  });
});

/* ---------------------------------------------------- the seal and the drain ------------------------ */

describe("a rate gate parks a send in awaiting, and the sweep is what drains it", () => {
  it("seals to awaiting with the breaker's reason and the four-part sentence", async () => {
    await handedOver(VOLUME_MAX + 1, AUGUST_20 - 600_000);

    const sealed = await seal(AUGUST_20);
    expect(sealed.state).toBe("awaiting");
    expect(sealed.stateReason).toBe("breaker_volume");
    expect(isBreakerReason(sealed.stateReason)).toBe(true);
    // AGENTS.md's four parts, at the moment the developer hits the limit: the named budget with its number,
    // the ask, where the number came from, and how to change it.
    expect(sealed.breakerError).toContain("breaker.volume_max_recipients=500");
    expect(sealed.breakerError).toContain(`${VOLUME_MAX + 1}`);
    expect(sealed.breakerError).toContain("docs/receipts/send-breakers.md");
    expect(sealed.breakerError).toContain("pnpm receipts");
    // And the same sentence on the row a person reads, rather than two that could drift.
    expect((await manifestRow(sealed.id))?.last_error).toBe(sealed.breakerError);

    // The recipients moved with the manifest: a gated send whose recipients read `held` shows somebody a
    // message that is simultaneously stopped and pending.
    const recipients = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE org_id = ? AND manifest_id = ?",
    ).bind(ORG, sealed.id).all<{ submission_state: string }>();
    expect(recipients.results.map((row) => row.submission_state)).toEqual(["awaiting"]);
  });

  it("records the trip, because nothing else does", async () => {
    await handedOver(VOLUME_MAX + 1, AUGUST_20 - 600_000);
    const sealed = await seal(AUGUST_20);

    const entry = await testEnv.CATALOG.prepare(
      `SELECT action, detail FROM audit_entries
        WHERE org_id = ? AND subject = ? AND action = 'send.rate_limited'`,
    ).bind(ORG, sealed.id).first<{ action: string; detail: string }>();
    expect(entry, "a rate breaker keeps no state, so an unaudited trip never happened").not.toBeNull();
    const detail = JSON.parse(entry!.detail) as Record<string, unknown>;
    expect(detail.breaker).toBe("volume");
    expect(detail.limit).toBe(VOLUME_MAX);
    expect(detail.observed).toBe(VOLUME_MAX + 1);
    expect(detail.at).toBe("seal");
    expect(detail.retryAfterExact).toBe(true);
  });

  it("does not dispatch it while the window is still over, and does once it clears", async () => {
    const oldest = AUGUST_20 - 600_000;
    await handedOver(VOLUME_MAX + 1, oldest);
    const sealed = await seal(AUGUST_20);
    expect(sealed.state).toBe("awaiting");

    // Past the hold window, still inside the volume window: the sweep picks it up — which is the widening
    // #66 needed — re-asks, and puts it straight back.
    const stillOver = Date.parse(sealed.releaseAt) + 1_000;
    const first = await dispatchDue(testEnv, atTime(stillOver), ORG, acceptingTransport);
    expect(first.map((result) => result.state)).toEqual(["awaiting"]);
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");

    // Past the volume window's far edge: nothing was reset and no timer fired, the rows simply aged out.
    const cleared = oldest + VOLUME_WINDOW * 1000 + 1_000;
    const second = await dispatchDue(testEnv, atTime(cleared), ORG, acceptingTransport);
    expect(second.map((result) => result.state)).toEqual(["handed_over"]);
    expect((await manifestRow(sealed.id))?.state).toBe("handed_over");
  });

  it("files one entry per gate rather than one per sweep", async () => {
    await handedOver(VOLUME_MAX + 1, AUGUST_20 - 600_000);
    const sealed = await seal(AUGUST_20);
    const after = Date.parse(sealed.releaseAt) + 1_000;

    // Three sweeps, all meeting the same answer. `audit-and-log-retention.md` sizes this table at a handful
    // per message, and a sweeper that filed an entry per tick would put sixty an hour behind one send.
    for (const tick of [0, 60_000, 120_000]) {
      await dispatchDue(testEnv, atTime(after + tick), ORG, acceptingTransport);
    }
    const entries = await testEnv.CATALOG.prepare(
      `SELECT COUNT(*) AS n FROM audit_entries
        WHERE org_id = ? AND subject = ? AND action = 'send.rate_limited'`,
    ).bind(ORG, sealed.id).first<{ n: number }>();
    // One from the seal. The three dispatches met a manifest already gated for this reason and wrote nothing.
    expect(entries?.n).toBe(1);
  });

  it("gates a send that was clear at the seal and is over at the dispatch — failing closed", async () => {
    const sealed = await seal(AUGUST_20);
    expect(sealed.state).toBe("held");

    // The rate goes over between the seal and the hand-over. #66 settled both evaluation points precisely so
    // this send does not slip through on an answer that was true when it was composed.
    await handedOver(VOLUME_MAX + 1, AUGUST_20 + 1_000);
    const after = Date.parse(sealed.releaseAt) + 1_000;
    const result = await dispatchOne(testEnv, atTime(after), ORG, sealed.id, acceptingTransport);

    expect(result.state).toBe("awaiting");
    const row = await manifestRow(sealed.id);
    expect(row?.state_reason).toBe("breaker_volume");
    const entry = await testEnv.CATALOG.prepare(
      `SELECT detail FROM audit_entries
        WHERE org_id = ? AND subject = ? AND action = 'send.rate_limited'`,
    ).bind(ORG, sealed.id).first<{ detail: string }>();
    expect((JSON.parse(entry!.detail) as { at: string }).at).toBe("dispatch");
    // No attempt was spent, which is what separates a gate from a failure.
    const attempts = await testEnv.CATALOG.prepare(
      "SELECT attempts FROM send_manifests WHERE id = ?",
    ).bind(sealed.id).first<{ attempts: number }>();
    expect(attempts?.attempts).toBe(0);

    // **The recipients followed the manifest**, which the seal path already asserts and this one did not.
    // Deleting the `UPDATE send_recipients` from the dispatch gate passed all 785 tests in this repository
    // before this line existed, so the sentence beside it in `dispatch.ts` — *"a gated send whose recipients
    // still read `held` shows a person a message that is simultaneously stopped and pending"* — was a claim
    // nothing enforced. Measured by mutation, restored, and pinned here.
    const recipients = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE org_id = ? AND manifest_id = ?",
    ).bind(ORG, sealed.id).all<{ submission_state: string }>();
    expect(recipients.results.length, "no recipients would make the next line vacuous").toBeGreaterThan(0);
    expect(recipients.results.map((recipient) => recipient.submission_state)).toEqual(
      recipients.results.map(() => "awaiting"),
    );
  });

  it("tells the caller what the send really is when the gate lost a race", async () => {
    // The gate's write is conditional, so it can match nothing — and there are two ways that happens. A
    // **re-visit** meets a send already gated for this reason and must still answer `awaiting`; a **lost
    // race** meets one somebody cancelled and must answer `cancelled`, not "waiting for a window". The
    // second used to be reported as `awaiting` unconditionally, under a comment claiming *"either way the
    // send is awaiting for this reason, and that is what the caller is told"*.
    const sealed = await seal(AUGUST_20);
    await handedOver(VOLUME_MAX + 1, AUGUST_20 + 1_000);
    const after = Date.parse(sealed.releaseAt) + 1_000;

    // The re-visit: gate it once, then meet it again while the window is still over.
    expect((await dispatchOne(testEnv, atTime(after), ORG, sealed.id, acceptingTransport)).state)
      .toBe("awaiting");
    const revisit = await dispatchOne(testEnv, atTime(after + 60_000), ORG, sealed.id, acceptingTransport);
    expect(revisit.state, "a re-visit is still awaiting, and nothing was recorded for it").toBe("awaiting");

    // The lost race: the send is gone from under the gate.
    await cancelSend(testEnv, atTime(after + 90_000), ORG, sealed.id);
    const raced = await dispatchOne(testEnv, atTime(after + 120_000), ORG, sealed.id, acceptingTransport);
    expect(raced.state, "a cancelled send is cancelled, not awaiting a window").toBe("cancelled");
    expect((await manifestRow(sealed.id))?.state).toBe("cancelled");
  });
});

describe("a rate gate never overwrites a policy gate, because the two clear differently", () => {
  it("keeps the policy's reason and leaves the send out of the sweep", async () => {
    // A policy that holds every send, and a volume rate well over its limit at the same instant. Both apply.
    const admin = "usr_admin_bk";
    await testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(admin, ORG, "admin@local.invalid", new Date(AUGUST_20).toISOString()).run();
    await tuple(admin, "org.admin", "organization", ORG);
    const draft = await createPolicyDraft(testEnv, atTime(AUGUST_20), ORG, admin, {
      name: "hold everything", outcome: "hold",
    });
    await publishPolicy(testEnv, atTime(AUGUST_20), ORG, admin, draft.policyId);
    await handedOver(VOLUME_MAX + 1, AUGUST_20 - 600_000);

    const sealed = await seal(AUGUST_20 + 1_000);
    expect(sealed.state).toBe("awaiting");
    // **`policy_hold`, not `breaker_volume`.** A policy gate needs a person and a rate gate needs time, so if
    // both apply the reason a reader must act on is the human one.
    expect(sealed.stateReason).toBe("policy_hold");
    expect(isBreakerReason(sealed.stateReason)).toBe(false);

    // And the consequence that actually matters: the sweep does not admit it. A rate limiter that could
    // release policy-gated mail once its window cleared would be a governance bypass with a benign name.
    const cleared = AUGUST_20 - 600_000 + VOLUME_WINDOW * 1000 + 1_000;
    expect(await dispatchDue(testEnv, atTime(cleared), ORG, acceptingTransport)).toEqual([]);
    expect((await manifestRow(sealed.id))?.state).toBe("awaiting");
  });
});

/* ---------------------------------------------------- doctor ---------------------------------------- */

describe("doctor refuses to arm a breaker with no observations", () => {
  it("says armed=false with the reason rather than a reassuring 0%", async () => {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)",
    ).bind(ctx.id("clm"), "x", new Date(AUGUST_20).toISOString(), ORG).run();

    const report = await runDoctor(testEnv, atTime(AUGUST_20));
    const finding = report.findings.find((f) => f.check === "send_breakers")!;
    expect(finding.detail).toContain("armed=false");
    expect(finding.detail).toContain("no_observations");
    expect(finding.detail).toContain("It is NOT 0%");
    // A quiet Node is not a broken one: a finding that fails on every fresh Node forever is one somebody
    // mutes, which `DELIVERY_SILENCE_MS` names in the same file.
    expect(finding.ok).toBe(true);
    expect(finding.severity).toBe("report");
  });

  it("degrades when the Node is sending and hearing nothing, which is when it cannot fire", async () => {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)",
    ).bind(ctx.id("clm"), "x", new Date(AUGUST_20).toISOString(), ORG).run();

    // A hand-over old enough to have been answered, and no attributed event at all — `delivery_visibility`'s
    // own blindness predicate, which this check reads rather than recomputing.
    const long_ago = AUGUST_20 - 7 * 24 * 3600_000;
    await handedOver(1, long_ago);
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests
         (id, org_id, mailbox_id, author_user_id, in_reply_to_message_id, envelope_from, envelope_to,
          envelope_cc, envelope_bcc, subject, rfc_message_id, references_header, fidelity,
          body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
          submitted_key, submitted_sha256, sealed_at, release_at, state, state_at,
          transport_message_id, last_error, attempts, policy_outcome, policy_versions, state_reason)
       VALUES (?,?,?,?,NULL,?,?,NULL,NULL,?,?,NULL,?,?,?,?,?,NULL,NULL,?,?,?,?,NULL,NULL,0,NULL,NULL,NULL)`,
    ).bind(
      (await testEnv.CATALOG.prepare(
        "SELECT manifest_id FROM send_recipients WHERE org_id = ? LIMIT 1",
      ).bind(ORG).first<{ manifest_id: string }>())!.manifest_id,
      ORG, MAILBOX, AUTHOR, ADDRESS, JSON.stringify(["r0@example.net"]), "Old", "old@acme.example",
      "authored", "k", "h", "k2", "h2",
      new Date(long_ago).toISOString(), new Date(long_ago).toISOString(), "handed_over",
      new Date(long_ago).toISOString(),
    ).run();

    const report = await runDoctor(testEnv, atTime(AUGUST_20));
    expect(report.findings.find((f) => f.check === "delivery_visibility")!.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === "send_breakers")!;
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    expect(finding.fix).toContain("no denominator");
  });
});
