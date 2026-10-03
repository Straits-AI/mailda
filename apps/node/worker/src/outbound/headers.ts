import { type Bytes, utf8 } from "@mailda/evidence";

import { unprocessable } from "../errors.ts";

/**
 * RFC 5322 header construction, and the **only** way to produce header bytes.
 *
 * ## Why this is a builder and not a validator
 *
 * The first fix for header injection was `assertHeaderSafe(field, value)` called at each site that
 * contributed a header. It worked, and it was the wrong shape — the same shape this codebase already
 * rejected once. `ui.ts` says it plainly: escaping on write "is correct only while every future author
 * remembers to do it; constructing nodes makes injection impossible instead of merely handled."
 *
 * A scattered check has exactly that flaw. The next person to add a header to an outgoing message
 * writes `headers.push(["X-Thing", value])` and nothing stops them. So the array is gone. `add()` is
 * the only way in, `bytes()` is the only way out, and neither can be bypassed without editing this
 * file — which is where someone changing this rule *should* have to be.
 *
 * That is the same structural-over-disciplined choice as the partial unique index that makes two
 * current signing keys unrepresentable, and ADR 35's manifest id that makes a stale approval moot by
 * construction.
 *
 * ## What it refuses, and why refusing beats stripping
 *
 * CR, LF and NUL end or truncate a header field. In this product that is not an abstract risk: ADR 36
 * keeps the author out of every header and Bcc out of the emitted ones, and a subject containing
 * `\r\nBcc: attacker@example.net` defeats both at once, as well as letting an author end the header
 * block early and write their own body.
 *
 * They are **refused, not stripped**. Silently removing a control character alters what the author
 * wrote and sends it anyway — the quiet alteration ADR 35 forbids, since the bytes sent must be the
 * bytes approved. A refusal the author can see is the honest outcome.
 */

const CONTROL = /[\r\n\0]/;
const NON_ASCII = /[^\x20-\x7e]/;
/** RFC 5322 field names: printable ASCII, no colon, no space. */
const VALID_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

/**
 * How many UTF-8 bytes one encoded word carries.
 *
 * RFC 2047 §2 caps an encoded word at 75 characters. `=?utf-8?B?` and `?=` take 12, leaving 63 for base64,
 * which holds 45 bytes; 42 (a multiple of 3, so no padding inside a subject) keeps the first line of
 * `Subject: ` plus one word within RFC 5322's 78-character SHOULD. Fixed by the two RFCs, not measured.
 */
const WORD_BYTES = 42;

/**
 * RFC 2047 encodes a value that is not already ASCII. Applied automatically, never by a caller.
 *
 * As **several** encoded words, each whole characters, one per folded line. It was one word of any length,
 * so a subject of about sixteen Han characters passed RFC 2047's 75-character limit on a word and one of
 * about 245 passed RFC 5322's 998-octet limit on a line, which is a MUST. A value that fits one word renders
 * exactly as it did, so a manifest sealed before this change sends the bytes it always would have.
 */
function encodeIfNeeded(value: string): string {
  return NON_ASCII.test(value) ? encodedWords(value) : value;
}

/**
 * A value as RFC 2047 encoded words of at most `WORD_BYTES` bytes of whole characters each, one per folded line.
 *
 * CRLF plus a space is folding whitespace, and a decoder ignores whitespace between adjacent encoded words
 * (RFC 2047 §6.2), so the value reads back whole. A value of `WORD_BYTES` or fewer is one word, as it always was.
 */
function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk: number[] = [];
  for (const char of value) {
    const bytes = new TextEncoder().encode(char);
    if (chunk.length + bytes.length > WORD_BYTES) {
      words.push(encodedWord(chunk));
      chunk = [];
    }
    chunk.push(...bytes);
  }
  words.push(encodedWord(chunk));
  return words.join("\r\n ");
}

function encodedWord(bytes: readonly number[]): string {
  return `=?utf-8?B?${btoa(String.fromCharCode(...bytes))}?=`;
}

/** A filename that can sit in a quoted MIME parameter as it is: printable ASCII with no quote or backslash. */
const PLAIN_PARAMETER = /^[\x20\x21\x23-\x5b\x5d-\x7e]*$/;

