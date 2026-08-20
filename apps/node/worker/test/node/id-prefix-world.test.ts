import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ID_PREFIXES, idPatternSource } from "@mailda/runtime";

/**
 * A closed world over every hand-written identifier pattern in the repository (#49).
 *
 * ## The defect that earned this file
 *
 * `packages/contract/src/send-mail.ts` required `/^case_[0-9A-HJKMNP-TV-Z]{26}$/`. `src/cases.ts` minted
 * `ctx.id` with a three-letter case prefix. **A case id this Node produces could not pass its own
 * contract's validation** — and nothing in the repository could have noticed, because the two spellings
 * lived in two packages and neither had ever been compared to the other. It was latent only because
 * `caseId` is optional on `mail.send` and nothing populates it; `case.assign` and `case.close` are shipping
 * Butler nodes that name case ids, which is where latent stops.
 *
 * The prefix is now chosen **once**, in `packages/runtime/src/ids.ts`, and both sides read it. That closes
 * the two spellings that existed. It does not, on its own, stop a third: the next person to need a
 * validated id can write the pattern out again, and everything else will pass.
 *
 * So this file is the half that makes the registry the only door. The rule is not "prefixes must agree" —
 * that is the symptom — it is **no file may write an identifier pattern at all**, in a contract, an AST, a
 * route or a query. A pattern that is not written cannot disagree with anything.
 *
 * ## Two things are scanned, and the second is the one that would have been missed
 *
 *   1. **An anchored prefixed pattern**: a `^`, a lowercase prefix, an underscore, and a `{26}` somewhere
 *      after it. That is what the divergent line looked like.
 *   2. **The Crockford alphabet itself**, in either of its two spellings — the character class the contract
 *      used, and the encoder's own thirty-two characters. A second copy of the alphabet is a divergence one
 *      level down: correct until somebody changes what `ctx.id` emits, and then a validator accepting ids
 *      nothing can mint. `idPattern` builds its class *from* `ULID_ALPHABET` for exactly this reason, which
 *      is also why `ids.ts` is not in the permitted list below — it writes no pattern to permit.
 *
 * ## What it found the day it was written
 *
 * A second divergence of the same family. `senderIdentityId` required the **send manifest's** prefix, and a
 * sender identity has no table at all — so a field was validating one object's id space against another's.
 * Recorded in `packages/runtime/src/ids.ts` and corrected in the contract rather than exempted here.
 *
 * ## What it deliberately does not catch
 *
 * - **Comment prose.** Lines that are pure comment are skipped, because this file, the registry and the
 *   contract all *discuss* the historical pattern and a scan that flagged the discussion would be
 *   unusable. The cost is that a pattern hidden in a comment is unflagged, which is harmless: a comment
 *   validates nothing. The extractor is proved against a literal fixture below rather than against any
 *   file's contents, so skipping comments cannot make it vacuous.
 * - **A trailing comment on a code line.** Still scanned. Stated rather than fixed: the simple rule is the
 *   one that stays true.
 * - **A pattern built at runtime from a variable.** `new RegExp(somethingElse)` is invisible to a regex.
 *   Nothing does this today; a site that started to would go unseen here.
 * - **`test/`.** A fixture writes `"cas_does_not_exist"` on purpose, and scanning tests would force an
 *   allowlist that grows with every fixture and stops meaning anything. Same reasoning as
 *   `placeholder-columns.test.ts` and `content-deletion-world.test.ts`.
 */

const repoRoot = resolve(import.meta.dirname, "../../../../..");

/** An anchored `^prefix_…{26}` pattern, in a regex literal or a string. */
const ANCHORED_PATTERN = /\^[a-z][a-z0-9]{0,9}_[^\n"'`]{0,40}\{26\}/;

/** The alphabet, in either spelling. */
const ALPHABET_COPIES = [/0-9A-HJKMNP-TV-Z/, /0123456789ABCDEFGHJKMNPQRSTVWXYZ/];

/** The line the divergence actually lived on, kept verbatim so the extractor is proved on the real shape. */
const THE_DEFECT = '  caseId: z.string().regex(/^case_[0-9A-HJKMNP-TV-Z]{26}$/).optional(),';

/**
 * The only files allowed to spell any of this, and what each is allowed to spell.
 *
 * One entry, because only one file writes the alphabet. `ids.ts` is deliberately absent: it *derives* its
 * pattern from that alphabet, so it matches neither extractor, and an entry nothing matches would read as
 * coverage of something that is not there.
 */
const PERMITTED: Record<string, string> = {
  "packages/runtime/src/ctx.ts": "the encoder: the one place the ULID alphabet is defined",
};

interface Hit { file: string; line: number; text: string }

function sourceFiles(): string[] {
  const roots = [
    join(repoRoot, "apps/node/worker/src"),
    ...readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, "packages", entry.name, "src")),
  ];
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a package with no src/ is not an error, it is a package with no src/
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(path);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** A line that is nothing but comment. See the header for what this costs. */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

