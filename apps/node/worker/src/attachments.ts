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
export const DANGEROUS: ReadonlySet<AttachmentVerdict> = new Set(["executable", "script", "disguised"]);

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

function extensionOf(filename: string | null): string {
  const name = (filename ?? "").trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1);
}

export function classifyAttachment(filename: string | null, head: Uint8Array): AttachmentVerdict {
  const extension = extensionOf(filename);
  const signature = signatureOf(head);
  if (EXECUTABLE_EXTENSIONS.has(extension)) return "executable";
  if (SCRIPT_EXTENSIONS.has(extension)) return "script";
  // The bytes say program and the name did not. `bin`/`elf` are above, so this is a name chosen to look
  // like something else — or no name at all, which is not more trustworthy.
  if (signature === "executable") return "disguised";
  if (ZIP_DOCUMENT_EXTENSIONS.has(extension)) return "plain";
  if (ARCHIVE_EXTENSIONS.has(extension) || signature === "archive") return "archive";
  return "plain";
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
      verdict: classifyAttachment(part.filename, bytes.subarray(0, 8)),
    };
  });
}