/** RFC 5987 / RFC 2231 `attr-char`: what a `*=` parameter carries unencoded. Everything else is `%XX`. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

/** A value as an RFC 5987 / RFC 2231 extended parameter's payload: UTF-8, percent-encoded outside `attr-char`. */
export function percentEncoded(value: string): string {
  let out = "";
  for (const char of value) {
    if (ATTR_CHAR.test(char)) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Whether a filename can go in `filename="…"` unchanged, which is also whether a download needs `filename*`. */
export function isPlainFilename(name: string): boolean {
  return PLAIN_PARAMETER.test(name);
}

/**
 * How many characters of a percent-encoded name go on one continuation line. RFC 2231 §3 continuations
 * exist so a long parameter fits RFC 5322's lines; 54 keeps the longest, ` filename*0*=utf-8''` plus the
 * segment and its `;`, within the 78-character SHOULD. Arithmetic on the RFCs, not a measurement.
 */
const SEGMENT_CHARS = 54;

/**
 * A parameter carrying a filename, for `Content-Type` (`name`) or `Content-Disposition` (`filename`).
 *
 * A plain name renders as `key="name"`, exactly as every part sealed before 29 September 2026 did, so an
 * already sealed manifest sends the bytes it was approved with. Anything else renders twice: an RFC 2047
 * encoded word in the quoted `key="…"`, which Outlook and most clients read, and RFC 2231's `key*=utf-8''…`,
 * which a client that knows it prefers (§4), split into `key*0*`, `key*1*` … continuations when long. The
 * name was `safeFilename`'s output before, which turned `合同.pdf` into `__.pdf` for the recipient.
 */
function filenameParameters(key: string, name: string): string {
  if (isPlainFilename(name)) return `${key}="${name}"`;
  // Folded inside the quotes, as a subject is: one word of a 253-byte name would be 352 characters against RFC
  // 2047's 75. RFC 5322 §3.2.4 allows folding whitespace in a quoted string, and the decoder drops it between
  // words. The first word shares its line with the field name and media type, so that line runs to about 111
  // characters for a PDF (121 for a spreadsheet's long media type, seen end to end on 30 September 2026): past
  // RFC 5322's 78 SHOULD, far inside its 998 MUST; every line after it is within 78.
  const fallback = `${key}="${encodedWords(name)}"`;
  const encoded = percentEncoded(name);
  if (encoded.length <= SEGMENT_CHARS) return `${fallback};\r\n ${key}*=utf-8''${encoded}`;
  const segments: string[] = [];
  for (let at = 0; at < encoded.length;) {
    let end = Math.min(at + SEGMENT_CHARS, encoded.length);
    // Never split a %XX triplet across two segments. `>=` in the first clause survives `mutants` and is
    // harmless: a triplet ending exactly at `end` is whole, and moving `end` back only shortens a segment.
    const lastPercent = encoded.lastIndexOf("%", end - 1);
    if (lastPercent > end - 3 && lastPercent >= at) end = lastPercent;
    segments.push(encoded.slice(at, end));
    at = end;
  }
  return [fallback, ...segments.map((segment, i) => `${key}*${i}*=${i === 0 ? "utf-8''" : ""}${segment}`)]
    .join(";\r\n ");
}

/**
 * The bytes a filename may have: 255, the file-name limit of the file systems a recipient saves to (POSIX
 * `NAME_MAX` on ext4 and APFS; NTFS counts 255 UTF-16 units, which 255 UTF-8 bytes never exceed). A fixed
 * platform value, not a measurement. Refused past it rather than cut, for the reason control characters are.
 */
export const MAX_FILENAME_BYTES = 255;

/**
 * Characters that make a shown name lie about itself: control characters, every bidirectional control
 * (`Bidi_Control`: U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069), and the line and paragraph
 * separators. `invoice<U+202E>fdp.exe` displays as `invoiceexe.pdf`, a name that shows one extension and has
 * another; U+2028 breaks a name across lines wherever it is shown. By Unicode property rather than listed by hand,
 * which is how U+061C was missed. One list for the seal (`attachmentName`) and the download (`undisguised`).
 */
const DISGUISING = String.raw`\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}`;

/** What a filename may not carry: the characters above, and a path separator, because a name is not a path. */
const NOT_IN_A_FILENAME = new RegExp(`[${DISGUISING}/\\\\]`, "u");

/** A name less the characters that would make it lie about itself: for a name somebody else wrote. */
export function undisguised(name: string): string {
  return name.replace(new RegExp(`[${DISGUISING}]`, "gu"), "");
}

/**
 * An attachment's name as the author gave it, in NFC, or a refusal.
 *
 * Kept as written: it is what the recipient sees and what the seal records, and the header builder encodes
 * it. Refused, never altered, when it carries a character above or runs past `MAX_FILENAME_BYTES`, for ADR
 * 35's reason: a send whose parts were quietly renamed is not the send its author sealed.
 */
export function attachmentName(field: string, candidate: string): string {
  const name = candidate.normalize("NFC");
  const bad = NOT_IN_A_FILENAME.exec(name);
  /*
   * `=?` opens an RFC 2047 encoded word, and a plain name is sent as it is: `=?utf-8?Q?invoice=2Ejs?=` has no
   * dot, so the judge sees no extension and calls it plain, and a recipient's client decodes it and saves
   * it under a .js name. Refused for `bad`'s reason: the name judged would not be the name received.
   */
  const word = name.includes("=?");
  if (name.trim() === "" || bad !== null || word) {
    throw unprocessable("E_ATTACHMENT_NAME_INVALID", {
      what: bad !== null
        ? `${field} ${JSON.stringify(name)} contains U+${bad[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
        : word ? `${field} ${JSON.stringify(name)} contains "=?", which a recipient's client decodes as an encoded word`
        : `${field} has no name`,
      why: "a name travels in a MIME header and is shown to the recipient; control and direction characters " +
        "can break the header or disguise the file's type, an encoded word is decoded into a different name, " +
        "and a path separator is not part of a name",
      fix: "rename the file without that character",
    });
  }
  const bytes = new TextEncoder().encode(name).byteLength;
  if (bytes > MAX_FILENAME_BYTES) {
    throw unprocessable("E_ATTACHMENT_NAME_TOO_LONG", {
      what: `${field} is ${bytes} bytes long; a name may be ${MAX_FILENAME_BYTES}`,
      why: "the file systems a recipient saves to refuse a longer name, and cutting it would send a different name",
      fix: "rename the file shorter",
    });
  }
  return name;
}

/**
 * Normalises an address, punycoding its domain.
 *
 * **This replaced a blanket refusal of every non-ASCII address**, which was a product limitation
 * invented inside a security fix: it would have made Mailda unable to write to anyone on an
 * internationalised domain — a large fraction of the world, and a strange thing for a product built in
 * Kuala Lumpur to decide by accident.
 *
 * The two halves are genuinely different problems:
 *
 *   **domain** — has a standard ASCII encoding, IDNA punycode, and the runtime already implements it
 *                correctly via `URL`. `café.example` becomes `xn--caf-dma.example` and reaches the
 *                real recipient. No dependency, no hand-rolled table.
 *   **local**   — has no ASCII encoding. A non-ASCII mailbox name requires the SMTPUTF8 extension,
 *                which this transport does not declare, so it is refused **with that named as the
 *                reason** rather than as "invalid address".
 *
 * Recorded as a real limitation in ADR 41 rather than buried here.
 */
export function normalizeAddress(field: string, value: string): string {
  const address = value.trim();

  if (CONTROL.test(address)) throw injectionError(field);

  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) {
    throw unprocessable("E_ADDRESS_MALFORMED", {
      what: `${field} is not an email address: ${JSON.stringify(address)}`,
      why: "an address needs a local part and a domain separated by @",
      fix: "supply a complete address",
    });
  }

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);

  if (NON_ASCII.test(local)) {
    throw unprocessable("E_SMTPUTF8_UNSUPPORTED", {
      what: `${field} has a non-ASCII local part: ${JSON.stringify(local)}`,
      why:
        "a mailbox name outside ASCII requires the SMTPUTF8 extension, which this transport does not " +
        "declare — unlike the domain, there is no standard ASCII encoding for it",
      fix: "use an ASCII mailbox name, or an address on a domain that provides one (ADR 41)",
    });
  }

  let asciiDomain: string;
  try {
    // The runtime's own IDNA implementation. Correct, and free.
    asciiDomain = new URL(`https://${domain}`).hostname;
  } catch {
    throw unprocessable("E_DOMAIN_MALFORMED", {
      what: `${field} has a domain that cannot be resolved to a name: ${JSON.stringify(domain)}`,
      why: "the domain is not a valid host, so it could not be encoded to ASCII",
      fix: "check the domain",
    });
  }

  if (NON_ASCII.test(asciiDomain) || CONTROL.test(asciiDomain)) {
    // Defensive: `URL` should never return this. If it does, the value must not reach a header.
    throw injectionError(field);
  }

  return `${local}@${asciiDomain}`;
}

