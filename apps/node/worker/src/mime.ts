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
  /** The From header's display name (0068), or null — see `displayNameOf`. */
  fromName: string | null;
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
  return splitHeaders(raw).block;
}

/**
 * `headerBlock`, and whether the bound cut it: `truncated` is true when no separator was found inside
 * `mime.max_header_bytes` and the message is longer than that, so what is returned is a prefix rather than
 * the whole block. The headers route says so rather than presenting a prefix as the block.
 */
export function splitHeaders(raw: Uint8Array): { block: string; truncated: boolean } {
  const limit = Math.min(raw.length, MAX_HEADER_BYTES);
  for (let i = 0; i + 1 < limit; i++) {
    if (raw[i] === 0x0a && raw[i + 1] === 0x0a) {
      return { block: new TextDecoder().decode(raw.subarray(0, i)), truncated: false };
    }
    if (
      i + 3 < limit &&
      raw[i] === 0x0d && raw[i + 1] === 0x0a && raw[i + 2] === 0x0d && raw[i + 3] === 0x0a
    ) {
      return { block: new TextDecoder().decode(raw.subarray(0, i)), truncated: false };
    }
  }
  // No separator found. Treat what we have as headers rather than discarding the message: §24 says
  // accepted mail is never lost, and a header-only message is still readable.
  return { block: new TextDecoder().decode(raw.subarray(0, limit)), truncated: raw.length > MAX_HEADER_BYTES };
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

/** One RFC 2047 encoded word: charset, encoding, payload. */
const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

/**
 * Decodes RFC 2047 encoded words (`=?utf-8?B?...?=`).
 *
 * A word that fails to decode is left **as written** rather than dropped or replaced, and so is the space
 * around it. A subject that reads `=?utf-8?B?bad?=` is ugly and honest; an empty subject is a lie about what the
 * sender sent, and a thrown error would lose the message.
 */
export function decodeEncodedWords(text: string): string {
  /*
   * Adjacent words are one run (RFC 2047 §6.2): the whitespace between two words that decode, which is where a
   * long value was folded, is not part of the text. A sender that folds a long Chinese subject into several
   * UTF-8 words, as this Node's own sender does and Gmail does, may split a character's bytes across two of
   * them, which RFC 2047 §5 forbids and real mail does; so adjacent **UTF-8** words are decoded as one byte
   * sequence. Only UTF-8: an ISO-2022-JP word ends back in ASCII (RFC 1468), and joined to the next word that
   * escape meets the next one's, which the decoder reports as U+FFFD. Every other charset is decoded word by
   * word, as it always was, and only the folding between them is dropped.
   */
  let out = "";
  let at = 0;
  let pending: Uint8Array[] = []; // adjacent UTF-8 words not yet decoded
  const flush = () => {
    if (pending.length === 0) return;
    const bytes = new Uint8Array(pending.reduce((n, piece) => n + piece.byteLength, 0));
    pending.reduce((offset, piece) => (bytes.set(piece, offset), offset + piece.byteLength), 0);
    out += UTF8.decode(bytes);
    pending = [];
  };
  let previousDecoded = false;
  for (const match of text.matchAll(ENCODED_WORD)) {
    const between = text.slice(at, match.index);
    const word = decodedWord(match[1]!, match[2]!, match[3]!);
    if (!(previousDecoded && word !== null && /^\s*$/.test(between))) {
      flush();
      out += between;
    }
    if (word === null) out += match[0];
    else if (word instanceof Uint8Array) pending.push(word);
    else {
      flush();
      out += word;
    }
    previousDecoded = word !== null;
    at = match.index + match[0].length;
  }
  flush();
  return out + text.slice(at);
}

// Workers types require both options. `fatal: false` is the point: a byte sequence that is invalid in the
// declared charset yields replacement characters rather than throwing, so a partly-mangled subject still
// reaches the reader.
const UTF8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/**
 * One word: its bytes when its charset is UTF-8 (to be joined with its neighbours'), its text otherwise, or
 * `null` when it does not decode, which the caller shows as written. A charset the runtime does not know throws
 * in `TextDecoder`, and a payload that is not base64 throws in `atob`; both are that `null`, and the word
 * standing in the subject as written is the visible state.
 */
function decodedWord(charset: string, encoding: string, payload: string): Uint8Array | string | null {
  try {
    const decoder = new TextDecoder(charset.trim().toLowerCase(), { fatal: false, ignoreBOM: false });
    const bytes = encoding.toUpperCase() === "B"
      ? Uint8Array.from(atob(payload.replace(/\s/g, "")), (c) => c.charCodeAt(0))
      : quotedPrintableWord(payload);
    // `encoding` is the label's canonical name, so `utf8` and `UTF-8` are both `utf-8`.
    return decoder.encoding === "utf-8" ? bytes : decoder.decode(bytes);
  } catch {
    return null;
  }
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

/**
 * Every address in a `To`/`Cc`/`Reply-To` header, lower-cased, display names dropped, in header order.
 * Split on commas outside quotes and angle brackets, since a display name may carry either. Bounded so a
 * header of a thousand recipients does not become a thousand-element reply-all.
 */
export function addressesOf(value: string, limit = 100): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, piece = "";
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") depth += 1;
    else if (!quoted && char === ">") depth = Math.max(0, depth - 1);
    if (char === "," && !quoted && depth === 0) {
      const one = addressOf(piece);
      if (one !== "" && !out.includes(one)) out.push(one);
      piece = "";
      if (out.length >= limit) return out;
    } else piece += char;
  }
  const last = addressOf(piece);
  if (last !== "" && !out.includes(last)) out.push(last);
  return out;
}

