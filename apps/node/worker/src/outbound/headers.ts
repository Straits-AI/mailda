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

// eslint-disable-next-line no-control-regex
const CONTROL = /[\r\n\0]/;
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x20-\x7e]/;
/** RFC 5322 field names: printable ASCII, no colon, no space. */
const VALID_NAME = /^[\x21-\x39\x3b-\x7e]+$/;

/** RFC 2047 encodes a value that is not already ASCII. Applied automatically, never by a caller. */
function encodeIfNeeded(value: string): string {
  if (!NON_ASCII.test(value)) return value;
  const utf8 = new TextEncoder().encode(value);
  return `=?utf-8?B?${btoa(String.fromCharCode(...utf8))}?=`;
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

  /** An address list. Each address is normalised, so a caller cannot pass a pre-joined string. */
  addAddresses(name: string, addresses: readonly string[]): this {
    if (addresses.length === 0) return this;
    return this.add(name, addresses.map((address) => normalizeAddress(name, address)).join(", "));
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
  bytes(body: string): Uint8Array {
    return new TextEncoder().encode(`${this.#fields.join("\r\n")}\r\n\r\n${body}`);
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
