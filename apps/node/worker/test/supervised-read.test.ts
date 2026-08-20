import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";

import { grant, isGrantable } from "../src/access.ts";
import { decideApproval, pendingApprovals, withdrawApproval } from "../src/approvals.ts";
import { authorize, mayRead, maySend, listMessages } from "../src/authz-read.ts";
import { hashPassword } from "../src/auth/password.ts";
import { login } from "../src/auth/session.ts";
import { runDoctor, type Finding } from "../src/doctor.ts";
import { closeMatter, listMatters, MATTER_TYPES, openMatter } from "../src/matters.ts";
import { mergeConversations } from "../src/merge.ts";
import { requestSupervisedRead, SUPERVISED_SCOPES } from "../src/supervised.ts";

/**
 * Supervised reading (#63, §7): a time-boxed, matter-bound, dual-approved read of a mailbox somebody holds
 * **no standing relation to** — and the self-grant that stays possible beside it.
 *
 * ## The tests this file exists for
 *
 * 1. *A supervised grant lets its holder read a mailbox they hold nothing else on, and **stops** when it
 *    expires.* Both halves matter equally: a grant that granted nothing would be the failure this repository
 *    keeps hitting, and an expiry that did not bite would make the word "supervised" a decoration. The stop is
 *    proved through `authorize()` — the real raw-evidence read — rather than against the predicate, because
 *    the claim being tested is *"nothing caches authorization, so the next request finds it expired"*, and a
 *    predicate test would prove the predicate and not the claim.
 * 2. *One approver is not enough, and the requester cannot be one of them.* §7 asks for dual approval and §18
 *    for separation of duty. `requestSupervisedRead` makes the reader and the requester the same principal by
 *    construction, so the actor exclusion #61 already enforces is what stops somebody approving their own way
 *    into a mailbox — asserted here rather than assumed from the shared machinery.
 * 3. *The self-grant produces a `doctor` finding and an ordinary grant does not.* The one thing that makes the
 *    front door and the back door distinguishable, and it is a claim about a partial index and a
 *    column-to-column comparison that nothing else in the suite would exercise.
 *
 * ## Non-vacuity
 *
 * Every assertion below was verified by breaking the source it guards and watching it fail. The mutations and
 * the observed failures are recorded in the report for this change; the ones whose failure mode is **silence**
 * rather than an error are noted inline, because those are the ones a reader cannot re-derive.
 */

const testEnv = env as unknown as Env;
const ORG = "org_supervised";
const MAILBOX = "mbx_sup_hr";
const OTHER_MAILBOX = "mbx_sup_billing";
const ADDRESS = "people@acme.example";

const ADMIN = "usr_sup_admin";
/** Holds nothing at all on MAILBOX. The whole point of the mechanism. */
const INVESTIGATOR = "usr_sup_investigator";
const ANA = "usr_sup_ana";
const BEN = "usr_sup_ben";
/** Holds the standing content relation, so the "supervised is not the only door" comparisons have a control. */
const MEMBER = "usr_sup_member";

const PASSWORD = "fixture-password-not-a-real-secret";
const AUGUST_20 = Date.parse("2026-08-20T09:00:00.000Z");
const THREE_DAYS = 3 * 24 * 60 * 60;

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

const RECEIPT = "rcpt_sup_one";

