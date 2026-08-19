import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { utf8 } from "@mailda/evidence";

import { conversationForDelivery } from "../src/conversations.ts";
import { deleteDraft, saveDraft } from "../src/drafts.ts";
import { runDoctor, withoutDataFindings, type Finding } from "../src/doctor.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { anyActiveHold, coveringHolds, placeHold } from "../src/holds.ts";
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
 * ## What it deliberately does not test
 *
 * Lifting, expiry, and "the matter closed" — **none of them exist**. #64 gave lifting dual approval and #61's
 * approval machinery is not built, so there is no lift path to test, and a test that invented one would be
 * asserting a decision this build contradicts. What is tested instead is that `doctor` *says* the path is
 * missing, and that nothing in `src/` can quietly remove a hold (see the closed-world file, which fails on an
 * undeclared `DELETE FROM holds` and on any `UPDATE holds`).
 */

const testEnv = env as unknown as Env;
const ORG = "org_hold";
const HELD_MAILBOX = "mbx_held";
const FREE_MAILBOX = "mbx_free";
const ADMIN = "usr_admin_h";
const ANA = "usr_ana_h";

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

beforeEach(async () => {
  for (const table of ["holds", "drafts", "cases", "conversations", "relationship_tuples", "mailboxes",
                       "audit_entries", "ingress_receipts", "node_claim"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/` });
  for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);

  const at = new Date(AUGUST_10).toISOString();
  for (const [id, name] of [[HELD_MAILBOX, "Support"], [FREE_MAILBOX, "Billing"]] as const) {
    await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(id, ORG, name, at).run();
  }
  await tuple(ADMIN, "org.admin", "organization", ORG);
  for (const user of [ADMIN, ANA]) {
    for (const mailbox of [HELD_MAILBOX, FREE_MAILBOX]) {
      await tuple(user, "mailbox.content.read", "mailbox", mailbox);
      await tuple(user, "send.propose", "mailbox", mailbox);
    }
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
    expect(message).toContain("#61");
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

describe("doctor reports what is held, and names the lift path it does not have", () => {
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
  });

  it("says plainly when nothing is held", async () => {
    const finding = find((await runDoctor(testEnv, atTime(AUGUST_10))).findings, "legal_holds_active");
    // A check that vanishes when clean cannot be told apart from a check that is not there.
    expect(finding.detail).toContain("No legal hold is in force");
  });

  it("names the missing lift path on every Node, held or not", async () => {
    for (const label of ["no hold", "one hold"]) {
      if (label === "one hold") {
        await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
      }
      const finding = find((await runDoctor(testEnv, atTime(AUGUST_10))).findings, "legal_hold_lift_path");
      expect(finding.detail, label).toContain("no way to lift");
      expect(finding.detail, label).toContain("#61");
      // `report` and `ok`, exactly like `workers_paid_plan`: a real gap that no operator action closes. As
      // `degraded` it would be a permanent WARN on every Node, and a check that always fails gets muted —
      // the failure mode this file's `DELIVERY_SILENCE_MS` comment names.
      expect(finding.severity, label).toBe("report");
      expect(finding.ok, label).toBe(true);
      // It must not vary with the hold count: it survives into the unauthenticated reduced report, so text
      // that moved when a hold was placed would leak that a hold exists.
      expect(JSON.stringify(finding), label).not.toContain(HELD_MAILBOX);
    }
  });

  it("keeps the lift-path gap in the reduced report and every mailbox id out of it", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const reduced = withoutDataFindings(await runDoctor(testEnv, atTime(AUGUST_10)));

    expect(reduced.findings.some((f) => f.check === "legal_hold_lift_path")).toBe(true);
    expect(reduced.findings.some((f) => f.check === "legal_holds_active")).toBe(false);
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
    expect(finding.fix).toContain("legal_hold_lift_path");
    expect(report.verdict).toBe("degraded");
  });

  it("raises no missing-mailbox finding while every hold names a live mailbox", async () => {
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX });
    const report = await runDoctor(testEnv, atTime(AUGUST_10));
    expect(report.findings.some((f) => f.check === "legal_hold_mailbox_missing")).toBe(false);
  });

  it("costs one fixed query, not one per hold", async () => {
    // The distinction `doctor-check-cost.md`'s `stale_when` cares about. Three holds, and the run costs what
    // one hold costs — which is what makes `doctor.max_subrequests_per_run` still mean something.
    const one = await runDoctor(testEnv, atTime(AUGUST_10));
    for (const matter of ["mat_a", "mat_b", "mat_c"]) {
      await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: HELD_MAILBOX, matterId: matter });
    }
    const three = await runDoctor(testEnv, atTime(AUGUST_10));
    expect(three.cost.d1Queries).toBe(one.cost.d1Queries);
    expect(three.cost.subrequests).toBeLessThanOrEqual(BUDGETS["doctor.max_subrequests_per_run"]);
  });
});
