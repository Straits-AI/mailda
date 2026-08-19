import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { anyActiveHold } from "./holds.ts";

/**
 * Evidence reconciliation (§13, §24).
 *
 * `ingress.ts` writes R2 before D1 deliberately, so the only reachable partial state is an **orphan
 * blob** rather than a message row pointing at nothing — §24 calls "accepted but absent" the most
 * dangerous failure in mail. That ordering has been in place since Layer 1; what did not exist was
 * anything to collect the orphans or to report the other direction. The `E_EVIDENCE_MISSING` error
 * has named this file as the fix the whole time.
 *
 * The two directions are **not symmetric**, and treating them alike is the mistake to avoid:
 *
 *   object, no referent  — a write that lost its transaction, or content whose row has been deleted.
 *                          Safe to delete after a grace period. Costs storage, reveals nothing.
 *   referent, no object  — **lost mail.** Never repaired, never tidied away, never resolved by
 *                          deleting the receipt. Enumerated and reported so a human decides.
 *
 * Deleting the receipt would turn a detectable data loss into an undetectable one, which is the worst
 * available outcome and also the tempting one, because it makes the report go green.
 *
 * ## Two prefixes, two referent rules, one delete (#67)
 *
 * `${orgId}/raw/` holds accepted mail, whose referent is a row in `ingress_receipts`. `${orgId}/drafts/`
 * holds draft bodies, whose referent is a row in `drafts` keyed by `body_key` — so **"no receipt" is not
 * the test for a draft body**, and that is why widening one listing was never the whole repair.
 *
 * The prefixes are scanned by different rules and then **collected by the same loop**. That is
 * deliberate: `EVIDENCE.delete` below is still the only call in the product that destroys content
 * *bytes*, so the allowlist in `test/node/content-deletion-world.test.ts` stays at one entry, which is the
 * property that tripwire exists to protect. A second delete site would be a second thing to remember to
 * put a hold in front of.
 *
 * #64 classified this site content-carrying and gave it the **org-wide** rule rather than a per-hold one,
 * because an unreferenced object cannot be attributed to a mailbox — see `anyActiveHold` at the top of the
 * pass. That argument covers a stranded draft body exactly as it covers an orphan: with no `drafts` row
 * there is no mailbox to test a hold against, and the key's own prefix is the organization rather than a
 * mailbox. Enumeration and reporting are unchanged while a hold stands; only the delete stops.
 */

const LIST_LIMIT = BUDGETS["reconcile.list_limit"];

/**
 * How long a blob may exist without its referent before it counts as collectable.
 *
 * It must exceed the longest possible gap between the R2 write returning and the row committing —
 * otherwise the reconciler races a write that is still in flight and deletes content that was about to be
 * referenced. Both writers order it that way for the same reason: `ingress.ts` puts evidence before the
 * receipt, and `saveDraft` puts the body before the row. A Worker invocation cannot outlive its own
 * wall-clock limit by orders of magnitude, so an hour is generous by a wide margin, and an hour of R2
 * storage for a handful of stray objects costs nothing. The asymmetry is deliberate: being slow to collect
 * is free, being fast is unrecoverable.
 */
const ORPHAN_GRACE_MS = BUDGETS["reconcile.orphan_grace_seconds"] * 1000;

/** Accepted mail. Referent: a row in `ingress_receipts`. */
function rawPrefix(orgId: string): string {
  return `${orgId}/raw/`;
}

/**
 * Draft bodies. Referent: a row in `drafts`, keyed by `body_key`.
 *
 * Exported because `doctor` reports this prefix by name and must not spell it a second time — a second
 * spelling is a second thing that can disagree, which is the shape of the defect #67 filed.
 */
export function draftBodyPrefix(orgId: string): string {
  return `${orgId}/drafts/`;
}

/**
 * Every prefix this pass lists — the one place it is written, so the report cannot claim a scope the
 * scan does not have.
 *
 * It is reported rather than merely used, because the report previously could not distinguish
 * *"nothing to collect"* from *"did not look"*. Both printed `0 orphans`. `${orgId}/drafts/` is the
 * prefix that made that ambiguity expensive: draft bodies live there, `deleteDraft` removes only the row,
 * and for a while no listing in this Worker covered it at all.
 *
 * Both entries are the same functions the two scans below are given, not a second description of them, so
 * a prefix named here that nothing lists would have to be a prefix nothing scans either.
 */