beforeEach(async () => {
  for (const table of ["supervised_grants", "matters", "approval_decisions", "approval_stages", "approvals",
                       "relationship_tuples", "team_members", "ingress_receipts", "messages", "cases",
                       "conversations", "addresses", "mailboxes", "users", "node_claim", "login_attempts",
                       "sessions", "refresh_tokens", "audit_entries", "log_entries", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(AUGUST_20).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_sup", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "People", at),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(OTHER_MAILBOX, ORG, "Billing", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    // One real delivery, so the raw-evidence read has something to authorize. The blob is never fetched:
    // `authorize` returns the key and the test asserts on the authorization, which is what is under test.
    testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
         blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind(RECEIPT, ORG, "evt_sup_one", "candidate@example.net", ADDRESS, 2048,
      `${ORG}/raw/${RECEIPT}`, "0".repeat(64), at),
    testEnv.CATALOG.prepare(
      `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
         thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
         conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(ctx.id("msg"), ORG, "2026-08", `${ORG}/raw/${RECEIPT}`, "0".repeat(64), 2048,
      "<redundancy@customer.example>", ctx.id("thr"), "Redundancy list, confidential",
      "hr@customer.example", at, at, RECEIPT, at, null),
    ...[ADMIN, INVESTIGATOR, ANA, BEN, MEMBER].map((userId) => testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at)),
  ]);

  await tuple(ADMIN, "org.admin", "organization", ORG);
  // Two eligible approvers on the mailbox, neither of them the investigator. Fewer than two and every
  // request below would be refused as unsatisfiable, which is its own test further down.
  await tuple(ANA, "approval.decide", "mailbox", MAILBOX);
  await tuple(BEN, "approval.decide", "mailbox", MAILBOX);
  await tuple(MEMBER, "mailbox.content.read", "mailbox", MAILBOX);
});

async function sessionFor(userId: string): Promise<string> {
  // The fake clock, not the real one: `verifyAccessToken` compares against the instant it is given, so a
  // token minted at wall-clock now and verified at AUGUST_20 is a token from the future and is refused —
  // which would make every authorization assertion below pass or fail for the wrong reason.
  const outcome = await login(testEnv, atTime(AUGUST_20), ORG, `${userId}@acme.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

function requestAs(token: string, path = "/api/messages"): Request {
  return new Request(`https://node.example${path}`, { headers: { authorization: `Bearer ${token}` } });
}

/** A supervised read requested and then approved by both eligible people. */
async function approvedGrant(options?: {
  scope?: string;
  matterId?: string | null;
  durationSeconds?: number;
  at?: number;
}) {
  const ctx = atTime(options?.at ?? AUGUST_20);
  const requested = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
    mailboxId: MAILBOX,
    scope: options?.scope ?? "content",
    durationSeconds: options?.durationSeconds ?? THREE_DAYS,
    matterId: options?.matterId ?? null,
  });
  await decideApproval(testEnv, ctx, ORG, ANA, requested.approvalId, "approve");
  const closing = await decideApproval(testEnv, ctx, ORG, BEN, requested.approvalId, "approve");
  // Asserted in the helper rather than in every caller: a helper that quietly failed to grant would make the
  // tests below pass for the wrong reason, which is the vacuous green this suite is written against.
  if (closing.supervisedGranted !== true) throw new Error("the second approval did not grant the read");
  return requested;
}

async function grantRow(id: string) {
  return testEnv.CATALOG.prepare(
    "SELECT scope, matter_id, expires_at, granted_at FROM supervised_grants WHERE org_id = ? AND id = ?",
  ).bind(ORG, id).first<{
    scope: string; matter_id: string | null; expires_at: string; granted_at: string | null;
  }>();
}

async function auditRows(action: string) {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT subject, outcome, detail FROM audit_entries WHERE org_id = ? AND action = ? ORDER BY seq",
  ).bind(ORG, action).all<{ subject: string | null; outcome: string; detail: string | null }>();
  return results;
}

function find(findings: Finding[], check: string): Finding {
  const found = findings.find((finding) => finding.check === check);
  if (found === undefined) throw new Error(`no finding named ${check}`);
  return found;
}

/* ------------------------------------------------------------------ the grant itself ------------ */

describe("a supervised grant reaches a mailbox its holder holds nothing on", () => {
  it("denies the read before the grant and allows it after", async () => {
    const before = await mayRead(testEnv, atTime(AUGUST_20), { orgId: ORG, userId: INVESTIGATOR }, MAILBOX);
    // The premise of every test in this file. Without it a passing grant test would prove nothing, because
    // the investigator might have been able to read all along.
    expect(before).toBe(false);

    const requested = await approvedGrant();
    const after = await mayRead(testEnv, atTime(AUGUST_20), { orgId: ORG, userId: INVESTIGATOR }, MAILBOX);
    expect(after).toBe(true);

    // And the grant carries what §7 binds it to, on the row rather than only in the answer.
    const row = await grantRow(requested.grantId);
    expect(row?.scope).toBe("content");
    expect(row?.granted_at).not.toBeNull();
    expect(row?.expires_at).toBe(new Date(AUGUST_20 + THREE_DAYS * 1000).toISOString());
  });

  it("authorizes the raw-evidence read, which is the path a person actually takes", async () => {
    const token = await sessionFor(INVESTIGATOR);
    const denied = await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPT);
    // §5C: an unauthorized message and an absent one answer alike, so the observable is a 404 rather than a
    // 403. That is what makes this assertion about authorization and not about the message existing.
    expect(denied.ok).toBe(false);

    await approvedGrant();
    const allowed = await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPT);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.blobKey).toBe(`${ORG}/raw/${RECEIPT}`);
  });

  it("lists the mailbox's mail, because an investigation starts with a query", async () => {
    const token = await sessionFor(INVESTIGATOR);
    const empty = await (await listMessages(testEnv, atTime(AUGUST_20), requestAs(token))).json();
    expect((empty as { messages: unknown[] }).messages).toHaveLength(0);

    await approvedGrant();
    const listed = await (await listMessages(testEnv, atTime(AUGUST_20), requestAs(token))).json();
    const messages = (listed as { messages: Array<{ subject: string }> }).messages;
    expect(messages).toHaveLength(1);
    // The subject line, which is content exposure — and the reason #63 part B owes a `supervised.query` entry
    // naming the ids returned. Asserted on the exact string the queue-disclosure defect returned, so the two
    // tests are visibly about the same bytes.
    expect(messages[0]?.subject).toBe("Redundancy list, confidential");
  });
});

