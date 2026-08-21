import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { utf8 } from "@mailda/evidence";

import { decideApproval, pendingApprovals, stageOf } from "../src/approvals.ts";
import { verifyChain } from "../src/audit.ts";
import { conversationForDelivery } from "../src/conversations.ts";
import { deleteDraft, saveDraft } from "../src/drafts.ts";
import { runDoctor, withoutDataFindings, type Finding } from "../src/doctor.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { anyActiveHold, coveringHolds, placeHold, requestHoldLift } from "../src/holds.ts";
import { mergeConversations } from "../src/merge.ts";
import { reconcileEvidence, formatReconcile } from "../src/reconcile.ts";

/**
 * Legal hold: enforcement, and only enforcement (#64).
 *
 * ## What this file is for
 *
 * `test/node/content-deletion-world.test.ts` proves the *set* of content-destroying call sites is closed and
 * that each content-carrying one calls the hold. That check is lexical. This file is the behavioural half:
 * real rows, real holds, and the refusal actually happening — because a guard called inside an `if` that is
 * never true would satisfy the closed world and protect nothing.
 *
 * ## Lifting, and what it has to prove
 *
 * The lift exists now, and the assertions that matter are the ones about what a lift *changes*: one person
 * cannot do it, the requester cannot decide it, a blank reason is refused, and a lifted hold **stops
 * covering** — proved through `deleteDraft` and through orphan collection rather than against
 * `coveringHolds` alone, because those two are the observable consequences and a predicate that returned the
 * right array while the deletion path kept refusing would be a passing test over a broken product.
 *
 * ## What it still deliberately does not test
 *
 * Expiry, and "the matter closed". Neither exists: #62 owns expiry, and there are no matters (#63 is charted,
 * not built), so a test for either would be asserting a decision this build has not taken. `doctor`'s header
 * records why the matter-closed finding is still absent.
 */

const testEnv = env as unknown as Env;
const ORG = "org_hold";
const HELD_MAILBOX = "mbx_held";
const FREE_MAILBOX = "mbx_free";
const ADMIN = "usr_admin_h";
const ANA = "usr_ana_h";
/** The second approver. A lift needs two people who are not the requester, so the fixture has to have two. */
const BEN = "usr_ben_h";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

/** A fixed instant, so every window in this file is written against a date a reader can check by eye. */
const AUGUST_10 = Date.parse("2026-08-10T09:00:00.000Z");

function find(findings: Finding[], check: string): Finding {
  const found = findings.find((finding) => finding.check === check);
  if (found === undefined) throw new Error(`no finding named ${check}`);
  return found;
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

/** A conversation with one case per named mailbox, claimed by `assignee` so a merge is auto-mergeable. */
async function conversationWithCases(
  root: string,
  mailboxes: string[],
  at: string,
  assignee: string,
): Promise<string> {
  const ctx = createSystemCtx();
  const id = await conversationForDelivery(testEnv, ctx, ORG, root);
  for (const mailboxId of mailboxes) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO cases (id, org_id, conversation_id, mailbox_id, state, state_at, assignee,
         claimed_at, created_at) VALUES (?,?,?,?, 'claimed', ?, ?, ?, ?)`,
    ).bind(ctx.id("cas"), ORG, id, mailboxId, at, assignee, at, at).run();
  }
  return id;
}

async function caseCount(conversationId: string): Promise<number> {
  const row = await testEnv.CATALOG.prepare(
    "SELECT COUNT(*) AS n FROM cases WHERE org_id = ? AND conversation_id = ?",
  ).bind(ORG, conversationId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function auditRows(action: string): Promise<Array<{ subject: string | null; outcome: string; detail: string | null }>> {
  const { results } = await testEnv.CATALOG.prepare(
    "SELECT subject, outcome, detail FROM audit_entries WHERE org_id = ? AND action = ? ORDER BY seq",
  ).bind(ORG, action).all<{ subject: string | null; outcome: string; detail: string | null }>();
  return results;
}

/** What a lift is asked for. One reason string, reused, so a test asserting on it reads as one fact. */
const REASON = "matter 41 closed; custodian mail no longer responsive";

/** A hold, then a lift requested by the administrator and approved by two other people. */
async function liftedHold(mailboxId: string = HELD_MAILBOX): Promise<{
  id: string; liftId: string; approvalId: string;
}> {
  const ctx = atTime(AUGUST_10);
  const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId });
  const lift = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, REASON);
  await decideApproval(testEnv, ctx, ORG, ANA, lift.approvalId, "approve");
  const closing = await decideApproval(testEnv, ctx, ORG, BEN, lift.approvalId, "approve");
  // Asserted in the helper rather than in every caller: a helper that quietly failed to lift would make the
  // tests below pass for the wrong reason, which is the vacuous green this suite is written against.
  if (closing.holdLifted !== true) throw new Error("the second approval did not lift the hold");
  return { id: hold.id, liftId: lift.liftId, approvalId: lift.approvalId };
}

async function holdRow(id: string) {
  return testEnv.CATALOG.prepare(
    "SELECT lifted_at, lifted_reason, lift_id FROM holds WHERE org_id = ? AND id = ?",
  ).bind(ORG, id).first<{ lifted_at: string | null; lifted_reason: string | null; lift_id: string | null }>();
}

beforeEach(async () => {
  for (const table of ["approval_decisions", "approval_stages", "approvals", "hold_lifts",
                       "holds", "drafts", "cases", "conversations", "relationship_tuples", "mailboxes",
                       "users", "audit_entries", "ingress_receipts", "node_claim"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/` });
  for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);

  const at = new Date(AUGUST_10).toISOString();
  for (const [id, name] of [[HELD_MAILBOX, "Support"], [FREE_MAILBOX, "Billing"]] as const) {
    await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(id, ORG, name, at).run();
  }
  // Rows in `users`, because `decidersByMailbox` counts only subjects that are people: a tuple whose subject
  // is a team id must not satisfy dual control on its own, so a tuple with no user behind it is nobody.
  for (const user of [ADMIN, ANA, BEN]) {
    await testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(user, ORG, `${user}@local.invalid`, at).run();
  }
  await tuple(ADMIN, "org.admin", "organization", ORG);
  for (const user of [ADMIN, ANA]) {
    for (const mailbox of [HELD_MAILBOX, FREE_MAILBOX]) {
      await tuple(user, "mailbox.content.read", "mailbox", mailbox);
      await tuple(user, "send.propose", "mailbox", mailbox);
    }
  }
  // Two approvers who are not the administrator who places and requests. Without them every hold here would
  // be unliftable — which is a real state and has its own test, but not the baseline one.
  for (const user of [ANA, BEN]) {
    for (const mailbox of [HELD_MAILBOX, FREE_MAILBOX]) await tuple(user, "approval.decide", "mailbox", mailbox);
  }
  // Claimed, so `doctor` has an organization whose holds it can report.
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, org_id, claimed_at) VALUES (1, ?, ?, ?)",
  ).bind("unused-in-this-test", ORG, at).run();
});

