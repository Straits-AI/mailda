import type { Bytes } from "@mailda/evidence";

import { unprocessable } from "../errors.ts";
import { headerFields, splitHeaders } from "../mime.ts";
import { HeaderBlock } from "./headers.ts";

/**
 * A copy's bytes (ADR 47, amended 3 October 2026): the original message's body as its sender wrote it, under headers
 * this Node writes. What a mailing list does, and for the same reason: the copy leaves from this Node's own domain, so
 * it is From this Node's address (DMARC aligns on the customer's domain), says who wrote it in the From display name
 * ("Alice via Support"), and sends replies to her (Reply-To). The original's own From, DKIM signature, Received chain
 * and every other header stay in the stored evidence and do not travel: they describe a different message.
 *
 * The body as written, not the original attached as `message/rfc822` under a note (the forward a person sends,
 * 0059). A recipient reads the message where they expect to, the way the forward rule delivered it; a wrapper would
 * need text this Node writes to an outsider, in a language it would have to choose. What the copy is lives in the
 * headers: the display name, `X-Original-From`, and `X-Mailda-Copy-Of` naming this Node.
 *
 * Pure: the seal calls it to know the exact size before anything is stored, and `renderRfc822` calls it with the same
 * inputs at dispatch, so the bytes sent are the bytes the size was checked on.
 */

/** The marker a copy carries, this Node's claim id: a copy that comes back is stored and never forwarded or copied. */
export const COPY_OF_HEADER = "X-Mailda-Copy-Of";

/** What a copy's headers say, as the seal froze it (`send_copies`) plus the manifest's own columns. */
export interface CopyHeaders {
  /** The address the original arrived at, which is this mailbox's own. */
  from: string;
  /** "<sender's name> via <mailbox name>". */
  fromName: string;
  replyTo: string;
  replyToName: string | null;
  to: readonly string[];
  subject: string;
  rfcMessageId: string;
  sealedAt: string;
  inReplyTo: string | null;
  references: string | null;
  marker: string;
}

const NON_ASCII = /[^\x20-\x7e]/;

function unreadable(why: string): Error {
  return unprocessable("E_COPY_UNREADABLE", {
    what: "the stored message cannot be copied as it was written",
    why,
    fix: "nothing to change here: the message is stored and readable in its mailbox, and its .eml can be downloaded",
  });
}

export function copyMessage(headers: CopyHeaders, original: Bytes): Bytes {
  const { block, bodyAt } = splitHeaders(original);
  if (bodyAt === null) throw unreadable("its header block has no end within mime.max_header_bytes, so where its body starts is not known");
  const fields = headerFields(block);
  const body = original.subarray(bodyAt);
  // RFC 2045's defaults when the original declared none, stated rather than left implicit; 8bit when the bytes say so.
  const contentType = fields.get("content-type")?.[0] ?? 'text/plain; charset="us-ascii"';
  const transfer = fields.get("content-transfer-encoding")?.[0] ?? (body.every((byte) => byte < 0x80) ? "7bit" : "8bit");
  if (NON_ASCII.test(contentType) || NON_ASCII.test(transfer)) {
    throw unreadable("its Content-Type or Content-Transfer-Encoding is not ASCII, so it cannot be carried over unchanged");
  }
  /*
   * The transport hands Cloudflare text (`transport.ts` decodes the bytes as UTF-8), so a body with 8-bit bytes in
   * another charset would arrive altered. Refused by name rather than sent changed; base64 and quoted-printable
   * bodies, which is nearly all mail, are ASCII and pass.
   */
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body);
  } catch {
    throw unprocessable("E_COPY_NOT_UTF8", {
      what: "the stored message's body carries 8-bit bytes that are not UTF-8",
      why: "this Node's outbound transport takes text, so those bytes would arrive altered, and a copy that is not the "
        + "message as written is not one",
      fix: "nothing to change here: the message is stored and readable in its mailbox, and its .eml can be downloaded",
    });
  }
  const head = new HeaderBlock()
    .addNamed("From", headers.fromName, headers.from)
    .addNamed("Reply-To", headers.replyToName, headers.replyTo)
    .addAddresses("To", headers.to)
    .add("Subject", headers.subject)
    .add("Message-ID", `<${headers.rfcMessageId}>`)
    .add("Date", new Date(headers.sealedAt).toUTCString())
    .add("MIME-Version", "1.0")
    .add("Content-Type", contentType)
    .add("Content-Transfer-Encoding", transfer)
    .addIfPresent("In-Reply-To", headers.inReplyTo)
    .addIfPresent("References", headers.references)
    .addNamed("X-Original-From", headers.replyToName, headers.replyTo)
    .add(COPY_OF_HEADER, headers.marker)
    .bytes("");
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(head, 0);
  out.set(body, head.byteLength);
  return out;
}