function scannedPrefixes(orgId: string): string[] {
  return [rawPrefix(orgId), draftBodyPrefix(orgId)];
}

/** One object with no live referent, in the shape both directions of this pass report it. */
export interface Unreferenced {
  blobKey: string;
  bytes: number;
  uploaded: string;
}

/**
 * Which objects under `${orgId}/drafts/` are stranded — **the one definition**, shared by this pass and by
 * `doctor`'s `draft_bodies_stranded` finding (#67).
 *
 * It is shared rather than reimplemented because two copies of "which objects are stranded" that can
 * disagree is a defect in waiting, and the disagreement would be silent in the direction that matters: the
 * diagnostic would report a count the collector then declined to act on, or the reverse. `doctor` calls
 * `reconcileEvidence` read-only already, so it reads this out of that report and lists nothing itself.
 *
 * The union is the enforcement, not a comment: a caller cannot reach `stranded` without narrowing on
 * `read`, so "0 stranded" can never stand in for "could not look". That distinction is the whole of #67.
 */
export type DraftBodyScan =
  | {
    read: "complete";
    prefix: string;
    /** Objects listed under the prefix, whatever was concluded about them. */
    examined: number;
    truncated: boolean;
    /** Inside the grace window: an autosave may be between its R2 write and its D1 commit right now. */
    tooFreshToJudge: number;
    /** Past the grace window with no `drafts` row. Deleted only when `collect` is set and no hold stands. */
    stranded: Unreferenced[];
  }
  | {
    read: "unreadable";
    prefix: string;
    /** The first line of the cause. Kept, because a report that says only "could not read" is a symptom. */
    because: string | null;
  };

/**
 * The scan itself. Throws rather than catching: the caller decides what an unreadable prefix means, and
 * `reconcileEvidence` is the one place that decides it.
 *
 * Two calls, fixed, regardless of how many objects the listing returns: one `R2Bucket.list()` for the page
 * and **one** `SELECT body_key` for every live referent at once. The bulk query is why adding this prefix
 * costs two subrequests rather than two hundred — the raw direction spends one D1 lookup per object because
 * it samples by key. Both halves of that are measured in `docs/receipts/evidence-lifecycle.md`'s correction
 * headed *"the pass gained a second prefix"*: this scan costs 2 subrequests at 0 stranded bodies and 2 at
 * five, while five raw objects with no receipt cost five extra D1 executions. The same correction derives what
 * a *full* pass can now reach — `4 × reconcile.list_limit + 6` — and `test/evidence-lifecycle.test.ts` asserts
 * that arithmetic stays under the Workers Free subrequest ceiling, because `list_limit` bounds each prefix
 * separately and adding one nearly doubled the ceiling a pass can touch.
 *
 * The referent query deliberately has **no LIMIT**. A partial set of referents would report a *live*
 * draft's body as stranded, and under `collect` that is not a false accusation, it is a deletion of
 * somebody's unfinished writing. It is bounded in practice by what it reads: one column of `drafts`, which
 * is working state deleted at seal, so it grows with drafts in progress rather than with mail volume.
 *
 * That claim was unenforced until 19 August 2026, and it is the most expensive one in this file to get wrong:
 * `LIMIT 1` here passed all 481 tests, because every fixture set up exactly one live draft and so could not
 * tell a first row from every row. `test/stranded-draft-bodies.test.ts` — *"spares every live draft, not just
 * one, because the referent read is not paged"* — now collects against **three** live drafts and one residue.
 *
 * **What that test bounds is stated rather than implied**, because a tripwire hiding its boundary is what this
 * file keeps finding defects in. It fails for any limit below three; it cannot prove the absence of a limit,
 * since a larger one needs a larger fixture and no count settles every number. Three is past the one that
 * already slipped through, and the realistic regression — `.all()` traded for a cursor, or a row cap
 * discovered at scale — truncates at any plurality rather than at a chosen literal.
 */
export async function scanDraftBodies(env: Env, ctx: Ctx, orgId: string): Promise<DraftBodyScan> {
  const prefix = draftBodyPrefix(orgId);
  const listed = await env.EVIDENCE.list({ prefix, limit: LIST_LIMIT });

  const referenced = await env.CATALOG.prepare(
    "SELECT body_key FROM drafts WHERE org_id = ? AND body_key IS NOT NULL",
  ).bind(orgId).all<{ body_key: string }>();
  const live = new Set(referenced.results.map((row) => row.body_key));

  const cutoff = ctx.now() - ORPHAN_GRACE_MS;
  const stranded: Unreferenced[] = [];
  let tooFreshToJudge = 0;
  for (const object of listed.objects) {
    if (live.has(object.key)) continue;
    if (object.uploaded.getTime() > cutoff) {
      tooFreshToJudge += 1;
      continue;
    }
    stranded.push({
      blobKey: object.key,
      bytes: object.size,
      uploaded: object.uploaded.toISOString(),
    });
  }

  return {
    read: "complete",
    prefix,
    examined: listed.objects.length,
    truncated: listed.truncated,
    tooFreshToJudge,
    stranded,
  };
}

