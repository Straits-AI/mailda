import type { AttachmentVerdict } from "@mailda/contract/schemas";

/**
 * What an attachment is, decided from its bytes as well as its name.
 *
 * A policy, not a scanner (docs/mail-security.md). Nothing here opens an archive, runs a signature or asks a
 * service; it reads the first bytes of each part and the extension on its name, and says one of five words.
 * Each is a verdict a person can check by looking at the file, which is what makes it a fact a mailbox may
 * act on rather than a guess it must trust.
 *
 * ## Both the name and the bytes, because one lies
 *
 * The magic numbers are the formats' own, published: PE/COFF begins `MZ` (Microsoft PE Format), ELF begins
 * `\x7fELF` (System V ABI), Mach-O begins `FEEDFACE`/`FEEDFACF`/`CAFEBABE` (Apple's loader; the last is also
 * a Java class file, and both are code), ZIP begins `PK\x03\x04` (PKWARE APPNOTE), RAR `Rar!\x1a\x07`,
 * 7-Zip `7z\xbc\xaf\x27\x1c`, gzip `\x1f\x8b`, PDF `%PDF`. An `.exe` renamed `invoice.pdf` still begins
 * `MZ`, and that is the `disguised` verdict: the name says document and the bytes say program. A file
 * whose name says program is `executable` whatever its bytes, because the name is what a double-click reads.
 *
 * ## Scripts are executables that have no magic
 *
 * `.js`, `.vbs`, `.ps1`, `.bat` and their kin are text, and text has no signature. They are decided by name
 * alone — `script` — and held to the same standard as a binary, since a mail client hands both to the shell.
 *
 * ## Archives are said, not judged
 *
 * A `.zip` is `archive`, and so is anything with an archive signature under a name that does not say so —
 * except Office documents, which are ZIPs by construction and are `plain`. Whether an archive holds an
 * executable is not looked at: that is the *archives-in-archives* row still open in the design note, and a
 * verdict that claimed to have looked would be the overclaim AGENTS.md forbids.
 * ponytail: archives are not opened; nested content is unknown. Walk the central directory if it matters.
 */
export interface AttachmentSummary {
  filename: string | null;
  declaredType: string;
  bytes: number;
  verdict: AttachmentVerdict;
}

/** Verdicts a mailbox may hold a delivery back for. Archives are not among them: see the module note. */
export const DANGEROUS: ReadonlySet<AttachmentVerdict> = new Set([
  "executable", "script", "disguised", "archive_dangerous",
]);

/** A mailbox's declared limits (0065). `null` on either is unbounded. */
export interface AttachmentLimits {
  maxBytes: number | null;
  /** Lower-case extensions without the dot. An attachment with no extension matches nothing on the list. */
  allowedTypes: readonly string[] | null;
}

/**
 * The extensions list as the column stores it. NULL is unbounded, by declaration. Anything that is not a
 * JSON array is not "unbounded": only `setAttachmentLimits` writes the column and it writes an array, so any
 * other value is corruption, and reading corruption as "accept everything" would fail a policy open.
 */
