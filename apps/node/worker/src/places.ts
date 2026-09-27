import type { Ctx } from "@mailda/runtime";
import { PLACES } from "@mailda/contract/routes";

import { notFound, unprocessable } from "./errors.ts";
import { readableMessage } from "./outbound/manifest.ts";

export type Place = (typeof PLACES)[number]; // "inbox" | "archive" | "trash"

function isPlace(value: string): value is Place {
  return (PLACES as readonly string[]).includes(value);
}

/**
 * Puts a message in this person's Inbox, Archive or Trash (0067, ADR 45). Per person, since a mailbox is
 * shared: nobody else's view changes. Under standing read authority on the message's mailbox, the same door
 * as read state and a label; not audited, for the reason the migration gives. Idempotent.
 *
 * **No legal-hold check, and that is not an omission.** A hold guards destruction, and filing destroys
 * nothing: the message, its evidence and every other reader's view are untouched, and Trash is a place that
 * can always be left. A purge would owe the hold; there is none.
 *
 * Cases are untouched too: archiving never closes a case and closing never archives. The case is the team's
 * shared "done"; the place is one person's view of it.
 */
export async function setPlace(
  env: Env, ctx: Ctx, orgId: string, userId: string, messageId: string, place: string,
): Promise<{ messageId: string; place: Place }> {
  if (!isPlace(place)) {
    throw unprocessable("E_PLACE_UNKNOWN", {
      what: `${JSON.stringify(place)} is not a place`,
      why: "a message is in your Inbox, Archive or Trash, and nothing else",
      fix: "send place: inbox, archive or trash",
    });
  }
  // One answer for no standing content read, another organization, quarantined and nonexistent (§5C).
  if ((await readableMessage(env, orgId, userId, messageId)) === null) {
    throw notFound("E_NO_SUCH_MESSAGE", {
      what: `${messageId} is not a message you can file`,
      why: "a place is where you keep a message you may read, and only in your own view",
      fix: "file a message in a mailbox you may read",
    });
  }
  await (place === "inbox"
    ? env.CATALOG.prepare("DELETE FROM message_places WHERE org_id = ? AND user_id = ? AND message_id = ?")
      .bind(orgId, userId, messageId)
    /*
     * The receipt's id and acceptance time are copied in (immutable facts), so Archive and Trash page from
     * this table's own index. The `WHERE` before `ON CONFLICT` is also what keeps SQLite's
     * upsert-after-SELECT parse unambiguous.
     */
    : env.CATALOG.prepare(
      `INSERT INTO message_places (org_id, user_id, message_id, receipt_id, accepted_at, place, placed_at)
       SELECT ?, ?, m.id, r.id, r.accepted_at, ?, ?
         FROM messages m JOIN ingress_receipts r ON r.id = m.ingress_receipt_id
        WHERE m.org_id = ? AND m.id = ?
       ON CONFLICT (user_id, message_id) DO UPDATE SET place = excluded.place, placed_at = excluded.placed_at`,
    ).bind(orgId, userId, place, new Date(ctx.now()).toISOString(), orgId, messageId)).run();
  return { messageId, place };
}
