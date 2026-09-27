import { wordsFromHtml } from "./search-body.ts";

/**
 * A message's row preview (0068, ADR 45): one line of its body for the list, sealed at rest.
 *
 * Pure except for WebCrypto, so node tests import it. `search-body.ts` imports `previewText` from here and
 * this imports `wordsFromHtml` from there; both are function declarations, which ESM initialises before
 * either module's body runs, so the cycle cannot read anything uninitialised.
 *
 * ## Why sealed
 *
 * A preview is the most-read text of every message, and ADR 28 exists so a D1 dump does not hand over
 * content. So it is sealed under the same content key as the message's evidence, with the message id as
 * additional data: a sealed preview copied onto another row fails to open rather than showing the wrong
 * message's words. Opened only where the reader holds standing content read (`authz-read.ts`), never under a
 * supervised grant, where opening the message is the recorded act.
 */

/**
 * Sized, not measured, and it is a storage decision as well as a presentation one. The widest one-line list is
 * the single-pane layout just under 768px: 729px of text at 14px Inter (~7.7px average advance) is ~95
 * characters; 120 code points leaves margin for narrow glyphs. Bytes per message: `message-metadata-bytes.md`.
 */
export const PREVIEW_CHARS = 120;

/**
 * How much of a body `previewText` reads: a scan limit, provisional and sized not measured. The line comes
 * from the top of the body, so its work is bounded here rather than by the body, which `extractBody` passes at
 * up to `render.max_body_bytes` and which ingest and both backfills hand over on every message. 16,384
 * UTF-16 units is room for `PREVIEW_CHARS` below a quoted block of about 200 lines of 80 characters. The cost of
 * the ceiling: a reply written under a longer quote lists without a preview, which is the row a body with no
 * words of its own already gets.
 */
export const PREVIEW_SCAN_CHARS = 16_384;

/**
 * How many rows one pass of `preview-backfill.ts` projects. It lives here, not beside the pass, because the
 * doctor's `preview_backlog` and the requeue route both state it, and the doctor path may not import a file
 * that batches (`test/node/doctor-meter-honesty.test.ts`).
 *
 * Provisional, sized not measured: the body backfill's per-message work (an R2 read, a key, a decryption, a
 * parse) at the body backfill's figure. The cron runs this pass only when the body and authentication passes
 * did no work in the same invocation, so one invocation still does at most 50 such messages (25 + 25), as
 * before 0068: 50 R2 reads + <= 3 vault RPCs + <= 6 D1 statements against doctor.free.max_subrequests (1,000).
 */
export const PREVIEW_BACKFILL_LIMIT = 25;

/** AES-GCM's standard nonce length, random per seal. */
const IV_BYTES = 12;

/**
 * One line of a body, or null when there is nothing to show.
 *
 * The plain part when it has any non-whitespace, else the HTML reduced to words; then only its first
 * `PREVIEW_SCAN_CHARS`, cut before a high surrogate rather than after it. The HTML is reduced before the cut,
 * never after: a cut inside an unclosed `<style>` would let the stylesheet through as words. Quoted lines (a
 * trimmed start of `>`) are dropped, because the newest words are what a list row is for and a reply's quote
 * is the previous message. Control and format characters are removed (whitespace ones become spaces),
 * whitespace is collapsed, and the result is cut to `PREVIEW_CHARS` code points, never inside a surrogate
 * pair. No ellipsis: the stylesheet adds one where the line is cut on screen, and a stored one would be a
 * second.
 */
export function previewText(body: { text: string | null; html: string | null }): string | null {
  const whole = body.text !== null && /\S/.test(body.text) ? body.text
    : body.html !== null ? wordsFromHtml(body.html) : "";
  const end = /[\uD800-\uDBFF]/.test(whole.charAt(PREVIEW_SCAN_CHARS - 1)) ? PREVIEW_SCAN_CHARS - 1 : PREVIEW_SCAN_CHARS;
  const unquoted = whole.slice(0, end).split(/\r?\n/).filter((line) => !line.trimStart().startsWith(">")).join(" ");
  const line = unquoted
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (/\s/.test(char) ? " " : ""))
    .replace(/\s+/g, " ")
    .trim();
  if (line === "") return null;
  return Array.from(line).slice(0, PREVIEW_CHARS).join("").trimEnd();
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** base64(12-byte IV ‖ AES-256-GCM ciphertext ‖ tag), additional data the message id. */
export async function sealPreview(key: CryptoKey, messageId: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(messageId) },
    key,
    new TextEncoder().encode(text),
  ));
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return base64(out);
}

/** Reverses `sealPreview`. Throws on any failure: tamper, another row's preview, the wrong key, bad base64. */
export async function openPreview(key: CryptoKey, messageId: string, sealed: string): Promise<string> {
  // No length check of its own: a value shorter than the IV and tag is refused by AES-GCM itself.
  const bytes = unbase64(sealed);
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: new TextEncoder().encode(messageId) },
    key,
    bytes.subarray(IV_BYTES),
  );
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(opened);
}