export interface ReconcileReport {
  /** Raw objects with no receipt, older than the grace period. Deleted only when `collect` is set. */
  orphans: Unreferenced[];
  orphansDeleted: number;
  /**
   * The draft-body half of direction 1 (#67), by the predicate `doctor` reports from.
   *
   * A sibling of `orphans` rather than merged into it, and the counts are **not summed**. The two have
   * different referents and different meanings — an orphan is a lost transaction, a stranded draft body is
   * the ordinary residue of a sent message — so a single total would be a number nobody could act on, and
   * `evidence_orphans`'s "N object(s) have no receipt" would become false of half of it.
   */
  draftBodies: DraftBodyScan;
  draftBodiesDeleted: number;
  /**
   * What this pass was asked to delete, and whether a legal hold stopped it (#64).
   *
   * Reported rather than silent, because suppression that cannot be seen is indistinguishable from a
   * reconciler that has stopped working — and this pass is the one an operator reaches for when they suspect
   * exactly that. `requested` is here so `suppressed: false` cannot be read as "nothing was in the way" by
   * somebody who never asked for collection in the first place.
   */
  collection: { requested: boolean; suppressed: boolean };
  /** Raw objects with no receipt but still inside the grace window — a delivery may be in flight. */
  tooFreshToJudge: number;
  /** Receipts whose evidence is absent. This is lost mail. */
  missing: { receiptId: string; blobKey: string; acceptedAt: string }[];
  /**
   * What was examined, so a bounded pass cannot read as an exhaustive one — including **which
   * prefixes**, so a prefix outside the scan appears in the output instead of being absent from it.
   */
  scanned: {
    objects: number;
    truncated: boolean;
    receipts: number;
    receiptsTotal: number;
    prefixes: string[];
  };
}

/**
 * One bounded pass. `collect` deletes what has no referent; without it the pass is read-only, which is the
 * mode `doctor` uses — a diagnostic must never be the thing that deletes data.
 */
