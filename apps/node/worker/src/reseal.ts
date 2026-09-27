import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import {
  contentOpeningKey, contentSealingKey, generationOf, openForReseal, putEvidence, runKeyCache, type RunKeyCache,
} from "./evidence-store.ts";
import { vault } from "./keyvault.ts";
import { openPreview, sealPreview } from "./preview.ts";

/**
 * Re-sealing evidence under a new content key (#25, driven by ADR 28).
 *
 * A Node deployed before the vault existed holds mail sealed under generation 0 — a constant
 * published in this repository. `doctor` refuses to call that healthy, and until this existed
 * nothing could act on the refusal: adopting a per-Node key would have made the existing mail
 * unreadable.
 *
 * The wider case is the one that matters more. **This is also what a compromised or rotated content
 * key requires.** A key that cannot be rotated is not much better than one that was never held, so
 * re-sealing is not a migration script — it is the operation that makes key rotation real.
 *
 * ## Four properties, each with a failure it prevents
 *
 * **Resumable.** A shard holds millions of messages (`message-metadata-bytes.md`), so no invocation
 * finishes the job. Progress is durable in `ingress_receipts.key_generation` and every call picks up
 * where the last stopped.
 *
 * **Verified.** Every receipt records the **plaintext** SHA-256 — that is *why* it records the
 * plaintext hash rather than the ciphertext's, decided when evidence storage was built. Re-sealing
 * recomputes it and refuses to advance on mismatch, so a re-seal can never quietly replace a message
 * with different bytes.
 *
 * **Safe to interrupt.** Both old and new generations open, so a half-finished run leaves every
 * message readable. R2 is written before D1: a crash between them costs one redundant pass, because
 * the object's own metadata is authoritative and re-sealing an already-new object is a no-op. The
 * reverse order would cost an unreadable message.
 *
 * **Never destructive on failure.** A receipt that fails is reported and left alone, still readable
 * under its old key. It is not skipped silently and not deleted — the same rule the reconciler uses
 * for a missing blob.
 *
 * ## The row preview moves with its receipt (0068)
 *
 * A message's row preview is sealed under the same content key as its evidence, so a rotation that moved
 * the evidence and left the preview would leave the old key still opening content. **Invariant: a preview is
 * never sealed under an older generation than its receipt's evidence.** Ingest seals both with one key in
 * one run; the backfill seals under the current generation; and here the preview is re-sealed in the same
 * step as its receipt, **before** the receipt is marked current, so a failure leaves the receipt behind to
 * be picked up again rather than a receipt that is current beside a preview that is not. That is what makes
 * `pendingReseal` — which counts receipts — also the count of previews behind, and `doctor`'s
 * `evidence_key_generation` detail true when it says so.
 */

const BATCH = BUDGETS["reseal.batch_size"];

export interface ResealOutcome {
  /** Receipts advanced to the current generation in this call. */
  resealed: number;
  /** Already current — counted rather than hidden, so a no-op run is visibly a no-op. */
  alreadyCurrent: number;
  /** Receipts that could not be re-sealed. Each one is mail that is still readable but not moved. */
  failed: { receiptId: string; reason: string }[];
  /** How many remain below the current generation after this call. */
  remaining: number;
  targetGeneration: number;
  /**
   * Row previews whose old seal would not open: cleared and put back to `pending`, so the backfill re-derives
   * them from the evidence just re-sealed. A projection, so nothing is lost; counted so it is not silent.
   */
  previewsRequeued: number;
}

