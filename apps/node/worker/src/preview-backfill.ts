import type { Ctx } from "@mailda/runtime";

import { contentSealingKey, EvidenceMissing, getEvidence, runKeyCache } from "./evidence-store.ts";
import { parseHeaders } from "./mime.ts";
import { PREVIEW_BACKFILL_LIMIT, sealPreview } from "./preview.ts";
import { indexableText } from "./search-body.ts";

/**
 * Projecting the row preview and sender name (0068) for mail that ingest did not project: everything that
 * predates 0068, anything an older code version inserted (the column's `pending` default makes that row owe a
 * projection), and any ingest whose seal failed.
 *
 * Its own file for the reason `search-backfill.ts` gives: it batches, and no file on the doctor path may
 * (`test/node/doctor-meter-honesty.test.ts`). The doctor's count, `preview_backlog`, lives in
 * `doctor/evidence.ts` and is one grouped query.
 *
 * ## Rebuildable, by construction
 *
 * The projections are derivatives of immutable evidence (AGENTS: "must actually be rebuildable, tested"):
 * `UPDATE messages SET preview_state = 'pending', preview_attempts = 0` and this pass re-derives every one
 * from the evidence, which `test/message-previews.test.ts` does and compares.
 */

/**
 * Rides out a blip of a few minutes (one attempt a minute); missing evidence is terminal at once. A fault that
 * outlasts it leaves the row `failed` rather than `pending`, so a lost key or a corrupt object cannot hold the
 * newest-first batch every minute and starve the rows behind it; `requeueFailedPreviews` is the way back.
 */
export const PREVIEW_MAX_ATTEMPTS = 3;

export interface PreviewBackfillOutcome {
  /** Rows written `projected` (with or without a preview: a message with no body text has none to show). */
  projected: number;
  /** Rows whose attempt failed and stay `pending` for the next pass. */
  retried: number;
  /** Rows now `failed`: evidence missing, or the last attempt spent. `requeueFailedPreviews` puts them back. */
  failed: number;
  /** The first failure's first line, or null when nothing failed. */
  reason: string | null;
}

/**
 * One pass: at most `PREVIEW_BACKFILL_LIMIT` pending rows, newest first (a Node catching up becomes useful
 * from the top of the list down), each read, parsed and sealed, and every outcome written in one batch.
 *
 * **A failure is counted per message, never a reason to stop the pass**: one unreadable message must not
 * starve the rows behind it. The attempt count is advanced **in SQL** (`preview_attempts + 1`), so two
 * overlapping passes both advance it — 0048's lesson — without a lease; the work they duplicate is bounded
 * by the limit and writes identical values. Every write is guarded by `preview_state = 'pending'`, so a row
 * another pass settled is not written twice.
 */
export async function backfillPreviews(env: Env, _ctx: Ctx): Promise<PreviewBackfillOutcome> {
  // The repeated term is what makes this a search of `msg_preview_open` rather than a scan (0068, point 5).
  // `blob_key` is NOT NULL since 0002, so every pending row has evidence to read.
  const pending = await env.CATALOG.prepare(
    `SELECT id, blob_key FROM messages
      WHERE preview_state <> 'projected' AND preview_state = 'pending'
      ORDER BY rowid DESC LIMIT ?`,
  ).bind(PREVIEW_BACKFILL_LIMIT).all<{ id: string; blob_key: string }>();
  const outcome: PreviewBackfillOutcome = { projected: 0, retried: 0, failed: 0, reason: null };
  if (pending.results.length === 0) return outcome;

  const cache = runKeyCache();
  const statements: D1PreparedStatement[] = [];
  for (const row of pending.results) {
    try {
      const raw = await getEvidence(env, row.blob_key, cache);
      /*
       * Deterministic, so not an attempt: the parser is written not to throw, and `materialise.ts` treats a
       * throw as a row with no parsed headers. Here that row lists with its address and no name, which is the
       * visible state a sender name that cannot be read is owed; retrying the same bytes would fail the same way.
       */
      let fromName: string | null;
      try {
        fromName = parseHeaders(raw).fromName;
      } catch {
        fromName = null;
      }
      const body = await indexableText(raw);
      const text = body.kind === "text" ? body.preview : null;
      let sealed: string | null = null;
      let generation: number | null = null;
      if (text !== null) {
        const sealing = await contentSealingKey(env, cache);
        sealed = await sealPreview(sealing.key, row.id, text);
        generation = sealing.generation;
      }
      statements.push(env.CATALOG.prepare(
        `UPDATE messages SET from_name = ?, preview_sealed = ?, preview_generation = ?,
                preview_state = 'projected', preview_attempts = 0
          WHERE id = ? AND preview_state = 'pending'
          RETURNING preview_state`,
      ).bind(fromName, sealed, generation, row.id));
    } catch (error) {
      outcome.reason ??= (error as Error).message.split("\n")[0] ?? "unknown";
      statements.push(error instanceof EvidenceMissing
        /*
         * Lost mail, and terminal at once: re-reading an absent object next minute finds it absent again.
         * `doctor`'s `evidence_present` already reports the receipt; this row only stops owing a projection.
         */
        ? env.CATALOG.prepare(
          `UPDATE messages SET preview_state = 'failed'
            WHERE id = ? AND preview_state = 'pending'
            RETURNING preview_state`,
        ).bind(row.id)
        : env.CATALOG.prepare(
          `UPDATE messages SET preview_attempts = preview_attempts + 1,
                  preview_state = CASE WHEN preview_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
            WHERE id = ? AND preview_state = 'pending'
            RETURNING preview_state`,
        ).bind(PREVIEW_MAX_ATTEMPTS, row.id));
    }
  }

  for (const result of await env.CATALOG.batch<{ preview_state: string }>(statements)) {
    const state = result.results[0]?.preview_state;
    if (state === "projected") outcome.projected += 1;
    else if (state === "pending") outcome.retried += 1;
    else if (state === "failed") outcome.failed += 1;
  }
  return outcome;
}

/**
 * Puts every preview the backfill gave up on back in its queue (`POST /api/maintenance/requeue-previews`), and
 * returns how many. The remedy `doctor`'s `preview_backlog` names once `evidence_present` and `key_vault` read
 * ok, since a vault or storage fault that spent a row's attempts leaves nothing else that would retry it.
 *
 * **Every failed row, not named ones**, which is the opposite of `mailda search repair` and for the reason
 * that command gives. The body index can fail deterministically (a body no parser reads), and repairing those
 * spends attempts on work that cannot succeed, so it takes ids. A preview cannot: an unparseable body projects
 * as a row with no preview, and a name that cannot be read as none. What reaches `failed` is missing evidence,
 * which returns at once for one R2 miss, or a read that failed on every attempt, which is worth another now.
 * Scoped to the caller's organization, and spelled with the partial index's term, so it reads only the rows
 * not yet projected.
 */
export async function requeueFailedPreviews(env: Env, orgId: string): Promise<number> {
  const result = await env.CATALOG.prepare(
    `UPDATE messages SET preview_state = 'pending', preview_attempts = 0
      WHERE preview_state <> 'projected' AND preview_state = 'failed' AND org_id = ?`,
  ).bind(orgId).run();
  return result.meta.changes ?? 0;
}