describe("placing a hold", () => {
  it("is one administrator, alone, and immediate", async () => {
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    expect(hold.mailboxId).toBe(HELD_MAILBOX);
    // Immediate: it covers this instant with no second act in between, which is the whole asymmetry — placing
    // only ever preserves, and ceremony in front of it is how evidence is lost.
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, new Date(AUGUST_10).toISOString()))
      .toHaveLength(1);
  });

  it("refuses anybody who does not hold org.admin", async () => {
    await expect(placeHold(testEnv, atTime(AUGUST_10), ORG, ANA, { mailboxId: HELD_MAILBOX }))
      .rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
    expect(await anyActiveHold(testEnv, ORG)).toBe(false);
  });

  it("records hold.placed with the scope, in the same transaction as the row", async () => {
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      mailboxId: HELD_MAILBOX, matterId: "mat_acme_v_widget", fromDate: "2026-08-01",
    });
    const entries = await auditRows("hold.placed");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.subject).toBe(hold.id);
    expect(entries[0]!.outcome).toBe("ok");
    // The scope is in the trail, not only in the table: an auditor asking what was preserved should not have
    // to join against a table whose rows a later migration may reshape.
    expect(JSON.parse(entries[0]!.detail!)).toMatchObject({
      mailboxId: HELD_MAILBOX, matterId: "mat_acme_v_widget",
    });
  });

  it("cites no matter at all, because the first act usually precedes one", async () => {
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    expect(hold.matterId).toBeNull();
  });

  it("refuses a hold on a mailbox that is not there, which would preserve nothing", async () => {
    await expect(placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: "mbx_nope" }))
      .rejects.toThrow(/E_NO_MAILBOX/);
  });

  it("refuses a bound it cannot compare, and an inverted window", async () => {
    // Both would make the hold cover nothing while reporting as active, which is the one error this
    // mechanism may not make.
    await expect(placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      mailboxId: HELD_MAILBOX, fromDate: "last Tuesday",
    })).rejects.toThrow(/E_HOLD_BOUND_UNREADABLE/);
    await expect(placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      mailboxId: HELD_MAILBOX, fromDate: "2026-08-10", toDate: "2026-08-01",
    })).rejects.toThrow(/E_HOLD_WINDOW_INVERTED/);
  });
});

describe("coverage is a predicate, evaluated at the instant of the act", () => {
  it("covers mail that arrives after the hold was placed", async () => {
    // The requirement that decided the whole shape: a hold placed on Tuesday covers Wednesday's mail. A
    // materialised set of ids could not do this without maintenance, and a hold that needs maintenance to
    // keep covering things will quietly stop.
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX, fromDate: "2026-08-01" });
    const tomorrow = new Date(AUGUST_10 + 24 * 60 * 60 * 1000).toISOString();
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, tomorrow)).toHaveLength(1);
  });

  it("covers one mailbox and not another", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const at = new Date(AUGUST_10).toISOString();
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, at)).toHaveLength(1);
    expect(await coveringHolds(testEnv, ORG, FREE_MAILBOX, at)).toHaveLength(0);
  });

  it("excludes content outside a closed window at either bound", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      mailboxId: HELD_MAILBOX, fromDate: "2026-08-05", toDate: "2026-08-15",
    });
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, "2026-08-04T23:59:59.999Z")).toHaveLength(0);
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, "2026-08-16T00:00:00.000Z")).toHaveLength(0);
  });

  it("includes the whole of the last day a bare to_date names", async () => {
    // The trap `normaliseBound` exists for: stored verbatim, `2026-08-15` sorts below everything that
    // happened during 15 August, so the hold would silently fail to cover the last day somebody chose.
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      mailboxId: HELD_MAILBOX, fromDate: "2026-08-05", toDate: "2026-08-15",
    });
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, "2026-08-15T17:04:00.000Z")).toHaveLength(1);
    // And symmetrically, a bare from_date includes that day from its first instant.
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, "2026-08-05T00:00:00.001Z")).toHaveLength(1);
  });

  it("reports any hold in the organization for the reconciler, whatever it covers", async () => {
    expect(await anyActiveHold(testEnv, ORG)).toBe(false);
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      mailboxId: FREE_MAILBOX, fromDate: "1999-01-01", toDate: "1999-12-31",
    });
    // Deliberately a hold that covers nothing recent: the reconciler's question is org-wide, because an
    // orphan cannot be attributed to a mailbox at all.
    expect(await anyActiveHold(testEnv, ORG)).toBe(true);
  });
});