export async function resealBatch(env: Env, ctx: Ctx, orgId: string): Promise<ResealOutcome> {
  const target = (await vault(env).sealingKey("content")).generation;

  const candidates = await env.CATALOG.prepare(
    `SELECT id, blob_key, blob_sha256, key_generation
       FROM ingress_receipts
      WHERE org_id = ? AND (key_generation IS NULL OR key_generation < ?)
      ORDER BY accepted_at ASC
      LIMIT ?`,
  )
    .bind(orgId, target, BATCH)
    .all<{ id: string; blob_key: string; blob_sha256: string; key_generation: number | null }>();

  const outcome: ResealOutcome = {
    resealed: 0,
    alreadyCurrent: 0,
    failed: [],
    remaining: 0,
    targetGeneration: target,
    previewsRequeued: 0,
  };
  // One run's keys: every preview in the batch opens and seals under a handful of generations (see `RunKeyCache`).
  const cache = runKeyCache();

  for (const receipt of candidates.results) {
    try {
      // The object's own metadata decides whether work is needed. D1 is only a scan hint, so a row
      // whose index is stale costs a HEAD and nothing else.
      const head = await env.EVIDENCE.head(receipt.blob_key);
      if (head === null) {
        // Lost mail, not a re-seal problem. The reconciler owns reporting it; advancing the index
        // here would hide it from the next scan.
        outcome.failed.push({ receiptId: receipt.id, reason: "evidence object is absent" });
        continue;
      }

      if (generationOf(head) >= target) {
        outcome.alreadyCurrent += 1;
        if (await resealPreview(env, receipt.id, target, cache)) outcome.previewsRequeued += 1;
        await markGeneration(env, receipt.id, target);
        continue;
      }

      const { plaintext } = await openForReseal(env, receipt.blob_key);

      // The gate. A re-seal that changed the bytes would be undetectable afterwards, so it is
      // checked before the write rather than after.
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (digest !== receipt.blob_sha256) {
        outcome.failed.push({
          receiptId: receipt.id,
          reason: `plaintext SHA-256 does not match the receipt (${digest} vs ${receipt.blob_sha256})`,
        });
        continue;
      }

      // R2 first, then D1. Same ordering rule as ingress, for the same reason: the reachable partial
      // state has to be the harmless one.
      const stored = await putEvidence(env, receipt.blob_key, plaintext);
      if (await resealPreview(env, receipt.id, stored.keyGeneration, cache)) outcome.previewsRequeued += 1;
      await markGeneration(env, receipt.id, stored.keyGeneration);
      outcome.resealed += 1;
    } catch (error) {
      outcome.failed.push({ receiptId: receipt.id, reason: (error as Error).message.split("\n")[0]! });
    }
  }

  const left = await env.CATALOG.prepare(
    `SELECT COUNT(*) AS n FROM ingress_receipts
      WHERE org_id = ? AND (key_generation IS NULL OR key_generation < ?)`,
  )
    .bind(orgId, target)
    .first<{ n: number }>();
  outcome.remaining = left?.n ?? 0;

  return outcome;
}

/**
 * Re-seals one receipt's row preview under `target` when it is sealed under anything older. True when the old
 * seal would not open and the preview was re-queued instead (the backfill re-derives it from the evidence).
 *
 * A vault or D1 failure throws, and the caller counts the receipt as failed and leaves it unmarked, so the
 * next pass does both again. Only a seal that will not open under its own recorded key is re-queued, because
 * that one would fail the same way on every pass and the evidence it came from is right here to rebuild it.
 */
async function resealPreview(env: Env, receiptId: string, target: number, cache: RunKeyCache): Promise<boolean> {
  // One row at most: `msg_by_receipt` is unique on the receipt.
  const row = await env.CATALOG.prepare(
    `SELECT id, preview_sealed, preview_generation FROM messages
      WHERE ingress_receipt_id = ? AND preview_generation IS NOT NULL AND preview_generation < ?`,
  ).bind(receiptId, target).first<{ id: string; preview_sealed: string; preview_generation: number }>();
  if (row === null) return false;
  const opening = await contentOpeningKey(env, row.preview_generation, cache);
  let text: string;
  try {
    text = await openPreview(opening, row.id, row.preview_sealed);
  } catch {
    // Recorded in the outcome as `previewsRequeued`, and the row becomes visible to `preview_backlog`.
    await env.CATALOG.prepare(
      `UPDATE messages SET preview_sealed = NULL, preview_generation = NULL, preview_state = 'pending',
              preview_attempts = 0
        WHERE id = ?`,
    ).bind(row.id).run();
    return true;
  }
  const sealing = await contentSealingKey(env, cache);
  await env.CATALOG.prepare(
    "UPDATE messages SET preview_sealed = ?, preview_generation = ? WHERE id = ? AND preview_generation = ?",
  ).bind(await sealPreview(sealing.key, row.id, text), sealing.generation, row.id, row.preview_generation).run();
  return false;
}

async function markGeneration(env: Env, receiptId: string, generation: number): Promise<void> {
  await env.CATALOG.prepare("UPDATE ingress_receipts SET key_generation = ? WHERE id = ?")
    .bind(generation, receiptId)
    .run();
}

/** How much is left, for `doctor`. Counts rows the index says are behind, across every org. */
export async function pendingReseal(env: Env, targetGeneration: number): Promise<number> {
  const row = await env.CATALOG.prepare(
    `SELECT COUNT(*) AS n FROM ingress_receipts
      WHERE key_generation IS NULL OR key_generation < ?`,
  )
    .bind(targetGeneration)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