export function allowedTypesOf(column: string | null): string[] | null {
  if (column === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(column);
  } catch (error) {
    throw new Error(`mailboxes.attachment_allowed_types is not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("mailboxes.attachment_allowed_types is JSON but not an array");
  return parsed.map((one) => String(one).toLowerCase());
}

/** Which of the attachments break the mailbox's limits, and how. Empty when nothing does. */
export function overLimits(
  attachments: ReadonlyArray<{ filename: string | null; bytes: number }>, limits: AttachmentLimits,
): Array<{ filename: string | null; because: "too_large" | "type_refused" }> {
  const broken: Array<{ filename: string | null; because: "too_large" | "type_refused" }> = [];
  for (const one of attachments) {
    if (limits.maxBytes !== null && one.bytes > limits.maxBytes) {
      broken.push({ filename: one.filename, because: "too_large" });
    } else if (limits.allowedTypes !== null && !limits.allowedTypes.includes(extensionOf(one.filename))) {
      broken.push({ filename: one.filename, because: "type_refused" });
    }
  }
  return broken;
}

const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "dll", "com", "scr", "pif", "cpl", "msi", "msp", "sys", "drv", "ocx", "app", "dmg", "pkg", "deb",
  "rpm", "jar", "class", "elf", "bin", "run", "lnk", "hta", "reg", "inf", "chm",
]);
const SCRIPT_EXTENSIONS = new Set([
  "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "psm1", "sh", "bash", "zsh", "py", "rb",
  "pl", "php", "scpt", "applescript",
]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "gz", "tgz", "tar", "bz2", "xz", "z", "cab", "iso"]);
/** OOXML and OpenDocument: ZIPs by construction, and documents by any honest reading. */
const ZIP_DOCUMENT_EXTENSIONS = new Set([
  "docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "odt", "ods", "odp", "epub", "xpi", "apk",
]);

type Signature = "executable" | "archive" | "document";

function signatureOf(head: Uint8Array): Signature | null {
  const at = (i: number) => head[i] ?? -1;
  if (at(0) === 0x4d && at(1) === 0x5a) return "executable"; // MZ
  if (at(0) === 0x7f && at(1) === 0x45 && at(2) === 0x4c && at(3) === 0x46) return "executable"; // \x7fELF
  const word = (at(0) << 24 | at(1) << 16 | at(2) << 8 | at(3)) >>> 0;
  if (word === 0xfeedface || word === 0xfeedfacf || word === 0xcefaedfe || word === 0xcffaedfe
    || word === 0xcafebabe) return "executable";
  if (at(0) === 0x50 && at(1) === 0x4b && at(2) === 0x03 && at(3) === 0x04) return "archive"; // PK
  if (at(0) === 0x52 && at(1) === 0x61 && at(2) === 0x72 && at(3) === 0x21 && at(4) === 0x1a && at(5) === 0x07) return "archive";
  if (at(0) === 0x37 && at(1) === 0x7a && at(2) === 0xbc && at(3) === 0xaf && at(4) === 0x27 && at(5) === 0x1c) return "archive";
  if (at(0) === 0x1f && at(1) === 0x8b) return "archive"; // gzip
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) return "document"; // %PDF
  return null;
}

export function extensionOf(filename: string | null): string {
  const name = (filename ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

/**
 * The verdict from the name and the first bytes. Given the **whole** attachment, a ZIP is also read for what
 * it lists (`zipEntries`), and one naming a program or a script is `archive_dangerous`. Eight bytes are
 * enough for everything else, which is why the two callers that only have a head still get a verdict.
 */
export function classifyAttachment(filename: string | null, bytes: Uint8Array): AttachmentVerdict {
  const extension = extensionOf(filename);
  const signature = signatureOf(bytes.subarray(0, 8));
  if (EXECUTABLE_EXTENSIONS.has(extension)) return "executable";
  if (SCRIPT_EXTENSIONS.has(extension)) return "script";
  // The bytes say program and the name did not. `bin`/`elf` are above, so this is a name chosen to look
  // like something else — or no name at all, which is not more trustworthy.
  if (signature === "executable") return "disguised";
  if (ZIP_DOCUMENT_EXTENSIONS.has(extension)) return "plain";
  if (ARCHIVE_EXTENSIONS.has(extension) || signature === "archive") {
    const listed = zipEntries(bytes);
    return listed !== null && listed.some((name) => {
      const inner = extensionOf(name);
      return EXECUTABLE_EXTENSIONS.has(inner) || SCRIPT_EXTENSIONS.has(inner);
    }) ? "archive_dangerous" : "archive";
  }
  return "plain";
}

/** Entries the central directory walk will read before giving up. A listing this long is not mail. */
const MAX_ZIP_ENTRIES = 10_000;

/**
 * The names a ZIP's central directory lists, without extracting anything (#267). Null when the bytes are
 * not a ZIP this can read whole: no end-of-central-directory record in the last 64 KiB, a ZIP64 offset, or a
 * directory that runs off the end. A nested archive is a name in this list and is not opened; what it holds
 * is compressed data and reading it would mean extracting, which is the line this does not cross. Names in
 * an encrypted ZIP are still in the clear, so a password does not hide a `.exe` from this.
 */
export function zipEntries(bytes: Uint8Array): string[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: signature 0x06054b50, fixed 22 bytes plus a comment of at most 65,535.
  const floor = Math.max(0, bytes.byteLength - 22 - 65_535);
  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= floor; at--) {
    if (view.getUint32(at, true) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || count === 0xffff || offset + size > bytes.byteLength) return null;
  const names: string[] = [];
  let at = offset;
  const decoder = new TextDecoder();
  for (let i = 0; i < Math.min(count, MAX_ZIP_ENTRIES); i++) {
    // Central directory file header: signature 0x02014b50, fixed 46 bytes, then name, extra, comment.
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) return null;
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (at + 46 + nameLength > bytes.byteLength) return null;
    names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** Summarises `postal-mime`'s attachments: names, declared types, sizes, and a verdict each. */
export function summariseAttachments(
  parts: ReadonlyArray<{ filename: string | null; mimeType: string; content: ArrayBuffer | Uint8Array | string }>,
): AttachmentSummary[] {
  return parts.map((part) => {
    const bytes = typeof part.content === "string"
      ? new TextEncoder().encode(part.content)
      : part.content instanceof Uint8Array ? part.content : new Uint8Array(part.content);
    return {
      filename: part.filename,
      declaredType: part.mimeType,
      bytes: bytes.byteLength,
      verdict: classifyAttachment(part.filename, bytes),
    };
  });
}
