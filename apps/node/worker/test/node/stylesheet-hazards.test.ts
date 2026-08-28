import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The stylesheet is CSS inside a TypeScript template literal, and that pairing has two hazards that have now
 * bitten four times between them. Neither is a design flaw worth a rewrite; both are exactly testable, so
 * this converts two recurring stumbles into one named failure.
 *
 * A **third** hazard lives at the bottom of this file, and it is hazard 2 one language up: an unbalanced
 * comment terminator inside a *TypeScript* block comment, which closed a doc comment early and cost a build.
 * The guard kept turning out to be narrower than the hazard — CSS first, then SQL, now TypeScript itself —
 * which is why each section says what it can and cannot see.
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
 *
 * ## The class recurred three times in one week, and a general guard was attempted and rejected
 *
 * This file guards `SHELL_CSS` and only that constant. The same mistake then happened three more times, in
 * three different files, with this warning on screen each time:
 *
 * | where | what the compiler said |
 * |:--|:--|
 * | `ui.ts` | nine backticks in CSS comments; `',' expected` at a line of prose |
 * | `font-modules.d.ts` | a glob closed a JSDoc block early; `Module declaration names may only use quoted strings` |
 * | `recovery.ts` | a backtick around a migration number in SQL commentary; `Octal literals are not allowed` |
 *
 * **All three were caught by `pnpm typecheck`, so none shipped.** The gap is not safety, it is that the error
 * describes the wreckage rather than the cause — every time, the fix took longer than the mistake.
 *
 * A lexical guard over every template literal in `src/` was written and **thrown away**. Finding "inside a
 * template literal" by tracking backtick parity cannot work in this repository: doc comments here are full of
 * backticks around identifiers, and the walk cannot tell a delimiter from prose. It flagged 67 correct lines
 * on a clean tree. A tripwire that fires on a healthy repository gets muted in a week, which would cost more
 * than the confusing compiler message it was meant to improve — the same argument `scripts/mutants.mjs` makes
 * about false kills.
 *
 * Doing it properly needs a TypeScript lexer to find the literals, and then the check is trivial. That is the
 * shape of the real fix if this recurs a fourth time. Until then the rule is the one this file already
 * states: **comments inside a template literal are written without backticks**, and the compiler is the net.
 */

const srcDir = join(import.meta.dirname, "..", "..", "src");

const stylesheetSources = [
  join(import.meta.dirname, "..", "..", "src", "ui.ts"),
];

/**
 * Every CSS region in a source file, since one file may hold more than one.
 *
 * Two shapes, and the second is why this comment exists. The stylesheet used to be a `<style>` element
 * inside the served document; #97 moved it into a named constant served at `/app/app.css`, because a CSP
 * worth having refuses an inline stylesheet. **The hazards did not move with it** — the CSS is still a
 * TypeScript template literal, so a backtick still ends the literal and a stray comment terminator still
 * discards the rule after it. Only the delimiter changed.
 *
 * Both patterns are kept rather than the old one replaced: an inline `<style>` in a future document would
 * carry the same two hazards, and a guard that stopped seeing the shape it was written for is how this
 * check comes to pass by finding nothing. The `it` below fails on zero regions for exactly that reason.
 */
