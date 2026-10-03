import type { Ctx } from "@mailda/runtime";

import { isAdmin } from "./access.ts";
import { auditedBatch, log } from "./audit.ts";
import { maySend } from "./authz-read.ts";
import { CallerError, conflict, forbidden, notFound } from "./errors.ts";
import { getEvidence } from "./evidence-store.ts";
import { headerBlock, headerFields, messageIds, parseHeaders } from "./mime.ts";
import { COPY_OF_HEADER } from "./outbound/copy.ts";
import { boundedReferences, sealManifest } from "./outbound/manifest.ts";

/**
 * Kept forwards (ADR 47, 3 October 2026): an address taken over from an Email Routing forward rule whose destination
 * keeps receiving each message, forwarded by this Worker with `message.forward()` after the message is stored.
 *
 * Measured on mailda.site on 2 October 2026 (`docs/receipts/email-worker-forward.md`): forward() works after
 * `message.raw` has been read to the end, up to a 24,400,483-byte message; the copy keeps the original From, body
 * and Message-ID (the sender's DKIM still passes); only `X-` headers survive its headers argument; a destination
 * that is not verified throws at once, "destination address not verified"; and a handler that catches that and
 * returns leaves the sender with nothing, no bounce. So the sender is never told about a failed forward, and this
 * Node must be: every call leaves the row `acceptInbound` wrote, settled here.
 */

/** The header that marks a message this Node forwarded, so one that comes back is stored and not forwarded again. */
export const FORWARDED_BY_HEADER = "X-Mailda-Forwarded-By";

/**
 * Whether `value` (the inbound message's `X-Mailda-Forwarded-By`, as `Headers.get` joins repeats) carries this Node's
 * marker. A substring test: the marker is this Node's claim id, a ULID no other Node shares, and how Cloudflare
 * joins a repeated header was never measured.
 */
export function forwardedBy(value: string | null, marker: string): boolean {
  return value !== null && marker !== "" && value.includes(marker);
}

/**
 * The call and its settlement. Called only on `accepted`, after the receipt and its attempt row committed, with the
 * destination the address row held (organization state, never anything from the message or a request).
 *
 * It never throws and never rejects the message: the message is stored, and a forward that failed is shown on
 * People and counted by doctor, not bounced, because the sender's message did arrive. A settlement that cannot be
 * written is logged, and the row it leaves is `outcome_unknown`, which doctor counts, so the failure stays visible.
 */
export async function forwardKept(
  env: Env, ctx: Ctx, message: Pick<ForwardableEmailMessage, "forward">,
  orgId: string, receiptId: string, destination: string, marker: string, copy = false,
): Promise<{ copyQueued: boolean }> {
  let settled: { state: "handed_over" | "refused"; error: string | null };
  try {
    await message.forward(destination, new Headers({ [FORWARDED_BY_HEADER]: marker }));
    settled = { state: "handed_over", error: null };
  } catch (error) {
    // Cloudflare's words, verbatim: the measured ones are "destination address not verified" and "message already
    // forwarded to this destination".
    settled = { state: "refused", error: error instanceof Error ? error.message : String(error) };
  }
  const at = new Date(ctx.now()).toISOString();
  /*
   * A copy (ADR 47, amended 3 October 2026), only when the address opted in and only on the refusal measured to have
   * delivered nothing. Asked for in the settle's own batch, as an outbox event, so it runs after the message is
   * filed and judged (the copy must not leave before the quarantine and the attachment verdicts have spoken, as the
   * forward does); and any other refusal is recorded as no copy, with why, because the destination may have it.
   */
  const wanted = copy && settled.state === "refused";
  const queued = wanted && copyable(settled.error);
  const statements = [
    env.CATALOG.prepare(
      "UPDATE kept_forward_attempts SET state = ?, error = ?, settled_at = ? WHERE receipt_id = ? AND state = 'outcome_unknown'",
    ).bind(settled.state, settled.error, at, receiptId),
    ...(!wanted ? [] : queued ? [env.CATALOG.prepare(
      `INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at)
       SELECT ?, ?, ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM kept_forward_attempts WHERE receipt_id = ? AND state = 'refused')`,
    ).bind(ctx.id("evt"), orgId, COPY_TOPIC, JSON.stringify({ receiptId, marker }), at, receiptId)] : [env.CATALOG.prepare(
      "UPDATE kept_forward_attempts SET copy_state = 'refused', copy_error = ?, copy_at = ? WHERE receipt_id = ? AND copy_state IS NULL",
    ).bind(`Cloudflare's refusal was not "${COPYABLE_REFUSAL}", the one measured to deliver nothing, so the `
      + "destination may already have this message", at, receiptId)]),
  ];
  try {
    await env.CATALOG.batch(statements);
    return { copyQueued: queued };
  } catch (unrecorded) {
    await log(env, ctx, {
      level: "error", event: "kept_forward.unrecorded", orgId, message: (unrecorded as Error).message,
      detail: { receiptId, state: settled.state, copyQueued: queued },
    });
    return { copyQueued: false };
  }
}

