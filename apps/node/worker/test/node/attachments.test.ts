import { describe, expect, it } from "vitest";

import { classifyAttachment, DANGEROUS, summariseAttachments } from "../../src/attachments.ts";

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

  it("holds a delivery for a program, a script or a disguise, and never for an archive or a document", () => {
    expect([...DANGEROUS].sort()).toEqual(["disguised", "executable", "script"]);
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
