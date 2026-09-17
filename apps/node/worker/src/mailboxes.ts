import { ID_PREFIXES, type Ctx } from "@mailda/runtime";

import { assertAdmin } from "./access.ts";
import { auditedBatch } from "./audit.ts";
import { unprocessable } from "./errors.ts";

/**
 * A second mailbox (17 September 2026). Until now the only mailbox a Node ever had was the one `claim.ts`
 * created — a product pitched on shared inboxes could not have `invoices@` beside `support@` without a hand
 * in D1, which the 17 September coverage audit named as the largest gap in the product.
 *
 * An administrator's act, audited. The creator is granted read and send on it in the same batch, for the
 * reason the claim grants the owner both: a mailbox nobody may see is not in anybody's rail, and the
 * People screen — where an administrator hands access to others — lists the mailboxes its reader holds.
 * Addresses arrive the way they always have, `POST /api/provider/receiving` with this id; nothing here
 * touches Cloudflare. There is no delete: a mailbox with mail in it is evidence, and one without is harmless.
 */
export const MAX_MAILBOX_NAME_CHARS = 60;

export async function createMailbox(
  env: Env, ctx: Ctx, orgId: string, actorUserId: string, rawName: string,
): Promise<{ mailboxId: string; name: string }> {
  await assertAdmin(env, orgId, actorUserId);
  const name = rawName.trim().replace(/\s+/g, " ");
  if (name === "" || name.length > MAX_MAILBOX_NAME_CHARS || /[\p{C}]/u.test(name)) {
    throw unprocessable("E_MAILBOX_NAME_INVALID", {
      what: `${JSON.stringify(rawName)} is not a mailbox name`,
      why: `a name is one to ${MAX_MAILBOX_NAME_CHARS} printable characters; it is what the rail and the queue show`,
      fix: "give it the name people will call it — Support, Invoices",
    });
  }
  const taken = await env.CATALOG.prepare("SELECT id FROM mailboxes WHERE org_id = ? AND lower(name) = lower(?) LIMIT 1")
    .bind(orgId, name).first<{ id: string }>();
  if (taken !== null) {
    throw unprocessable("E_MAILBOX_NAME_TAKEN", {
      what: `a mailbox called ${JSON.stringify(name)} already exists (${taken.id})`,
      why: "two mailboxes with one name are indistinguishable everywhere a name is shown",
      fix: "pick another name, or route the address at the existing mailbox",
    });
  }
  const mailboxId = ctx.id(ID_PREFIXES.mailbox);
  const at = new Date(ctx.now()).toISOString();
  await auditedBatch<never>(env, ctx, orgId, {
    action: "mailbox.created", outcome: "ok", actorUserId, subject: mailboxId, detail: { name },
  }, (entry) => [
    entry,
    env.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)").bind(mailboxId, orgId, name, at),
    ...["mailbox.content.read", "send.propose"].map((relation) => env.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,'mailbox',?,?)`,
    ).bind(ctx.id("rt"), orgId, actorUserId, relation, mailboxId, at)),
  ]);
  return { mailboxId, name };
}