describe("a draft in a held mailbox cannot be destroyed", () => {
  const composition = {
    mailboxId: HELD_MAILBOX,
    to: ["customer@example.net"],
    subject: "Container MSKU4471203",
    body: "half a sentence",
  };

  it("refuses the deletion, keeps the row, and records the attempt", async () => {
    const ctx = atTime(AUGUST_10);
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX, matterId: "mat_1" });

    await expect(deleteDraft(testEnv, ctx, ORG, ANA, saved.id)).rejects.toThrow(/E_LEGAL_HOLD/);

    const row = await testEnv.CATALOG.prepare("SELECT id FROM drafts WHERE id = ?").bind(saved.id).first();
    expect(row, "the row a refused deletion must leave alone").not.toBeNull();

    // An attempt to destroy held mail is evidence about the attempt. Discarding it would be the one
    // omission this mechanism exists to prevent.
    const blocked = await auditRows("hold.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.outcome).toBe("refused");
    expect(blocked[0]!.subject).toBe(saved.id);
    expect(JSON.parse(blocked[0]!.detail!)).toMatchObject({ kind: "draft", mailboxId: HELD_MAILBOX });
  });

  it("names the budget-shaped four parts in the refusal a person reads", async () => {
    const ctx = atTime(AUGUST_10);
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const error = await deleteDraft(testEnv, ctx, ORG, ANA, saved.id).catch((caught: Error) => caught);
    const message = (error as Error).message;
    // What, why, and the remedy — including the fact that the remedy does not exist yet, which is the
    // honest answer and better than a fix nobody can run.
    expect(message).toContain(hold.id);
    expect(message).toContain(HELD_MAILBOX);
    expect(message).toContain("hold.blocked");
    // The remedy, which now exists: the endpoint that asks for a lift, and the decision that says nobody
    // does it alone. This read "#61" while the honest fix was "there is no lift yet".
    expect(message).toContain("/lift");
    expect(message).toContain("#64");
  });

  it("deletes a draft in a mailbox no hold covers", async () => {
    const ctx = atTime(AUGUST_10);
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, { ...composition, mailboxId: FREE_MAILBOX });
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    expect(await deleteDraft(testEnv, ctx, ORG, ANA, saved.id)).toBe(true);
    expect(await auditRows("hold.blocked")).toHaveLength(0);
  });

  it("answers not-found for somebody else's draft without consulting a hold", async () => {
    // §5C keeps absent and invisible alike, and asking about the hold first would let a caller learn that a
    // draft exists in a held mailbox from the shape of the refusal.
    const ctx = atTime(AUGUST_10);
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    expect(await deleteDraft(testEnv, ctx, ORG, ADMIN, saved.id)).toBe(false);
    expect(await auditRows("hold.blocked")).toHaveLength(0);
  });

  it("does not cover a draft written outside the hold's window", async () => {
    const ctx = atTime(AUGUST_10);
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    await placeHold(testEnv, ctx, ORG, ADMIN, {
      mailboxId: HELD_MAILBOX, fromDate: "2026-09-01",
    });
    // The window is a statement about when the content happened, so a hold over September does not preserve
    // an August draft. Tested because the opposite — a window nothing narrows — would pass every other test
    // in this file.
    expect(await deleteDraft(testEnv, ctx, ORG, ANA, saved.id)).toBe(true);
  });
});

describe("merging away a held case", () => {
  it("refuses the whole merge and changes nothing", async () => {
    const ctx = atTime(AUGUST_10);
    const at = new Date(AUGUST_10).toISOString();
    const source = await conversationWithCases("<a@example.net>", [HELD_MAILBOX], at, ANA);
    const target = await conversationWithCases("<b@example.net>", [HELD_MAILBOX], at, ANA);
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    await expect(mergeConversations(testEnv, ctx, ORG, ANA, source, target)).rejects.toThrow(/E_LEGAL_HOLD/);

    // All-or-nothing, which is the rule this function already has for a contested pair: a partially merged
    // conversation is not a thing, and a hold on one mailbox must not produce one.
    expect(await caseCount(source)).toBe(1);
    const row = await testEnv.CATALOG.prepare("SELECT merged_into FROM conversations WHERE id = ?")
      .bind(source).first<{ merged_into: string | null }>();
    expect(row?.merged_into).toBeNull();
    expect(await auditRows("conversation.merged")).toHaveLength(0);
    expect(await auditRows("hold.blocked")).toHaveLength(1);
  });

  it("merges when the source case is repointed rather than deleted", async () => {
    // Only the pairs where **both** sides have a case reach the delete. Where only the source has one it is
    // repointed, which destroys nothing — so a hold must not refuse it, or a hold would stop merges having
    // nothing to do with destruction.
    const ctx = atTime(AUGUST_10);
    const at = new Date(AUGUST_10).toISOString();
    const source = await conversationWithCases("<c@example.net>", [HELD_MAILBOX], at, ANA);
    const target = await conversationWithCases("<d@example.net>", [FREE_MAILBOX], at, ANA);
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const outcome = await mergeConversations(testEnv, ctx, ORG, ANA, source, target);
    expect(outcome.merged).toBe(true);
    expect(await auditRows("hold.blocked")).toHaveLength(0);
  });

  it("merges once no hold covers the mailbox", async () => {
    const ctx = atTime(AUGUST_10);
    const at = new Date(AUGUST_10).toISOString();
    const source = await conversationWithCases("<e@example.net>", [FREE_MAILBOX], at, ANA);
    const target = await conversationWithCases("<f@example.net>", [FREE_MAILBOX], at, ANA);
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const outcome = await mergeConversations(testEnv, ctx, ORG, ANA, source, target);
    expect(outcome.merged).toBe(true);
    expect(await caseCount(source)).toBe(0);
  });
});