describe("expiry is a hard stop, and no mechanism enforces it", () => {
  it("stops the raw read at the deadline, on the next request", async () => {
    const token = await sessionFor(INVESTIGATOR);
    const requested = await approvedGrant({ durationSeconds: 60 });

    const during = await authorize(testEnv, atTime(AUGUST_20 + 30_000), requestAs(token), RECEIPT);
    expect(during.ok).toBe(true);

    /*
     * One millisecond past the deadline, and nothing ran in between: no sweep, no revocation, no expiry job.
     * This is the whole of #63's claim that failing closed was already the behaviour — authorization is
     * re-read per request, so the request after the deadline checks and finds the grant over.
     *
     * **Non-vacuity, and this one is worth recording beside the code:** removing `expires_at > ?` from
     * `LIVE_SUPERVISED_GRANT` leaves every other test in this file green and fails only here. That is the
     * shape of the defect this test exists for — an expiry that reads as enforced and is not.
     */
    const after = await authorize(testEnv, atTime(AUGUST_20 + 60_001), requestAs(token), RECEIPT);
    expect(after.ok).toBe(false);
    // The row is untouched: an expired grant is the record of an access that happened, not an absence.
    expect((await grantRow(requested.grantId))?.granted_at).not.toBeNull();
  });

  it("stops the listing at the deadline too", async () => {
    const token = await sessionFor(INVESTIGATOR);
    await approvedGrant({ durationSeconds: 60 });
    const after = await (await listMessages(testEnv, atTime(AUGUST_20 + 60_001), requestAs(token))).json();
    expect((after as { messages: unknown[] }).messages).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ the ceremony ---------------- */

describe("dual approval, and the requester is never one of the two", () => {
  it("grants nothing on one approval", async () => {
    const ctx = atTime(AUGUST_20);
    const requested = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: THREE_DAYS,
    });
    // Requested is not granted. This is the assertion that `granted_at` is authority rather than decoration.
    expect((await grantRow(requested.grantId))?.granted_at).toBeNull();
    expect(await mayRead(testEnv, ctx, { orgId: ORG, userId: INVESTIGATOR }, MAILBOX)).toBe(false);

    const first = await decideApproval(testEnv, ctx, ORG, ANA, requested.approvalId, "approve");
    expect(first.completed).toBe(false);
    expect(first.supervisedGranted).toBe(false);
    expect((await grantRow(requested.grantId))?.granted_at).toBeNull();
    // The read is still refused after one approver, which is the observable the count exists for.
    expect(await mayRead(testEnv, ctx, { orgId: ORG, userId: INVESTIGATOR }, MAILBOX)).toBe(false);

    const second = await decideApproval(testEnv, ctx, ORG, BEN, requested.approvalId, "approve");
    expect(second.supervisedGranted).toBe(true);
    expect(await mayRead(testEnv, ctx, { orgId: ORG, userId: INVESTIGATOR }, MAILBOX)).toBe(true);
  });

  it("refuses the requester's own decision, even to deny it", async () => {
    const ctx = atTime(AUGUST_20);
    // The investigator is given `approval.decide` on the very mailbox, so eligibility is not what refuses
    // them — the actor exclusion is. Without this tuple the refusal would be `E_NO_APPROVAL` and the test
    // would pass while proving nothing about separation of duty.
    await tuple(INVESTIGATOR, "approval.decide", "mailbox", MAILBOX);
    const requested = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: THREE_DAYS,
    });

    await expect(
      decideApproval(testEnv, ctx, ORG, INVESTIGATOR, requested.approvalId, "approve"),
    ).rejects.toThrow(/E_APPROVER_IS_ACTOR/);
    await expect(
      decideApproval(testEnv, ctx, ORG, INVESTIGATOR, requested.approvalId, "deny"),
    ).rejects.toThrow(/E_APPROVER_IS_ACTOR/);
    expect((await grantRow(requested.grantId))?.granted_at).toBeNull();
  });

  it("refuses the request outright when two other approvers do not exist", async () => {
    const ctx = atTime(AUGUST_20);
    await expect(
      requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
        // Nobody holds `approval.decide` on the billing mailbox, so no supervised read of it can complete.
        // Refused at request time rather than parked: an open request nobody can decide reads as waiting.
        mailboxId: OTHER_MAILBOX, scope: "content", durationSeconds: THREE_DAYS,
      }),
    ).rejects.toThrow(/E_SUPERVISED_UNSATISFIABLE/);
  });

  it("tells the two approvers what they are agreeing to, deadline included", async () => {
    const requested = await requestSupervisedRead(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "metadata", durationSeconds: THREE_DAYS,
    });
    const waiting = await pendingApprovals(testEnv, ORG, ANA);
    expect(waiting).toHaveLength(1);
    /*
     * The whole of the control on a supervised read's duration is that the people asked can see it. Nothing
     * caps `durationSeconds` — a maximum would be a number with no receipt — so a queue that showed only
     * "somebody wants a supervised read" would be asking two people to agree to nothing in particular.
     */
    expect(waiting[0]?.supervised).toEqual({
      grantId: requested.grantId,
      subjectId: INVESTIGATOR,
      scope: "metadata",
      matterId: null,
      // A grant citing no matter shows a null rather than a blank: absent is a real answer (#63), and an
      // approver should see it as such rather than as a description somebody forgot to write.
      matter: null,
      expiresAt: requested.expiresAt,
    });
  });

  it("shows the two approvers the matter itself, not just its id", async () => {
    /*
     * The text is here **because it is not in `GET /api/matters` for everybody**. An org-wide matter listing
     * hands "suspected exfiltration by Dana" to Dana, and §7 makes the notice to her due after the matter
     * closes rather than on the day it opened — so the description travels to exactly the two people being
     * asked to agree to a read for it, on the join that was already fetching the grant.
     */
    const matter = await openMatter(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      type: "security_incident", description: "Suspected exfiltration from the people mailbox",
    });
    await requestSupervisedRead(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: THREE_DAYS, matterId: matter.id,
    });

    for (const approver of [ANA, BEN]) {
      const waiting = await pendingApprovals(testEnv, ORG, approver);
      expect(waiting[0]?.supervised?.matter).toEqual({
        type: "security_incident",
        description: "Suspected exfiltration from the people mailbox",
      });
    }
  });

  it("refuses the requester with advice about the act they actually attempted", async () => {
    /*
     * The `fix` is the part a person acts on (AGENTS.md principle 3), and this one was a two-way test on
     * `hold_lift` that handed a supervised reader the send's advice — "cancel the send if you want to stop
     * it" — for a request that has no send in it. `ACTOR_DID` was a `Record` and was a compile error when the
     * third kind arrived; the `fix` beside it was not, which is what this asserts is no longer true.
     */
    await tuple(INVESTIGATOR, "approval.decide", "mailbox", MAILBOX);
    const requested = await requestSupervisedRead(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: THREE_DAYS,
    });
    const refusal = await decideApproval(
      testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, requested.approvalId, "approve",
    ).then(() => null, (error: Error) => error.message);

    expect(refusal).toContain("E_APPROVER_IS_ACTOR");
    expect(refusal).toContain("two other people holding approval.decide on that mailbox");
    // The wrong advice, named so the assertion above cannot pass by being vague.
    expect(refusal).not.toContain("cancel the send");
  });

  it("moves no send when a withdrawal leaves the request unsatisfiable", async () => {
    /*
     * A withdrawal that leaves too few approvers closes the request as `unsatisfiable` — and for a **send**
     * it also withholds the manifest and its recipients. That branch tested `subjectKind === "hold_lift"`,
     * so a supervised read ran the send statements: measured, not reasoned, with a `send_recipients` row
     * whose `manifest_id` was the grant's id, which came back `withheld`. Real ids cannot collide, which is
     * exactly what makes it a landmine rather than a bug — no symptom, and a recipient update keyed on
     * `manifest_id` alone waiting for the day two id spaces meet.
     */
    const ctx = atTime(AUGUST_20);
    const requested = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: THREE_DAYS,
    });
    await decideApproval(testEnv, ctx, ORG, ANA, requested.approvalId, "approve");
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_recipients (id, org_id, manifest_id, kind, address, submission_state,
         submission_state_at, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).bind("snr_supervised_probe", ORG, requested.grantId, "to", "someone@example.net", "awaiting",
      new Date(AUGUST_20).toISOString(), new Date(AUGUST_20).toISOString()).run();

    const outcome = await withdrawApproval(testEnv, atTime(AUGUST_20 + 10), ORG, ANA, requested.approvalId);
    expect(outcome.approvalState).toBe("unsatisfiable");
    // Nothing about a send was touched, because a supervised read has no send in it.
    const row = await testEnv.CATALOG.prepare(
      "SELECT submission_state FROM send_recipients WHERE id = ?",
    ).bind("snr_supervised_probe").first<{ submission_state: string }>();
    expect(row?.submission_state).toBe("awaiting");
    // And the read was never authorized: `granted_at` stays NULL, which is the whole of the refusal.
    expect((await grantRow(requested.grantId))?.granted_at).toBeNull();
  });

  it("keeps a denial from foreclosing a later request", async () => {
    const ctx = atTime(AUGUST_20);
    const first = await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: THREE_DAYS,
    });
    await decideApproval(testEnv, ctx, ORG, ANA, first.approvalId, "deny");
    expect((await grantRow(first.grantId))?.granted_at).toBeNull();

    // Asking again mints a new row rather than reopening the denied one, which is why the approval's subject
    // is a request and not a person-and-mailbox pair (#64's trap, arriving through the schema).
    const second = await approvedGrant();
    expect(second.grantId).not.toBe(first.grantId);
    expect(await mayRead(testEnv, ctx, { orgId: ORG, userId: INVESTIGATOR }, MAILBOX)).toBe(true);
  });

  it("refuses a second request while one is still pending", async () => {
    const ctx = atTime(AUGUST_20);
    await requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, scope: "content", durationSeconds: THREE_DAYS,
    });
    await expect(
      requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
        mailboxId: MAILBOX, scope: "metadata", durationSeconds: 60,
      }),
    ).rejects.toThrow(/E_SUPERVISED_PENDING/);
  });

  it("records what was agreed to, in one entry, in the granting transaction", async () => {
    const matter = await openMatter(testEnv, atTime(AUGUST_20), ORG, INVESTIGATOR, {
      type: "departure_handover", description: "Dana left; live customer threads need picking up",
    });
    const requested = await approvedGrant({ matterId: matter.id });

    const entries = await auditRows("supervised.granted");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe(requested.grantId);
    const detail = JSON.parse(entries[0]?.detail ?? "{}") as Record<string, unknown>;
    // Everything §7 binds a grant to, in the entry — so an investigation answers "who was let into whose
    // mailbox, under what matter, until when" without joining `approvals` to `supervised_grants`.
    expect(detail.subjectId).toBe(INVESTIGATOR);
    expect(detail.mailboxId).toBe(MAILBOX);
    expect(detail.scope).toBe("content");
    expect(detail.matterId).toBe(matter.id);
    expect(detail.expiresAt).toBe(requested.expiresAt);
    expect(detail.approvedBy).toEqual([ANA, BEN]);
  });
});