function injectionError(field: string): Error {
  return unprocessable("E_HEADER_INJECTION", {
    what: `${field} contains a carriage return, newline or NUL`,
    why:
      "those characters end a header field, so this value could inject headers of its own — a Bcc " +
      "that exfiltrates the reply, or an early end to the header block",
    fix:
      "remove the control characters; they are refused rather than stripped, because silently " +
      "altering what an author wrote and sending it anyway is worse",
  });
}

/**
 * A header block under construction.
 *
 * There is no way to append a pre-formatted line, and that is the point. Every value passes through
 * `add`, so validation and RFC 2047 encoding cannot be forgotten by a future caller.
 */
export class HeaderBlock {
  #fields: string[] = [];

  /** A single field. Validates the name, refuses control characters, encodes non-ASCII. */
  add(name: string, value: string): this {
    if (!VALID_NAME.test(name)) {
      throw unprocessable("E_HEADER_NAME_INVALID", {
        what: `${JSON.stringify(name)} is not a valid header field name`,
        why: "RFC 5322 field names are printable ASCII without a colon or space",
        fix: "use a conventional field name",
      });
    }
    if (CONTROL.test(value)) throw injectionError(name);
    this.#fields.push(`${name}: ${encodeIfNeeded(value)}`);
    return this;
  }