/**
 * A sender-chosen string stored (0068) and rendered in the list; sized, not measured: a real display name is
 * a few words, and a cap keeps a hostile one from becoming a paragraph in every row.
 */
export const NAME_CHARS = 128;

/**
 * A bare domain (`paypal.com`, or `whуmelabs.test` with a Cyrillic `у`): as a display name it claims to be an
 * organization it may not be. Letters and digits of any script, because a homoglyph is a letter of another
 * one; the separators are the four IDNA treats as a dot, as they read after NFKC (U+FF0E becomes `.`, U+FF61
 * becomes U+3002).
 */
const DOMAIN_SHAPED = /^[\p{L}\p{N}\p{M}-]+([.\u3002][\p{L}\p{N}\p{M}-]+)+$/u;

/**
 * The display name of a `From` header (0068), or null.
 *
 * The part before the first unquoted `<`; no `<` is a bare address, which has no name. Quotes stripped and
 * `\"`/`\\` unescaped, encoded words decoded, control and format characters removed, whitespace collapsed.
 *
 * **Null when the name looks like an address or a domain**, and that is a security rule rather than tidiness.
 * A display name is whatever the sender typed, so `"ceo@whymelabs.test" <x@evil.example>` would put the
 * address it impersonates at the head of a list row, where the real address is the smaller text. Such a
 * name says nothing true that the address does not, so it is dropped rather than shown. The check reads the
 * name after NFKC, which folds the lookalike at signs (U+FF20, U+FE6B) into `@`, and the name returned is that
 * folded form, so what was checked is what is shown.
 *
 * **Null when nothing visible is left**, for the same reason: a name of Hangul fillers (U+3164) renders as a
 * blank sender line. Default-ignorable code points are removed with the control and format characters, and a
 * name with no letter or digit left (U+2800 alone, punctuation alone) is not a name.
 */
export function displayNameOf(fromHeader: string): string | null {
  let quoted = false;
  let end = -1;
  for (let i = 0; i < fromHeader.length; i++) {
    const char = fromHeader[i];
    if (char === "\\" && quoted) { i++; continue; }
    if (char === '"') quoted = !quoted;
    else if (char === "<" && !quoted) { end = i; break; }
  }
  if (end === -1) return null;
  let name = fromHeader.slice(0, end).trim();
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  name = decodeEncodedWords(name)
    .normalize("NFKC")
    .replace(/[\p{C}\p{Default_Ignorable_Code_Point}]/gu, (char) => (/\s/.test(char) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(name) || name.includes("@") || DOMAIN_SHAPED.test(name)) return null;
  return Array.from(name).slice(0, NAME_CHARS).join("");
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
    fromName: displayNameOf(first("from") ?? ""),
    date: sentAt(first("date")),
  };
}
