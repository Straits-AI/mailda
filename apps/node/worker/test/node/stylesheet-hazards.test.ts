import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The stylesheet is CSS inside a TypeScript template literal, and that pairing has two hazards that have now
 * bitten four times between them. Neither is a design flaw worth a rewrite; both are exactly testable, so
 * this converts two recurring stumbles into one named failure.
 *
 * ## 1. A backtick in a CSS comment ends the template literal
 *
 * Three times: once in this stylesheet, once in a SQL comment in `response-clock.ts`, once again here. The
 * build does fail loudly — esbuild reports "Expected ; but found td" from a line that looks like prose — so
 * the cost is a minute of confusion rather than a shipped defect. Worth a test because the *diagnosis* is
 * the slow part, and a named assertion says the cause outright.
 *
 * ## 2. A stray comment terminator silently swallows the next rule
 *
 * (Named rather than written: the two characters, quoted in this docblock, closed this docblock. Which is the
 * same hazard one level up, and is why the assertion below scans for it rather than a comment describing it.)
 *
 * This one ships. Editing a long explanatory comment left an old terminator mid-block, so the prose after it
 * sat outside any comment. CSS error recovery consumes that prose as a selector up to the next `{...}` — so
 * the rule immediately following it was **discarded by the parser**, silently, while its neighbours applied.
 *
 * What that cost: `width: 100%` on the queue's subject column was in the served bytes, absent from
 * `document.styleSheets[0].cssRules`, and four consecutive layout attempts were judged against a stylesheet
 * that never contained the rule being tested. The measurement was honest and the conclusions drawn from it
 * were all wrong — the failure mode AGENTS.md means by a landmine, since nothing anywhere reports it.
 *
 * The invariant is exact: scanning the stylesheet left to right, every comment terminator must close a
 * comment that an opener opened, and no comment may be left open at the end.
 */

const srcDir = join(import.meta.dirname, "..", "..", "src");

const stylesheetSources = [
  join(import.meta.dirname, "..", "..", "src", "ui.ts"),
];

/** Every `<style>…</style>` region in a source file, since one file may render more than one document. */
function stylesheets(source: string): string[] {
  const blocks: string[] = [];
  const pattern = /<style>([\s\S]*?)<\/style>/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    blocks.push(match[1]!);
  }
  return blocks;
}

/** Line number of an offset, so a failure names the line rather than a character index. */
function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

describe("stylesheet hazards", () => {
  for (const path of stylesheetSources) {
    const source = readFileSync(path, "utf8");
    const blocks = stylesheets(source);

    it(`${path} contains at least one stylesheet to check`, () => {
      // Otherwise this file passes by finding nothing, which is the vacuous green the placeholder-columns
      // test names as the failure mode of a guard that guards nothing.
      expect(blocks.length).toBeGreaterThan(0);
    });

    it("has no backtick in any stylesheet, which would end the template literal", () => {
      for (const block of blocks) {
        const at = block.indexOf("`");
        expect(
          at === -1 ? null : `line ${lineOf(source, source.indexOf(block) + at)}`,
          "a backtick inside the CSS ends the TypeScript template literal holding it",
        ).toBeNull();
      }
    });

    it("has balanced comment delimiters, so no rule is silently swallowed", () => {
      for (const block of blocks) {
        const base = source.indexOf(block);
        let open: number | null = null;
        for (let i = 0; i < block.length - 1; i += 1) {
          const two = block.slice(i, i + 2);
          if (two === "/*" && open === null) {
            open = i;
            i += 1;
          } else if (two === "*/") {
            expect(
              open === null ? `stray comment terminator at line ${lineOf(source, base + i)}` : null,
              "text outside a comment is consumed as a selector, discarding the rule after it",
            ).toBeNull();
            open = null;
            i += 1;
          }
        }
        expect(
          open === null ? null : `comment opened at line ${lineOf(source, base + open)} is never closed`,
        ).toBeNull();
      }
    });
  }
});

/**
 * The same hazard, everywhere else: a backtick inside a **SQL** comment.
 *
 * The CSS check above was written after this bit twice. It has now bitten **four** times — `ui.ts`'s
 * stylesheet, a SQL comment in `response-clock.ts`, and a SQL comment in `doctor.ts` written while fixing an
 * unrelated defect. Three of the four were SQL, which the CSS-only guard could not see, so the guard was
 * narrower than the hazard.
 *
 * Every `--` comment inside a template literal is a candidate, and a backtick in one ends the literal. The
 * build does fail loudly — esbuild reports a parse error from a line that reads as prose — so the cost is
 * diagnosis rather than a shipped defect. But diagnosis is the slow part, and four repeats say the comment
 * warning attached to two files is not reaching whoever writes the third.
 */
describe("SQL comments inside template literals carry no backticks", () => {
  const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.includes("client/"));

  it("finds source files to check, so this cannot pass vacuously", () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
  });

  it("has no backtick in any SQL line comment", () => {
    const offenders: string[] = [];
    for (const relative of sourceFiles) {
      const source = readFileSync(join(srcDir, relative), "utf8");
      source.split("\n").forEach((line, index) => {
        // A SQL line comment: `--` with SQL-ish indentation, inside what is almost certainly a template
        // literal. Deliberately loose — a false positive costs one rename, a false negative costs the
        // afternoon somebody spends on "Expected ; but found td".
        const comment = /^\s*--\s(.*)$/.exec(line);
        if (comment !== null && comment[1]!.includes("`")) {
          offenders.push(`${relative}:${index + 1}`);
        }
      });
    }
    expect(
      offenders.length === 0 ? null
        : `backtick inside a SQL comment (${offenders.join(", ")}) — these sit inside TypeScript template `
          + "literals, so a backtick ends the literal and the build fails from a line that reads as prose",
    ).toBeNull();
  });
});
