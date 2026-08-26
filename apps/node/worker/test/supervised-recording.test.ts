import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { createSystemCtx, type Ctx } from "@mailda/runtime";

import worker from "../src/index.ts";
import { decideApproval } from "../src/approvals.ts";
import { authorize, listMessages } from "../src/authz-read.ts";
import { recordDisclosure } from "../src/audit.ts";
import { hashPassword } from "../src/auth/password.ts";
import { login } from "../src/auth/session.ts";
import { runDoctor, type Finding } from "../src/doctor.ts";
import { queueFor } from "../src/cases.ts";
import { closeMatter, openMatter } from "../src/matters.ts";
import { deliverDueNotifications } from "../src/notice-delivery.ts";
import { notificationsFor } from "../src/notifications.ts";
import { buildSupervisedQuery, requestSupervisedRead } from "../src/supervised.ts";

/**
 * Per-act recording, and the notice that follows it (#63 part B, §7, Layer 5).
 *
 * Part A shipped the authority — a matter, a time-boxed dual-approved grant, and an expiry that is a hard
 * stop — and named two things absent: **what the reader then read**, and **the person whose mail it was being
 * told**. This file is about those two, and about the collision between them that part A left deliberately
 * open (F-A: §7 hangs the notice on the matter closing, and a close can precede the reading it describes).
 *
 * ## The tests this file exists for
 *
 * 1. *Every supervised read leaves an entry, and a read this Node cannot record does not happen.* The second
 *    half is the one that matters: an unrecorded supervised read is the exact defect the mechanism exists to
 *    prevent, so the recording fails **closed**. Proved by making the append fail and watching the bytes stay
 *    where they are.
 * 2. *A query entry names the ids it returned, and the id list is never truncated.* `boundedDetail` would
 *    replace an oversized detail with a prefix — a record that understates what a person saw, which is the
 *    failure #63 chose per-act recording to avoid — so an oversized page is split instead. Tested at the
 *    edge, with a real page, against the real cap.
 * 3. *A notice becomes due, is delivered, and cannot be suppressed without deleting an audited row.*
 * 4. *The notice is held until the reading stopped*, which is F-A's resolution and the thing a close-dated
 *    notice would get wrong.
 *
 * ## Non-vacuity
 *
 * Every assertion below was verified by breaking the source it guards and watching it fail. The mutations and
 * the observed failures are recorded in the report for this change; the ones whose failure mode is **silence**
 * rather than an error are noted inline, because those are the ones a reader cannot re-derive.
 */

const testEnv = env as unknown as Env;
const ORG = "org_recording";
const MAILBOX = "mbx_rec_hr";
const ADDRESS = "people@rec.example";

const ADMIN = "usr_rec_admin";
/** Holds nothing on MAILBOX. The reader whose every act must be recorded. */
const INVESTIGATOR = "usr_rec_investigator";
const ANA = "usr_rec_ana";
const BEN = "usr_rec_ben";
/** Holds the standing content relation: the person §7's notice is *for*, and the control for "not recorded". */
const MEMBER = "usr_rec_member";

const PASSWORD = "fixture-password-not-a-real-secret";
const AUGUST_20 = Date.parse("2026-08-20T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const RECEIPTS = ["rcpt_rec_one", "rcpt_rec_two"];

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

beforeEach(async () => {
  for (const table of ["notifications", "supervised_grants", "matters", "approval_decisions",
                       "approval_stages", "approvals", "relationship_tuples", "team_members",
                       "ingress_receipts", "messages", "cases", "conversations", "addresses", "mailboxes",
                       "users", "node_claim", "login_attempts", "sessions", "refresh_tokens",
                       "audit_entries", "log_entries", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(AUGUST_20).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_rec", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "People", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...RECEIPTS.flatMap((receiptId, index) => [
      testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
           blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(receiptId, ORG, `evt_rec_${index}`, "candidate@example.net", ADDRESS, 2048,
        `${ORG}/raw/${receiptId}`, "0".repeat(64), at),
      testEnv.CATALOG.prepare(
        `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
           conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(ctx.id("msg"), ORG, "2026-08", `${ORG}/raw/${receiptId}`, "0".repeat(64), 2048,
        `<rec-${index}@customer.example>`, ctx.id("thr"), `Redundancy list ${index}`,
        "hr@customer.example", at, at, receiptId, at, null),
    ]),
    ...[ADMIN, INVESTIGATOR, ANA, BEN, MEMBER].map((userId) => testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@rec.example`, at, verifier.encoded, verifier.effectiveIterations, at)),
  ]);

  await tuple(ADMIN, "org.admin", "organization", ORG);
  await tuple(ANA, "approval.decide", "mailbox", MAILBOX);
  await tuple(BEN, "approval.decide", "mailbox", MAILBOX);
  // The person whose mailbox this is. §7's notice is addressed to the mailbox and resolved through this row.
  await tuple(MEMBER, "mailbox.content.read", "mailbox", MAILBOX);
});

