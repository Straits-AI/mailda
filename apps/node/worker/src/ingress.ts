import type { Bytes } from "@mailda/evidence";
import type { Ctx } from "@mailda/runtime";

import { putEvidence } from "./evidence-store.ts";

/**
 * Inbound receipt (§13).
 *
 * Synchronous acceptance does only what it must: resolve the recipient, persist the
 * lossless MIME, commit the receipt, and accept. Parsing, scanning, threading and Butler
 * events are all asynchronous and happen off the outbox event.
 *
 * Two orderings are load-bearing and neither is arbitrary:
 *
 *   1. **R2 before D1.** They are not one transaction. Writing the blob first means the
 *      only reachable partial state is an orphan blob, which a sweeper can collect. The
 *      reverse would leave a message row pointing at nothing — "accepted but absent",
 *      which §24 calls the most dangerous failure in mail.
 *
 *   2. **Receipt and outbox row in one `batch()`.** #5 established `batch()` is D1's only
 *      atomic primitive, so the domain write and the event that will process it commit
 *      together or not at all (§22).
 */

export interface IngressResult {
  status: "accepted" | "already_accepted" | "unknown_recipient";
  receiptId?: string;
}

export interface InboundMessage {
  /** Provider event identity. The derived key that makes this path retry-safe (#9). */
  providerEventId: string;
  envelopeFrom: string;
  envelopeTo: string;
  raw: Bytes;
}

export async function acceptInbound(
  env: Env,
  ctx: Ctx,
  orgId: string,
  message: InboundMessage,
): Promise<IngressResult> {
  // §13: resolve the recipient before touching content. An address this Node does not
  // serve is rejected without reading, storing or paying for the message.
  const address = await env.CATALOG.prepare(
    "SELECT mailbox_id FROM addresses WHERE org_id = ? AND address = ? LIMIT 1",
  )
    .bind(orgId, message.envelopeTo.toLowerCase())
    .first<{ mailbox_id: string }>();

  if (address === null) {
    return { status: "unknown_recipient" };
  }

  // Cheap idempotency check. Not the guarantee — the UNIQUE index below is (#9). This only
  // avoids writing a blob we would then discard.
  const seen = await env.CATALOG.prepare(
    "SELECT id FROM ingress_receipts WHERE org_id = ? AND provider_event_id = ? LIMIT 1",
  )
    .bind(orgId, message.providerEventId)
    .first<{ id: string }>();

  if (seen !== null) {
    return { status: "already_accepted", receiptId: seen.id };
  }

  const receiptId = ctx.id("rcpt");
  const at = new Date(ctx.now()).toISOString();
  const timeBucket = bucketFor(ctx.now());

  // (1) R2 first, so a failure here leaves nothing behind at all.
  const blobKey = `${orgId}/raw/${timeBucket}/${receiptId}.eml`;
  const stored = await putEvidence(env, blobKey, message.raw);

  // (2) Receipt and outbox row atomically. INSERT OR IGNORE on the receipt because the
  // UNIQUE index is the real guarantee: a concurrent duplicate loses here rather than
  // creating a second receipt, and repeating the batch is always safe (#9).
  const results = await env.CATALOG.batch([
    env.CATALOG.prepare(
      `INSERT OR IGNORE INTO ingress_receipts
         (id, org_id, provider_event_id, envelope_from, envelope_to,
          raw_bytes, blob_key, blob_sha256, accepted_at, key_generation)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      receiptId,
      orgId,
      message.providerEventId,
      message.envelopeFrom,
      message.envelopeTo.toLowerCase(),
      stored.plaintextBytes,
      stored.blobKey,
      stored.plaintextSha256,
      at,
      // The generation that sealed this object. R2's own metadata remains authoritative; this is the
      // indexed column the re-seal driver scans, so a new message never looks like it needs work.
      stored.keyGeneration,
    ),
    env.CATALOG.prepare(
      `INSERT INTO outbox (id, org_id, topic, payload, published_at, created_at)
       VALUES (?,?,?,?,NULL,?)`,
    ).bind(
      ctx.id("evt"),
      orgId,
      "mail.ingress.accepted",
      // References only. §13: the queue never carries the MIME payload.
      JSON.stringify({ receiptId, mailboxId: address.mailbox_id, blobKey: stored.blobKey }),
      at,
    ),
  ]);

  // If the receipt was ignored, a concurrent delivery won the race. The blob we wrote is
  // now an orphan; the sweeper collects it. Reporting `already_accepted` is honest — this
  // delivery did not create the receipt.
  const inserted = (results[0]?.meta.changes ?? 0) > 0;
  if (!inserted) {
    const winner = await env.CATALOG.prepare(
      "SELECT id FROM ingress_receipts WHERE org_id = ? AND provider_event_id = ? LIMIT 1",
    )
      .bind(orgId, message.providerEventId)
      .first<{ id: string }>();
    return { status: "already_accepted", receiptId: winner?.id };
  }

  return { status: "accepted", receiptId };
}

/**
 * Time bucket — the routing and sort unit, and what retention drops wholesale (#12).
 * Quarterly. A bucket is not a shard: the catalog maps buckets onto physical databases by
 * size, so the query shape and the 10 GB ceiling stay independent concerns.
 */
export function bucketFor(millis: number): string {
  const date = new Date(millis);
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}`;
}
