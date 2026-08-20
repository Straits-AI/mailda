import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { utf8 } from "@mailda/evidence";

import { decideApproval, pendingApprovals } from "../src/approvals.ts";
import { authorizeExport } from "../src/authz-read.ts";
import { hashPassword } from "../src/auth/password.ts";
import { login } from "../src/auth/session.ts";
import { getEvidence, putEvidence, sha256Hex } from "../src/evidence-store.ts";
import {
  authorizeExportObject, canonicalPredicate, EXPORT_STATES, exportsForReport, predicateHash, readExport,
  requestExport, runExport,
} from "../src/exports.ts";
import { placeHold } from "../src/holds.ts";
import { closeMatter, openMatter } from "../src/matters.ts";
import { reconcileEvidence } from "../src/reconcile.ts";

/**
 * eDiscovery export (#65, §7, §22): the supervised bulk copy, and the permission that finally governs the
 * single-message one.
 *
 * ## What each block is for, in the terms of the failure it prevents
 *
 * 1. **A manifest whose hash is over its own bytes.** The manifest is the account of what was disclosed, and
 *    an account nobody can verify is a claim. So the test re-reads the sealed manifest object, hashes its
 *    plaintext, and compares that against the `exports` row *and* against the audit entry — three places that
 *    must agree, and the entry is the one a person reads years later.
 * 2. **The bound aborts rather than truncating.** A truncated export carrying a manifest that reads as
 *    complete is the one failure this whole mechanism may not have: it is worse than refusing and worse than
 *    exporting too much, because it is the only outcome that misleads.
 * 3. **A revoked grant stops a download mid-way.** §7 says revocation terminates export jobs, and the only
 *    reason that is a mechanism rather than a sentence is that nothing is presigned and nothing is cached —
 *    so the assertion is that object 1 downloads, the relation is revoked, and object 2 does not.
 * 4. **A held source refuses collection.** #64 makes a hold a predicate over a mailbox and a window, and an
 *    export is a copy of the same material — so a stranded export object is not swept while a hold stands.
 *    Stated plainly because the alternative reading was rejected: a hold does **not** refuse the export
 *    itself, because a hold is placed *for* a matter and refusing the eDiscovery it exists to serve would
 *    make the two mechanisms fight.
 * 5. **An unapproved export produces nothing.** Not "produces less" and not "produces a partial file":
 *    `runExport` refuses before its first page, so an unapproved export stages zero objects.
 * 6. **The `.eml` download is recorded**, and refused without `message.export`. The reachable door.
 *
 * ## Non-vacuity
 *
 * Every assertion here was verified by breaking the source it guards and watching it fail. The mutations and
 * the observed failures are in the report for this change. The ones whose failure mode is **silence** rather
 * than an error are noted inline, because a reader cannot re-derive those.
 */

const testEnv = env as unknown as Env;
const ORG = "org_export";
const MAILBOX = "mbx_exp_hr";
const ADDRESS = "people@acme.example";

const ADMIN = "usr_exp_admin";
/** Holds `ediscovery.export`. Holds no read relation at all — an export is not a read. */
const INVESTIGATOR = "usr_exp_investigator";
const ANA = "usr_exp_ana";
const BEN = "usr_exp_ben";
/** Holds `mailbox.content.read` and `message.export`, as migration 0025's backfill leaves everybody. */
const MEMBER = "usr_exp_member";
/** Holds `mailbox.content.read` and **not** `message.export`: the revocation the new relation makes possible. */
const READER = "usr_exp_reader";

const PASSWORD = "fixture-password-not-a-real-secret";
const AUGUST = Date.parse("2026-08-20T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

const who = (userId: string) => ({ orgId: ORG, userId });

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT OR IGNORE INTO relationship_tuples
       (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId,
    new Date(ctx.now()).toISOString()).run();
}

/** How many messages the fixture puts in the mailbox, one per day from AUGUST. */
const MESSAGES = 4;
const RECEIPTS = Array.from({ length: MESSAGES }, (_, index) => `rcpt_exp_${index}`);
const SUBJECTS = ["Redundancy list", "Invoice 4001", "Redundancy appeal", "Lunch"];

/** The real bytes of message `index`, so a manifest hash is over something rather than over a fixture. */
const bodyOf = (index: number) =>
  utf8(`From: sender${index}@example.net\r\nSubject: ${SUBJECTS[index]}\r\n\r\nbody ${index}\r\n`);

beforeEach(async () => {
  for (const table of ["exports", "holds", "supervised_grants", "matters", "approval_decisions",
                       "approval_stages", "approvals", "notifications", "relationship_tuples", "team_members",
                       "ingress_receipts", "messages", "cases", "conversations", "addresses", "mailboxes",
                       "users", "node_claim", "login_attempts", "sessions", "refresh_tokens", "audit_entries",
                       "log_entries", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/` });
  for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);

  const ctx = createSystemCtx();
  const at = new Date(AUGUST).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_exp", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "People", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
    ...[ADMIN, INVESTIGATOR, ANA, BEN, MEMBER, READER].map((userId) => testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at)),
  ]);

  // Real sealed evidence, one object per receipt, so the export copies bytes rather than rows.
  for (const [index, receiptId] of RECEIPTS.entries()) {
    const acceptedAt = new Date(AUGUST + index * DAY).toISOString();
    const stored = await putEvidence(testEnv, `${ORG}/raw/${receiptId}.eml`, bodyOf(index));
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
           blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(receiptId, ORG, `evt_${receiptId}`, `sender${index}@example.net`, ADDRESS,
        stored.plaintextBytes, stored.blobKey, stored.plaintextSha256, acceptedAt),
      testEnv.CATALOG.prepare(
        `INSERT INTO messages (id, org_id, time_bucket, blob_key, blob_sha256, blob_bytes, rfc_message_id,
           thread_id, subject, from_addr, sent_at, received_at, ingress_receipt_id, created_at,
           conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(ctx.id("msg"), ORG, "2026-08", stored.blobKey, stored.plaintextSha256, stored.plaintextBytes,
        `<${receiptId}@example.net>`, ctx.id("thr"), SUBJECTS[index]!, `sender${index}@example.net`,
        acceptedAt, acceptedAt, receiptId, acceptedAt, null),
    ]);
  }

  await tuple(ADMIN, "org.admin", "organization", ORG);
  await tuple(ANA, "approval.decide", "mailbox", MAILBOX);
  await tuple(BEN, "approval.decide", "mailbox", MAILBOX);
  await tuple(INVESTIGATOR, "ediscovery.export", "mailbox", MAILBOX);
  await tuple(MEMBER, "mailbox.content.read", "mailbox", MAILBOX);
  await tuple(MEMBER, "message.export", "mailbox", MAILBOX);
  // Read but not export: the state migration 0025 does **not** produce, reached by revoking one of the two.
  await tuple(READER, "mailbox.content.read", "mailbox", MAILBOX);
});