describe("lifting a hold takes two people, a reason, and somebody who did not ask", () => {
  const composition = {
    mailboxId: HELD_MAILBOX,
    to: ["customer@example.net"],
    subject: "Container MSKU4471203",
    body: "half a sentence",
  };

  it("refuses an empty reason, and writes nothing at all", async () => {
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    for (const blank of ["", "   "]) {
      await expect(requestHoldLift(testEnv, atTime(AUGUST_10), ORG, ADMIN, hold.id, blank))
        .rejects.toThrow(/E_HOLD_LIFT_REASON_REQUIRED/);
    }
    // A whitespace reason is the case NOT NULL cannot catch, which is why the refusal is in the code and
    // this test uses both. Nothing written: no request, no approval, no entry.
    const lifts = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM hold_lifts").first<{ n: number }>();
    expect(lifts?.n).toBe(0);
    const approvals = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>();
    expect(approvals?.n).toBe(0);
    expect(await auditRows("approval.requested")).toHaveLength(0);
  });

  it("refuses anybody who does not hold org.admin", async () => {
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    await expect(requestHoldLift(testEnv, atTime(AUGUST_10), ORG, ANA, hold.id, REASON))
      .rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
  });

  it("opens one stage of two, and one approval is not enough", async () => {
    const ctx = atTime(AUGUST_10);
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const lift = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, REASON);
    expect(lift.stages).toEqual([stageOf(2)]);
    // Two of the three people on this mailbox hold approval.decide, and the requester is not one of them.
    expect(lift.eligible).toBe(2);

    const first = await decideApproval(testEnv, ctx, ORG, ANA, lift.approvalId, "approve");
    expect(first.completed).toBe(false);
    expect(first.holdLifted).toBe(false);
    expect(first.openStage).toBe(1);

    // **The hold is still in force**, which is the whole assertion: one person cannot lift it, and the proof
    // is the deletion still being refused rather than the approval row still saying pending.
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, new Date(AUGUST_10).toISOString()))
      .toHaveLength(1);
    await expect(deleteDraft(testEnv, ctx, ORG, ANA, saved.id)).rejects.toThrow(/E_LEGAL_HOLD/);
    expect((await holdRow(hold.id))?.lifted_at).toBeNull();
    expect(await auditRows("hold.lifted")).toHaveLength(0);
  });

  it("refuses the requester's own decision, so no administrator lifts a hold alone", async () => {
    const ctx = atTime(AUGUST_10);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    // The administrator holds approval.decide on this mailbox as well, so nothing but the actor exclusion
    // stands between them and lifting their own request — which is exactly the case #64 cares about.
    await tuple(ADMIN, "approval.decide", "mailbox", HELD_MAILBOX);
    const lift = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, REASON);

    await expect(decideApproval(testEnv, ctx, ORG, ADMIN, lift.approvalId, "approve"))
      .rejects.toThrow(/E_APPROVER_IS_ACTOR/);
    // And a denial is refused too: the requester does not get to record a judgement on their own request in
    // either direction.
    await expect(decideApproval(testEnv, ctx, ORG, ADMIN, lift.approvalId, "deny"))
      .rejects.toThrow(/E_APPROVER_IS_ACTOR/);
    expect((await holdRow(hold.id))?.lifted_at).toBeNull();
  });

  it("refuses a lift when fewer than two other people could approve it", async () => {
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ? AND relation = 'approval.decide'",
    ).bind(ORG, BEN).run();
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const error = await requestHoldLift(testEnv, atTime(AUGUST_10), ORG, ADMIN, hold.id, REASON)
      .catch((caught: unknown) => caught);
    // Asserted to have thrown *before* reading the message, so a request that was wrongly accepted fails with
    // "a lift was opened that nobody could complete" rather than with a complaint about `undefined`.
    expect(error, "a lift was opened that nobody could complete").toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("E_HOLD_LIFT_UNSATISFIABLE");
    // The shortfall, named: which stage, how many short, and how many are eligible. An agent can act on this.
    expect(message).toContain("stage 1 needs 2 distinct approver(s)");
    expect(message).toContain("approval.decide");
    // Refused before anything is written, so there is no request sitting in a queue nobody can clear.
    const lifts = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM hold_lifts").first<{ n: number }>();
    expect(lifts?.n).toBe(0);
  });

  it("lifts on the second approval, and the refused deletion then succeeds", async () => {
    const ctx = atTime(AUGUST_10);
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    // Before: refused. This is the observable the whole mechanism exists for, so it is the observable the
    // lift is measured against — not `coveringHolds` returning a shorter array.
    await expect(deleteDraft(testEnv, ctx, ORG, ANA, saved.id)).rejects.toThrow(/E_LEGAL_HOLD/);

    const lift = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, REASON);
    await decideApproval(testEnv, ctx, ORG, ANA, lift.approvalId, "approve");
    const closing = await decideApproval(testEnv, ctx, ORG, BEN, lift.approvalId, "approve");
    expect(closing.completed).toBe(true);
    expect(closing.holdLifted).toBe(true);
    expect(closing.subjectKind).toBe("hold_lift");
    // A lift has no manifest, so the field that would name one is absent rather than filled with a word that
    // is not true of it.
    expect(closing.manifestState).toBeUndefined();

    // After: the predicate stops covering, and the deletion goes through.
    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, new Date(AUGUST_10).toISOString()))
      .toHaveLength(0);
    expect(await deleteDraft(testEnv, ctx, ORG, ANA, saved.id)).toBe(true);

    // The row says what happened and why, without a join: lifted, with the reason and the request that did it.
    const row = await holdRow(hold.id);
    expect(row?.lifted_at).not.toBeNull();
    expect(row?.lifted_reason).toBe(REASON);
    expect(row?.lift_id).toBe(lift.liftId);
  });

  it("records hold.lifted with the reason and both approvers, in the same transaction as the row", async () => {
    const lifted = await liftedHold();
    const entries = await auditRows("hold.lifted");
    expect(entries).toHaveLength(1);
    // The hold is the subject, so `hold.placed` and `hold.lifted` line up for a reader filtering one hold.
    expect(entries[0]!.subject).toBe(lifted.id);
    expect(entries[0]!.outcome).toBe("ok");
    const detail = JSON.parse(entries[0]!.detail!) as Record<string, unknown>;
    expect(detail.reason).toBe(REASON);
    expect(detail.requestedBy).toBe(ADMIN);
    expect(detail.liftId).toBe(lifted.liftId);
    expect(detail.approvalId).toBe(lifted.approvalId);
    // Dual control is only evidence if the trail says who the two were. The eligible set is live and cannot
    // be reconstructed from the tuples as they stand later.
    expect(detail.approvedBy).toEqual([ANA, BEN]);

    // Two entries in one batch — `approval.decided` and `hold.lifted` — chain to each other rather than both
    // to the tip, and verification is the only real check of that.
    expect(await verifyChain(testEnv, ORG)).toMatchObject({ intact: true, brokenAt: null });
  });

  it("shows the approvers the reason before they decide, in the queue they read", async () => {
    const ctx = atTime(AUGUST_10);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const lift = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, REASON);

    const queue = await pendingApprovals(testEnv, ORG, ANA);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.subjectKind).toBe("hold_lift");
    expect(queue[0]!.subjectId).toBe(lift.liftId);
    // The reason where a reader meets it. Somebody asked to re-permit destruction has to see what they are
    // agreeing to, and the audit trail is where a decision is accounted for afterwards rather than before.
    expect(queue[0]!.reason).toBe(REASON);
    expect(queue[0]!.stages).toEqual([stageOf(2)]);

    // And not in the requester's own queue, because they cannot decide it.
    expect(await pendingApprovals(testEnv, ORG, ADMIN)).toEqual([]);
  });

  it("keeps the hold when the lift is denied, and lets a fresh request be made", async () => {
    const ctx = atTime(AUGUST_10);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const first = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, "wrong mailbox, I think");
    const denial = await decideApproval(testEnv, ctx, ORG, ANA, first.approvalId, "deny");
    expect(denial.approvalState).toBe("denied");
    expect((await holdRow(hold.id))?.lifted_at, "a denied lift leaves the hold exactly as it was").toBeNull();
    expect(await auditRows("hold.lifted")).toHaveLength(0);

    // Asking again is possible, which is why the subject of a lift approval is the request and not the hold:
    // a denial that made a hold permanent would be #64's trap arriving through the schema.
    const second = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, REASON);
    expect(second.liftId).not.toBe(first.liftId);
    await decideApproval(testEnv, ctx, ORG, ANA, second.approvalId, "approve");
    await decideApproval(testEnv, ctx, ORG, BEN, second.approvalId, "approve");
    expect((await holdRow(hold.id))?.lift_id).toBe(second.liftId);
  });

  it("allows one open question per hold, and refuses a second while it stands", async () => {
    const ctx = atTime(AUGUST_10);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, REASON);

    const error = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, "another reason")
      .catch((caught: unknown) => caught);
    expect(error, "a second lift request was accepted on a hold that already has one").toBeInstanceOf(Error);
    expect((error as Error).message).toContain("E_HOLD_LIFT_PENDING");
    // Enforced by the predicate every statement carries rather than by a read beforehand, so this exercises
    // the thing that also settles two simultaneous requests.
    const lifts = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM hold_lifts").first<{ n: number }>();
    expect(lifts?.n).toBe(1);
  });

  it("refuses a lift of a hold that is already lifted", async () => {
    const lifted = await liftedHold();
    const error = await requestHoldLift(testEnv, atTime(AUGUST_10), ORG, ADMIN, lifted.id, REASON)
      .catch((caught: unknown) => caught);
    expect(error, "a lift was opened on a hold that is already lifted").toBeInstanceOf(Error);
    expect((error as Error).message).toContain("E_HOLD_ALREADY_LIFTED");
    // One lift, one entry: nothing lifted this hold twice.
    expect(await auditRows("hold.lifted")).toHaveLength(1);
  });

  it("refuses a lift of a hold that does not exist", async () => {
    await expect(requestHoldLift(testEnv, atTime(AUGUST_10), ORG, ADMIN, "hld_nope", REASON))
      .rejects.toThrow(/E_NO_HOLD/);
  });

  it("lifts one hold and leaves another over the same mailbox covering", async () => {
    // Two holds, two matters, one mailbox — the ordinary shape when a second matter arrives. Lifting one must
    // not release the mail, which is what makes coverage a question about the *set* of holds.
    const ctx = atTime(AUGUST_10);
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    const first = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX, matterId: "mat_a" });
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX, matterId: "mat_b" });

    const lift = await requestHoldLift(testEnv, ctx, ORG, ADMIN, first.id, REASON);
    await decideApproval(testEnv, ctx, ORG, ANA, lift.approvalId, "approve");
    await decideApproval(testEnv, ctx, ORG, BEN, lift.approvalId, "approve");

    expect(await coveringHolds(testEnv, ORG, HELD_MAILBOX, new Date(AUGUST_10).toISOString()))
      .toHaveLength(1);
    await expect(deleteDraft(testEnv, ctx, ORG, ANA, saved.id)).rejects.toThrow(/E_LEGAL_HOLD/);
  });

  it("refuses the completing decision when the hold went out from under it, recording nothing", async () => {
    /*
     * `E_HOLD_LIFT_RACED` is the one refusal in this module that is a decision **not recorded**, and the
     * asymmetry is deliberate: `auditedBatchMany` gates a batch rather than an entry, so under the ordinary
     * `pending` predicate this transaction would insert a `hold.lifted` entry for a lift that did not happen —
     * a false statement in the one place that is supposed to be checkable.
     *
     * The interleaving inside the product is not constructible from a single isolate. This is the *other* way
     * into the same state, and it is the one that is actually reachable: a hold lifted outside the product,
     * through `wrangler d1 execute` or the dashboard, which this module's header already names as the boundary
     * the whole hold mechanism has. So the refusal is exercised rather than declared and left to a comment.
     */
    const ctx = atTime(AUGUST_10);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const lift = await requestHoldLift(testEnv, ctx, ORG, ADMIN, hold.id, REASON);
    await decideApproval(testEnv, ctx, ORG, ANA, lift.approvalId, "approve");

    await testEnv.CATALOG.prepare("UPDATE holds SET lifted_at = ? WHERE org_id = ? AND id = ?")
      .bind(new Date(AUGUST_10).toISOString(), ORG, hold.id).run();

    const error = await decideApproval(testEnv, ctx, ORG, BEN, lift.approvalId, "approve")
      .catch((caught: unknown) => caught);
    // Asserted to have thrown before the message is read, so a decision that was wrongly recorded fails with
    // the sentence below rather than with a complaint about `undefined`.
    expect(error, "the completing decision was accepted against a hold that had already gone").toBeInstanceOf(Error);
    expect((error as Error).message).toContain("E_HOLD_LIFT_RACED");

    // Nothing recorded, which is the whole point: no `hold.lifted` claiming a lift this decision did not
    // perform, and no second `approval.decided` either — they share one gate, so they are one act.
    expect(await auditRows("hold.lifted")).toHaveLength(0);
    expect(await auditRows("approval.decided")).toHaveLength(1);
    const decisions = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM approval_decisions WHERE approval_id = ?",
    ).bind(lift.approvalId).first<{ n: number }>();
    expect(decisions?.n, "a decision row was written for a refused decision").toBe(1);
    // And the chain is still contiguous, because a skipped insert consumes no sequence number.
    expect(await verifyChain(testEnv, ORG)).toMatchObject({ intact: true, brokenAt: null });
  });
});

