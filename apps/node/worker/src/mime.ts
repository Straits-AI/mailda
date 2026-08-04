import { BUDGETS } from "@mailda/budgets";

/**
 * RFC 5322 header parsing — headers only, deliberately (#27).
 *
 * `postal-mime` was measured at **+106.6 KiB** on the bundle and deferred to #28, which is the ticket
 * that actually renders a body. The reasoning is in `docs/receipts/mime-header-parse.md`, and the
 * short version is that headers and bodies carry different risk: a bug here produces a **mis-threaded
 * conversation or a mangled subject**, on a path that reaches the DOM only through `textContent`,
 * while body parsing feeds a renderer with attacker-chosen structure. If #28 adopts a parser, this
 * file is deleted rather than kept beside it.
 *
 * What this must survive is real mail, which means: folded lines, duplicated headers, missing headers,
 * RFC 2047 encoded words in several charsets, malformed base64, `References` chains of arbitrary
 * length, and header blocks that never terminate. Every one of those has a test.
 */

const MAX_HEADER_BYTES = BUDGETS["mime.max_header_bytes"];
const MAX_REFERENCES = BUDGETS["mime.max_references_depth"];

export interface ParsedHeaders {
  messageId: string | null;
  inReplyTo: string | null;
  /** Bounded: the first id of the References chain, which is the thread root. */
  referencesRoot: string | null;
  subject: string;
  from: string;
  date: string | null;
}

/**
 * Splits the header block off the front of a message.
 *
 * Bounded at 64 KiB: a message with no blank line in its first 64 KiB is malformed, and reading
 * further to prove it costs memory against the 128 MB limit for nothing. Handles a bare-LF separator
 * as well as CRLF, because real senders emit both and refusing the former loses mail that every other
 * client accepts.
 */
export function headerBlock(raw: Uint8Array): string {
  const limit = Math.min(raw.length, MAX_HEADER_BYTES);
  for (let i = 0; i + 1 < limit; i++) {
    if (raw[i] === 0x0a && raw[i + 1] === 0x0a) {
      return new TextDecoder().decode(raw.subarray(0, i));
    }
    if (
      i + 3 < limit &&
      raw[i] === 0x0d && raw[i + 1] === 0x0a && raw[i + 2] === 0x0d && raw[i + 3] === 0x0a
    ) {
      return new TextDecoder().decode(raw.subarray(0, i));
    }
  }
  // No separator found. Treat what we have as headers rather than discarding the message: §24 says
  // accepted mail is never lost, and a header-only message is still readable.
  return new TextDecoder().decode(raw.subarray(0, limit));
}

/**
 * Unfolds continuation lines (RFC 5322 §2.2.3) and returns `name -> values`, lowercased names.
 *
 * Duplicates are kept as a list rather than overwritten. `Received` appears many times by definition,
 * and a message with two `Subject` headers is a real thing that exists — silently picking one and
 * discarding the other is how a parser and a renderer end up disagreeing.
 */
export function headerFields(block: string): Map<string, string[]> {
  const fields = new Map<string, string[]>();
  let name: string | null = null;
  let value = "";

  const commit = () => {
    if (name === null) return;
    const list = fields.get(name) ?? [];
    list.push(value.trim());
    fields.set(name, list);
    name = null;
    value = "";
  };

  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0) continue;
    // A leading space or tab continues the previous field.
    if (line[0] === " " || line[0] === "\t") {
      if (name !== null) value += " " + line.trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 1) continue; // not a field; skip rather than guess
    commit();
    name = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1);
  }
  commit();
  return fields;
}

/**
 * Decodes RFC 2047 encoded words (`=?utf-8?B?...?=`).
 *
 * A word that fails to decode is left **as written** rather than dropped or replaced. A subject that
 * reads `=?utf-8?B?bad?=` is ugly and honest; an empty subject is a lie about what the sender sent,
 * and a thrown error would lose the message.
 */
export function decodeEncodedWords(text: string): string {
  return text.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, encoding, payload) => {
    try {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Uint8Array.from(atob(payload.replace(/\s/g, "")), (c) => c.charCodeAt(0))
          : quotedPrintableWord(payload);
      // A charset the runtime does not know throws, and is caught below.
      // Workers types require both options. `fatal: false` is the point: a byte sequence that
      // is invalid in the declared charset yields replacement characters rather than throwing, so a
      // partly-mangled subject still reaches the reader.
      return new TextDecoder(charset.trim().toLowerCase(), { fatal: false, ignoreBOM: false }).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/** Q-encoding: like quoted-printable, but `_` is a space. */
function quotedPrintableWord(payload: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i]!;
    if (ch === "_") {
      out.push(0x20);
    } else if (ch === "=" && i + 2 < payload.length) {
      const hex = payload.slice(i + 1, i + 3);
      const byte = Number.parseInt(hex, 16);
      if (Number.isNaN(byte)) {
        out.push(ch.charCodeAt(0));
      } else {
        out.push(byte);
        i += 2;
      }
    } else {
      out.push(ch.charCodeAt(0));
    }
  }
  return new Uint8Array(out);
}

/**
 * Extracts `<addr-spec>` tokens. Used for `Message-ID`, `In-Reply-To` and `References`.
 *
 * Angle brackets are stripped, because that is the form these are compared in. Real mail omits them,
 * duplicates them, and separates ids with commas as well as whitespace, so all three are tolerated.
 */
export function messageIds(value: string, limit = MAX_REFERENCES): string[] {
  const ids: string[] = [];
  const bracketed = value.matchAll(/<([^<>]+)>/g);
  for (const match of bracketed) {
    ids.push(match[1]!.trim());
    if (ids.length >= limit) return ids;
  }
  if (ids.length > 0) return ids;

  // No brackets at all: fall back to whitespace/comma splitting rather than returning nothing.
  for (const token of value.split(/[\s,]+/)) {
    const trimmed = token.trim();
    if (trimmed.length > 0 && trimmed.includes("@")) ids.push(trimmed);
    if (ids.length >= limit) break;
  }
  return ids;
}

/** The address from a `From` header, without its display name. */
export function addressOf(value: string): string {
  const bracketed = /<([^<>]+)>/.exec(value);
  if (bracketed !== null) return bracketed[1]!.trim().toLowerCase();
  return value.split(/[\s,]+/).find((token) => token.includes("@"))?.trim().toLowerCase() ?? "";
}

/**
 * Normalises a `Date` header to an ISO string, or null.
 *
 * Null rather than "now": a message whose date cannot be read has an *unknown* send time, and
 * substituting the current time would silently reorder someone's mailbox. The caller decides what to
 * sort by when this is null, and it decides visibly.
 */
export function sentAt(value: string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function parseHeaders(raw: Uint8Array): ParsedHeaders {
  const fields = headerFields(headerBlock(raw));
  const first = (name: string): string | undefined => fields.get(name)?.[0];

  const references = messageIds(first("references") ?? "");
  const messageId = messageIds(first("message-id") ?? "")[0] ?? null;
  const inReplyTo = messageIds(first("in-reply-to") ?? "")[0] ?? null;

  return {
    messageId,
    inReplyTo,
    // The root is the chain's first entry. Without a chain, this message is its own root — which is
    // what makes the column non-null for every message and the thread query one index scan.
    referencesRoot: references[0] ?? null,
    subject: decodeEncodedWords(first("subject") ?? ""),
    from: addressOf(first("from") ?? ""),
    date: sentAt(first("date")),
  };
}