export async function reconcileEvidence(
  env: Env,
  ctx: Ctx,
  orgId: string,
  options: { collect?: boolean } = {},
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    orphans: [],
    orphansDeleted: 0,
    // Overwritten unconditionally below, and the placeholder is the *refusing* arm on purpose: an empty
    // `complete` scan would claim a clean prefix this pass had not looked at yet, which is precisely the
    // overclaim #67 is about. If a future edit ever returns before the scan, it returns "not read".
    draftBodies: {
      read: "unreadable",
      prefix: draftBodyPrefix(orgId),
      because: "the pass returned before reaching this prefix",
    },
    draftBodiesDeleted: 0,
    collection: { requested: options.collect === true, suppressed: false },
    tooFreshToJudge: 0,
    missing: [],
    scanned: { objects: 0, truncated: false, receipts: 0, receiptsTotal: 0, prefixes: [] },
  };

  /**
   * Any hold anywhere in the organization suppresses collection, for the whole organization (#64).
   *
   * **An unreferenced object is unattributable by definition** — this pass finds it precisely *because* its
   * referent is missing — so nothing can establish which mailbox it belonged to, and nothing can prove it is
   * not responsive. A per-hold check is not expensive here, it is unimplementable: it would need a mailbox
   * inferred from exactly the data whose absence defines the state. That holds for a stranded draft body as
   * well as for an orphan: the `drafts` row carried the mailbox, and the row is what is gone. Enumeration is
   * unaffected; only the delete is.
   *
   * Asked **once per pass and only when collection was requested**, so the read-only mode `doctor` uses
   * spends nothing on it — which is why `doctor-check-cost.md`'s figure does not move for this file.
   */
  if (options.collect === true) {
    report.collection.suppressed = await anyActiveHold(env, orgId);
  }

  // ---- direction 1: objects with no referent -----------------------------------------------
  // The reported prefixes come from the same two functions the scans below are handed, so the report
  // cannot name a prefix the scan skipped. That is the whole point of reporting them: an unscanned prefix
  // has to be visible somewhere other than in a comment.
  report.scanned.prefixes = scannedPrefixes(orgId);
  const cutoff = ctx.now() - ORPHAN_GRACE_MS;

  /**
   * What this pass may destroy, tagged with the referent it is missing.
   *
   * Both scans fill it and the single `EVIDENCE.delete` below drains it. That is what keeps this Worker's
   * R2 delete site at exactly one while covering two prefixes — the property
   * `test/node/content-deletion-world.test.ts` exists to protect, and the reason #67's residue is collected
   * here rather than by a sweep of its own.
   */
  const collectable: { blobKey: string; referent: "ingress_receipt" | "drafts_row" }[] = [];

  const listed = await env.EVIDENCE.list({ prefix: rawPrefix(orgId), limit: LIST_LIMIT });
  report.scanned.objects += listed.objects.length;
  if (listed.truncated) report.scanned.truncated = true;

  for (const object of listed.objects) {
    if (object.uploaded.getTime() > cutoff) {
      // A delivery may be between its R2 write and its D1 commit right now.
      report.tooFreshToJudge += 1;
      continue;
    }

    const receipt = await env.CATALOG.prepare(
      "SELECT id FROM ingress_receipts WHERE org_id = ? AND blob_key = ? LIMIT 1",
    )
      .bind(orgId, object.key)
      .first<{ id: string }>();

    if (receipt !== null) continue;

    report.orphans.push({
      blobKey: object.key,
      bytes: object.size,
      uploaded: object.uploaded.toISOString(),
    });
    collectable.push({ blobKey: object.key, referent: "ingress_receipt" });
  }

  /**
   * The draft-body half, and the one place that decides what an unreadable prefix means.
   *
   * Caught rather than propagated, because direction 2 below — receipts pointing at absent objects, which is
   * *lost mail* — is produced by nothing else in this Node, and losing that report because a second prefix
   * would not answer trades the serious finding for the cheap one. What it must not do is fall back to a
   * silent zero: the report carries the failure so the text form can say the prefix was not read, which is
   * the same distinction `scanned.prefixes` was added for.
   */
  report.draftBodies = await scanDraftBodies(env, ctx, orgId).catch((error: unknown) => ({
    read: "unreadable" as const,
    prefix: draftBodyPrefix(orgId),
    because: (error as Error).message.split("\n")[0] ?? null,
  }));
  if (report.draftBodies.read === "complete") {
    report.scanned.objects += report.draftBodies.examined;
    if (report.draftBodies.truncated) report.scanned.truncated = true;
    for (const object of report.draftBodies.stranded) {
      collectable.push({ blobKey: object.blobKey, referent: "drafts_row" });
    }
  }

  // ---- the one R2 delete in this Worker ----------------------------------------------------
  // Everything above is enumerated whatever happens; deleted only when collection was asked for and no
  // hold stands anywhere in the organization.
  if (report.collection.requested && !report.collection.suppressed) {
    for (const object of collectable) {
      await env.EVIDENCE.delete(object.blobKey);
      // Counted per referent rule, not as one total: "3 deleted" that mixed a lost transaction with the
      // residue of a sent message would be a number an operator could not act on.
      if (object.referent === "ingress_receipt") report.orphansDeleted += 1;
      else report.draftBodiesDeleted += 1;
    }
  }

  // ---- direction 2: receipts with no object ------------------------------------------------
  const total = await env.CATALOG.prepare(
    "SELECT COUNT(*) AS n FROM ingress_receipts WHERE org_id = ?",
  )
    .bind(orgId)
    .first<{ n: number }>();
  report.scanned.receiptsTotal = total?.n ?? 0;

  const receipts = await env.CATALOG.prepare(
    `SELECT id, blob_key, accepted_at FROM ingress_receipts
      WHERE org_id = ? ORDER BY accepted_at DESC LIMIT ?`,
  )
    .bind(orgId, LIST_LIMIT)
    .all<{ id: string; blob_key: string; accepted_at: string }>();
  report.scanned.receipts = receipts.results.length;

  for (const receipt of receipts.results) {
    if ((await env.EVIDENCE.head(receipt.blob_key)) === null) {
      // Reported, never repaired. Deleting the receipt would convert a detectable loss into an
      // undetectable one — and it is the tempting option, because it makes the report go green.
      report.missing.push({
        receiptId: receipt.id,
        blobKey: receipt.blob_key,
        acceptedAt: receipt.accepted_at,
      });
    }
  }

  return report;
}

