import type { Ctx } from "@mailda/runtime";

/**
 * Conversation identity: what a case is created per (#38).
 *
 * ## Grouping is the sender's root and nothing else
 *
 * Root present, join it. Root absent — a reply with no `In-Reply-To`, a fresh mail quoting an old thread, or
 * headers that could not be parsed at all — start a new conversation.
 *
 * There is **no subject-and-participant fallback**, and that is a refusal rather than a missing feature.
 * Subject matching is a guess about identity whose failure is silent and asymmetric: two customers writing
 * to `support@` with the same normalised subject in the same window is the ordinary case, not the exotic
 * one, and the result is one customer's message sitting inside another's case. Fragmentation is the opposite
 * kind of wrong — visible on the screen, and fixable by a person. Merge is therefore the remedy (#43).
 *
 * ## Identity is ours, the join key is theirs
 *
 * `id` is a `cnv_` ULID this Node mints. `root_rfc_id` is the sender's. A case whose identity derived from a
 * header an outside party controls would move between cases when that header is broken or spoofed; owning
 * the identity means a bad header changes only the join, which is repairable.
 */

/**
 * Finds or creates the conversation a delivery belongs to, and returns **the id that won**.
 *
 * ## Why this commits before the caller's batch rather than inside it
 *
 * The first version returned statements for the caller to include in its batch, alongside the message and
 * the case. That is wrong, and the bug is worth recording because it reads as more atomic than the correct
 * version: two deliveries sharing a root would both find nothing, both mint an id, and both bind their
 * message rows to their *own* id — then `cnv_by_root` would silently ignore the loser's conversation insert
 * and leave its message and case pointing at a row that does not exist. `INSERT OR IGNORE` is silent about
 * losing, so nothing would have failed.
 *
 * So the conversation is committed first and re-read, and the caller binds the id this returns. The cost is
 * that a failure in the caller's batch leaves a conversation with no messages.
 *
 * That is the recoverable side, and it is the same trade the draft body already makes by writing to R2
 * before the row: an orphan is collectable and a dangling reference is not. ADR 32's asymmetry is the
 * general form — an unreferenced object may be collected, a reference with no object may only be reported.
 */
export async function conversationForDelivery(
  env: Env,
  ctx: Ctx,
  orgId: string,
  rootRfcId: string | null,
): Promise<string> {
  // A NULL root joins nothing, now or ever, so there is nothing to look up and nothing to race with.
  if (rootRfcId === null) {
    const id = ctx.id("cnv");
    await env.CATALOG.prepare(
      `INSERT INTO conversations (id, org_id, root_rfc_id, grouped_by, merged_into, created_at)
       VALUES (?,?,NULL,'root',NULL,?)`,
    )
      .bind(id, orgId, new Date(ctx.now()).toISOString())
      .run();
    return id;
  }

  const existing = await env.CATALOG.prepare(
    `SELECT id FROM conversations
      WHERE org_id = ? AND root_rfc_id = ? AND merged_into IS NULL LIMIT 1`,
  )
    .bind(orgId, rootRfcId)
    .first<{ id: string }>();
  if (existing !== null) return existing.id;

  // `INSERT OR IGNORE` then read: the UNIQUE index is the concurrency control, and the read is how the
  // loser learns the winner's id instead of proceeding with its own. Checking first and inserting second
  // would be the race; this is the resolution of it.
  await env.CATALOG.prepare(
    `INSERT OR IGNORE INTO conversations (id, org_id, root_rfc_id, grouped_by, merged_into, created_at)
     VALUES (?,?,?, 'root', NULL, ?)`,
  )
    .bind(ctx.id("cnv"), orgId, rootRfcId, new Date(ctx.now()).toISOString())
    .run();

  const winner = await env.CATALOG.prepare(
    `SELECT id FROM conversations
      WHERE org_id = ? AND root_rfc_id = ? AND merged_into IS NULL LIMIT 1`,
  )
    .bind(orgId, rootRfcId)
    .first<{ id: string }>();

  // Non-null in every reachable case: the insert either created the row or lost to one that exists.
  return winner!.id;
}