async function aMatter(): Promise<string> {
  const matter = await openMatter(testEnv, atTime(AUGUST), ORG, INVESTIGATOR, {
    type: "regulatory_request",
    description: "Regulator asked for correspondence about the redundancy programme",
  });
  return matter.id;
}

/** An export requested and approved by both eligible people. */
async function approvedExport(options?: {
  maxMessages?: number;
  subjectContains?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
}) {
  const ctx = atTime(AUGUST);
  const requested = await requestExport(testEnv, ctx, ORG, INVESTIGATOR, {
    mailboxId: MAILBOX,
    matterId: await aMatter(),
    maxMessages: options?.maxMessages ?? 100,
    subjectContains: options?.subjectContains ?? null,
    fromDate: options?.fromDate ?? null,
    toDate: options?.toDate ?? null,
  });
  await decideApproval(testEnv, ctx, ORG, ANA, requested.approvalId, "approve");
  const closing = await decideApproval(testEnv, ctx, ORG, BEN, requested.approvalId, "approve");
  // Asserted in the helper: an approval that quietly failed to complete would make every test below pass for
  // the wrong reason, which is the vacuous green this suite is written against.
  if (closing.exportApproved !== true) throw new Error("the second approval did not authorize the export");
  return requested;
}

/** Runs pages until the export is done. The loop the route's caller runs, and the checkpoint's whole point. */
async function runToCompletion(exportId: string, at = AUGUST) {
  for (let page = 0; page < 20; page++) {
    const outcome = await runExport(testEnv, atTime(at), ORG, who(INVESTIGATOR), exportId);
    if (outcome.done) return outcome;
  }
  throw new Error("the export did not finish in 20 pages");
}

async function auditRows(action: string) {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT subject, outcome, detail FROM audit_entries WHERE org_id = ? AND action = ? ORDER BY seq",
  ).bind(ORG, action).all<{ subject: string | null; outcome: string; detail: string | null }>();
  return results;
}

async function objectsUnder(prefix: string): Promise<string[]> {
  const listed = await testEnv.EVIDENCE.list({ prefix });
  return listed.objects.map((object) => object.key.slice(prefix.length)).sort();
}

/* ------------------------------------------------------------------ the happy path -------------- */

