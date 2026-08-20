import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { utf8 } from "@mailda/evidence";

import { clearKeyCache, currentSigningKey } from "../src/auth/keys.ts";
import { runDoctor, withoutDataFindings, type Finding } from "../src/doctor.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { placeHold } from "../src/holds.ts";
import { formatReconcile, reconcileEvidence, scanDraftBodies } from "../src/reconcile.ts";

/**
 * Draft bodies whose row is gone: counted, and now collected (#67).
 *
 * ## What was invisible
 *
 * A draft body is written to `${orgId}/drafts/{draftId}.txt`. `deleteDraft` issues one
 * `DELETE FROM drafts` and touches R2 not at all, and a draft is deleted when its message is **sealed** —
 * the ordinary path through the composer, not an exception. The reconciler's only listing was
 * `${orgId}/raw/`, and its `EVIDENCE.delete` is the one R2 delete in the Worker.
 *
 * So those objects were not collected late. They were **outside every scan**: no listing covered the
 * prefix, `reconcile` printed `0 orphans` while never having looked, and `doctor` had no figure that could
 * reveal them. The code and `application-shell.md` both said the object was *"left for the reconciler,
 * because ADR 32 makes an orphan blob collectable"* — true of ADR 32, false of this prefix. The same shape
 * as three of this month's defects: a claim in a comment with nothing enforcing it.
 *
 * ## What this file pins
 *
 * That the residue is **counted**, that it is **collected by the reconciler's existing pass** rather than by
 * a sweep of its own, that a live or mid-save draft's body is never accused or destroyed, that a legal hold
 * suppresses collection org-wide (#64), and that `doctor` reads the collector's own scan rather than
 * repeating the predicate — because two definitions of "which objects are stranded" that can disagree is
 * the defect this issue is about, one layer up.
 *
 * The delete itself is not tested here for *being the only one*: `test/node/content-deletion-world.test.ts`
 * owns that, and asserts it lexically.
 */

const testEnv = env as unknown as Env;
const ORG = "org_stranded";
const MAILBOX = "mbx_stranded";
const AUTHOR = "usr_stranded";
const ADMIN = "usr_stranded_admin";

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

/** Past the grace window, so a fresh autosave mid-write is not what is being counted. */
function afterTheGraceWindow(): Ctx {
  return atTime(Date.now() + (BUDGETS["reconcile.orphan_grace_seconds"] + 60) * 1000);
}

function find(findings: Finding[], check: string): Finding {
  const found = findings.find((finding) => finding.check === check);
  if (found === undefined) throw new Error(`no finding named ${check}`);
  return found;
}

/**
 * Exactly what `deleteDraft` leaves behind: the body object written by `saveDraft`, and no row.
 *
 * Written through `putEvidence` with the key `bodyKeyFor` produces, so the fixture is the real artifact
 * rather than a plausible-looking one — `putEvidence` writes the key verbatim, which is why the object
 * lands outside the reconciler's raw prefix in the first place.
 */
async function aSealedDraftsResidue(draftId: string): Promise<string> {
  const stored = await putEvidence(testEnv, `${ORG}/drafts/${draftId}.txt`, utf8("half a sentence"));
  return stored.blobKey;
}

/** An accepted-mail object with no receipt: the *other* referent rule, for telling the two counts apart. */
async function aRawOrphan(name: string): Promise<string> {
  const stored = await putEvidence(testEnv, `${ORG}/raw/${name}.eml`, utf8("From: a@b.com\r\n\r\nhi\r\n"));
  return stored.blobKey;
}

/**
 * The same Node with an `EVIDENCE` binding whose `list` refuses — the state a bucket that was never
 * created presents as. It is here to reach the *unreadable* branch, which is the branch that names the
 * prefix (and therefore the org id) in a detail a locked-out operator might be served.
 */
