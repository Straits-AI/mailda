import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";
import { utf8 } from "@mailda/evidence";

import { clearKeyCache, currentSigningKey } from "../src/auth/keys.ts";
import { runDoctor, withoutDataFindings, type Finding } from "../src/doctor.ts";
import { putEvidence } from "../src/evidence-store.ts";
import { formatReconcile, reconcileEvidence } from "../src/reconcile.ts";

/**
 * A draft body nothing can collect has to be counted by something (#67).
 *
 * ## What was invisible
 *
 * A draft body is written to `${orgId}/drafts/{draftId}.txt`. `deleteDraft` issues one
 * `DELETE FROM drafts` and touches R2 not at all, and a draft is deleted when its message is **sealed** —
 * the ordinary path through the composer, not an exception. The reconciler's only listing is
 * `${orgId}/raw/`, and its `EVIDENCE.delete` is the one R2 delete in the Worker.
 *
 * So these objects are not collected late. They are **outside every scan**: no listing covers the prefix,
 * `reconcile` printed `0 orphans` while never having looked, and `doctor` had no figure that could reveal
 * them. The code and `application-shell.md` both said the object was *"left for the reconciler, because
 * ADR 32 makes an orphan blob collectable"* — true of ADR 32, false of this prefix. The same shape as
 * three of this month's defects: a claim in a comment with nothing enforcing it.
 *
 * ## What this file pins, and what it deliberately does not
 *
 * That the residue is **counted**, that a live draft's body is not accused of being residue, and that
 * `reconcile` now names the prefixes it scanned so a prefix outside the scan appears in the output rather
 * than being absent from it.
 *
 * It asserts **nothing is deleted**, because nothing may be: #64 requires every content-destroying call
 * site to consult a legal hold that does not exist yet, and a cleanup sweep is itself such a path.
 * Reporting is the whole of the change.
 */

const testEnv = env as unknown as Env;
const ORG = "org_stranded";
const MAILBOX = "mbx_stranded";
const AUTHOR = "usr_stranded";

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
 * lands outside the reconciler's prefix in the first place.
 */
async function aSealedDraftsResidue(draftId: string): Promise<string> {
  const stored = await putEvidence(testEnv, `${ORG}/drafts/${draftId}.txt`, utf8("half a sentence"));
  return stored.blobKey;
}