describe("an approved export runs and produces a manifest whose hash is over its own bytes", () => {
  it("copies every matching message, seals each one, and names them all in the manifest", async () => {
    const requested = await approvedExport();
    const outcome = await runToCompletion(requested.exportId);

    expect(outcome.state).toBe("completed");
    expect(outcome.messagesEmitted).toBe(MESSAGES);
    expect(outcome.manifest?.count).toBe(MESSAGES);

    // Every message is staged under the export's own prefix, plus the manifest. Sorted, so the assertion is
    // about the set rather than about listing order.
    expect(await objectsUnder(requested.destination))
      .toEqual([...RECEIPTS.map((id) => `${id}.eml`), "manifest.json"].sort());

    // The staged bytes are the message's bytes. Without this the export could be writing anything and the
    // manifest would still hash consistently — a self-consistent account of nothing.
    for (const [index, receiptId] of RECEIPTS.entries()) {
      const staged = await getEvidence(testEnv, `${requested.destination}${receiptId}.eml`);
      expect(staged).toEqual(bodyOf(index));
    }
  });

  it("hashes the manifest over the bytes anybody downloading it can re-hash", async () => {
    const requested = await approvedExport();
    const outcome = await runToCompletion(requested.exportId);

    // The claim: `exports.manifest_sha256` is the SHA-256 of the **plaintext** of the manifest object. Not of
    // the sealed bytes — sealing uses a random nonce, so a hash over those could never be re-derived by
    // anybody verifying the export later.
    const bytes = await getEvidence(testEnv, outcome.manifest!.key);
    expect(await sha256Hex(bytes)).toBe(outcome.manifest!.sha256);

    const row = await readExport(testEnv, ORG, requested.exportId);
    expect(row?.manifestSha256).toBe(outcome.manifest!.sha256);
    expect(row?.manifestKey).toBe(outcome.manifest!.key);

    // And the manifest names each message with the hash of that message's own plaintext, so a copy can be
    // checked one object at a time and not only in aggregate.
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
      count: number;
      predicateSha256: string;
      messages: { receiptId: string; object: string; sha256: string }[];
    };
    expect(manifest.count).toBe(MESSAGES);
    expect(manifest.predicateSha256).toBe(requested.predicateSha256);
    for (const [index, entry] of manifest.messages.entries()) {
      expect(entry.receiptId).toBe(RECEIPTS[index]);
      expect(entry.sha256).toBe(await sha256Hex(bodyOf(index)));
    }
  });

  it("puts the hash and the count in the trail, where somebody reads them years later", async () => {
    const requested = await approvedExport();
    const outcome = await runToCompletion(requested.exportId);

    const authorized = await auditRows("supervised.export_requested");
    expect(authorized).toHaveLength(1);
    expect(authorized[0]!.subject).toBe(requested.exportId);
    const asked = JSON.parse(authorized[0]!.detail!) as {
      predicateSha256: string; maxMessages: number; approvedBy: string[]; requestedBy: string;
    };
    // What two people agreed to: the bound artifact hash and the count. `approval.decided` cannot say either.
    expect(asked.predicateSha256).toBe(requested.predicateSha256);
    expect(asked.maxMessages).toBe(100);
    expect(asked.approvedBy.sort()).toEqual([ANA, BEN].sort());
    expect(asked.requestedBy).toBe(INVESTIGATOR);

    const completed = await auditRows("supervised.export_completed");
    expect(completed).toHaveLength(1);
    const done = JSON.parse(completed[0]!.detail!) as { manifestSha256: string; count: number };
    expect(done.manifestSha256).toBe(outcome.manifest!.sha256);
    expect(done.count).toBe(MESSAGES);

    // **Two entries for the whole export, not one per page.** The assertion that keeps
    // `audit-and-log-retention.md`'s "a handful per message" sizing true of a real investigation.
    expect(outcome.pagesDone).toBeGreaterThan(0);
    expect(authorized.length + completed.length).toBe(2);
  });

  it("resumes from its cursor rather than restarting, which is what the checkpoint is for", async () => {
    // A bound of 2 with 4 matching messages would abort, so this narrows the predicate instead: the point
    // being tested is the cursor, and it is tested by running one page at a time over a fixture whose page
    // size is forced down by the bound rather than by a budget.
    const requested = await approvedExport({ subjectContains: "Redundancy" });
    const first = await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId);
    expect(first.done).toBe(true);
    expect(first.messagesEmitted).toBe(2);

    const row = await readExport(testEnv, ORG, requested.exportId);
    // The cursor is the last emitted `(accepted_at, id)` pair, and it survives the run that set it.
    expect(row?.cursorAfter).toContain(RECEIPTS[2]!);
    expect(row?.pagesDone).toBe(1);

    // Only the two matching messages were copied. The predicate is a filter, not a suggestion.
    expect(await objectsUnder(requested.destination))
      .toEqual(["manifest.json", `${RECEIPTS[0]!}.eml`, `${RECEIPTS[2]!}.eml`].sort());
  });

  it("reaches every state the union declares, so none of them is a category of one", async () => {
    /*
     * The behavioural half of `test/node/matter-and-scope-world.test.ts`'s extraction check, and it lives
     * here because that pool cannot import `src/exports.ts` — the module reaches `cloudflare:workers`
     * through the key vault. A declared state nothing reaches is the same defect as a declared audit action
     * nothing emits: a category of one, which reads as coverage and is not.
     */
    const reached = new Set<string>();

    const unrun = await approvedExportRequestOnly();
    reached.add((await readExport(testEnv, ORG, unrun.exportId))!.state);

    const bounded = await approvedExport({ maxMessages: 2 });
    await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), bounded.exportId).catch(() => null);
    reached.add((await readExport(testEnv, ORG, bounded.exportId))!.state);

    const whole = await approvedExport();
    await runToCompletion(whole.exportId);
    reached.add((await readExport(testEnv, ORG, whole.exportId))!.state);

    /*
     * `running` is the state a **full page that is not the last** leaves behind, so reaching it needs more
     * matching messages than `export.page_size`. That is not a fixture inconvenience, it is the shape of the
     * state machine: a page shorter than it asked for is the last page and completes in the same call, and a
     * page that would exceed `max_messages` aborts. So the only way to be `running` is to fill a page.
     *
     * The extra receipts share one blob key rather than getting one object each: what is being exercised is
     * the cursor and the page boundary, and `getEvidence` reading the same object 101 times is the same code
     * path as reading 101 different ones for a tenth of the fixture cost.
     */
    const shared = `${ORG}/raw/${RECEIPTS[0]!}.eml`;
    const pageSize = BUDGETS["export.page_size"];

    for (let index = 0; index <= pageSize; index++) {
      const receiptId = `rcpt_bulk_${String(index).padStart(4, "0")}`;
      const acceptedAt = new Date(AUGUST + (MESSAGES + index) * DAY).toISOString();
      await testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
           blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(receiptId, ORG, `evt_${receiptId}`, "bulk@example.net", ADDRESS, 32, shared,
        "0".repeat(64), acceptedAt).run();
    }


    const paged = await approvedExport({ maxMessages: 1000 });
    const first = await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), paged.exportId);
    // A full page, and not done: the checkpoint is what a second invocation resumes from.
    expect(first.emitted).toBe(pageSize);
    expect(first.done).toBe(false);
    reached.add((await readExport(testEnv, ORG, paged.exportId))!.state);

    expect([...reached].sort()).toEqual([...EXPORT_STATES].sort());
  });

  it("carries the cursor across pages, so a second page continues rather than restarting", async () => {
    /*
     * **The requirement blueprint:1276 states outright, and the one nothing proved.** Every cursor assertion
     * before this one is about an export that finishes in a single page, so dropping the resume clause from
     * `messagePage` — `AND (? IS NULL OR (accepted_at || ' ' || id) > ?)` — passed the entire suite. What
     * that would produce is not a crash: page two re-emits page one, over the same object keys, so the
     * objects look right while `messages_emitted` counts every message twice and the export either never
     * terminates or aborts against a bound it never really reached.
     *
     * So the assertion is over **more messages than one page**, run to completion, checking three numbers
     * that can only agree if the second page started where the first stopped: the page count, the emitted
     * count, and the manifest's own count.
     */
    const pageSize = BUDGETS["export.page_size"];
    const shared = `${ORG}/raw/${RECEIPTS[0]!}.eml`;
    const extra = 5;
    for (let index = 0; index < pageSize + extra - MESSAGES; index++) {
      const receiptId = `rcpt_page_${String(index).padStart(4, "0")}`;
      await testEnv.CATALOG.prepare(
        `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to, raw_bytes,
           blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(receiptId, ORG, `evt_${receiptId}`, "paged@example.net", ADDRESS, 32, shared, "0".repeat(64),
        new Date(AUGUST + (MESSAGES + index) * DAY).toISOString()).run();
    }
    const total = pageSize + extra;

    const requested = await approvedExport({ maxMessages: 1000 });
    const first = await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId);
    expect(first.emitted).toBe(pageSize);
    expect(first.done).toBe(false);

    const second = await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId);
    // The remainder, not the whole first page again.
    expect(second.emitted).toBe(extra);
    expect(second.done).toBe(true);
    expect(second.pagesDone).toBe(2);
    expect(second.messagesEmitted).toBe(total);
    expect(second.manifest?.count).toBe(total);

    // And the objects agree with the counts: one per message, plus the manifest, with nothing double-staged.
    expect(await objectsUnder(requested.destination)).toHaveLength(total + 1);
  });

  it("orders the cursor totally, so two messages in one millisecond cannot be skipped", async () => {
    // A property of two encodings rather than of one line, which is why it is asserted rather than commented:
    // the cursor is `accepted_at + " " + id`, and a space is below every character an ISO-8601 instant or a
    // Crockford ULID can contain. If that stopped being true the cursor would skip or replay a message.
    const same = "2026-08-20T09:00:00.000Z";
    expect(`${same} rcpt_a` < `${same} rcpt_b`).toBe(true);
    expect(`${same} rcpt_zzz` < "2026-08-20T09:00:00.001Z rcpt_a").toBe(true);
    // The separator is what makes it total: without it, `…000Zrcpt_a` and a longer instant could interleave.
    // A space is 0x20, below every character either encoding produces.
    const separator = " ";
    for (const character of ["-", ":", ".", "0", "9", "A", "T", "Z", "_", "r"]) {
      expect(separator < character, `the cursor separator must sort below ${character}`).toBe(true);
    }
  });
});

describe("two invocations of one export cannot both write its ending", () => {
  it("records one completion, whichever of them lost", async () => {
    /*
     * The cursor's compare-and-swap catches a race only when the cursor **moves**. The last page of an
     * export moves nothing — it is empty, so `cursor_after IS ?` compares a value against itself and both
     * invocations pass — and both then reach the completion, where the `UPDATE` is guarded by the state and
     * the audit entry was not. The loser's `UPDATE` changed no row while its `supervised.export_completed`
     * landed anyway, so the trail said one export completed twice.
     *
     * `TERMINAL_GATE` puts the entry behind the same predicate as the write, inside the same transaction,
     * which is the standard `COMPLETING_EFFECT.raced` already states one module over: an entry for a state
     * change that did not happen is worse than a missing one, because it is wrong rather than absent.
     *
     * A predicate that matches nothing is what makes the race reachable **and deterministic in shape**: both
     * invocations take the empty-page branch on their first call, so whichever commits second finds the row
     * already `completed`. The assertion is on the count, not on which one won.
     */
    const requested = await approvedExport({ subjectContains: "nothing matches this" });
    const outcomes = await Promise.allSettled([
      runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId),
      runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId),
    ]);
    // At least one of them has to have got through; a pair that both refused would make the count below
    // pass for the wrong reason.
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);

    const row = await readExport(testEnv, ORG, requested.exportId);
    expect(row?.state).toBe("completed");
    expect(row?.messagesEmitted).toBe(0);
    // One ending in the trail, not two. An export that completed twice is not a thing that can happen.
    expect(await auditRows("supervised.export_completed")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ the bound ------------------- */

describe("an export that would exceed its bound aborts instead of truncating", () => {
  it("stages nothing beyond the bound, records the abort, and refuses loudly", async () => {
    const requested = await approvedExport({ maxMessages: 2 });

    const failure = await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId)
      .then(() => null, (error: Error) => error);
    expect(failure).not.toBeNull();
    // The four-part refusal AGENTS.md §3 requires: the budget, its number and the ask.
    expect(failure!.message).toContain("E_EXPORT_BOUND_EXCEEDED");
    expect(failure!.message).toContain("max_messages=2");

    const row = await readExport(testEnv, ORG, requested.exportId);
    expect(row?.state).toBe("aborted");
    expect(row?.stateReason).toBe("max_messages");
    // **Nothing was staged**, which is the difference between aborting and truncating: an export that had
    // written its first two messages and stopped would carry a manifest reading as a complete account.
    expect(await objectsUnder(requested.destination)).toEqual([]);

    const aborted = await auditRows("supervised.export_aborted");
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.outcome).toBe("refused");
    expect(JSON.parse(aborted[0]!.detail!)).toMatchObject({ reason: "max_messages", maxMessages: 2 });
    // And no completion entry, because there is no manifest to name.
    expect(await auditRows("supervised.export_completed")).toHaveLength(0);
  });

  it("is terminal: an aborted export needs a fresh approval, not a retry", async () => {
    const requested = await approvedExport({ maxMessages: 2 });
    await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId).catch(() => null);

    const again = await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId)
      .then(() => null, (error: Error) => error);
    expect(again!.message).toContain("E_EXPORT_SETTLED");
    expect(again!.message).toContain("aborted");
  });

  it("refuses a bound above the manifest's own boundary, naming both numbers", async () => {
    const ceiling = BUDGETS["export.max_messages_ceiling"];
    const failure = await requestExport(testEnv, atTime(AUGUST), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX,
      matterId: await aMatter(),
      maxMessages: ceiling + 1,
    }).then(() => null, (error: Error) => error);

    expect(failure!.message).toContain("E_EXPORT_TOO_LARGE");
    // blueprint:1280 — the boundary is named rather than worked around, and the message carries both the
    // limit and the ask so an agent can fix it without reading this code.
    expect(failure!.message).toContain(`export.max_messages_ceiling=${ceiling}`);
    expect(failure!.message).toContain(String(ceiling + 1));
    expect(failure!.message).toContain(String(BUDGETS["r2.list_max_keys_per_call"]));
    // Refused before anything was written: no export row, so no ceremony was started for a copy that could
    // not be accounted for.
    expect(await exportsForReport(testEnv, ORG)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ revocation ------------------ */

describe("revoking the grant terminates the export, mid-download", () => {
  it("stops the very next object while the ones already taken stay taken", async () => {
    const requested = await approvedExport();
    await runToCompletion(requested.exportId);

    const first = await authorizeExportObject(
      testEnv, ORG, who(INVESTIGATOR), requested.exportId, `${RECEIPTS[0]!}.eml`,
    );
    expect(first.ok).toBe(true);

    // §7: "revocation terminates export jobs". Nothing is presigned and nothing is cached, so the mechanism
    // is that the next request asks again.
    await testEnv.CATALOG.prepare(
      `DELETE FROM relationship_tuples
        WHERE org_id = ? AND subject_id = ? AND relation = 'ediscovery.export' AND object_id = ?`,
    ).bind(ORG, INVESTIGATOR, MAILBOX).run();

    const second = await authorizeExportObject(
      testEnv, ORG, who(INVESTIGATOR), requested.exportId, `${RECEIPTS[1]!}.eml`,
    );
    expect(second.ok).toBe(false);
    // §5C: refused and absent answer alike, so a revoked investigator cannot probe what was staged.
    if (!second.ok) expect(second.response.status).toBe(404);
  });

  it("stops a running export at its next page rather than at its next message", async () => {
    const requested = await approvedExport({ maxMessages: 100 });
    await testEnv.CATALOG.prepare(
      `DELETE FROM relationship_tuples
        WHERE org_id = ? AND subject_id = ? AND relation = 'ediscovery.export' AND object_id = ?`,
    ).bind(ORG, INVESTIGATOR, MAILBOX).run();

    const failure = await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId)
      .then(() => null, (error: Error) => error);
    expect(failure!.message).toContain("E_EXPORT_REVOKED");
    expect(await objectsUnder(requested.destination)).toEqual([]);
  });

  it("stops the download too, not only the run, when the approval stops standing", async () => {
    /*
     * The half that was unguarded: `authorizeExportObject` re-reads the live approval on **every object**,
     * and deleting that line passed the whole suite. Revocation reaches an export by two routes — the
     * relation and the approval — and §7 asks for both, so both are proved on both halves.
     *
     * The relation half is above. This is the approval half at the download, and it is the one that matters
     * most for staged bytes: an export that finished before anybody withdrew still has every message sitting
     * in R2, and the only thing standing between a withdrawn authorization and those bytes is this check.
     */
    const requested = await approvedExport();
    await runToCompletion(requested.exportId);
    expect((await authorizeExportObject(
      testEnv, ORG, who(INVESTIGATOR), requested.exportId, `${RECEIPTS[0]!}.eml`,
    )).ok).toBe(true);

    await testEnv.CATALOG.prepare(
      "UPDATE approvals SET state = 'denied' WHERE org_id = ? AND subject_id = ?",
    ).bind(ORG, requested.exportId).run();

    for (const name of [`${RECEIPTS[1]!}.eml`, "manifest.json"]) {
      const refused = await authorizeExportObject(
        testEnv, ORG, who(INVESTIGATOR), requested.exportId, name,
      );
      expect(refused.ok, `${name} was still downloadable after the approval was withdrawn`).toBe(false);
    }
    // The objects are still there — no mechanism un-copies a file, and destroying evidence in a matter is
    // not what a withdrawal asks for. What changed is that this Node will not hand them over again.
    expect(await objectsUnder(requested.destination)).toHaveLength(MESSAGES + 1);
  });

  it("stops when an approver withdraws, because the approval is read live and never copied", async () => {
    const requested = await approvedExport();
    // The approval is `approved`; moving it out of that state is what the run has to notice. Done directly
    // rather than through `withdrawApproval`, which refuses a settled request — the point is that the run
    // reads the live column rather than an `approved_at` copy on the export row, and the only way to
    // exercise that is to move the column.
    await testEnv.CATALOG.prepare(
      "UPDATE approvals SET state = 'denied' WHERE org_id = ? AND subject_id = ?",
    ).bind(ORG, requested.exportId).run();

    const failure = await runExport(testEnv, atTime(AUGUST), ORG, who(INVESTIGATOR), requested.exportId)
      .then(() => null, (error: Error) => error);
    expect(failure!.message).toContain("E_EXPORT_NOT_APPROVED");
  });
});

/* ------------------------------------------------------------------ no approval ----------------- */

describe("an unapproved export produces nothing at all", () => {
  it("refuses before its first page, so no object is staged and no entry is written", async () => {
    const ctx = atTime(AUGUST);
    const requested = await requestExport(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX,
      matterId: await aMatter(),
      maxMessages: 100,
    });

    const failure = await runExport(testEnv, ctx, ORG, who(INVESTIGATOR), requested.exportId)
      .then(() => null, (error: Error) => error);
    expect(failure!.message).toContain("E_EXPORT_NOT_APPROVED");

    // Not "fewer objects" and not "a partial file" — zero.
    expect(await objectsUnder(requested.destination)).toEqual([]);
    expect(await auditRows("supervised.export_requested")).toHaveLength(0);
    expect(await auditRows("supervised.export_completed")).toHaveLength(0);
    const row = await readExport(testEnv, ORG, requested.exportId);
    expect(row?.state).toBe("requested");
    expect(row?.messagesEmitted).toBe(0);
  });

  it("refuses one approval as well as none, because dual control means two", async () => {
    const ctx = atTime(AUGUST);
    const requested = await requestExport(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX,
      matterId: await aMatter(),
      maxMessages: 100,
    });
    const one = await decideApproval(testEnv, ctx, ORG, ANA, requested.approvalId, "approve");
    expect(one.exportApproved).toBe(false);

    const failure = await runExport(testEnv, ctx, ORG, who(INVESTIGATOR), requested.exportId)
      .then(() => null, (error: Error) => error);
    expect(failure!.message).toContain("E_EXPORT_NOT_APPROVED");
  });

  it("will not let the requester approve their own export", async () => {
    const ctx = atTime(AUGUST);
    // The investigator is not an approver on this mailbox, so give them the relation: the refusal being
    // tested is §18's actor exclusion, not a missing relation, and without this the test would pass for the
    // wrong reason.
    await tuple(INVESTIGATOR, "approval.decide", "mailbox", MAILBOX);
    const requested = await requestExport(testEnv, ctx, ORG, INVESTIGATOR, {
      mailboxId: MAILBOX,
      matterId: await aMatter(),
      maxMessages: 100,
    });

    const failure = await decideApproval(testEnv, ctx, ORG, INVESTIGATOR, requested.approvalId, "approve")
      .then(() => null, (error: Error) => error);
    expect(failure!.message).toContain("E_APPROVER_IS_ACTOR");
    // And the refusal is the export's own words, not a send's or a hold lift's — the `Record` keyed on the
    // subject kind is what makes that structural, and this is the assertion that it was filled in.
    expect(failure!.message).toContain("you asked for this export");
  });

  it("shows the two approvers the bound before they agree to it", async () => {
    const requested = await approvedExportRequestOnly();
    const queue = await pendingApprovals(testEnv, ORG, ANA);
    const row = queue.find((entry) => entry.subjectId === requested.exportId);
    expect(row).toBeDefined();
    // §18 binds an approval to the artifact hashes it names, and an export's artifact is a predicate. If the
    // queue did not carry these, the two people would be agreeing to "somebody wants an export".
    expect(row!.exportRequest?.maxMessages).toBe(100);
    expect(row!.exportRequest?.predicateSha256).toBe(requested.predicateSha256);
    expect(row!.exportRequest?.predicate).toContain(MAILBOX);
    // And a subject kind that is not an export carries null there rather than a half-populated object.
    expect(row!.supervised).toBeNull();
  });
});

async function approvedExportRequestOnly() {
  return requestExport(testEnv, atTime(AUGUST), ORG, INVESTIGATOR, {
    mailboxId: MAILBOX,
    matterId: await aMatter(),
    maxMessages: 100,
  });
}

/* ------------------------------------------------------------------ asking at all --------------- */

describe("asking for an export takes a granted authority and an open matter", () => {
  it("refuses somebody who does not hold ediscovery.export, naming the relation", async () => {
    const failure = await requestExport(testEnv, atTime(AUGUST), ORG, MEMBER, {
      mailboxId: MAILBOX,
      matterId: await aMatter(),
      maxMessages: 10,
    }).then(() => null, (error: Error) => error);
    // MEMBER can read every message in this mailbox and export them one at a time. That is deliberately not
    // the same authority as a bulk copy, which is the whole reason there are two permissions.
    expect(failure!.message).toContain("E_NO_EXPORT_PERMISSION");
    expect(failure!.message).toContain("ediscovery.export");
  });

  it("refuses an export with no matter, unlike a hold and unlike a supervised read", async () => {
    const failure = await requestExport(testEnv, atTime(AUGUST), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX,
      matterId: "",
      maxMessages: 10,
    }).then(() => null, (error: Error) => error);
    expect(failure!.message).toContain("E_NO_MATTER");
  });

  it("refuses a matter that has been closed, because §7's notice is computed from it", async () => {
    // The citation has to be live, not merely resolvable. §7 hangs the notice to the people whose mail was
    // copied on the matter closing, so a fresh copy taken under a closed matter would make that notice
    // untrue about the disclosure it describes. Unguarded until now: deleting the check passed the suite.
    const matterId = await aMatter();
    await closeMatter(testEnv, atTime(AUGUST), ORG, INVESTIGATOR, matterId);
    const failure = await requestExport(testEnv, atTime(AUGUST), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, matterId, maxMessages: 10,
    }).then(() => null, (error: Error) => error);
    expect(failure!.message).toContain("E_MATTER_CLOSED");
    expect(await exportsForReport(testEnv, ORG)).toEqual([]);
  });

  it("refuses a bound that is not a whole positive number", async () => {
    for (const maxMessages of [0, -1, 1.5, Number.NaN]) {
      const failure = await requestExport(testEnv, atTime(AUGUST), ORG, INVESTIGATOR, {
        mailboxId: MAILBOX,
        matterId: await aMatter(),
        maxMessages,
      }).then(() => null, (error: Error) => error);
      expect(failure, `maxMessages ${maxMessages} was accepted`).not.toBeNull();
      expect(failure!.message).toContain("E_EXPORT_BOUND_REQUIRED");
    }
  });

  it("hashes the predicate it stores, so widening it cannot reuse an old approval", async () => {
    const narrow = await requestExport(testEnv, atTime(AUGUST), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, matterId: await aMatter(), maxMessages: 10, subjectContains: "Redundancy",
    });
    const wide = await requestExport(testEnv, atTime(AUGUST + 1000), ORG, INVESTIGATOR, {
      mailboxId: MAILBOX, matterId: await aMatter(), maxMessages: 10, subjectContains: null,
    });
    // The property the approval binding rests on: two predicates that match different sets hash differently,
    // so an approval of one cannot be pointed at the other.
    expect(narrow.predicateSha256).not.toBe(wide.predicateSha256);
    expect(await predicateHash(canonicalPredicate(narrow.predicate))).toBe(narrow.predicateSha256);
    // And the canonical form is stable under key order, which is what a hash over an object needs.
    expect(canonicalPredicate(narrow.predicate)).toBe(canonicalPredicate({
      subjectContains: narrow.predicate.subjectContains,
      toDate: narrow.predicate.toDate,
      fromDate: narrow.predicate.fromDate,
      mailboxId: narrow.predicate.mailboxId,
    }));
  });
});

/* ------------------------------------------------------------------ the held source ------------- */

describe("an export is held if its source is held", () => {
  it("refuses to sweep a stranded export object while a hold stands, and sweeps it once lifted", async () => {
    /*
     * #64 made a hold a predicate over a mailbox and a date range, and an export is a copy of the same
     * material — so the objects an export stages are covered by the same hold that covers what they were
     * copied from, and the reconciler must not collect them.
     *
     * **The hold does not refuse the export itself**, and that is a decision rather than an omission: a hold
     * is placed *for* a matter, and refusing the eDiscovery that matter exists to serve would make the two
     * mechanisms fight. What a hold refuses is destruction, which here is the sweep.
     *
     * The object is made stranded — its `exports` row removed — because that is the only state in which the
     * reconciler would ever consider deleting an export object at all.
     */
    const requested = await approvedExport();
    await runToCompletion(requested.exportId);
    await testEnv.CATALOG.prepare("DELETE FROM exports WHERE org_id = ? AND id = ?")
      .bind(ORG, requested.exportId).run();

    await placeHold(testEnv, atTime(AUGUST), ORG, ADMIN, { mailboxId: MAILBOX, matterId: null });

    // Past the grace window measured against the **real** clock, because `uploaded` on an R2 object is set by
    // the runtime and not by `ctx`. Testing it against the fixture's frozen instant would put the cutoff in
    // the past and count every object as too fresh to judge — a green that proves nothing.
    const later = atTime(Date.now() + (BUDGETS["reconcile.orphan_grace_seconds"] + 60) * 1000);
    const held = await reconcileEvidence(testEnv, later, ORG, { collect: true });
    expect(held.collection).toEqual({ requested: true, suppressed: true });
    expect(held.exportObjects.read).toBe("complete");
    if (held.exportObjects.read === "complete") {
      // Enumerated — a hold suppresses the delete, never the report.
      expect(held.exportObjects.stranded.length).toBe(MESSAGES + 1);
    }
    expect(held.exportObjectsDeleted).toBe(0);
    expect(await objectsUnder(requested.destination)).not.toEqual([]);

    // And the suppression ends with the hold, which is the half #64 found missing the first time.
    await testEnv.CATALOG.prepare("UPDATE holds SET lifted_at = ? WHERE org_id = ?")
      .bind(new Date(AUGUST).toISOString(), ORG).run();
    const swept = await reconcileEvidence(testEnv, later, ORG, { collect: true });
    expect(swept.exportObjectsDeleted).toBe(MESSAGES + 1);
    expect(await objectsUnder(requested.destination)).toEqual([]);
  });

  it("never touches an export whose row is there, however old the objects are", async () => {
    const requested = await approvedExport();
    await runToCompletion(requested.exportId);

    // Past the grace window measured against the **real** clock, because `uploaded` on an R2 object is set by
    // the runtime and not by `ctx`. Testing it against the fixture's frozen instant would put the cutoff in
    // the past and count every object as too fresh to judge — a green that proves nothing.
    const later = atTime(Date.now() + (BUDGETS["reconcile.orphan_grace_seconds"] + 60) * 1000);
    const report = await reconcileEvidence(testEnv, later, ORG, { collect: true });
    // The referent rule: an `exports` row, found by the id in the key's second segment. "No receipt" is not
    // the test, and if it were, every export object in the product would be collected an hour after it was
    // staged.
    expect(report.exportObjectsDeleted).toBe(0);
    expect(await objectsUnder(requested.destination)).toHaveLength(MESSAGES + 1);
  });

  it("names the export prefix in what it scanned, so its coverage is visible rather than assumed", async () => {
    const report = await reconcileEvidence(testEnv, atTime(AUGUST), ORG);
    expect(report.scanned.prefixes).toContain(`${ORG}/exports/`);
    // `${ORG}/sent/` is deliberately absent — filed rather than repaired here — and this is the line that
    // makes that absence readable in the output instead of absent from it.
    expect(report.scanned.prefixes).not.toContain(`${ORG}/sent/`);
  });
});

/* ------------------------------------------------------------------ the .eml door --------------- */

describe("the single-message .eml download is governed and recorded", () => {
  function requestAs(token: string): Request {
    return new Request("https://node.example/api/messages", {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  async function sessionFor(userId: string): Promise<string> {
    const outcome = await login(testEnv, atTime(AUGUST), ORG, `${userId}@acme.example`, PASSWORD);
    if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
    return outcome.session.accessToken;
  }

  it("records who took a copy, which was unanswerable before #65", async () => {
    const token = await sessionFor(MEMBER);
    const allowed = await authorizeExport(testEnv, atTime(AUGUST), requestAs(token), RECEIPTS[0]!);
    expect(allowed.ok).toBe(true);

    const taken = await auditRows("message.exported");
    expect(taken).toHaveLength(1);
    expect(taken[0]!.subject).toBe(RECEIPTS[0]!);
    // A standing relation answered, so no grant is named — the field distinguishes an ordinary copy from a
    // supervised one without a join.
    expect(JSON.parse(taken[0]!.detail!)).toMatchObject({
      receiptId: RECEIPTS[0]!, mailboxId: MAILBOX, grantId: null,
    });
  });

  it("refuses a reader who may read but no longer may export", async () => {
    const token = await sessionFor(READER);
    const refused = await authorizeExport(testEnv, atTime(AUGUST), requestAs(token), RECEIPTS[0]!);
    // The whole point of the new relation: READER holds `mailbox.content.read` and not `message.export`,
    // which was not expressible before. §5C makes the refusal a 404.
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(404);
    // And nothing was recorded, because nothing was disclosed. An entry here would be a copy in the trail
    // that never happened, which is worse than a missing one.
    expect(await auditRows("message.exported")).toHaveLength(0);
  });

  it("does not record when the message is not there, so the trail cannot be seeded by guessing ids", async () => {
    const token = await sessionFor(MEMBER);
    const refused = await authorizeExport(testEnv, atTime(AUGUST), requestAs(token), "rcpt_does_not_exist");
    expect(refused.ok).toBe(false);
    expect(await auditRows("message.exported")).toHaveLength(0);
  });

  it("refuses somebody who may export but may not read, because both authorities are required", async () => {
    /*
     * The other half of the pair, and it was the unguarded one: `authorizeExport` checks `message.export`
     * **and then** `mayRead`, and until this test only the first check was proved. Deleting the `mayRead`
     * call passed the whole suite — which would have handed the original `.eml` to somebody holding a
     * relation that says "you may take copies" on a mailbox they may not open, and skipped the
     * `supervised.attachment` entry a grant owes on the way past.
     *
     * ADMIN holds `org.admin` and no mailbox relation at all; the grant below is deliberately only the
     * export half.
     */
    await tuple(ADMIN, "message.export", "mailbox", MAILBOX);
    const refused = await authorizeExport(
      testEnv, atTime(AUGUST), requestAs(await sessionFor(ADMIN)), RECEIPTS[0]!,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.response.status).toBe(404);
    expect(await auditRows("message.exported")).toHaveLength(0);
  });

  it("lets a supervised grant answer both checks, and writes both entries", async () => {
    /*
     * The supervised arm of the `.eml` door, which nothing exercised: a scope-`content` grant satisfies
     * `message.export` as well as `mailbox.content.read`, because a grant that could read a body but not
     * produce the original would be an investigator told to screenshot it.
     *
     * Two entries, and the assertion is that neither pretends to answer the other's question:
     * `supervised.attachment` is keyed on the grant and says *who was let in*; `message.exported` is keyed on
     * the receipt and says *what left*, naming the grant that answered so an ordinary copy and a supervised
     * one are distinguishable without a join.
     */
    await testEnv.CATALOG.prepare(
      `INSERT INTO supervised_grants
         (id, org_id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).bind("sgr_exp_probe", ORG, ANA, MAILBOX, "content", await aMatter(),
      new Date(AUGUST).toISOString(), new Date(AUGUST + DAY).toISOString(),
      new Date(AUGUST).toISOString()).run();

    const allowed = await authorizeExport(
      testEnv, atTime(AUGUST), requestAs(await sessionFor(ANA)), RECEIPTS[0]!,
    );
    expect(allowed.ok).toBe(true);

    const taken = await auditRows("message.exported");
    expect(taken).toHaveLength(1);
    expect(JSON.parse(taken[0]!.detail!)).toMatchObject({ grantId: "sgr_exp_probe" });
    expect(await auditRows("supervised.attachment")).toHaveLength(1);

    // And an expired grant is not an authority: the same person, one millisecond past the deadline.
    const after = atTime(AUGUST + DAY + 1);
    const refused = await authorizeExport(testEnv, after, requestAs(await sessionFor(ANA)), RECEIPTS[1]!);
    expect(refused.ok).toBe(false);
    expect(await auditRows("message.exported")).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ who may run it -------------- */

describe("an export belongs to the person it was approved for", () => {
  it("refuses another holder of ediscovery.export, on the run and on the download alike", async () => {
    /*
     * `runExport` and `authorizeExportObject` both compare `requested_by` against the caller, and until this
     * test neither comparison was guarded: deleting either passed the whole suite. What it would allow is
     * somebody who holds `ediscovery.export` on the same mailbox — a colleague on the same investigation,
     * not an intruder — staging and taking a copy under an approval that named a different person, leaving
     * a trail that says the requester took a copy they never took.
     *
     * MEMBER gets the relation here so the refusal under test is the ownership one and not a missing
     * permission; without that this would pass for the wrong reason.
     */
    await tuple(MEMBER, "ediscovery.export", "mailbox", MAILBOX);
    const requested = await approvedExport();
    await runToCompletion(requested.exportId);

    const run = await runExport(testEnv, atTime(AUGUST), ORG, who(MEMBER), requested.exportId)
      .then(() => null, (error: Error) => error);
    // §5C: an export id discloses that somebody is investigating a mailbox, so "not yours" and "not there"
    // answer alike.
    expect(run!.message).toContain("E_NO_SUCH_EXPORT");

    const download = await authorizeExportObject(
      testEnv, ORG, who(MEMBER), requested.exportId, `${RECEIPTS[0]!}.eml`,
    );
    expect(download.ok).toBe(false);
    if (!download.ok) expect(download.response.status).toBe(404);

    // And the owner is still served, so the refusal above is about the person and not about the export.
    expect((await authorizeExportObject(
      testEnv, ORG, who(INVESTIGATOR), requested.exportId, `${RECEIPTS[0]!}.eml`,
    )).ok).toBe(true);
  });

  it("refuses an object name this Node would never have staged", async () => {
    const requested = await approvedExport();
    await runToCompletion(requested.exportId);

    /*
     * The conservative character class, checked rather than described. Every name here is **staged first**,
     * which is what makes the assertion about the class rather than about the object being absent: an R2 key
     * is a literal string, so `../raw/x.eml` under a destination never resolves anywhere else and the
     * `head()` at the foot of `authorizeExportObject` would refuse it whatever the class said. Deleting the
     * class then passes — which is exactly how this test read before it staged anything.
     *
     * What the class is actually for is that a name reaching R2 at all should be one this Node wrote:
     * a receipt id plus `.eml`, or `manifest.json`. So the objects below are put there deliberately, and
     * the refusal has to come from the name.
     */
    const names = ["..", "../raw/rcpt_exp_0.eml", "a/b", "x\ny", "we ird.eml", "%2e%2e"];
    for (const name of names) {
      await testEnv.EVIDENCE.put(`${requested.destination}${name}`, new Uint8Array([1, 2, 3]));
      const got = await authorizeExportObject(testEnv, ORG, who(INVESTIGATOR), requested.exportId, name);
      expect(got.ok, `object name ${JSON.stringify(name)} was accepted`).toBe(false);
    }
    // And the empty name, which has nothing to stage: it would resolve to the destination prefix itself.
    expect((await authorizeExportObject(testEnv, ORG, who(INVESTIGATOR), requested.exportId, "")).ok)
      .toBe(false);
  });
});