function withUnlistableEvidence(): Env {
  const evidence = new Proxy(testEnv.EVIDENCE, {
    get(target, property) {
      if (property === "list") return () => Promise.reject(new Error("no such bucket"));
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...testEnv, EVIDENCE: evidence } as Env;
}

/**
 * The same Node whose evidence listing reports itself truncated.
 *
 * Reaching truncation honestly would mean writing more objects than `reconcile.list_limit`, which is 200 —
 * expensive, and it would pin the test to a budget it is not about. The truncation *flag* is what the
 * detail string reads, so that is what this forces.
 */
function withTruncatedListing(): Env {
  const evidence = new Proxy(testEnv.EVIDENCE, {
    get(target, property) {
      if (property === "list") {
        return async (options: R2ListOptions) => {
          const real = await target.list(options);
          return { ...real, objects: real.objects, truncated: true, delimitedPrefixes: [] };
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...testEnv, EVIDENCE: evidence } as Env;
}

/**
 * The same Node whose `drafts` read refuses — the referent half of the scan rather than the listing half.
 *
 * It matters because the two halves fail for different reasons in the world (an absent bucket, an
 * unmigrated catalog) and both have to end in a report that says *the prefix was not read* rather than in a
 * zero. A zero is what the single-prefix report used to print for a prefix nobody had looked at.
 */
function withUnreadableDrafts(): Env {
  const catalog = new Proxy(testEnv.CATALOG, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("FROM drafts")) return statement;
          return new Proxy(statement, {
            get(stmtTarget, stmtProperty) {
              if (stmtProperty === "bind") {
                return () => ({ all: () => Promise.reject(new Error("no such table: drafts")) });
              }
              const value = Reflect.get(stmtTarget, stmtProperty) as unknown;
              return typeof value === "function"
                ? (value as (...a: unknown[]) => unknown).bind(stmtTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...testEnv, CATALOG: catalog } as Env;
}

/** The same Node, recording every prefix `list()` was called with, so a second listing is countable. */
function withListingLog(log: string[]): Env {
  const evidence = new Proxy(testEnv.EVIDENCE, {
    get(target, property) {
      if (property === "list") {
        return (options?: R2ListOptions) => {
          log.push(options?.prefix ?? "(no prefix)");
          return target.list(options);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...testEnv, EVIDENCE: evidence } as Env;
}

/** A draft somebody is still writing: body object **and** the row that references it. */
async function aLiveDraft(ctx: Ctx, draftId: string): Promise<string> {
  const stored = await putEvidence(testEnv, `${ORG}/drafts/${draftId}.txt`, utf8("still typing"));
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.prepare(
    `INSERT INTO drafts (id, org_id, mailbox_id, author_user_id, in_reply_to_message_id,
                         to_addresses, cc_addresses, bcc_addresses, subject,
                         body_key, body_sha256, body_bytes, created_at, updated_at)
     VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
  ).bind(draftId, ORG, MAILBOX, AUTHOR, '["c@example.net"]', "[]", "[]", "hello",
    stored.blobKey, stored.plaintextSha256, 12, at, at).run();
  return stored.blobKey;
}

beforeEach(async () => {
  for (const table of ["drafts", "ingress_receipts", "node_claim", "mailboxes", "holds",
                       "relationship_tuples", "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/` });
  for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);

  const at = new Date(Date.now()).toISOString();
  await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
    .bind(MAILBOX, ORG, "Support", at).run();
  // `placeHold` is `org.admin` only, and the suppression cases below place a real hold rather than
  // inserting a row: the closed world requires `INSERT INTO holds` to live in `src/holds.ts` alone, and a
  // fixture that wrote the table directly would be testing suppression against a bound nothing normalised.
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind("rt_stranded_admin", ORG, ADMIN, "org.admin", "organization", ORG, at).run();
  // Claimed: the draft prefix is scoped to an organization, so an unclaimed Node has none to check.
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, org_id, claimed_at) VALUES (1, ?, ?, ?)",
  ).bind("unused-in-this-test", ORG, at).run();
});

describe("doctor counts draft bodies whose drafts row is gone", () => {
  it("counts a body whose draft row is gone", async () => {
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.ok, "a body with no drafts row is residue and must be reported").toBe(false);
    expect(finding.detail).toContain("1 draft body object(s) have no drafts row");
    expect(finding.detail).toContain(`${ORG}/drafts/`);
  });

  it("reports the residue without degrading the verdict, because residue is not a fault", async () => {
    // The severity argument was **re-made** for #67 and came out the same way, which is why this test kept
    // its shape. Collection runs on `?collect=1` and nowhere else — there is no cron — so a Node that has
    // sent one message from the composer and has not been swept since has residue and is healthy.
    // `degraded` would put a permanent WARN on the ordinary state of the product, and it would be
    // unclosable under a hold, where collection is refused on purpose. `DELIVERY_SILENCE_MS` names that
    // failure mode in the same file: a false alarm gets a check muted.
    const ctx = afterTheGraceWindow();
    // Otherwise-healthy: the stranded finding must be the *only* failure, or this proves nothing about
    // which finding moved the verdict.
    await testEnv.CATALOG.prepare("DELETE FROM signing_keys").run();
    clearKeyCache();
    await currentSigningKey(testEnv, createSystemCtx());
    await aSealedDraftsResidue("dft_sealed");

    const report = await runDoctor(testEnv, ctx);
    expect(report.findings.filter((f) => !f.ok).map((f) => f.check)).toEqual(["draft_bodies_stranded"]);
    expect(report.verdict, "a failing `report` finding is not a degraded Node").toBe("ok");
    expect(find(report.findings, "draft_bodies_stranded").severity).toBe("report");
  });

  it("keeps every org id out of the unauthenticated reduced report, on the unreadable branch too", async () => {
    // `withoutDataFindings` keeps every `infrastructure` finding, and `/api/doctor` serves that reduced
    // report with no authentication when the Node cannot authenticate anyone. `discloses:
    // "infrastructure"` promises names already public in this repository; the prefix this check names is
    // the org id, so no branch of it may claim that.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const cases = [
      ["scan complete", testEnv],
      // Both halves of the scan, not one: the listing and the referent query fail for different reasons.
      ["listing refuses", withUnlistableEvidence()],
      ["drafts read refuses", withUnreadableDrafts()],
    ] as const;
    for (const [label, nodeEnv] of cases) {
      const report = await runDoctor(nodeEnv, ctx);
      // The branch under test really was reached, rather than the assertion passing by absence.
      expect(find(report.findings, "draft_bodies_stranded").ok, label).toBe(false);

      const reduced = withoutDataFindings(report);
      expect(JSON.stringify(reduced), label).not.toContain(ORG);
      expect(reduced.findings.some((f) => f.check === "draft_bodies_stranded"), label).toBe(false);
    }
  });

  it("says why residue exists now that something can collect it, and gives the command", async () => {
    // The wording is the point of the finding, and it is the wording that had gone stale. "Not collectable
    // orphans / no code path can collect them" was the true statement before #67 and is false after it:
    // residue now means the collector has not run, or a hold is suppressing it. A `fix` that still read
    // "nothing to run yet" would be the same defect this issue is about, pointing the other way.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.detail).toContain("the collector has not run or a legal hold is suppressing it");
    expect(finding.detail, "the old claim, which the collector made false")
      .not.toContain("no code path can collect");
    expect(finding.fix, "a finding a person can act on has to say the act").toBeTruthy();
    expect(finding.fix).toContain("/api/maintenance/reconcile?collect=1");
    // And the hold caveat, unconditional because this finding spends no query and so cannot know.
    expect(finding.fix).toContain("legal hold");
    expect(finding.fix, "the old deferral, which no longer describes anything")
      .not.toContain("nothing to run yet");
  });

  it("counts one residue per stranded object rather than reporting a boolean", async () => {
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_one");
    await aSealedDraftsResidue("dft_two");
    await aSealedDraftsResidue("dft_three");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.detail).toContain("3 draft body object(s)");
  });

  it("does not accuse a live draft's body of being residue", async () => {
    const ctx = afterTheGraceWindow();
    await aLiveDraft(ctx, "dft_live");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.ok, "a draft somebody is still writing is not residue").toBe(true);
    expect(finding.detail).toContain("No draft body without a drafts row among those judged");
    expect(finding.detail).toContain("1 object(s)");
    // Nothing was skipped here, so this pass may say so — and does, explicitly, rather than leaving the
    // reader to infer completeness from the absence of a caveat.
    expect(finding.detail).toContain("Every object under the prefix was listed and judged");
  });

  it("does not judge a body written while its row was still being committed", async () => {
    // `saveDraft` writes R2 before the row, so a brand-new draft's object legitimately has no row for
    // the width of that gap. Counting it would be a false accusation against a live draft.
    const ctx = createSystemCtx();
    await aSealedDraftsResidue("dft_inflight");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.ok).toBe(true);
  });

  it("does not report a withheld judgement as a clean prefix", async () => {
    // The success branch is the one that can lie the way #67 is about: a partial scan reading as a
    // complete one. One object was deliberately not judged, so "every draft body has a row" is not a
    // claim this pass is entitled to make — the withheld count and the caveat both have to be in the
    // detail a human reads, not only in the `ok` flag.
    const ctx = createSystemCtx();
    await aSealedDraftsResidue("dft_inflight");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.ok).toBe(true);
    expect(finding.detail, "the withheld judgement is part of the scope of the answer")
      .toContain("1 too fresh to judge");
    expect(finding.detail).toContain("Not every draft body was judged");
    expect(finding.detail).not.toContain("Every object under the prefix");
  });

  it("reports and never collects, because a diagnostic must not be the thing that deletes", async () => {
    const ctx = afterTheGraceWindow();
    const blobKey = await aSealedDraftsResidue("dft_sealed");

    await runDoctor(testEnv, ctx);
    expect(await testEnv.EVIDENCE.head(blobKey), "doctor calls the pass read-only").not.toBeNull();
  });

  it("keeps the count out of a locked-out operator's report — it is derived from mail", async () => {
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.discloses).toBe("data");
  });

  it("reads the collector's own scan instead of listing the prefix a second time", async () => {
    // The predicate is shared, not duplicated (#67). Two copies of "which objects are stranded" that can
    // disagree is a defect in waiting, and the disagreement would be silent in the worst direction: the
    // diagnostic reporting a count the collector then declines to act on. Counted at the binding, because
    // "it is shared" is otherwise a claim about the shape of the source that nothing checks.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const listings: string[] = [];
    await runDoctor(withListingLog(listings), ctx);

    // The anchor: if the log were empty every count below would pass against nothing.
    expect(listings.length, "the listing log recorded nothing, so the counts prove nothing")
      .toBeGreaterThan(0);
    expect(listings.filter((prefix) => prefix === `${ORG}/drafts/`)).toEqual([`${ORG}/drafts/`]);
    expect(listings.filter((prefix) => prefix === `${ORG}/raw/`)).toEqual([`${ORG}/raw/`]);
  });

  it("carries the scanned prefixes into doctor's own finding, un-spliced when truncated", async () => {
    // The truncation clause in `checkEvidence` used to split the phrase "examined under" — "200 object(s),
    // truncated examined under org_x/raw/". Nothing guarded that: `doctor.test.ts` only asserts the
    // receipt count.
    //
    // The listing **must be forced truncated**, because that is the only state in which the splice
    // appears at all. A first version of this test asserted against an ordinary fixture and passed with
    // the splice restored — vacuous, and caught by mutating rather than by reading it.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const detail = find((await runDoctor(withTruncatedListing(), ctx)).findings, "evidence_present").detail;
    expect(detail).toContain(`object(s) examined under ${ORG}/raw/, ${ORG}/drafts/`);
    expect(detail).toContain("listing truncated");
    // The clause goes after the prefixes, never inside the phrase it used to split.
    expect(detail).not.toContain("truncated examined");
  });
});

describe("reconcile collects a stranded draft body through its one delete", () => {
  it("collects it when asked, past the grace window", async () => {
    const ctx = afterTheGraceWindow();
    const blobKey = await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.draftBodiesDeleted).toBe(1);
    expect(await testEnv.EVIDENCE.head(blobKey), "the residue #67 was filed about").toBeNull();
  });

  it("leaves it alone when collection was not asked for, which is doctor's mode", async () => {
    const ctx = afterTheGraceWindow();
    const blobKey = await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG);
    expect(report.draftBodies.read).toBe("complete");
    if (report.draftBodies.read !== "complete") throw new Error("unreachable");
    expect(report.draftBodies.stranded.map((object) => object.blobKey)).toEqual([blobKey]);
    expect(report.draftBodiesDeleted).toBe(0);
    expect(await testEnv.EVIDENCE.head(blobKey)).not.toBeNull();
  });

  it("never touches a live draft's body, even asked to collect", async () => {
    // The referent rule is a `drafts` row keyed by `body_key`, not a receipt — so getting this wrong does
    // not cost storage, it destroys somebody's unfinished writing while they are writing it.
    const ctx = afterTheGraceWindow();
    const live = await aLiveDraft(ctx, "dft_live");
    const residue = await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.draftBodiesDeleted, "the residue, and only the residue").toBe(1);
    expect(await testEnv.EVIDENCE.head(live), "a draft somebody is still writing").not.toBeNull();
    expect(await testEnv.EVIDENCE.head(residue)).toBeNull();
  });

  it("spares every live draft, not just one, because the referent read is not paged", async () => {
    // `scanDraftBodies` claims its referent query "deliberately has **no LIMIT**", because a partial set of
    // referents reports a *live* draft's body as stranded and under `collect` that deletes somebody's
    // unfinished writing. **Nothing checked that claim.** Adding `LIMIT 1` to the query passed the entire
    // suite — 481 tests — because every fixture above sets up exactly one live draft, so a referent read that
    // returned only the first row was indistinguishable from one that returned all of them. That is the
    // vacuity mode AGENTS.md names: a mutation that can only manifest in a state no fixture builds.
    //
    // **What this bounds, and what it does not.** Behaviourally it fails for any limit below
    // `liveDrafts.length`; it cannot prove the *absence* of a limit, because a `LIMIT 9` would need nine live
    // drafts to show and a test cannot enumerate every number. The count is therefore a tripwire and not a
    // proof: three is past the one that already slipped through, and a paging bug introduced by pagination
    // rather than by a literal — `.all()` swapped for a cursor, a D1 row cap — shows up at any plurality,
    // which is the realistic shape. The residual is stated in `reconcile.ts` beside the claim rather than
    // left for a reader to discover here.
    const ctx = afterTheGraceWindow();
    const liveDrafts = [
      await aLiveDraft(ctx, "dft_live_one"),
      await aLiveDraft(ctx, "dft_live_two"),
      await aLiveDraft(ctx, "dft_live_three"),
    ];
    const residue = await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.draftBodies.read).toBe("complete");
    if (report.draftBodies.read !== "complete") throw new Error("unreachable");
    // The accusation, before the deletion: a live body named as stranded is already the whole bug, and the
    // read-only pass `doctor` performs would report it even where no delete follows.
    expect(report.draftBodies.stranded.map((object) => object.blobKey), "only the residue is stranded")
      .toEqual([residue]);
    expect(report.draftBodiesDeleted, "the residue, and nothing anybody is still writing").toBe(1);
    for (const key of liveDrafts) {
      expect(await testEnv.EVIDENCE.head(key), `live draft body ${key}`).not.toBeNull();
    }
    expect(await testEnv.EVIDENCE.head(residue)).toBeNull();
  });

  it("never touches a body inside the grace window", async () => {
    // `saveDraft` writes R2 before the row, so a body legitimately has no row for the width of that gap.
    // Collecting inside it would delete the body of a draft mid-save.
    const ctx = createSystemCtx();
    const blobKey = await aSealedDraftsResidue("dft_inflight");

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.draftBodies.read).toBe("complete");
    if (report.draftBodies.read !== "complete") throw new Error("unreachable");
    expect(report.draftBodies.tooFreshToJudge).toBe(1);
    expect(report.draftBodiesDeleted).toBe(0);
    expect(await testEnv.EVIDENCE.head(blobKey)).not.toBeNull();
  });

  it("counts the two referent rules apart rather than as one total", async () => {
    // "3 deleted" mixing a lost transaction with the residue of a sent message is a number an operator
    // cannot act on, and it would make `evidence_orphans`'s "N object(s) have no receipt" false of half
    // its own count.
    const ctx = afterTheGraceWindow();
    await aRawOrphan("msg_orphan");
    await aSealedDraftsResidue("dft_one");
    await aSealedDraftsResidue("dft_two");

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.orphansDeleted).toBe(1);
    expect(report.draftBodiesDeleted).toBe(2);
    expect(report.orphans.length, "an orphan is an object with no receipt, and only that").toBe(1);
  });

  it("collects the residue every Node already has, in the same pass, with no migration", async () => {
    // Item 4 of the design: every Node that has ever sent from the composer holds these objects, and they
    // are collected by the ordinary pass rather than by a one-off sweep. Three pre-existing objects, none
    // of which this test created through a draft lifecycle, all gone in one call.
    const ctx = afterTheGraceWindow();
    const keys = [
      await aSealedDraftsResidue("dft_old_one"),
      await aSealedDraftsResidue("dft_old_two"),
      await aSealedDraftsResidue("dft_old_three"),
    ];

    await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    for (const key of keys) expect(await testEnv.EVIDENCE.head(key)).toBeNull();
  });
});