function scanLine(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function scan(patterns: readonly RegExp[]): Hit[] {
  const hits: Hit[] = [];
  for (const path of sourceFiles()) {
    const relative = path.slice(repoRoot.length + 1);
    readFileSync(path, "utf8").split("\n").forEach((text, index) => {
      if (isComment(text)) return;
      if (scanLine(text, patterns)) hits.push({ file: relative, line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

function report(kind: string, offenders: readonly Hit[], remedy: string): string | null {
  if (offenders.length === 0) return null;
  return `${kind} outside the registry. ${remedy}\n  `
    + offenders.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`).join("\n  ");
}

describe("the closed world over identifier patterns (#49)", () => {
  it("finds files to scan, so nothing below passes by scanning nothing", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(40);
    // The two ends of the divergence, both in the scan.
    expect(files.some((path) => path.endsWith("packages/contract/src/send-mail.ts"))).toBe(true);
    expect(files.some((path) => path.endsWith("apps/node/worker/src/cases.ts"))).toBe(true);
  });

  it("recognises the line the defect actually lived on", () => {
    // Anti-vacuity, and proved against a fixture rather than against a file: an extractor asserted only
    // through "some file still matches it" stops meaning anything the moment that file is cleaned up, which
    // is the #71 shape. This is the exact text that shipped.
    expect(isComment(THE_DEFECT)).toBe(false);
    expect(scanLine(THE_DEFECT, [ANCHORED_PATTERN])).toBe(true);
    expect(scanLine(THE_DEFECT, ALPHABET_COPIES)).toBe(true);
    // And it does not fire on ordinary code, so the scan below is a check rather than a tautology.
    expect(scanLine("const at = new Date(ctx.now()).toISOString();", [ANCHORED_PATTERN])).toBe(false);
    expect(scanLine("  caseId: z.string().optional(),", ALPHABET_COPIES)).toBe(false);
  });

  it("still finds the one permitted spelling, so the alphabet scan is live", () => {
    expect(scan(ALPHABET_COPIES).map((hit) => hit.file)).toContain("packages/runtime/src/ctx.ts");
  });

  it("has no identifier pattern written anywhere", () => {
    // No permitted file for this one: `ids.ts` builds its pattern from the alphabet rather than writing it.
    expect(report(
      "an identifier pattern is written",
      scan([ANCHORED_PATTERN]),
      "Add the entity to ID_PREFIXES in packages/runtime/src/ids.ts and use idPattern().",
    )).toBeNull();
  });

  it("has no second copy of the ULID alphabet", () => {
    const offenders = scan(ALPHABET_COPIES).filter((hit) => PERMITTED[hit.file] === undefined);
    expect(report(
      "the Crockford alphabet is spelled",
      offenders,
      "Import ULID_ALPHABET, or use idPattern(), so a change to what ctx.id emits reaches it.",
    )).toBeNull();
  });

  it("registers cas, not case — the divergence, asserted as a fact rather than a story", () => {
    expect(ID_PREFIXES.case).toBe("cas");
    expect(idPatternSource(ID_PREFIXES.case)).not.toContain("case_");
    // And the Node still mints it, so nothing about existing rows had to move.
    const cases = readFileSync(join(repoRoot, "apps/node/worker/src/cases.ts"), "utf8");
    expect(cases).toContain("ctx.id(ID_PREFIXES.case)");
  });

  it("mints every registered prefix through the registry, never as a literal", () => {
    const literals: Hit[] = [];
    for (const path of sourceFiles()) {
      const relative = path.slice(repoRoot.length + 1);
      readFileSync(path, "utf8").split("\n").forEach((text, index) => {
        if (isComment(text)) return;
        for (const [, prefix] of text.matchAll(/ctx\.id\("([a-z0-9]+)"\)/g)) {
          if (prefix !== undefined && (Object.values(ID_PREFIXES) as string[]).includes(prefix)) {
            literals.push({ file: relative, line: index + 1, text: text.trim() });
          }
        }
      });
    }
    expect(report(
      "a registered prefix is minted as a literal",
      literals,
      "Use ctx.id(ID_PREFIXES.<entity>) — otherwise the registry is a second spelling of its own subject.",
    )).toBeNull();
  });

  it("says how partial the registry is, so nobody reads it as total", () => {
    // Five registered against the thirty-odd prefixes `ctx.id` mints. The gap is the point: a prefix
    // spelled in one place cannot diverge from anything, and the scans above are what keep the *validated*
    // set complete.
    const minted = new Set<string>();
    for (const path of sourceFiles()) {
      for (const [, prefix] of readFileSync(path, "utf8").matchAll(/ctx\.id\("([a-z0-9]+)"\)/g)) {
        if (prefix !== undefined) minted.add(prefix);
      }
    }
    expect(minted.size).toBeGreaterThan(20);
    expect(Object.keys(ID_PREFIXES).length).toBeLessThan(minted.size);
  });
});