async function sessionFor(userId: string): Promise<string> {
  const outcome = await login(testEnv, atTime(AUGUST_20), ORG, `${userId}@rec.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

function requestAs(token: string, path = "/api/messages"): Request {
  return new Request(`https://node.example${path}`, { headers: { authorization: `Bearer ${token}` } });
}

/** A supervised read requested by the investigator and approved by both eligible people. */
async function approvedGrant(options?: { matterId?: string | null; durationSeconds?: number }) {
  const ctx = atTime(AUGUST_20);
  const requested = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
    mailboxId: MAILBOX,
    scope: "content",
    durationSeconds: options?.durationSeconds ?? 3600,
    matterId: options?.matterId ?? null,
  });
  await decideApproval(testEnv, ctx, ORG, ANA, requested.approvalId, "approve");
  const closing = await decideApproval(testEnv, ctx, ORG, BEN, requested.approvalId, "approve");
  // Asserted in the helper rather than in every caller: a helper that quietly failed to grant would make
  // every recording assertion below pass for the wrong reason.
  if (closing.supervisedGranted !== true) throw new Error("the second approval did not grant the read");
  return requested;
}

async function auditRows(action: string) {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT subject, actor_user_id, outcome, detail FROM audit_entries WHERE org_id = ? AND action = ? ORDER BY seq",
  ).bind(ORG, action).all<{
    subject: string | null; actor_user_id: string | null; outcome: string; detail: string | null;
  }>();
  return results;
}

/** The §7 notices only. #61's approval requests share this table and are asserted separately. */
async function supervisedNotices() {
  return (await noticeRows()).filter((row) => row.kind === "supervised_read");
}

async function noticeRows() {
  const { results } = await testEnv.CATALOG.prepare(
    `SELECT id, kind, subject_id, user_id, mailbox_id, matter_id, due_at, delivered_at, body
       FROM notifications WHERE org_id = ? ORDER BY created_at, id`,
  ).bind(ORG).all<{
    id: string; kind: string; subject_id: string; user_id: string | null; mailbox_id: string | null;
    matter_id: string | null; due_at: string | null; delivered_at: string | null; body: string | null;
  }>();
  return results;
}

function find(findings: Finding[], check: string): Finding {
  const found = findings.find((finding) => finding.check === check);
  if (found === undefined) throw new Error(`no finding named ${check}`);
  return found;
}

/* ------------------------------------------------------------------ the acts ------------------- */