describe("a legal hold suppresses draft-body collection org-wide", () => {
  const AUGUST_10 = Date.parse("2026-08-10T09:00:00.000Z");

  it("enumerates the residue and leaves the bytes in place", async () => {
    // #64's rule, and it applies here for the same reason it applies to an orphan: a stranded body has no
    // `drafts` row, so there is no mailbox to test a hold against, and the key's own prefix is the
    // organization. Unattributable by definition, so nothing can prove it is not responsive.
    const ctx = afterTheGraceWindow();
    const blobKey = await aSealedDraftsResidue("dft_sealed");
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: MAILBOX });

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.collection).toEqual({ requested: true, suppressed: true });
    expect(report.draftBodiesDeleted, "a suppressed pass deletes nothing").toBe(0);
    expect(report.draftBodies.read).toBe("complete");
    if (report.draftBodies.read !== "complete") throw new Error("unreachable");
    expect(report.draftBodies.stranded.map((object) => object.blobKey), "still enumerated").toEqual([blobKey]);
    expect(await testEnv.EVIDENCE.head(blobKey), "the bytes a hold protects").not.toBeNull();
  });

  it("counts the withheld draft bodies in the line an operator reads", async () => {
    // Suppression nobody can see is indistinguishable from a reconciler that has stopped working, and the
    // held count has to include the draft bodies or the line understates what is being preserved.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_one");
    await aSealedDraftsResidue("dft_two");
    await placeHold(testEnv, atTime(AUGUST_10), ORG, ADMIN, { mailboxId: MAILBOX });

    const text = formatReconcile(await reconcileEvidence(testEnv, ctx, ORG, { collect: true }));
    expect(text).toContain("HELD      2 collectable object(s) not collected");
  });

  it("collects when nothing is held, so the suppression is the hold and not the code path", async () => {
    const ctx = afterTheGraceWindow();
    const blobKey = await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(report.collection).toEqual({ requested: true, suppressed: false });
    expect(report.draftBodiesDeleted).toBe(1);
    expect(await testEnv.EVIDENCE.head(blobKey)).toBeNull();
  });
});