  /**
   * A field whose value ends in a filename parameter: `Content-Type` with `name`, `Content-Disposition` with
   * `filename`. The name is encoded here (`filenameParameters`), so no caller interpolates one into a value.
   */
  addWithFilename(name: string, value: string, key: "name" | "filename", filename: string): this {
    if (CONTROL.test(filename)) throw injectionError(name);
    this.add(name, value);
    this.#fields[this.#fields.length - 1] += `; ${filenameParameters(key, filename)}`;
    return this;
  }

  /** An address list. Each address is normalised, so a caller cannot pass a pre-joined string. */
  addAddresses(name: string, addresses: readonly string[]): this {
    if (addresses.length === 0) return this;
    return this.add(name, addresses.map((address) => normalizeAddress(name, address)).join(", "));
  }

  /**
   * One address with a display name: `"Alice via Support" <support@acme.example>`, for a copy's From and Reply-To
   * (ADR 47). The name is a quoted string when it is ASCII and RFC 2047 encoded words when it is not; the address is
   * normalised. Built here, because `add` would encode the whole value, address and all, when the name is not ASCII.
   */
  addNamed(name: string, displayName: string | null, address: string): this {
    const normalized = normalizeAddress(name, address);
    if (displayName === null || displayName === "") return this.add(name, normalized);
    if (CONTROL.test(displayName)) throw injectionError(name);
    this.add(name, normalized);
    const phrase = NON_ASCII.test(displayName) ? encodedWords(displayName) : `"${displayName.replace(/(["\\])/g, "\\$1")}"`;
    this.#fields[this.#fields.length - 1] = `${name}: ${phrase} <${normalized}>`;
    return this;
  }

  /** Present only when there is something to add — keeps callers free of `if` around every field. */
  addIfPresent(name: string, value: string | null | undefined): this {
    return value == null || value === "" ? this : this.add(name, value);
  }

  /**
   * The bytes. The only exit, so every field in the result went through `add`.
   *
   * The body is *not* validated for control characters — a body is allowed to contain anything, and
   * that is precisely why the blank line separating it from the headers must be produced here rather
   * than by a caller concatenating strings.
   */
  bytes(body: string): Bytes {
    return utf8(`${this.#fields.join("\r\n")}\r\n\r\n${body}`);
  }

  /** For tests and diagnostics. Never used to build the wire form. */
  get fieldCount(): number {
    return this.#fields.length;
  }
}

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * Same class of bug as the above and found by auditing rather than by review: `index.ts` built
 * `filename="${receiptId}.eml"` from a path segment. Not exploitable today — `authorize()` proves the
 * id exists in D1 before it is used, and a raw CR or LF cannot survive in a URL pathname — but a
 * quote would still break the quoted string, and "not reachable today" is a property of two other
 * functions rather than of this one.
 */
export function safeFilename(candidate: string, extension: string): string {
  const cleaned = candidate.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `${cleaned.length > 0 ? cleaned : "message"}${extension}`;
}