/* ------------------------------------------------------------------ what it does not reach ------ */

describe("a read grant authorizes reading and nothing else", () => {
  it("does not let its holder send as the mailbox", async () => {
    await approvedGrant();
    // §7's supervised access is a read. A grant that conferred `send.propose` would let an investigator send
    // from the mailbox they are investigating.
    expect(await maySend(testEnv, { orgId: ORG, userId: INVESTIGATOR }, MAILBOX)).toBe(false);
  });

  it("does not let its holder merge conversations", async () => {
    const ctx = atTime(AUGUST_20);
    await approvedGrant();
    const from = ctx.id("cnv");
    const into = ctx.id("cnv");
    for (const id of [from, into]) {
      await testEnv.CATALOG.prepare(
        "INSERT INTO conversations (id, org_id, root_rfc_id, grouped_by, created_at) VALUES (?,?,?,?,?)",
      ).bind(id, ORG, `<${id}@example.net>`, "root", new Date(AUGUST_20).toISOString()).run();
      await testEnv.CATALOG.prepare(
        `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at,
           created_at) VALUES (?,?,?,?, 'claimed', ?, ?, ?, ?)`,
      ).bind(ctx.id("cas"), ORG, id, MAILBOX, new Date(AUGUST_20).toISOString(), MEMBER,
        new Date(AUGUST_20).toISOString(), new Date(AUGUST_20).toISOString()).run();
    }

    // Merging is irreversible restructuring of somebody else's queue. `holdsStandingRead` is what refuses it,
    // and the control below proves the refusal is about *how* the authority is held rather than about the
    // fixture being wrong.
    const supervised = await mergeConversations(testEnv, ctx, ORG, INVESTIGATOR, from, into);
    expect(supervised.merged).toBe(false);
    const standing = await mergeConversations(testEnv, ctx, ORG, MEMBER, from, into);
    expect(standing.merged).toBe(true);
  });

  it("does not open the bytes on a metadata scope, and still lists", async () => {
    const token = await sessionFor(INVESTIGATOR);
    await approvedGrant({ scope: "metadata" });

    const listed = await (await listMessages(testEnv, atTime(AUGUST_20), requestAs(token))).json();
    expect((listed as { messages: unknown[] }).messages).toHaveLength(1);
    // Content is strictly the stronger authority, so the weaker scope must not reach the bytes. A scope that
    // reached everything would make the enum a label rather than a bound.
    const raw = await authorize(testEnv, atTime(AUGUST_20), requestAs(token), RECEIPT);
    expect(raw.ok).toBe(false);
    expect(await mayRead(testEnv, atTime(AUGUST_20), { orgId: ORG, userId: INVESTIGATOR }, MAILBOX))
      .toBe(false);
  });

  it("is not grantable through the ordinary access route", async () => {
    // `supervised.read` is declared in `GRANTABLE` and conferred by nothing in `access.ts`. If `isGrantable`
    // ever accepted it, an administrator could mint one with no matter, no expiry and no approvers — a
    // relation whose name says supervised and whose grant had no supervision.
    expect(isGrantable("supervised.read")).toBe(false);
    expect(isGrantable("mailbox.content.read")).toBe(true);
  });
});