describe("every supervised read leaves an entry naming the grant it was made under", () => {
  it("records the listing, with the ids it returned rather than only how many", async () => {
    const token = await sessionFor(INVESTIGATOR);
    const grant = await approvedGrant();

    const listed = await (await listMessages(testEnv, atTime(AUGUST_20), requestAs(token))).json();
    expect((listed as { messages: unknown[] }).messages).toHaveLength(2);

    const entries = await auditRows("supervised.query");
    // One act, one entry: a query matching two things is not two entries. This is the sizing claim
    // `audit-and-log-retention.md` rests on, asserted rather than assumed.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe(grant.grantId);
    expect(entries[0]?.actor_user_id).toBe(INVESTIGATOR);
    const detail = JSON.parse(entries[0]?.detail ?? "{}") as { returned: number; ids: string[] };
    expect(detail.returned).toBe(2);
    // The ids, because "a query matched two things" understates what was seen by two subject lines.
    expect([...detail.ids].sort()).toEqual([...RECEIPTS].sort());
  });

  it("distinguishes opening content from reading the raw evidence", async () => {
    const token = await sessionFor(INVESTIGATOR);
    const grant = await approvedGrant();

    const opened = await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPTS[0]!,
      "supervised.opened");
    expect(opened.ok).toBe(true);
    const raw = await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPTS[1]!,
      "supervised.attachment");
    expect(raw.ok).toBe(true);

    /*
     * Two actions rather than one, because the raw `.eml` carries **every attachment** and §7 names an
     * attachment read separately from a result opened. One action for both would make "did anything leave
     * this Node as a file" unanswerable from the trail.
     */
    const openedEntries = await auditRows("supervised.opened");
    const rawEntries = await auditRows("supervised.attachment");
    expect(openedEntries).toHaveLength(1);
    expect(rawEntries).toHaveLength(1);
    expect(openedEntries[0]?.subject).toBe(grant.grantId);
    expect(JSON.parse(openedEntries[0]?.detail ?? "{}")).toMatchObject({ opened: RECEIPTS[0] });
    expect(JSON.parse(rawEntries[0]?.detail ?? "{}")).toMatchObject({ opened: RECEIPTS[1] });
  });

  it("records nothing when a standing relation is what answered", async () => {
    /*
     * The control, and it is what keeps the audit sizing honest: §7 asks for a record of *supervised* acts,
     * and `audit-and-log-retention.md` sizes the table at a handful of entries per message on the assumption
     * that ordinary reading is not one of them. `UNION ALL … LIMIT 1` stops at the tuple arm, so this costs
     * nothing to guarantee.
     *
     * **Non-vacuity note:** its failure mode is *extra* entries, which no other assertion in this file would
     * notice — every other one counts entries for the investigator.
     */
    const token = await sessionFor(MEMBER);
    await listMessages(testEnv, atTime(AUGUST_20), requestAs(token));
    const opened = await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPTS[0]!,
      "supervised.opened");
    expect(opened.ok).toBe(true);

    expect(await auditRows("supervised.query")).toHaveLength(0);
    expect(await auditRows("supervised.opened")).toHaveLength(0);
  });

  it("records the queue listing too, which part A called unreachable and is not", async () => {
    /*
     * `queueFor` is gated on `send.propose` **first**, so a supervised grant does not put a mailbox in
     * anybody's queue — part A's decision, and unchanged. What part A also said was that the supervised arm
     * of `mayReadMetadata` was therefore *unreachable*, and that was one relation too strong: `send.propose`
     * and `mailbox.content.read` are separate, so a drafter who may propose sends from a mailbox they may not
     * read is expressible — and for that person a grant is exactly what puts subject lines on the screen.
     *
     * Reproduced here, because "this cannot happen" is the sentence that stops anybody checking.
     */
    const conversation = createSystemCtx().id("cnv");
    const caseId = createSystemCtx().id("cas");
    const at = new Date(AUGUST_20).toISOString();
    await testEnv.CATALOG.prepare(
      "INSERT INTO conversations (id, org_id, root_rfc_id, grouped_by, created_at) VALUES (?,?,?,?,?)",
    ).bind(conversation, ORG, `<${conversation}@example.net>`, "root", at).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
         created_at) VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
    ).bind(caseId, ORG, conversation, MAILBOX, at, at).run();
    // The case's conversation has to hold a message, or the subject the grant is supposed to expose is NULL
    // for a reason that has nothing to do with authorization — and the test would pass for the wrong reason.
    await testEnv.CATALOG.prepare(
      "UPDATE messages SET conversation_id = ? WHERE org_id = ? AND ingress_receipt_id = ?",
    ).bind(conversation, ORG, RECEIPTS[0]).run();

    // The drafter: may send as the mailbox, holds no read relation on it.
    await tuple(INVESTIGATOR, "send.propose", "mailbox", MAILBOX);

    const before = await queueFor(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, MAILBOX);
    // Without a grant the queue is there and the subject lines are not — the control, so the assertion below
    // is about the grant rather than about the fixture.
    expect(before).toHaveLength(1);
    expect(before[0]?.subject).toBeNull();
    expect(await auditRows("supervised.query")).toHaveLength(0);

    const grant = await approvedGrant();
    const after = await queueFor(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, MAILBOX);
    expect(after[0]?.subject).toBe("Redundancy list 0");

    const entries = await auditRows("supervised.query");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe(grant.grantId);
    // The case ids, because those are what this listing returned — the same builder the message listing uses,
    // so one act cannot be recorded two ways.
    expect(JSON.parse(entries[0]?.detail ?? "{}")).toMatchObject({ returned: 1, ids: [caseId] });
  });

  it("refuses the read when it cannot be recorded, rather than reading unrecorded", async () => {
    /*
     * **The assertion this whole ticket exists for.**
     *
     * `audit` never throws, deliberately: a record of something that already happened must not fail the
     * request that happened. A supervised read is the opposite case — nothing has happened yet, and reading
     * without a record is the defect — so `recordDisclosure` throws and the bytes never leave.
     *
     * The append is broken rather than the table dropped, because dropping the table would also break the
     * authorization query and the test would pass for the wrong reason: the read has to be **authorized** and
     * still refused.
     */
    const token = await sessionFor(INVESTIGATOR);
    await approvedGrant();

    const brokenEnv = {
      ...testEnv,
      CATALOG: new Proxy(testEnv.CATALOG, {
        get(target, property) {
          if (property === "batch") {
            return () => Promise.reject(new Error("audit_entries is unwritable in this test"));
          }
          const value = Reflect.get(target, property) as unknown;
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
    } as Env;

    await expect(
      authorize(brokenEnv, atTime(AUGUST_20), requestAs(token), RECEIPTS[0]!, "supervised.attachment"),
    ).rejects.toThrow(/E_SUPERVISED_UNRECORDABLE/);

    // And the authorization itself was fine, which is what makes the refusal about the record. Same request,
    // an env whose appends work.
    const allowed = await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPTS[0]!,
      "supervised.attachment");
    expect(allowed.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ the id bound --------------- */

describe("a query entry never truncates its id list, because a prefix understates the exposure", () => {
  /** A typed-prefix ULID's shape and length: `rcpt_` plus 26, which is the 31 characters #63 measured. */
  const id = (n: number) => `rcpt_${String(n).padStart(26, "0")}`;

  async function record(count: number) {
    const events = buildSupervisedQuery("sgr_bound", INVESTIGATOR, MAILBOX,
      Array.from({ length: count }, (_, index) => id(index)));
    await recordDisclosure(testEnv, atTime(AUGUST_20), ORG, events);
    return (await auditRows("supervised.query")).map(
      (row) => JSON.parse(row.detail ?? "{}") as Record<string, unknown>,
    );
  }

  it("fits a real listing page in one entry, with the measured fill printed rather than assumed", async () => {
    /*
     * #63's correction computed **about 59** ids from a 2 KiB cap and 31-character typed-prefix ULIDs, and
     * added *"once the query text, matter id and page number share the object"*. This entry's siblings are a
     * different set — `grantId`, `mailboxId`, `returned` and the continuation pair — so the real fill is
     * measured here rather than inherited, which is the point of splitting instead of picking a number.
     *
     * What is **asserted** is the property the listing depends on: one page's worth of ids fits in one
     * entry, so a real page never splits. The fill is printed so the margin is a number somebody can read.
     *
     * **From `messages.page_size`, not the literal 50 it happens to be.** #91 made the page a receipt-backed
     * budget, and this file kept asserting the old constant in three places plus a comment — so raising the
     * page size would have left this test passing while proving nothing about the page it now has. That is
     * the shape of an assertion that agrees with whatever it is given.
     */
    const page = BUDGETS["messages.page_size"];
    const details = await record(page);
    expect(details).toHaveLength(1);
    expect(details[0]?.truncated).toBeUndefined();
    expect((details[0]?.ids as string[]).length).toBe(page);
    // Continuation fields are absent when there is only one part: a reader should not have to parse
    // `part: 1, of: 1` to learn there was no split.
    expect(details[0]?.part).toBeUndefined();

    // The edge itself, found by asking the builder rather than by arithmetic. One entry up to here, two after.
    let fill = 0;
    for (let count = 40; count <= 80; count++) {
      if (buildSupervisedQuery("sgr_bound", INVESTIGATOR, MAILBOX,
        Array.from({ length: count }, (_, index) => id(index))).length === 1) fill = count;
    }
    console.log(`MEASURE supervised.query  ids_per_entry=${fill}  listing_page=${page}`);
    // Comfortably above the listing's page, and the assertion is against the page rather than against the
    // fill: if a future page size passed this, the splitting is what keeps the record honest, not this line.
    expect(fill).toBeGreaterThanOrEqual(page);
  });

  it("splits rather than truncating when a page will not fit", async () => {
    const details = await record(60);
    /*
     * The alternative — handing 60 ids to `boundedDetail` — records `{truncated, bytes, head}`, which is a
     * **prefix** of the list and therefore a record that understates what the reader saw. That is the exact
     * failure per-act recording was chosen to avoid, so the list is split across entries in one transaction.
     */
    expect(details.length).toBeGreaterThan(1);
    expect(details.some((detail) => detail.truncated === true)).toBe(false);
    // Every id is in some entry, which is the property "never understates" actually means.
    const recovered = details.flatMap((detail) => detail.ids as string[]);
    expect(recovered).toEqual(Array.from({ length: 60 }, (_, index) => id(index)));
    // And each part says which it is, so a reader meets one act rather than several.
    expect(details.map((detail) => detail.part)).toEqual(details.map((_, index) => index + 1));
    expect(new Set(details.map((detail) => detail.of))).toEqual(new Set([details.length]));
    // `returned` is the whole act's count on every part, so no part misrepresents the query it belongs to.
    expect(new Set(details.map((detail) => detail.returned))).toEqual(new Set([60]));
  });

  it("stores every entry inside the cap, measured on the stored bytes", async () => {
    await record(200);
    const { results } = await testEnv.CATALOG.prepare(
      "SELECT detail FROM audit_entries WHERE org_id = ? AND action = 'supervised.query'",
    ).bind(ORG).all<{ detail: string }>();
    expect(results.length).toBeGreaterThan(3);
    for (const row of results) {
      // The real bound, read off the stored column with the same encoder `boundedDetail` uses. Asserting on
      // `String.length` here would be the #69 defect again — a byte cap checked in code units.
      expect(new TextEncoder().encode(row.detail).length).toBeLessThanOrEqual(2048);
      expect(row.detail).not.toContain("truncated");
    }
  });
});

/* ------------------------------------------------------------------ the notice ----------------- */

describe("a grant owes a notice, in its own transaction", () => {
  it("writes the notice with the grant and dates it from the grant's own expiry when no matter is cited", async () => {
    const grant = await approvedGrant({ durationSeconds: 3600 });
    const notices = (await noticeRows()).filter((row) => row.kind === "supervised_read");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.subject_id).toBe(grant.grantId);
    expect(notices[0]?.mailbox_id).toBe(MAILBOX);
    // Addressed to the mailbox, not to a person: a Mailda mailbox is shared and the audience is resolved live.
    expect(notices[0]?.user_id).toBeNull();
    // No matter, so the only end that exists is the grant's own deadline — known at grant time.
    expect(notices[0]?.due_at).toBe(new Date(AUGUST_20 + 3600 * 1000).toISOString());
    expect(notices[0]?.delivered_at).toBeNull();
  });

  it("holds the notice until the reading stopped, which is F-A's resolution", async () => {
    /*
     * §7 hangs the notice on the matter closing; 0023 deliberately does **not** revoke a live grant when its
     * matter closes. Left alone those two produce a notice telling somebody their mail *was* read while it
     * still is — so the notice is held: `due_at = max(closed_at, the grant's own expires_at)`.
     *
     * The matter is closed **one hour before** the grant expires, so a notice dated from the close alone
     * would come due while the investigator could still read. That is the assertion.
     */
    const matter = await openMatter(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      type: "security_incident", description: "Suspected exfiltration from the people mailbox",
    });
    const grant = await approvedGrant({ matterId: matter.id, durationSeconds: 2 * 3600 });

    // Undated while the matter is open: pre-close confidentiality is what makes the notice meaningful.
    expect(await supervisedNotices()).toMatchObject([{ due_at: null }]);

    const closedAt = AUGUST_20 + HOUR;
    await closeMatter(testEnv, atTime(closedAt), ORG, INVESTIGATOR, matter.id);

    const dated = await supervisedNotices();
    expect(dated[0]?.subject_id).toBe(grant.grantId);
    // The grant's expiry, not the close — because the reading had not stopped at the close.
    expect(dated[0]?.due_at).toBe(new Date(AUGUST_20 + 2 * HOUR).toISOString());
    expect(new Date(dated[0]!.due_at!).getTime()).toBeGreaterThan(closedAt);

    // And nothing about *this* notice is delivered before it is due, however many times the scan runs. The
    // two approval-request rows the request itself minted are due immediately and do deliver, which is why
    // this asserts on the supervised row rather than on the scan's total.
    await deliverDueNotifications(testEnv, atTime(closedAt), ORG);
    expect(await supervisedNotices()).toMatchObject([{ delivered_at: null }]);
  });

  it("dates the notice when the matter closed before the grant took effect", async () => {
    /*
     * **The ordering that made the whole mechanism suppressible, and it was reachable through the product.**
     *
     * `noticesDueOnMatterClose` runs inside the close's transaction, so it can only date notices that already
     * exist. A grant is asked for at one instant and takes effect two approvals later, and nothing refuses a
     * close in between — `requestSupervisedRead` refuses a *new* request citing a closed matter, which looked
     * like the whole defence and is not, because this request was made while the matter was open.
     *
     * So *request, close, approve* left `due_at` NULL with nothing that would ever write it: no second close
     * is permitted, the cron delivers only what is due, `doctor`'s overdue count is `due_at IS NOT NULL` by
     * construction, and the missing-notice count sees a row that is present. The reader then read, every act
     * was recorded, and the person whose mail it was was never told — **without an audited row being
     * deleted**, and arranged by the investigator, who opened the matter and may therefore close it.
     *
     * `noticeOwedByGrant` now dates the notice itself when the matter is already closed. Both orderings
     * write the same instant, from the same expression.
     */
    const matter = await openMatter(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      type: "security_incident", description: "Suspected exfiltration from the people mailbox",
    });
    const ctx = atTime(AUGUST_20);
    const requested = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: 2 * 3600, matterId: matter.id,
    });
    // The investigator closes their own matter while their own request is still pending.
    await closeMatter(testEnv, atTime(AUGUST_20 + HOUR), ORG, INVESTIGATOR, matter.id);
    await decideApproval(testEnv, atTime(AUGUST_20), ORG, ANA, requested.approvalId, "approve");
    const closing = await decideApproval(testEnv, atTime(AUGUST_20), ORG, BEN, requested.approvalId, "approve");
    expect(closing.supervisedGranted).toBe(true);

    const notices = await supervisedNotices();
    // Dated, and dated to the later of the two instants — the grant's own expiry, because the reading had not
    // stopped at the close. The same `max` the close writes, from the same expression.
    expect(notices[0]?.due_at).toBe(new Date(AUGUST_20 + 2 * HOUR).toISOString());
    // And it actually reaches the person, which is what "the obligation survives" means.
    await deliverDueNotifications(testEnv, atTime(AUGUST_20 + 3 * HOUR), ORG);
    const mine = await notificationsFor(testEnv, { orgId: ORG, userId: MEMBER }, [MEMBER]);
    expect(mine.filter((notice) => notice.kind === "supervised_read")).toHaveLength(1);
  });

  it("dates from the close when the grant had already expired", async () => {
    // The other half of the `max`, and the one a naive "always use the expiry" would get wrong: reading
    // stopped first, so the close is the later instant and the notice is due then.
    const matter = await openMatter(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      type: "departure_handover", description: "Dana left; live customer threads need picking up",
    });
    await approvedGrant({ matterId: matter.id, durationSeconds: 60 });
    const closedAt = AUGUST_20 + HOUR;
    await closeMatter(testEnv, atTime(closedAt), ORG, INVESTIGATOR, matter.id);
    expect((await supervisedNotices())[0]?.due_at).toBe(new Date(closedAt).toISOString());
  });
});