/**
 * The one refusal of `forward()` measured to deliver nothing (`docs/receipts/email-worker-forward.md`): the destination
 * is not verified. The other measured one, "message already forwarded to this destination", means a copy did arrive,
 * and a refusal nobody has measured may mean either, so neither is copied: a duplicate cannot be recalled.
 */
export const COPYABLE_REFUSAL = "destination address not verified";
export function copyable(error: string | null): boolean {
  return error !== null && error.toLowerCase().includes(COPYABLE_REFUSAL);
}

/** The outbox topic a copy is asked for on, consumed in `src/pipeline.ts`. */
export const COPY_TOPIC = "mail.kept_forward.copy";

/** One address keeping a forward, and what its latest attempt says. The People and Setup line. */
export interface KeptForward {
  address: string;
  mailboxId: string;
  to: string;
  /** The latest read of the account's destination list: null when none has answered since the forward was kept. */
  verified: "verified" | "waiting" | "absent" | null;
  checkedAt: string | null;
  /** The latest attempt, or null when nothing has arrived since; `copy` is what became of the copy it asked for. */
  last: {
    state: "outcome_unknown" | "handed_over" | "refused" | "withheld"; at: string; error: string | null;
    copy: { state: "sealed" | "refused"; at: string | null; error: string | null; sendId: string | null; sendState: string | null } | null;
  } | null;
  /** When a forward was last handed over, which may be older than `last`. */
  lastHandedOverAt: string | null;
  /** Who turned copies on and when (ADR 47, amended); null when off. */
  copy: { by: string; at: string } | null;
}