/* ------------------------------------------------------------------ matters --------------------- */

describe("a matter is an object with a lifecycle, because free text cannot close", () => {
  it("opens, closes once, and refuses a second close", async () => {
    const ctx = atTime(AUGUST_20);
    const matter = await openMatter(testEnv, ctx, ORG, INVESTIGATOR, {
      type: "security_incident", description: "Suspected exfiltration from the people mailbox",
    });
    expect(matter.closedAt).toBeNull();

    const closed = await closeMatter(testEnv, atTime(AUGUST_20 + 1000), ORG, INVESTIGATOR, matter.id);
    expect(closed.closedAt).toBe(new Date(AUGUST_20 + 1000).toISOString());
    expect(closed.closedBy).toBe(INVESTIGATOR);
    await expect(closeMatter(testEnv, ctx, ORG, INVESTIGATOR, matter.id))
      .rejects.toThrow(/E_MATTER_ALREADY_CLOSED/);

    // Both acts recorded, and the close carries its own entry because §7 hangs the notice on it.
    expect(await auditRows("matter.opened")).toHaveLength(1);
    expect(await auditRows("matter.closed")).toHaveLength(1);
  });

  it("refuses a type it does not recognise and a description that is only whitespace", async () => {
    const ctx = atTime(AUGUST_20);
    await expect(openMatter(testEnv, ctx, ORG, INVESTIGATOR, { type: "hunch", description: "x" }))
      .rejects.toThrow(/E_MATTER_TYPE_UNKNOWN/);
    // Mandatory means non-empty. `NOT NULL` is satisfied by a space, and two people are asked to approve
    // reading somebody's mail for this text.
    await expect(openMatter(testEnv, ctx, ORG, INVESTIGATOR, { type: MATTER_TYPES[0], description: "  " }))
      .rejects.toThrow(/E_MATTER_DESCRIPTION_REQUIRED/);
  });

  it("lets a grant cite an open matter and refuses a closed one", async () => {
    const ctx = atTime(AUGUST_20);
    const matter = await openMatter(testEnv, ctx, ORG, INVESTIGATOR, {
      type: "regulatory_request", description: "ICO reference 2026/8891",
    });
    const requested = await approvedGrant({ matterId: matter.id });
    expect((await grantRow(requested.grantId))?.matter_id).toBe(matter.id);

    await closeMatter(testEnv, ctx, ORG, INVESTIGATOR, matter.id);
    await expect(
      requestSupervisedRead(testEnv, ctx, ORG, ANA, {
        mailboxId: MAILBOX, scope: "content", durationSeconds: 60, matterId: matter.id,
      }),
    ).rejects.toThrow(/E_MATTER_CLOSED/);
    await expect(
      requestSupervisedRead(testEnv, ctx, ORG, ANA, {
        mailboxId: MAILBOX, scope: "content", durationSeconds: 60, matterId: "mtr_does_not_exist",
      }),
    ).rejects.toThrow(/E_NO_MATTER/);
  });

  it("does not list somebody else's matter to them", async () => {
    /*
     * The disclosure boundary, and it is the one §7's deferred notice depends on. A description names the
     * person being examined — *"Suspected exfiltration from the people mailbox"* is one sentence away from a
     * name — and §7 makes the notice to that person due **after the matter closes**. A listing that returned
     * every matter to every member would deliver it on the day the matter opened, which is the notice
     * arriving early, badly, and only to the person it should reach last.
     *
     * So: an `org.admin` sees all, the opener sees their own, everybody else sees none. The route picks which
     * by asking `isAdmin`; this asserts the function underneath can express both, and that the caller who
     * is neither gets nothing rather than a filtered-looking everything.
     */
    await openMatter(testEnv, atTime(AUGUST_20), ORG, ADMIN, {
      type: "security_incident", description: "Suspected exfiltration from the people mailbox",
    });
    expect(await listMatters(testEnv, ORG, null)).toHaveLength(1);
    expect(await listMatters(testEnv, ORG, ADMIN)).toHaveLength(1);
    // The investigator did not open it, so it is not theirs to read — and neither is the sentence in it.
    expect(await listMatters(testEnv, ORG, INVESTIGATOR)).toHaveLength(0);
    expect(JSON.stringify(await listMatters(testEnv, ORG, INVESTIGATOR))).not.toContain("exfiltration");
  });

  it("closing a matter does not revoke a live grant", async () => {
    const ctx = atTime(AUGUST_20);
    const matter = await openMatter(testEnv, ctx, ORG, INVESTIGATOR, {
      type: "legal_hold", description: "Preservation for matter 41",
    });
    await approvedGrant({ matterId: matter.id });
    await closeMatter(testEnv, ctx, ORG, INVESTIGATOR, matter.id);
    /*
     * A grant's authority ends at its own deadline and nowhere else. Cascading revocation from a closed matter
     * would be a second expiry mechanism — a second place for "may this person still read" to be answered —
     * and the honest single answer is the grant's own `expires_at`. What a closed matter does change is that
     * no new grant may cite it, which the test above proves.
     */
    expect(await mayRead(testEnv, ctx, { orgId: ORG, userId: INVESTIGATOR }, MAILBOX)).toBe(true);
  });

  it("refuses a scope it does not recognise and a duration that is not a positive whole number", async () => {
    const ctx = atTime(AUGUST_20);
    for (const scope of ["everything", ""]) {
      await expect(requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
        mailboxId: MAILBOX, scope, durationSeconds: 60,
      })).rejects.toThrow(/E_SUPERVISED_SCOPE_UNKNOWN/);
    }
    for (const durationSeconds of [0, -60, 1.5, Number.NaN]) {
      await expect(requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
        mailboxId: MAILBOX, scope: SUPERVISED_SCOPES[0], durationSeconds,
      })).rejects.toThrow(/E_SUPERVISED_DURATION_REQUIRED/);
    }
    // And a mailbox that is not there, which would run the whole ceremony and authorize nothing.
    await expect(requestSupervisedRead(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: "mbx_nope", scope: "content", durationSeconds: 60,
    })).rejects.toThrow(/E_NO_MAILBOX/);
  });
});