/**
 * The same Node with an `EVIDENCE` binding whose `list` refuses — the state a bucket that was never
 * created presents as. It is here to reach the check's *error* branch, which is the branch that names the
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
 * The same Node whose `drafts` read refuses — the check's *other* error branch.
 *
 * It exists because the check's JSDoc claimed both failing branches were asserted and only one was. That
 * branch's detail names nothing org-scoped today, so this is not a leak now; the point is that a later edit
 * adding the prefix to it would otherwise be caught by nothing. Proved by putting `infrastructure` back on
 * it and watching the full suite stay green.
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
  for (const table of ["drafts", "ingress_receipts", "node_claim", "mailboxes"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await testEnv.EVIDENCE.list({ prefix: `${ORG}/` });
  for (const object of listed.objects) await testEnv.EVIDENCE.delete(object.key);

  const at = new Date(Date.now()).toISOString();
  await testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
    .bind(MAILBOX, ORG, "Support", at).run();
  // Claimed: the draft prefix is scoped to an organization, so an unclaimed Node has none to check.
  await testEnv.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, org_id, claimed_at) VALUES (1, ?, ?, ?)",
  ).bind("unused-in-this-test", ORG, at).run();
});

describe("doctor counts draft bodies nothing can collect", () => {
  it("counts a body whose draft row is gone", async () => {
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.ok, "a body with no drafts row is residue and must be reported").toBe(false);
    expect(finding.detail).toContain("1 draft body object(s) have no drafts row");
    expect(finding.detail).toContain(`${ORG}/drafts/`);
  });

  it("reports the gap without degrading the verdict, because no operator action closes it", async () => {
    // A draft is deleted on the ordinary send path, so residue is permanent until #64's legal hold makes a
    // collector possible. `degraded` here would mean every Node that ever sent one message from the
    // composer reports WARN for good, and a check that is always failing is a check somebody mutes —
    // `DELIVERY_SILENCE_MS` names that failure mode in this same file. `workers_paid_plan` is the
    // precedent: a real gap, honestly reported, at `report`.
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

  it("keeps every org id out of the unauthenticated reduced report, on the error branch too", async () => {
    // `withoutDataFindings` keeps every `infrastructure` finding, and `/api/doctor` serves that reduced
    // report with no authentication when the Node cannot authenticate anyone. `discloses:
    // "infrastructure"` promises names already public in this repository; the prefix this check lists is
    // the org id, so no branch of it may claim that.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const cases = [
      ["listing works", testEnv],
      ["listing refuses", withUnlistableEvidence()],
      // Both failing branches, not one. The JSDoc claimed this coverage before it existed.
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

  it("says these are not collectable orphans, and that collection is deferred", async () => {
    // The wording is the point of the finding. "Collectable orphan" is the false claim that made this
    // invisible: the reconciler cannot collect what it does not list.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.detail).toContain("not collectable orphans");
    expect(finding.detail).toContain("no code path can collect");
    // Deferred to #64's legal hold, because a sweep is itself a content-destroying path.
    expect(finding.fix, "a finding a person cannot act on still has to say why").toBeTruthy();
    expect(finding.fix).toContain("legal hold");
    expect(finding.fix).toContain("deferred");
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

  it("reports rather than collects: the object is still there afterwards", async () => {
    // #64 decided every content-destroying call site must consult a legal hold, and that hold does not
    // exist. A diagnostic was never allowed to delete anyway, and this slice adds no deletion at all.
    const ctx = afterTheGraceWindow();
    const blobKey = await aSealedDraftsResidue("dft_sealed");

    await runDoctor(testEnv, ctx);
    expect(await testEnv.EVIDENCE.head(blobKey)).not.toBeNull();

    // Even the reconciler asked to collect leaves it, because it never lists this prefix.
    await reconcileEvidence(testEnv, ctx, ORG, { collect: true });
    expect(await testEnv.EVIDENCE.head(blobKey)).not.toBeNull();
  });

  it("keeps the count out of a locked-out operator's report — it is derived from mail", async () => {
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const finding = find((await runDoctor(testEnv, ctx)).findings, "draft_bodies_stranded");
    expect(finding.discloses).toBe("data");
  });
});

describe("reconcile names the prefixes it scanned", () => {
  it("reports the prefix it listed, so a prefix outside the scan is visible", async () => {
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG);
    expect(report.scanned.prefixes).toEqual([`${ORG}/raw/`]);
    // The draft prefix is not scanned, and the residue therefore does not appear as an orphan. Before
    // this field existed the report was silent about both facts at once.
    expect(report.scanned.prefixes).not.toContain(`${ORG}/drafts/`);
    expect(report.orphans).toEqual([]);
  });

  it("carries the scanned prefixes into doctor's own finding, un-spliced when truncated", async () => {
    // This slice also un-spliced the truncation clause in `checkEvidence`, where it used to split the
    // phrase "examined under" — "200 object(s), truncated examined under org_x/raw/". Nothing guarded
    // that: `doctor.test.ts` only asserts the receipt count.
    //
    // The listing **must be forced truncated**, because that is the only state in which the splice
    // appears at all. A first version of this test asserted against an ordinary fixture and passed with
    // the splice restored — vacuous, and caught by mutating rather than by reading it.
    const ctx = afterTheGraceWindow();
    await aSealedDraftsResidue("dft_sealed");

    const detail = find((await runDoctor(withTruncatedListing(), ctx)).findings, "evidence_present").detail;
    expect(detail).toContain(`object(s) examined under ${ORG}/raw/`);
    expect(detail).toContain("listing truncated");
    // The clause goes after the prefix, never inside the phrase it used to split.
    expect(detail).not.toContain("truncated examined");
  });

  it("prints them, because a structured field a human never sees is not a disclosure", async () => {
    const ctx = afterTheGraceWindow();
    const text = formatReconcile(await reconcileEvidence(testEnv, ctx, ORG));
    expect(text).toContain(`${ORG}/raw/`);
    expect(text).toContain("any other prefix");
  });

  it("counts every object it lists, so the reported prefixes cannot outrun the scan", async () => {
    // The report's prefixes are the loop's own input. If they ever name more than the scan lists, this
    // total goes stale — which is the failure mode the field exists to remove, not to reproduce.
    const ctx = afterTheGraceWindow();
    await putEvidence(testEnv, `${ORG}/raw/2026-Q3/one.eml`, utf8("From: a@b.com\r\n\r\nhi\r\n"));
    await aSealedDraftsResidue("dft_sealed");

    const report = await reconcileEvidence(testEnv, ctx, ORG);
    let listedAcrossPrefixes = 0;
    for (const prefix of report.scanned.prefixes) {
      listedAcrossPrefixes += (await testEnv.EVIDENCE.list({ prefix })).objects.length;
    }
    expect(report.scanned.objects).toBe(listedAcrossPrefixes);
    // And the draft body is not among them: one raw object, one draft body, one object scanned.
    expect(report.scanned.objects).toBe(1);
  });
});
