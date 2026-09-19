import { describe, expect, it } from "vitest";

import { classifyAttachment, DANGEROUS, summariseAttachments, zipEntries } from "../../src/attachments.ts";

/**
 * The verdicts, each pinned to the bytes and the name that produce it. The magic numbers are the formats'
 * own (see the module note), so a wrong constant fails here rather than letting an `MZ` through.
 */
const MZ = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
const MACHO = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]);
const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
const RAR = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const SEVENZ = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
const GZIP = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const TEXT = new TextEncoder().encode("Dear Sir");

describe("an attachment is judged by its name and its bytes, and one lying does not save it", () => {
  it.each([
    ["invoice.pdf", PDF, "plain"],
    ["photo.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "plain"],
    ["notes.txt", TEXT, "plain"],
    ["report.docx", PK, "plain"],
    ["deck.pptx", PK, "plain"],
    ["setup.exe", MZ, "executable"],
    ["setup.EXE", MZ, "executable"],
    ["driver.dll", MZ, "executable"],
    ["tool.jar", PK, "executable"],
    ["shortcut.lnk", TEXT, "executable"],
    ["run.bat", TEXT, "script"],
    ["macro.vbs", TEXT, "script"],
    ["update.ps1", TEXT, "script"],
    ["load.js", TEXT, "script"],
    ["invoice.pdf", MZ, "disguised"],
    ["photo.jpg", ELF, "disguised"],
    ["statement.docx", MACHO, "disguised"],
    [null, MZ, "disguised"],
    ["files.zip", PK, "archive"],
    ["files.rar", RAR, "archive"],
    ["files.7z", SEVENZ, "archive"],
    ["files.tar.gz", GZIP, "archive"],
    ["files.dat", PK, "archive"],
    [null, TEXT, "plain"],
    ["noextension", TEXT, "plain"],
  ] as const)("%s beginning %o is %s", (filename, head, verdict) => {
    expect(classifyAttachment(filename, head)).toBe(verdict);
  });

  it("holds a delivery for a program, a script, a disguise or an archive listing one; never a plain archive or a document", () => {
    expect([...DANGEROUS].sort()).toEqual(["archive_dangerous", "disguised", "executable", "script"]);
  });

  it("summarises postal-mime's parts by name, declared type, size and verdict, keeping no bytes", () => {
    const summary = summariseAttachments([
      { filename: "a.pdf", mimeType: "application/pdf", content: PDF.buffer },
      { filename: "b.exe", mimeType: "application/octet-stream", content: MZ },
      { filename: "c.txt", mimeType: "text/plain", content: "hello" },
    ]);
    expect(summary).toEqual([
      { filename: "a.pdf", declaredType: "application/pdf", bytes: 8, verdict: "plain" },
      { filename: "b.exe", declaredType: "application/octet-stream", bytes: 8, verdict: "executable" },
      { filename: "c.txt", declaredType: "text/plain", bytes: 5, verdict: "plain" },
    ]);
    for (const one of summary) expect(Object.keys(one)).not.toContain("content");
  });
});

/**
 * A stored (uncompressed) ZIP built by hand from the format's own layout: local headers, then the central
 * directory, then the end record. `zipEntries` reads only the last two, which is the whole point.
 */
function zipOf(entries: Array<[name: string, content: string]>, opts: { comment?: string; zip64?: boolean } = {}): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const [name, content] of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes, ...data,
    ]);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0),
      ...u16(0), ...u32(0), ...u32(offset), ...nameBytes,
    ]));
    parts.push(local);
    offset += local.length;
  }
  const directory = central.reduce((n, one) => n + one.length, 0);
  const comment = enc.encode(opts.comment ?? "");
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(directory), ...u32(opts.zip64 === true ? 0xffffffff : offset), ...u16(comment.length), ...comment,
  ]);
  const whole = new Uint8Array(offset + directory + eocd.length);
  let at = 0;
  for (const one of [...parts, ...central, eocd]) { whole.set(one, at); at += one.length; }
  return whole;
}

describe("what a ZIP lists, read from its central directory and never extracted (#267)", () => {
  it("names every entry, in order, through a trailing comment", () => {
    const zip = zipOf([["invoice.pdf", "%PDF"], ["notes/readme.txt", "hi"]], { comment: "sent by accounts" });
    expect(zipEntries(zip)).toEqual(["invoice.pdf", "notes/readme.txt"]);
  });

  it("judges an archive listing a program or a script as dangerous, and one listing documents as an archive", () => {
    expect(classifyAttachment("invoice.zip", zipOf([["invoice.pdf", "x"], ["Invoice.EXE", "MZ"]]))).toBe("archive_dangerous");
    expect(classifyAttachment("scripts.zip", zipOf([["run.ps1", "x"]]))).toBe("archive_dangerous");
    expect(classifyAttachment("docs.zip", zipOf([["a.pdf", "x"], ["b.docx", "PK"]]))).toBe("archive");
    // A nested archive is a name, not opened: what it holds is compressed data.
    expect(classifyAttachment("outer.zip", zipOf([["inner.zip", "PK\x03\x04"]]))).toBe("archive");
    // The whole file is needed; from eight bytes a ZIP is an archive and no more.
    expect(classifyAttachment("invoice.zip", PK)).toBe("archive");
  });

  it("gives up rather than guessing on what it cannot read whole", () => {
    expect(zipEntries(PK)).toBeNull();
    expect(zipEntries(zipOf([["a.exe", "x"]], { zip64: true }))).toBeNull();
    const truncated = zipOf([["a.exe", "x"]]).subarray(0, 40);
    expect(zipEntries(truncated)).toBeNull();
    // An unreadable listing is `archive`, the verdict that says nothing was looked at.
    expect(classifyAttachment("a.zip", zipOf([["a.exe", "x"]], { zip64: true }))).toBe("archive");
  });
});