describe("the cron delivers the notice into the mailbox's own interface", () => {
  it("delivers what was read to the person whose mailbox it is, and not to the investigator", async () => {
    const token = await sessionFor(INVESTIGATOR);
    const grant = await approvedGrant({ durationSeconds: 3600 });

    // A realistic session: one query, one content read, one raw read.
    await listMessages(testEnv, atTime(AUGUST_20), requestAs(token));
    await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPTS[0]!, "supervised.opened");
    await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPTS[1]!, "supervised.attachment");

    const after = AUGUST_20 + 2 * HOUR;
    // Three rows: the §7 notice, and the two approval requests #61 minted when the grant was asked for.
    const outcome = await deliverDueNotifications(testEnv, atTime(after), ORG);
    expect(outcome.delivered).toBe(3);

    const mine = await notificationsFor(testEnv, { orgId: ORG, userId: MEMBER }, [MEMBER]);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.kind).toBe("supervised_read");
    const body = mine[0]?.body as {
      readerId: string; readerEmail: string; scope: string; grantId: string;
      acts: { queries: number; listed: number; opened: number; attachments: number };
    };
    /*
     * What the notice says, and each field is a disclosure decision rather than a detail.
     *
     * The reader is **named**: it is the first question anybody asks, and a notice that withholds it invites
     * the person to find out by other means. The counts are what make the notice actionable at all — the
     * difference between a grant nobody used and one under which everything was opened — and without them
     * this is the compliance theatre §7 would otherwise be satisfied by.
     */
    expect(body.grantId).toBe(grant.grantId);
    expect(body.readerId).toBe(INVESTIGATOR);
    expect(body.readerEmail).toBe(`${INVESTIGATOR}@rec.example`);
    expect(body.scope).toBe("content");
    expect(body.acts).toEqual({ queries: 1, listed: 2, opened: 1, attachments: 1 });

    // **The property that makes in-product delivery hold structurally.** The investigator's own feed is
    // resolved from `relationship_tuples`, and a supervised grant is never a tuple — so the person who read
    // the mail cannot see, and therefore cannot suppress, the notice about having read it.
    const theirs = await notificationsFor(testEnv, { orgId: ORG, userId: INVESTIGATOR }, [INVESTIGATOR]);
    expect(theirs.filter((notice) => notice.kind === "supervised_read")).toHaveLength(0);
  });

  it("does not disclose the matter's description, which names the person being examined", async () => {
    /*
     * `listMatters` already treats the description as confidential — an org-wide listing would hand
     * *"suspected exfiltration by Dana"* to Dana — and closing a matter is not a finding. The Node cannot
     * vouch for that sentence, so publishing it as a system notice would be an overclaim. The type is
     * disclosed; the accusation is not.
     */
    const matter = await openMatter(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      type: "security_incident", description: "Suspected exfiltration by Dana",
    });
    await approvedGrant({ matterId: matter.id, durationSeconds: 60 });
    await closeMatter(testEnv, atTime(AUGUST_20 + HOUR), ORG, INVESTIGATOR, matter.id);
    await deliverDueNotifications(testEnv, atTime(AUGUST_20 + 2 * HOUR), ORG);

    const mine = await notificationsFor(testEnv, { orgId: ORG, userId: MEMBER }, [MEMBER]);
    expect(JSON.stringify(mine)).not.toContain("exfiltration");
    expect((mine[0]?.body as { matterType: string }).matterType).toBe("security_incident");
    expect((mine[0]?.body as { matterId: string }).matterId).toBe(matter.id);
  });

  it("is idempotent, so a re-run of the one-minute cron costs nothing", async () => {
    await approvedGrant({ durationSeconds: 60 });
    const after = AUGUST_20 + HOUR;
    expect((await deliverDueNotifications(testEnv, atTime(after), ORG)).delivered).toBe(3);
    // Cron documents no retry, so the scan is a query over due rows and running it twice must change nothing.
    expect((await deliverDueNotifications(testEnv, atTime(after), ORG)).delivered).toBe(0);
    expect(await notificationsFor(testEnv, { orgId: ORG, userId: MEMBER }, [MEMBER])).toHaveLength(1);
  });
});