describe("reconcile says what it scanned, and what it could not read", () => {
  it("names every prefix, because a prefix outside the scan has to be visible", async () => {
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG);
    // Four since #74, which closed the gap this assertion used to record: `${ORG}/sent/` was named here as
    // deliberately absent, and its absence being visible is what made it repairable rather than forgotten.
    // `test/node/evidence-prefix-world.test.ts` is now what stops a fifth prefix repeating the pattern.
    expect(report.scanned.prefixes).toEqual([
      `${ORG}/raw/`, `${ORG}/drafts/`, `${ORG}/exports/`, `${ORG}/sent/`,
    ]);
  });

  it("prints them, because a structured field a human never sees is not a disclosure", async () => {
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const text = formatReconcile(await reconcileEvidence(testEnv, ctx, ORG));
    expect(text).toContain(`${ORG}/raw/`);
    expect(text).toContain(`${ORG}/drafts/`);
    expect(text).toContain("any other prefix");
    // The draft-body line is its own, because "no receipt" is not the test that produced it.
    expect(text).toContain("1 body object(s) with no drafts row");
  });

  it("counts every object it lists, so the reported prefixes cannot outrun the scan", async () => {
    // The report's prefixes are the loop's own input. If they ever name more than the scan lists, this
    // total goes stale — which is the failure mode the field exists to remove, not to reproduce.
    const ctx = afterTheGraceWindow();
    await aRawOrphan("one");
    await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG);
    let listedAcrossPrefixes = 0;
    for (const prefix of report.scanned.prefixes) {
      listedAcrossPrefixes += (await testEnv.EVIDENCE.list({ prefix })).objects.length;
    }
    expect(report.scanned.objects).toBe(listedAcrossPrefixes);
    // Both prefixes are now in the total: one raw object, one draft body, two objects scanned.
    expect(report.scanned.objects).toBe(2);
  });

  it("reports a prefix it could not read instead of counting zero under it", async () => {
    // The whole of #67 in one assertion. A prefix nobody could read must not contribute a `0`, because a
    // `0` from a prefix nobody looked at is exactly what the single-prefix report printed for two months.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(withUnreadableDrafts(), ctx, ORG, { collect: true });
    expect(report.draftBodies.read).toBe("unreadable");
    if (report.draftBodies.read !== "unreadable") throw new Error("unreachable");
    expect(report.draftBodies.because, "the cause, not just the symptom").toContain("no such table");
    expect(report.draftBodiesDeleted).toBe(0);
    expect(formatReconcile(report)).toContain(`UNREAD    ${ORG}/drafts/ could not be read`);
  });

  it("still reports lost mail when the draft prefix will not answer", async () => {
    // Why the failure is caught rather than thrown: direction 2 — a receipt pointing at an absent object —
    // is produced by nothing else in this Node, and losing that report because a second prefix would not
    // answer trades the serious finding for the cheap one.
    const ctx = afterTheGraceWindow();
    // Every column `0003_ingress.sql` declares NOT NULL, filled: a fixture that omits one fails on the
    // constraint rather than on the thing under test, which has cost this repository hours before.
    await testEnv.CATALOG.prepare(
      `INSERT INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
         raw_bytes, blob_key, blob_sha256, accepted_at, key_generation) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind("igr_lost", ORG, "igr_lost", "a@b.com", "c@d.com", 7, `${ORG}/raw/gone.eml`,
      "0".repeat(64), new Date(Date.now()).toISOString(), 1).run();

    const report = await reconcileEvidence(withUnreadableDrafts(), ctx, ORG);
    expect(report.draftBodies.read).toBe("unreadable");
    expect(report.missing.map((entry) => entry.receiptId), "lost mail, still reported").toEqual(["igr_lost"]);
  });
});

describe("the predicate has one definition", () => {
  it("is the function both readers call, and it judges the same objects they report", async () => {
    // `scanDraftBodies` is exported so `doctor` reads the collector's set rather than recomputing it. This
    // asserts the two agree on a fixture where they could differ: one live body, one residue, one too
    // fresh. If the shared function is ever bypassed, the counts drift here first.
    const ctx = afterTheGraceWindow();
    await aLiveDraft(ctx, "dft_live");
    const residue = await aSealedDraftsResidue("dft_sealed");

    const direct = await scanDraftBodies(testEnv, ctx, ORG);
    expect(direct.read).toBe("complete");
    if (direct.read !== "complete") throw new Error("unreachable");
    expect(direct.stranded.map((object) => object.blobKey)).toEqual([residue]);

    const viaPass = await reconcileEvidence(testEnv, ctx, ORG);
    expect(viaPass.draftBodies).toEqual(direct);

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.detail).toContain(`${direct.stranded.length} draft body object(s)`);
  });
});
