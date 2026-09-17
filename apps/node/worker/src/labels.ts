import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { unprocessable, notFound } from "./errors.ts";
import { readableMessage } from "./outbound/manifest.ts";

/**
 * Labels (0061): words a person puts on a message, to find it again. Flat, not folders — the migration says
 * why. A label is normalised here once (trimmed, lower-cased, one line, bounded) so `?label=` on the listing
 * compares equal strings, and the set on a message is bounded so a row cannot become a tag cloud.
 */
export const MAX_LABEL_CHARS = 40;
export const MAX_LABELS_PER_MESSAGE = 20;

export function normaliseLabel(raw: string): string {
  const label = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (label === "" || label.length > MAX_LABEL_CHARS || /[\p{C}]/u.test(label)) {
    throw unprocessable("E_LABEL_INVALID", {
      what: `${JSON.stringify(raw)} is not a label`,
      why: `a label is one to ${MAX_LABEL_CHARS} printable characters; it is compared lower-cased`,
      fix: "use a short word or phrase",
    });
  }
  return label;
}

export async function setLabels(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, messageId: string,
  change: { add: readonly string[]; remove: readonly string[] },
): Promise<{ messageId: string; labels: string[] }> {
  // The same door as a reply's parent: read authority on the mailbox the message landed in (§5C: 404 either way).
  if ((await readableMessage(env, orgId, actorUserId, messageId)) === null) {
    throw notFound("E_NO_SUCH_MESSAGE", {
      what: `${messageId} is not a message you can label`,
      why: "a label is a word on a message the reader can see",
      fix: "label a message in a mailbox you may read",
    });
  }
  const add = [...new Set(change.add.map(normaliseLabel))].sort();
  const remove = new Set(change.remove.map(normaliseLabel));
  const current = (await env.CATALOG.prepare(
    "SELECT label FROM message_labels WHERE org_id = ? AND message_id = ? ORDER BY label",
  ).bind(orgId, messageId).all<{ label: string }>()).results.map((row) => row.label);
  const after = [...new Set([...current.filter((one) => !remove.has(one)), ...add])].sort();
  if (after.length > MAX_LABELS_PER_MESSAGE) {
    throw unprocessable("E_TOO_MANY_LABELS", {
      what: `${after.length} labels on one message, over the ${MAX_LABELS_PER_MESSAGE} allowed`,
      why: "a message wearing every word is one no word finds",
      fix: "remove some first",
    });
  }
  const added = add.filter((one) => !current.includes(one));
  const removed = current.filter((one) => remove.has(one));
  if (added.length === 0 && removed.length === 0) return { messageId, labels: after };
  const at = new Date(ctx.now()).toISOString();
  await auditedBatch<never>(env, ctx, orgId, {
    action: "message.labelled", outcome: "ok", actorUserId, subject: messageId,
    detail: { added, removed },
  }, (entry) => [
    entry,
    ...added.map((label) => env.CATALOG.prepare(
      "INSERT OR IGNORE INTO message_labels (org_id, message_id, label, applied_by, applied_at) VALUES (?,?,?,?,?)",
    ).bind(orgId, messageId, label, actorUserId, at)),
    ...removed.map((label) => env.CATALOG.prepare(
      "DELETE FROM message_labels WHERE org_id = ? AND message_id = ? AND label = ?",
    ).bind(orgId, messageId, label)),
  ]);
  return { messageId, labels: after };
}
