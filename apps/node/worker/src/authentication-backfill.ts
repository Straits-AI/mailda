import type { Ctx } from "@mailda/runtime";

import { authenticationOf } from "./authentication-results.ts";
import { getEvidence } from "./evidence-store.ts";
import { headerBlock, headerFields } from "./mime.ts";

/**
 * Evaluates the sender of every message materialised before migration 0055, a few a minute.
 *
 * A NULL in `auth_dmarc` means "nobody looked", and on a Node that predates the check every message reads
 * that way for ever unless something looks. This does, from the cron, the way the search backfill catches
 * the index up: bounded, resumable, and writing nothing once there is nothing left. Each message costs one
 * R2 read — the header block is inside the sealed evidence — so the batch is small: twenty-five a minute is
 * an old Node's archive in a day or two, and the same figure the body backfill settled on for the same
 * reason (`search-backfill.ts`).
 *
 * The verdict written is exactly what materialise would have written on the day: the receiving server's
 * header if it is there, `absent` if it is not. A message whose evidence cannot be read is left NULL and
 * comes round again; the reconciler is what says whether the evidence is gone.
 */
const AUTH_BACKFILL_LIMIT = 25;

export async function backfillAuthentication(env: Env, _ctx: Ctx): Promise<number> {
  const pending = await env.CATALOG.prepare(
    "SELECT id, blob_key FROM messages WHERE auth_dmarc IS NULL ORDER BY received_at LIMIT ?",
  ).bind(AUTH_BACKFILL_LIMIT).all<{ id: string; blob_key: string }>();

  let evaluated = 0;
  for (const row of pending.results) {
    let verdict;
    try {
      const raw = await getEvidence(env, row.blob_key);
      verdict = authenticationOf(headerFields(headerBlock(raw)));
    } catch {
      // Unreadable evidence is the reconciler's finding, not this pass's; the row stays NULL and is retried.
      continue;
    }
    await env.CATALOG.prepare(
      `UPDATE messages SET auth_spf = ?, auth_dkim = ?, auth_dmarc = ?, auth_dmarc_policy = ?, auth_from_domain = ?
        WHERE id = ? AND auth_dmarc IS NULL`,
    ).bind(verdict.spf, verdict.dkim, verdict.dmarc, verdict.dmarcPolicy, verdict.fromDomain, row.id).run();
    evaluated += 1;
  }
  return evaluated;
}