/** Every address on this Node keeping a forward. Reads D1 only, no Cloudflare call. */
export async function keptForwards(env: Env, orgId: string): Promise<KeptForward[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT a.address, a.mailbox_id, a.kept_forward_to, a.kept_forward_verified, a.kept_forward_checked_at,
            a.copy_by, a.copy_at, l.state, l.attempted_at, l.error, l.copy_state, l.copy_at AS copied_at, l.copy_error,
            c.manifest_id AS copy_send_id, sm.state AS copy_send_state,
            (SELECT MAX(h.attempted_at) FROM kept_forward_attempts h
              WHERE h.org_id = a.org_id AND h.address = a.address AND h.state = 'handed_over') AS handed_over_at
       FROM addresses a
       LEFT JOIN kept_forward_attempts l ON l.receipt_id = (
         SELECT x.receipt_id FROM kept_forward_attempts x WHERE x.org_id = a.org_id AND x.address = a.address
          ORDER BY x.attempted_at DESC, x.receipt_id DESC LIMIT 1)
       LEFT JOIN send_copies c ON c.receipt_id = l.receipt_id
       LEFT JOIN send_manifests sm ON sm.id = c.manifest_id
      WHERE a.org_id = ? AND a.kept_forward_to IS NOT NULL
      ORDER BY a.address`,
  ).bind(orgId).all<{
    address: string; mailbox_id: string; kept_forward_to: string; kept_forward_verified: KeptForward["verified"];
    kept_forward_checked_at: string | null; state: NonNullable<KeptForward["last"]>["state"] | null;
    attempted_at: string | null; error: string | null; handed_over_at: string | null;
    copy_by: string | null; copy_at: string | null; copy_state: "sealed" | "refused" | null; copied_at: string | null;
    copy_error: string | null; copy_send_id: string | null; copy_send_state: string | null;
  }>();
  return results.map((row) => ({
    address: row.address, mailboxId: row.mailbox_id, to: row.kept_forward_to,
    verified: row.kept_forward_verified, checkedAt: row.kept_forward_checked_at,
    last: row.state === null || row.attempted_at === null ? null : {
      state: row.state, at: row.attempted_at, error: row.error,
      copy: row.copy_state === null ? null : {
        state: row.copy_state, at: row.copied_at, error: row.copy_error, sendId: row.copy_send_id, sendState: row.copy_send_state,
      },
    },
    lastHandedOverAt: row.handed_over_at,
    copy: row.copy_by === null || row.copy_at === null ? null : { by: row.copy_by, at: row.copy_at },
  }));
}

/**
 * A copy (ADR 47, amended 3 October 2026): the stored message sent again through this Node's own outbound path,
 * because its kept forward was refused as not verified and the address opted in. Called by the outbox handler for
 * `COPY_TOPIC`, after the message is filed, so every judgement the Node makes of a message has been made.
 *
 * Every outcome is written to the attempt row: `copy_state` `sealed` (the seal's own batch writes it) or `refused`
 * with the rule that stopped it. A refusal is the system working and is recorded, never thrown; a fault (D1, R2, the
 * vault) is thrown, so the outbox tries again, and a second seal of one delivery fails whole on `send_copies`'
 * unique receipt. A copy is never retried by this Node once sealed: its send has its own state in the Outbox.
 */
export async function copyKept(env: Env, ctx: Ctx, receiptId: string, messageId: string, marker: string): Promise<void> {
  const row = await env.CATALOG.prepare(
    `SELECT k.org_id, k.address, k.destination, k.state, k.copy_state, d.mailbox_id, d.copy_by, d.copy_at, b.name AS mailbox_name,
            m.blob_key, m.subject, m.quarantined_at, m.attachments_dangerous, m.auth_dmarc
       FROM kept_forward_attempts k
       JOIN addresses d ON d.org_id = k.org_id AND d.address = k.address
       JOIN mailboxes b ON b.org_id = d.org_id AND b.id = d.mailbox_id
       JOIN messages m ON m.org_id = k.org_id AND m.id = ?
      WHERE k.receipt_id = ? LIMIT 1`,
  ).bind(messageId, receiptId).first<{
    org_id: string; address: string; destination: string; state: string; copy_state: string | null;
    mailbox_id: string; copy_by: string | null; copy_at: string | null; mailbox_name: string;
    blob_key: string; subject: string; quarantined_at: string | null; attachments_dangerous: number | null; auth_dmarc: string | null;
  }>();
  // Settled already (a redelivered event), or nothing to copy: the address or the attempt is gone.
  if (row === null || row.state !== "refused" || row.copy_state !== null) return;

  const refuse = async (why: string): Promise<void> => {
    await env.CATALOG.prepare(
      "UPDATE kept_forward_attempts SET copy_state = 'refused', copy_error = ?, copy_at = ? WHERE receipt_id = ? AND copy_state IS NULL",
    ).bind(why.slice(0, 1000), new Date(ctx.now()).toISOString(), receiptId).run();
  };

  // The authority, read live: the opt-in still set, and the administrator who set it still one.
  if (row.copy_by === null || row.copy_at === null) return await refuse(`copies were turned off for ${row.address} before this one was sealed`);
  if (!(await isAdmin(env, row.org_id, row.copy_by))) {
    return await refuse(`${row.copy_by}, who turned copies on for ${row.address}, is no longer an administrator; an administrator turns them on again`);
  }
  // The loop guard that needs no measurement: a destination on a domain this organisation receives at could route
  // straight back here, by its own rule or a catch-all, so it is never copied to.
  const domain = row.destination.slice(row.destination.lastIndexOf("@") + 1).toLowerCase();
  const ours = await env.CATALOG.prepare(
    "SELECT 1 AS hit FROM addresses WHERE org_id = ? AND lower(substr(address, instr(address, '@') + 1)) = ? LIMIT 1",
  ).bind(row.org_id, domain).first<{ hit: number }>();
  if (ours !== null) return await refuse(`${row.destination} is on ${domain}, where this organisation receives mail, so a copy could come straight back`);
  // What this Node judged of the message. A copy goes out under the customer's domain, so nothing it held back or
  // could not judge goes with it, and no automatic copy has an override.
  if (row.quarantined_at !== null) return await refuse("the message is quarantined in its mailbox, and a copy would send what the mailbox held back");
  if (row.attachments_dangerous === null) return await refuse("this Node could not read the message's attachments, so it cannot say none is dangerous");
  if (row.attachments_dangerous > 0) {
    return await refuse(`the message carries ${row.attachments_dangerous} attachment(s) this Node judges dangerous, and an automatic copy has no author to say send them anyway`);
  }
  // DMARC failed: the sender's own domain disowned this message. The copy is From the customer's domain and passes
  // DMARC there, so copying it would launder a forged sender's name into a message that authenticates.
  if (row.auth_dmarc === "fail") return await refuse("the message failed DMARC for its sender's domain, and a copy from this domain would pass it");

  const original = await getEvidence(env, row.blob_key);
  const fields = headerFields(headerBlock(original));
  if (forwardedBy(fields.get(COPY_OF_HEADER.toLowerCase())?.join(", ") ?? null, marker)
    || forwardedBy(fields.get(FORWARDED_BY_HEADER.toLowerCase())?.join(", ") ?? null, marker)) {
    return await refuse("the message carries this Node's own marker, so it left this Node and came back");
  }
  const parsed = parseHeaders(original);
  if (parsed.from === "") return await refuse("the message names no sender in its From header, so there is nobody for replies to go to");

  try {
    await sealManifest(env, ctx, row.org_id, {
      mailboxId: row.mailbox_id, authorUserId: row.copy_by, senderAddress: row.address,
      to: [row.destination], subject: row.subject, bodyTyped: "", fidelity: "authored",
      copy: {
        receiptId, messageId, original,
        fromName: `${parsed.fromName ?? parsed.from} via ${row.mailbox_name}`,
        replyTo: parsed.from, replyToName: parsed.fromName,
        inReplyTo: parsed.inReplyTo === null ? null : `<${parsed.inReplyTo}>`,
        references: boundedReferences(messageIds(fields.get("references")?.[0] ?? "")),
        marker, optedInAt: row.copy_at,
      },
    });
  } catch (error) {
    // A refusal by name (too large, not UTF-8, a suppressed recipient, sending authority, the From address malformed)
    // is recorded. A fault (5xx, or anything that is not a refusal) is thrown, so the outbox tries again.
    // A 5xx CallerError (`unavailable`) is a fault and is retried. `< 500` against `<= 500` survives `mutants`, and
    // that is accepted: no CallerError is minted with status 500, so the two cannot differ.
    if (error instanceof CallerError && error.status < 500) return await refuse(error.message);
    throw error;
  }
}

/**
 * Why copies may not be turned on for an address, or null (ADR 47, amended 3 October 2026). Shared by the opt-in and
 * the take-over's `copy: true`, and named by code, so each refusal is one an administrator can act on.
 */
export async function copyRefusal(
  env: Env, orgId: string, userId: string, mailboxId: string, address: string, destination: string,
): Promise<CallerError | null> {
  if (env.EMAIL === undefined) {
    return conflict("E_COPY_NEEDS_SENDING", {
      what: "this Node has no send_email binding, so it cannot send a copy",
      why: "a copy is an ordinary send through Email Sending, from the address itself",
      fix: "add a send_email binding to wrangler.jsonc and deploy again, then turn copies on",
    });
  }
  if (!(await maySend(env, { orgId, userId }, mailboxId))) {
    return forbidden("E_COPY_NEEDS_SEND_PROPOSE", {
      what: `you do not hold send.propose on the mailbox ${address} files into`,
      why: "each copy is sealed under the administrator who turned copies on, as its author, and an author must be "
        + "allowed to send as the mailbox; it is read again at every copy",
      fix: "grant yourself send.propose on that mailbox (People), then turn copies on",
    });
  }
  const domain = destination.slice(destination.lastIndexOf("@") + 1).toLowerCase();
  const ours = domain === address.slice(address.lastIndexOf("@") + 1).toLowerCase() || (await env.CATALOG.prepare(
    "SELECT 1 AS hit FROM addresses WHERE org_id = ? AND lower(substr(address, instr(address, '@') + 1)) = ? LIMIT 1",
  ).bind(orgId, domain).first<{ hit: number }>()) !== null;
  if (ours) {
    return conflict("E_COPY_WOULD_LOOP", {
      what: `${destination} is on ${domain}, where this organisation receives mail`,
      why: "a copy sent there could route straight back to this Node, by its own rule or a catch-all",
      fix: "keep the forward without copies, or put the rule back",
    });
  }
  return null;
}

/**
 * Turns copies on or off for one address that keeps a forward (`POST /api/forwards/copy`). On records who and when, and
 * is the authority every copy is sealed under; off clears both, and a copy sealed before it is withheld at dispatch.
 */
export async function setKeptForwardCopy(
  env: Env, ctx: Ctx, orgId: string, userId: string, address: string, copy: boolean,
): Promise<{ address: string; to: string; by: string | null; at: string | null }> {
  const normalized = address.trim().toLowerCase();
  const row = await env.CATALOG.prepare(
    "SELECT mailbox_id, kept_forward_to FROM addresses WHERE org_id = ? AND address = ? LIMIT 1",
  ).bind(orgId, normalized).first<{ mailbox_id: string; kept_forward_to: string | null }>();
  if (row === null || row.kept_forward_to === null) {
    throw notFound("E_ADDRESS_KEEPS_NO_FORWARD", {
      what: `${normalized} is not an address of this organisation that keeps a forward`,
      why: "a copy is what follows a kept forward that Cloudflare refuses, so there is nothing to follow",
      fix: "GET /api/forwards lists the addresses that keep one; a forward is kept by taking over its rule with forward: \"keep\"",
    });
  }
  if (copy) {
    const refusal = await copyRefusal(env, orgId, userId, row.mailbox_id, normalized, row.kept_forward_to);
    if (refusal !== null) throw refusal;
  }
  const at = new Date(ctx.now()).toISOString();
  await auditedBatch(env, ctx, orgId, {
    action: "kept_forward.copy_set", outcome: "ok", actorUserId: userId, subject: normalized,
    // The destination is not named: the trail is permanent and it is usually somebody's own inbox.
    detail: { copy, mailboxId: row.mailbox_id },
  }, (entry) => [entry, env.CATALOG.prepare(
    "UPDATE addresses SET copy_by = ?, copy_at = ? WHERE org_id = ? AND address = ?",
  ).bind(copy ? userId : null, copy ? at : null, orgId, normalized)]);
  return { address: normalized, to: row.kept_forward_to, by: copy ? userId : null, at: copy ? at : null };
}