function stylesheets(source: string): string[] {
  const blocks: string[] = [];
  for (const pattern of [/<style>([\s\S]*?)<\/style>/g, /const SHELL_CSS = `([\s\S]*?)`;/g]) {
    for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
      blocks.push(match[1]!);
    }
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

/**
 * The same hazard a third time: a **comment terminator inside a TypeScript block comment**, which closes it
 * early. (Written in words, not in characters, for the reason the CSS section above records: typing the two
 * characters here would end this docblock.)
 *
 * This one has now cost a build. `src/matters.ts` documented a one-minute cron expression inside a JSDoc
 * block; the star-slash in the middle of it terminated the comment, and the prose after it was parsed as
 * code. The failure is loud — esbuild reports a parse error from a line that reads as English — so the cost is
 * diagnosis, which is the slow part and the reason the two checks above exist.
 *
 * It is the **exact** invariant the CSS check enforces, one language up: scanning left to right, every comment
 * terminator must close a comment an opener opened. When a doc block ends early, the terminator the author
 * *meant* as the end is left standing in code, and that stray terminator is what this finds. Which also means
 * the check does not need to guess at intent — it reads the same imbalance the compiler does.
 *
 * ## What it takes to make that scan sound, and where it is deliberately blunt
 *
 * `/` and `*` are ordinary operators in TypeScript, and the two characters can legitimately sit inside a
 * string, a template literal, a line comment, or a regular expression. So this walks the file with a small
 * state machine over exactly those five states. Two boundaries are declared rather than solved:
 *
 *   - **Regular expressions are recognised by the preceding token**, the standard heuristic, because deciding
 *     whether `/` opens a regex or divides requires a parser. A misjudged `/` can only cause a *false
 *     positive*, which costs one line of rewriting rather than an afternoon.
 *   - **`${}` inside a template literal** is tracked with a depth counter so an interpolation containing a
 *     string or a nested template stays understood. Beyond that, this is not a tokenizer.
 *
 * `src/client/` is included, unlike the SQL check above: JSX and React source carry the same doc comments and
 * the same hazard, and the reason the SQL scan excludes the client is that the client writes no SQL.
 */
describe("TypeScript block comments are balanced, so a doc comment cannot end early", () => {
  const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx?$/.test(entry) && !entry.endsWith(".d.ts"));

  /**
   * Every stray comment terminator in `text`, as 1-indexed line numbers.
   *
   * Returns positions rather than a boolean, so a failure names a line somebody can open — the lesson the CSS
   * check records about diagnosis being the expensive half.
   */
  function strayTerminators(text: string): number[] {
    const stray: number[] = [];
    let state: "code" | "line" | "block" | "single" | "double" | "template" | "regex" = "code";
    /** Nesting of `${` inside template literals, so an interpolation can hold its own strings. */
    const templates: number[] = [];
    /** The last non-whitespace character seen in code, which is how a regex is told from a division. */
    let previous = "";
    let line = 1;

    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      const next = text[i + 1] ?? "";
      if (c === "\n") line += 1;

      switch (state) {
        case "code":
          if (c === "\n") { break; }
          if (c === "/" && next === "/") { state = "line"; i += 1; break; }
          if (c === "/" && next === "*") { state = "block"; i += 1; break; }
          if (c === "*" && next === "/") {
            // A terminator with no comment open. Either a doc block ended early further up, or somebody typed
            // one by hand — both leave the file meaning something other than it reads.
            stray.push(line);
            i += 1;
            break;
          }
          if (c === "'") { state = "single"; break; }
          if (c === '"') { state = "double"; break; }
          if (c === "`") { state = "template"; break; }
          if (c === "}" && templates.length > 0 && templates[templates.length - 1] === 0) {
            // Closing the `${…}` we opened: back inside the template literal that holds it.
            templates.pop();
            state = "template";
            break;
          }
          if (c === "}" && templates.length > 0) { templates[templates.length - 1]! -= 1; break; }
          if (c === "{" && templates.length > 0) { templates[templates.length - 1]! += 1; break; }
          // A `/` that is not a comment: a regex if what precedes it cannot end an expression, else division.
          if (c === "/" && !/[\w)\]$]/.test(previous)) { state = "regex"; break; }
          if (!/\s/.test(c)) previous = c;
          break;

        case "line":
          if (c === "\n") state = "code";
          break;

        case "block":
          if (c === "*" && next === "/") { state = "code"; previous = ""; i += 1; }
          break;

        case "single":
          if (c === "\\") { i += 1; break; }
          if (c === "'") { state = "code"; previous = "'"; }
          break;

        case "double":
          if (c === "\\") { i += 1; break; }
          if (c === '"') { state = "code"; previous = '"'; }
          break;

        case "template":
          if (c === "\\") { i += 1; break; }
          if (c === "$" && next === "{") { templates.push(0); state = "code"; previous = ""; i += 1; break; }
          if (c === "`") { state = "code"; previous = "`"; }
          break;

        case "regex":
          if (c === "\\") { i += 1; break; }
          // An unterminated regex would be a syntax error the build catches; recovering at the newline keeps
          // a misjudged division from swallowing the rest of the file and reporting nonsense.
          if (c === "\n") { state = "code"; break; }
          if (c === "/") { state = "code"; previous = "/"; }
          break;
      }
    }
    return stray;
  }

  it("finds source files to check, so this cannot pass vacuously", () => {
    expect(sourceFiles.length).toBeGreaterThan(10);
  });

  it("recognises the pattern that cost a build, and the ones that must not trip it", () => {
    /*
     * The scanner is proved on inputs rather than trusted, because a source scan that found nothing would look
     * exactly like a clean tree. The first case is the real defect, verbatim in shape: a cron expression in a
     * doc comment, whose `*` and `/` close the block and leave the intended terminator stranded.
     */
    expect(strayTerminators('/**\n * runs on */1 * * * *\n */\nconst a = 1;\n')).toEqual([3]);
    // And every legitimate way those two characters appear, none of which may fire.
    expect(strayTerminators('const s = "*/";\n')).toEqual([]);
    expect(strayTerminators("const t = `SELECT 1 -- */`;\n")).toEqual([]);
    expect(strayTerminators("// a stray */ in a line comment\n")).toEqual([]);
    expect(strayTerminators("const r = /a*\\//;\n")).toEqual([]);
    expect(strayTerminators("const q = a / b * /* c */ d;\n")).toEqual([]);
    expect(strayTerminators("const u = `x${ [1].map((n) => `${n}*/`).join('') }y`;\n")).toEqual([]);
    // Division by a parenthesised expression, which the regex heuristic must not read as a regex opener.
    expect(strayTerminators("const v = (a + b) / (c * d);\n")).toEqual([]);
  });

  it("has no stray comment terminator anywhere in src", () => {
    const offenders: string[] = [];
    for (const relative of sourceFiles) {
      const source = readFileSync(join(srcDir, relative), "utf8");
      for (const line of strayTerminators(source)) offenders.push(`${relative}:${line}`);
    }
    expect(
      offenders.length === 0 ? null
        : `comment terminator with no comment open (${offenders.join(", ")}) — a block comment above it ended `
          + "early, most likely on a cron expression or a glob in the prose, so the text between the two "
          + "terminators is being parsed as code",
    ).toBeNull();
  });
});