/**
 * The one line about legal hold, in the tense the pass actually earned.
 *
 * Separated out because it is the only line in this report with three possible states rather than a value,
 * and because "we did not look" is a distinct answer from "we looked and found nothing" — the same
 * distinction §24 draws between `unobserved` and `accepted`, applied to the pass's own knowledge.
 */
function reconcileHoldLine(report: ReconcileReport): string {
  const held = report.orphans.length
    + (report.draftBodies.read === "complete" ? report.draftBodies.stranded.length : 0);
  if (report.collection.suppressed) {
    return `  HELD      ${held} collectable object(s) not collected: a legal hold is active in this `
      + `organization, and an object with no referent is unattributable by definition, so nothing can prove `
      + `one is not responsive. They are reported above and left in place`;
  }
  if (report.collection.requested) {
    return `  holds     collection was requested and no legal hold stands in this organization, so nothing `
      + `suppressed it`;
  }
  return `  holds     collection was not requested, so no hold was consulted — this pass could not have `
    + `deleted anything, and it does not know whether a hold stands`;
}

/**
 * The draft-body line, printed on every branch including the unreadable one.
 *
 * A prefix that could not be read has to say so here rather than contribute a zero, because a zero is
 * exactly what the old single-prefix report printed for a prefix it had never looked at.
 */
function draftBodyLine(report: ReconcileReport): string {
  const scan = report.draftBodies;
  if (scan.read === "unreadable") {
    return `  UNREAD    ${scan.prefix} could not be read, so nothing under it was counted or collected`
      + (scan.because === null ? `` : `: ${scan.because}`);
  }
  return `  drafts    ${scan.stranded.length} body object(s) with no drafts row, `
    + `${report.draftBodiesDeleted} deleted, ${scan.tooFreshToJudge} too fresh to judge, `
    + `out of ${scan.examined} examined under ${scan.prefix}`
    + (scan.truncated ? ` (truncated — more remain)` : ``);
}

/** The text form, for a CLI and for a log line. */
export function formatReconcile(report: ReconcileReport): string {
  const lines = [
    `evidence reconcile`,
    `  scanned   ${report.scanned.objects} object(s)${report.scanned.truncated ? " (truncated — more remain)" : ""}, ` +
      `${report.scanned.receipts} of ${report.scanned.receiptsTotal} receipt(s)`,
    // Named, because "0 orphans" from a scan of one prefix reads exactly like "0 orphans" from a scan
    // of the bucket. An object under any other prefix was not examined and is not collectable here.
    `  prefixes  ${report.scanned.prefixes.join(", ")} — objects under any other prefix were not ` +
      `listed, so they are neither counted above nor collectable by this pass`,
    `  orphans   ${report.orphans.length} collectable, ${report.orphansDeleted} deleted, ` +
      `${report.tooFreshToJudge} too fresh to judge`,
    // The second referent rule gets its own line rather than being folded into the one above, because
    // "no receipt" is not the test that produced it and a reader who assumes it was would draw the wrong
    // conclusion about what is missing (#67).
    draftBodyLine(report),
    // Printed on every branch, including "collection was not asked for", because a reader who sees nothing
    // about holds cannot tell whether the line is absent or the suppression is.
    //
    // **Three branches, not two**, and the third is the point. `anyActiveHold` runs only when collection was
    // requested, so a read-only pass — the one `doctor` performs — has not asked and therefore cannot say
    // that nothing is in the way. This line said "collection was not requested; nothing suppresses it" until
    // it was measured against a Node with a hold standing, where it was simply false: `suppressed` is `false`
    // there because nobody asked, which is the exact misreading `requested` was added to the report to
    // prevent. The text form now says what was not done instead of asserting the answer it never obtained.
    reconcileHoldLine(report),
  ];

  if (report.missing.length === 0) {
    lines.push(`  missing   none — every sampled receipt's evidence is present`);
  } else {
    lines.push(`  MISSING   ${report.missing.length} receipt(s) reference absent evidence. This is lost mail.`);
    for (const entry of report.missing) {
      lines.push(`            ${entry.receiptId}  accepted ${entry.acceptedAt}  ${entry.blobKey}`);
    }
    lines.push(`  fix       do not delete these receipts. Check R2 lifecycle rules and §24 Time Travel first.`);
  }
  return lines.join("\n");
}
