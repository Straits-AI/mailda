import type { Ctx } from "@mailda/runtime";

import { notFound } from "./errors.ts";
import { readableMessage } from "./outbound/manifest.ts";

/**
 * Read state (0062): whether this person has opened a message. Per person, since a mailbox is shared.
 * The reading pane marks a message read when it opens it; the toggle puts it back. Under read authority on
 * the message's mailbox, the same door as a label; not audited, for the reason the migration gives.
 */
export async function setRead(
  env: Env, ctx: Ctx, orgId: string, userId: string, messageId: string, read: boolean,
): Promise<{ messageId: string; read: boolean }> {
  if ((await readableMessage(env, orgId, userId, messageId)) === null) {
    throw notFound("E_NO_SUCH_MESSAGE", {
      what: `${messageId} is not a message you can read`,
      why: "read state is a bookmark on a message the reader can see",
      fix: "open a message in a mailbox you may read",
    });
  }
  await (read
    ? env.CATALOG.prepare("INSERT OR IGNORE INTO message_reads (org_id, user_id, message_id, read_at) VALUES (?,?,?,?)")
      .bind(orgId, userId, messageId, new Date(ctx.now()).toISOString())
    : env.CATALOG.prepare("DELETE FROM message_reads WHERE org_id = ? AND user_id = ? AND message_id = ?")
      .bind(orgId, userId, messageId)).run();
  return { messageId, read };
}