describe("orphan collection is suppressed org-wide while any hold stands", () => {
  /** Past the grace window, so a delivery mid-write is not what is being judged. */
  function afterTheGraceWindow(): Ctx {
    return atTime(Date.now() + (BUDGETS["reconcile.orphan_grace_seconds"] + 60) * 1000);
  }

  async function anOrphan(): Promise<string> {
    const stored = await putEvidence(testEnv, `${ORG}/raw/msg_orphan.eml`, utf8("a message with no receipt"));
    return stored.blobKey;
  }

  it("enumerates the orphan and leaves it in place", async () => {
    const ctx = afterTheGraceWindow();
    const key = await anOrphan();
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.orphans.map((orphan) => orphan.blobKey)).toContain(key);
    expect(report.orphansDeleted, "a suppressed pass deletes nothing").toBe(0);
    expect(report.collection).toEqual({ requested: true, suppressed: true });
    expect(await testEnv.EVIDENCE.head(key), "the bytes a hold protects").not.toBeNull();
  });

  it("says so in the text form, because suppression nobody can see looks like a broken reconciler", async () => {
    const ctx = afterTheGraceWindow();
    await anOrphan();
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const text = formatReconcile(await reconcileEvidence(testEnv, ctx, ORG, { collect: true }));
    expect(text).toContain("HELD");
    expect(text).toContain("not collected");
  });

  it("collects when nothing is held, so the suppression is the hold and not the code path", async () => {
    const ctx = afterTheGraceWindow();
    const key = await anOrphan();

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.orphansDeleted).toBe(1);
    expect(report.collection).toEqual({ requested: true, suppressed: false });
    expect(await testEnv.EVIDENCE.head(key)).toBeNull();
  });

  it("suppresses on a hold over an unrelated mailbox, which is the org-wide part", async () => {
    // An orphan is unattributable **by definition** — the pass finds it because its receipt is missing — so
    // nothing can establish which mailbox it belonged to and nothing can prove it is not responsive. A
    // per-hold check here is not expensive, it is unimplementable.
    const ctx = afterTheGraceWindow();
    const key = await anOrphan();
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: FREE_MAILBOX });

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.orphansDeleted).toBe(0);
    expect(await testEnv.EVIDENCE.head(key)).not.toBeNull();
  });

  it("collects again once the last hold is lifted, which is the inverse of #64's own defect", async () => {
    // **A lift is not a delete, and this is the assertion that says so.** Lifting every hold while collection
    // stayed suppressed would leave a reconciler that never collects again and nothing saying why — the
    // mirror image of the defect #64 was written to prevent, and invisible without this test, because a
    // suppressed pass and a clean pass both report "0 deleted" until you look at `collection`.
    const ctx = afterTheGraceWindow();
    const key = await anOrphan();
    const lifted = await liftedHold();

    expect(await anyActiveHold(testEnv, ORG), "the last hold is lifted, so nothing is active").toBe(false);
    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.collection).toEqual({ requested: true, suppressed: false });
    expect(report.orphansDeleted).toBe(1);
    expect(await testEnv.EVIDENCE.head(key), "the bytes a lifted hold no longer protects").toBeNull();
    // And the row is still there: what was preserved, and why it stopped being, is not destroyed by lifting.
    expect((await holdRow(lifted.id))?.lifted_reason).toBe(REASON);
  });

  it("stays suppressed while one of two holds is lifted", async () => {
    // Org-wide means the *set*: lifting one hold does not answer the question the other one is asking.
    const ctx = afterTheGraceWindow();
    const key = await anOrphan();
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: FREE_MAILBOX });
    await liftedHold();

    expect(await anyActiveHold(testEnv, ORG)).toBe(true);
    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.collection).toEqual({ requested: true, suppressed: true });
    expect(await testEnv.EVIDENCE.head(key)).not.toBeNull();
  });

  it("spends no query on holds when collection was not requested, which is doctor's mode", async () => {
    const ctx = afterTheGraceWindow();
    await anOrphan();
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const report = await reconcileEvidence(testEnv, ctx, ORG);
    // `suppressed: false` alongside `requested: false` is why both fields exist: a read-only pass has not
    // asked, so it cannot report that nothing was in the way.
    expect(report.collection).toEqual({ requested: false, suppressed: false });
  });

  it("does not let the text form claim nothing suppresses collection when it never asked", async () => {
    // The defect this asserts against was live and measured: with a hold standing, the read-only pass — the
    // one `doctor` runs — printed "collection was not requested; nothing suppresses it". The second clause
    // was false, and it was false in the permissive direction, telling an operator the collector is clear
    // while a hold stands. `requested` exists in the report to prevent exactly that misreading, so the text
    // projection of the report may not commit the misreading itself.
    const ctx = afterTheGraceWindow();
    await anOrphan();
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const text = formatReconcile(await reconcileEvidence(testEnv, ctx, ORG));
    expect(text).toContain("collection was not requested");
    expect(text).toContain("does not know whether a hold stands");
    // The words the old line used to assert. Kept as a literal, because the failure was a sentence rather
    // than a value and only the sentence can be checked.
    expect(text).not.toContain("nothing suppresses it");

    // And the other branch still says the thing it did earn, so this is not a check that any vague line
    // satisfies: asking for collection *does* consult a hold, so it may state the answer.
    const asked = formatReconcile(await reconcileEvidence(testEnv, ctx, ORG, { collect: true }));
    expect(asked).toContain("HELD");
  });
});