describe("the cron trigger is what runs the scan, and that wiring is the whole delivery", () => {
  it("delivers through the scheduled handler this Worker actually declares", async () => {
    /*
     * **A scan nothing calls is a row that sits.** Every other test here invokes `deliverDueNotifications`
     * directly, which proves the scan works and says nothing about whether anything runs it — and the one
     * caller is a branch inside `scheduled`, which no test reached. Removing that call would have left §7's
     * notices permanently owed with the whole suite green.
     *
     * So this goes through the exported handler, on the real clock, with the trigger `wrangler.jsonc`
     * declares (`triggers.crons`, every minute). #61's approval requests are what make it testable: they fall
     * due the instant they are written, so a handler running *now* has something to deliver.
     */
    const requested = await requestSupervisedRead(testEnv, createSystemCtx(), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: 3600,
    });
    const owed = (await noticeRows()).filter((row) => row.kind === "approval_request");
    expect(owed).toHaveLength(2);
    expect(owed.every((row) => row.delivered_at === null)).toBe(true);

    const execution = createExecutionContext();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/1 * * * *", noRetry: () => undefined } as ScheduledController,
      testEnv,
      execution,
    );
    // The handler does its work in `waitUntil`, so the assertion has to wait for it — the same shape
    // `fresh-install.test.ts` uses.
    await waitOnExecutionContext(execution);

    const delivered = (await noticeRows()).filter((row) => row.kind === "approval_request");
    expect(delivered.every((row) => row.delivered_at !== null)).toBe(true);
    const ana = await notificationsFor(testEnv, { orgId: ORG, userId: ANA }, [ANA]);
    expect(ana.map((notice) => notice.subjectId)).toEqual([requested.approvalId]);
  });
});

