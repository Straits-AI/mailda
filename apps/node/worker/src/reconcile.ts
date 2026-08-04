import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

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
 *   orphan blob, no receipt  — a write that lost its transaction. Safe to delete after a grace
 *                             period. Costs storage, reveals nothing, loses nothing.
 *   receipt, no blob         — **lost mail.** Never repaired, never tidied away, never resolved by
 *                             deleting the receipt. Enumerated and reported so a human decides.
 *
 * Deleting the receipt would turn a detectable data loss into an undetectable one, which is the worst
 * available outcome and also the tempting one, because it makes the report go green.
 */

const LIST_LIMIT = BUDGETS["reconcile.list_limit"];

/**
 * How long a blob may exist without a receipt before it counts as an orphan.
 *
 * It must exceed the longest possible gap between `putEvidence` returning and the receipt's `batch()`
 * committing — otherwise the reconciler races a delivery that is still in flight and deletes mail
 * that was about to be accepted. A Worker invocation cannot outlive its own wall-clock limit by
 * orders of magnitude, so an hour is generous by a wide margin, and an hour of R2 storage for a
 * handful of stray objects costs nothing. The asymmetry is deliberate: being slow to collect an
 * orphan is free, being fast is unrecoverable.
 */
const ORPHAN_GRACE_MS = BUDGETS["reconcile.orphan_grace_seconds"] * 1000;

export interface ReconcileReport {
  /** Objects with no receipt, older than the grace period. Deleted only when `collect` is set. */
  orphans: { blobKey: string; bytes: number; uploaded: string }[];
  orphansDeleted: number;
  /** Objects with no receipt but still inside the grace window — a delivery may be in flight. */
  tooFreshToJudge: number;
  /** Receipts whose evidence is absent. This is lost mail. */
  missing: { receiptId: string; blobKey: string; acceptedAt: string }[];
  /** What was examined, so a bounded pass cannot read as an exhaustive one. */
  scanned: { objects: number; truncated: boolean; receipts: number; receiptsTotal: number };
}

/**
 * One bounded pass. `collect` deletes orphans; without it the pass is read-only, which is the mode
 * `doctor` uses — a diagnostic must never be the thing that deletes data.
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
    tooFreshToJudge: 0,
    missing: [],
    scanned: { objects: 0, truncated: false, receipts: 0, receiptsTotal: 0 },
  };

  // ---- direction 1: objects with no receipt ------------------------------------------------
  const listed = await env.EVIDENCE.list({ prefix: `${orgId}/raw/`, limit: LIST_LIMIT });
  report.scanned.objects = listed.objects.length;
  report.scanned.truncated = listed.truncated;

  const cutoff = ctx.now() - ORPHAN_GRACE_MS;
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

    if (options.collect === true) {
      await env.EVIDENCE.delete(object.key);
      report.orphansDeleted += 1;
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

/** The text form, for a CLI and for a log line. */
export function formatReconcile(report: ReconcileReport): string {
  const lines = [
    `evidence reconcile`,
    `  scanned   ${report.scanned.objects} object(s)${report.scanned.truncated ? " (truncated — more remain)" : ""}, ` +
      `${report.scanned.receipts} of ${report.scanned.receiptsTotal} receipt(s)`,
    `  orphans   ${report.orphans.length} collectable, ${report.orphansDeleted} deleted, ` +
      `${report.tooFreshToJudge} too fresh to judge`,
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