describe("doctor reports what is held, and whether anybody could lift it", () => {
  it("gives every hold's scope and age, without degrading the verdict", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, {
      mailboxId: HELD_MAILBOX, matterId: "mat_acme", fromDate: "2026-08-01",
    });
    // Ten days after it was placed.
    const report = await runDoctor(testEnv, atTime(AUGUST_10 + 10 * 24 * 60 * 60 * 1000));
    const finding = find(report.findings, "legal_holds_active");

    expect(finding.severity, "a hold is a normal state of a governed Node").toBe("report");
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain("1 legal hold(s) in force");
    expect(finding.detail).toContain(HELD_MAILBOX);
    expect(finding.detail).toContain("2026-08-01");
    expect(finding.detail).toContain("mat_acme");
    expect(finding.detail).toContain("10 day(s) ago");
    // And it says why collection stopped, because suppression that cannot be seen is indistinguishable from
    // a reconciler that has stopped working.
    expect(finding.detail).toContain("suppressed");
    // Two people hold approval.decide here, so the hold is liftable and no hold finding degrades anything.
    // The *verdict* is not asserted: this fixture has no signing key, so the run is already `degraded` for a
    // reason that has nothing to do with holds — and a test that pinned it would be asserting that.
    expect(report.findings.some((f) => f.check === "legal_hold_unliftable")).toBe(false);
    expect(report.findings.filter((f) => !f.ok).map((f) => f.check)).not.toContain("legal_hold_unliftable");
  });

  it("says plainly when nothing is held", async () => {
    const finding = find((await runDoctor(testEnv, atTime(AUGUST_10))).findings, "legal_holds_active");
    // A check that vanishes when clean cannot be told apart from a check that is not there.
    expect(finding.detail).toContain("No legal hold is in force");
  });

  it("stops reporting a hold once it is lifted, and says nothing is held", async () => {
    const hold = await liftedHold();
    const finding = find((await runDoctor(testEnv, atTime(AUGUST_10))).findings, "legal_holds_active");
    expect(finding.detail).toContain("No legal hold is in force");
    expect(JSON.stringify(finding)).not.toContain(hold.id);
  });

  it("names a pending lift, with the reason it was asked for", async () => {
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    await requestHoldLift(testEnv, atTime(AUGUST_10), ORG, ADMIN, hold.id, "matter 41 closed on 9 August");

    const report = await runDoctor(testEnv, atTime(AUGUST_10));
    const finding = find(report.findings, "legal_hold_lift_pending");
    expect(finding.severity, "being asked to decide is not a fault").toBe("report");
    expect(finding.ok).toBe(true);
    expect(finding.detail).toContain(hold.id);
    // The reason, in the report. An operator reading doctor should not have to open the audit trail to find
    // out why somebody wants preservation to stop.
    expect(finding.detail).toContain("matter 41 closed on 9 August");
    expect(finding.detail).toContain(ADMIN);
    // And the hold is still in force while the request is open, which is the sentence that stops a reader
    // treating a pending lift as a lifted one.
    expect(finding.detail).toContain("still in force");
    expect(find(report.findings, "legal_holds_active").detail).toContain("1 legal hold(s) in force");
  });

  it("raises no pending-lift finding when nobody has asked", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const report = await runDoctor(testEnv, atTime(AUGUST_10));
    expect(report.findings.some((f) => f.check === "legal_hold_lift_pending")).toBe(false);
  });

  it("degrades on a hold nobody could lift, which is #64's operational trap made visible", async () => {
    // One approver is not two, and the requester is excluded — so this hold is permanent until somebody is
    // granted the relation. Reported *before* an administrator discovers it by being refused.
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ? AND relation = 'approval.decide'",
    ).bind(ORG, BEN).run();
    const hold = await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const report = await runDoctor(testEnv, atTime(AUGUST_10));
    const finding = find(report.findings, "legal_hold_unliftable");
    expect(finding.severity).toBe("degraded");
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain(hold.id);
    expect(finding.detail).toContain("1 person(s) hold approval.decide");
    // Not a preservation failure, and it says so: the failure direction is over-holding.
    expect(finding.detail).toContain("Preservation is unaffected");
    // A fix somebody can run, which is what separates this from a permanent WARN nobody can clear.
    expect(finding.fix).toContain("approval.decide");
    expect(report.verdict).toBe("degraded");
  });

  it("raises no unliftable finding for a lifted hold, because there is nothing left to lift", async () => {
    // Lifted while two people could approve, and one of them revoked afterwards. A finding here would be a
    // warning that a hold enforcing nothing cannot be released — true, and useless.
    await liftedHold();
    await testEnv.CATALOG.prepare(
      "DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ? AND relation = 'approval.decide'",
    ).bind(ORG, BEN).run();
    const report = await runDoctor(testEnv, atTime(AUGUST_10));
    expect(report.findings.some((f) => f.check === "legal_hold_unliftable")).toBe(false);
  });

  it("has dropped the lift-path gap, because the gap is closed", async () => {
    // The finding said "there is no way to lift a legal hold on this Node". That sentence is now false, and a
    // check kept alive by rewriting it into "lifting works" would be a check that always passes and tells an
    // operator nothing. This asserts the *absence* deliberately, so nobody reinstates it by copying the old
    // test — and `test/node/doctor-check-names.test.ts` catches any `fix:` still pointing at the name.
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const report = await runDoctor(testEnv, atTime(AUGUST_10));
    expect(report.findings.some((f) => f.check === "legal_hold_lift_path")).toBe(false);
    expect(JSON.stringify(report)).not.toContain("no way to lift");
  });

  it("keeps every mailbox id out of the reduced report, which now carries no hold finding at all", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const reduced = withoutDataFindings(await runDoctor(testEnv, atTime(AUGUST_10)));

    // Every hold finding discloses `data` now that the one `infrastructure` one is gone, so an
    // unauthenticated reader learns nothing about holds — including whether any exist, which is the property
    // the old finding had to be written carefully to preserve.
    expect(reduced.findings.some((f) => f.check.startsWith("legal_hold"))).toBe(false);
    expect(JSON.stringify(reduced)).not.toContain(HELD_MAILBOX);
  });

  it("degrades on a hold whose mailbox no longer exists, because it enforces nothing", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    // Not reachable through the product: placing refuses an absent mailbox and nothing deletes one. This is
    // the state a restore, or a hand-edited database, leaves behind — and it reports as active while
    // preserving nothing, which is the one thing a hold may not do.
    await testEnv.CATALOG.prepare("DELETE FROM mailboxes WHERE id = ?").bind(HELD_MAILBOX).run();

    const report = await runDoctor(testEnv, atTime(AUGUST_10));
    const finding = find(report.findings, "legal_hold_mailbox_missing");
    expect(finding.severity).toBe("degraded");
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("enforce nothing");
    // The fix used to point at the lift path that did not exist. It now points at the finding that says
    // whether this hold can be lifted at all, which is the next thing a reader needs.
    expect(finding.fix).toContain("legal_hold_unliftable");
    expect(report.verdict).toBe("degraded");
  });

  it("raises no missing-mailbox finding while every hold names a live mailbox", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const report = await runDoctor(testEnv, atTime(AUGUST_10));
    expect(report.findings.some((f) => f.check === "legal_hold_mailbox_missing")).toBe(false);
  });

  it("costs the same for three holds as for one, which is the per-run/per-row distinction", async () => {
    // The distinction `doctor-check-cost.md`'s `stale_when` cares about. Three holds, and the run costs what
    // one hold costs — which is what makes `doctor.max_subrequests_per_run` still mean something.
    //
    // **One hold versus three, not zero versus three**, and the change is deliberate: the eligibility query
    // behind `legal_hold_unliftable` is spent only when a hold is in force, so a Node with no holds pays one
    // query less. Comparing against zero would have made this test fail for the right reason with the wrong
    // message — and its own name always said "one".
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX, matterId: "mat_first" });
    const one = await runDoctor(testEnv, atTime(AUGUST_10));
    for (const matter of ["mat_a", "mat_b", "mat_c"]) {
      await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX, matterId: matter });
    }
    const three = await runDoctor(testEnv, atTime(AUGUST_10));
    expect(three.cost.d1Queries).toBe(one.cost.d1Queries);
    expect(three.cost.subrequests).toBeLessThanOrEqual(BUDGETS["doctor.max_subrequests_per_run"]);
  });

  it("spends nothing on eligibility when no hold is in force", async () => {
    // The other half of the same sizing claim, and the reason the comparison above starts at one hold: a
    // clean Node does not pay for a question about holds it does not have. Measured off the run rather than
    // argued, the way `doctor-check-cost.md`'s corrections are taken.
    const clean = await runDoctor(testEnv, atTime(AUGUST_10));
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const held = await runDoctor(testEnv, atTime(AUGUST_10));
    expect(held.cost.d1Queries).toBe(clean.cost.d1Queries + 1);
  });
});
