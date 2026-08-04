import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { generationOf, openForReseal, putEvidence } from "./evidence-store.ts";
import { vault } from "./keyvault.ts";

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
 * **Resumable.** A shard holds ~8.5M messages (`message-metadata-bytes.md`), so no invocation
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
  };

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