/* ------------------------------------------------------------------ the self-grant -------------- */

describe("the self-grant stays possible and becomes conspicuous", () => {
  it("still works, which is the honest half of this finding", async () => {
    const ctx = atTime(AUGUST_20);
    // An administrator giving themselves the content relation. #63 deliberately did not close this: refusing
    // it traps a two-person organization into seeking approval from the person being examined.
    const outcome = await grant(testEnv, ctx, ORG, ADMIN, {
      subjectId: ADMIN, relation: "mailbox.content.read", objectId: MAILBOX,
    });
    expect(outcome.granted).toBe(true);
    expect(await mayRead(testEnv, ctx, { orgId: ORG, userId: ADMIN }, MAILBOX)).toBe(true);
  });

  it("produces the doctor finding, and an ordinary grant does not", async () => {
    const ctx = atTime(AUGUST_20);

    // One person granting another: the ordinary act, and the control. Without it a finding that fired on
    // every grant would pass the assertion below for the wrong reason.
    await grant(testEnv, ctx, ORG, ADMIN, {
      subjectId: ANA, relation: "mailbox.content.read", objectId: MAILBOX,
    });
    const clean = find((await runDoctor(testEnv, ctx)).findings, "self_granted_access");
    expect(clean.ok).toBe(true);
    expect(clean.severity).toBe("report");
    expect(clean.discloses).toBe("data");

    await grant(testEnv, ctx, ORG, ADMIN, {
      subjectId: ADMIN, relation: "mailbox.content.read", objectId: MAILBOX,
    });
    const flagged = find((await runDoctor(testEnv, ctx)).findings, "self_granted_access");
    expect(flagged.ok).toBe(false);
    // `report`, not `degraded`. A self-grant is the correct act in a two-person organization, and a permanent
    // WARN on a legitimate act is the muted check this repository has already paid for once.
    expect(flagged.severity).toBe("report");
    expect(flagged.detail).toContain("1 access.granted entry");
    // The wording must not claim more than it does. This is the sentence #63 required be said plainly.
    expect(flagged.detail).toContain("does not prevent an administrator reading mail");
    expect(flagged.fix).toContain("POST /api/supervised");
  });

  it("does not fire for the supervised path, which is the point of having two doors", async () => {
    const ctx = atTime(AUGUST_20);
    await approvedGrant();
    const finding = find((await runDoctor(testEnv, ctx)).findings, "self_granted_access");
    // A supervised read is requested by the reader and granted by two other people, so no `access.granted`
    // entry exists at all — which is exactly what makes the two paths distinguishable in the record.
    expect(finding.ok).toBe(true);
  });

  it("does not degrade the verdict, so a governed Node stays green", async () => {
    const ctx = atTime(AUGUST_20);
    await grant(testEnv, ctx, ORG, ADMIN, {
      subjectId: ADMIN, relation: "mailbox.content.read", objectId: MAILBOX,
    });
    const report = await runDoctor(testEnv, ctx);
    // A `degraded` here would put a permanent WARN on the ordinary state of a small organization, and a check
    // that always warns is a check somebody turns off.
    expect(report.findings.some((f) => f.check === "self_granted_access" && f.severity === "degraded"))
      .toBe(false);
  });
});