describe("suppressing a notice requires deleting an audited row, and doctor says so", () => {
  it("reports nothing while the trail and the table agree", async () => {
    await approvedGrant({ durationSeconds: 60 });
    const report = await runDoctor(testEnv, atTime(AUGUST_20));
    // Nothing is overdue: `notify.overdue_grace_seconds` covers the window between a notice falling due and
    // the next cron tick, which #61's approval requests enter the instant they are written. Without it this
    // would be `degraded` on every Node with a request opened in the last minute.
    expect(find(report.findings, "supervision_notices_overdue").ok).toBe(true);
    // The missing-notice and stranded-notice findings are only pushed when there *is* a discrepancy, so their
    // absence is the pass.
    expect(report.findings.some((finding) => finding.check === "supervision_notice_missing")).toBe(false);
    expect(report.findings.some((finding) => finding.check === "supervision_notice_stranded")).toBe(false);
  });

  it("notices when the row is deleted outside the product", async () => {
    const grant = await approvedGrant({ durationSeconds: 60 });
    // The only way to suppress a notice: reach into the database. Doing it through the product is not
    // possible — there is no delete endpoint, no dismiss, and no mark-read.
    await testEnv.CATALOG.prepare("DELETE FROM notifications WHERE org_id = ? AND subject_id = ?")
      .bind(ORG, grant.grantId).run();

    const finding = find((await runDoctor(testEnv, atTime(AUGUST_20))).findings, "supervision_notice_missing");
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    // The count comes off the hash-linked trail, so the other half of the suppression — deleting the
    // `supervised.granted` entry instead — breaks `verifyChain` at a nameable point rather than hiding here.
    expect(finding.detail).toContain("1 supervised grant(s) taking effect");
    expect(finding.detail).toContain("removed outside the product");
  });

  it("counts a notice that can never fall due, which deletion checks cannot see", async () => {
    /*
     * The blind spot in the two checks above: both are about a row being **removed**, and neither can see a
     * row that is present and inert. A notice with no due date whose matter has already closed is one nothing
     * will ever deliver — it passes the missing-notice count because the row is there, and the overdue count
     * because that is `due_at IS NOT NULL` by construction.
     *
     * This Node no longer produces the state (see the close-before-approve test above), so it is forced here
     * by hand. That is the point: the check is what makes "cannot be produced" a measured claim rather than a
     * sentence in a comment.
     */
    const matter = await openMatter(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      type: "legal_hold", description: "Regulator asked for the people mailbox",
    });
    const grant = await approvedGrant({ matterId: matter.id, durationSeconds: 60 });
    await closeMatter(testEnv, atTime(AUGUST_20 + HOUR), ORG, INVESTIGATOR, matter.id);
    expect(find((await runDoctor(testEnv, atTime(AUGUST_20))).findings, "supervision_notices_overdue").ok)
      .toBe(true);

    await testEnv.CATALOG.prepare("UPDATE notifications SET due_at = NULL WHERE org_id = ? AND subject_id = ?")
      .bind(ORG, grant.grantId).run();

    const finding = find(
      (await runDoctor(testEnv, atTime(AUGUST_20))).findings, "supervision_notice_stranded",
    );
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    expect(finding.detail).toContain("1 notification(s) have no due date");
    // And the deletion checks stay quiet, which is exactly why this one has to exist.
    expect(find((await runDoctor(testEnv, atTime(AUGUST_20))).findings, "supervision_notices_overdue").ok)
      .toBe(true);
  });

  it("counts an overdue notice, which is what a cron that stopped running looks like", async () => {
    await approvedGrant({ durationSeconds: 60 });
    // Two hours later and nothing has delivered it: the scan is not running.
    const finding = find(
      (await runDoctor(testEnv, atTime(AUGUST_20 + 2 * HOUR))).findings, "supervision_notices_overdue",
    );
    expect(finding.ok).toBe(false);
    expect(finding.severity).toBe("degraded");
    // Three: the §7 notice, plus #61's two approval requests, all past the grace and none delivered.
    expect(finding.detail).toContain("3 notification(s) fell due");

    await deliverDueNotifications(testEnv, atTime(AUGUST_20 + 2 * HOUR), ORG);
    const cleared = find(
      (await runDoctor(testEnv, atTime(AUGUST_20 + 2 * HOUR))).findings, "supervision_notices_overdue",
    );
    expect(cleared.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ #61 inherits --------------- */

describe("an approval request is a row in the same table, delivered by the same scan (#61)", () => {
  it("tells the people who were asked, and not the person who asked", async () => {
    const ctx = atTime(AUGUST_20);
    const requested = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: 3600,
    });

    const asked = (await noticeRows()).filter((row) => row.kind === "approval_request");
    // One row per eligible decider, written in the request's own transaction — so an approval waiting on
    // people nobody told is not a state this Node can reach.
    expect(asked.map((row) => row.user_id).sort()).toEqual([ANA, BEN].sort());
    expect(asked.every((row) => row.subject_id === requested.approvalId)).toBe(true);
    // Due now: somebody is waiting on a decision, so the next tick delivers it.
    expect(asked.every((row) => row.due_at !== null)).toBe(true);
    // §18's separation of duty, applied once in `planApproval`: the requester is not in the eligible set, so
    // they are not in the notified set either. One rule, one place.
    expect(asked.some((row) => row.user_id === INVESTIGATOR)).toBe(false);

    await deliverDueNotifications(testEnv, atTime(AUGUST_20 + 60_000), ORG);
    const ana = await notificationsFor(testEnv, { orgId: ORG, userId: ANA }, [ANA]);
    expect(ana).toHaveLength(1);
    expect(ana[0]?.kind).toBe("approval_request");
    expect((ana[0]?.body as { approvalId: string }).approvalId).toBe(requested.approvalId);
    expect((ana[0]?.body as { subjectKind: string }).subjectKind).toBe("supervised_read");
  });
});
