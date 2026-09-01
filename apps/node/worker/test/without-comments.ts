import { readFileSync } from "node:fs";

/**
 * A source file with its comments removed, for tests that read code.
 *
 * ## Why this exists
 *
 * **Eight times** in this repository a lexical assertion has been defeated by finding its search string
 * inside a comment — usually a comment written by the same change, quoting the very code it documents. The
 * failures look identical to real defects and cost a debugging cycle each:
 *
 *   - the deploy sequence's step order matched `firstInstall`'s prose before its code;
 *   - `"applying migrations"` matched `"applying migrations for the first time"`;
 *   - `shouldPromote(verdict)` was matched exactly, so a differently-spelled call slipped past the gate;
 *   - `refuseIfWorkflowBelongsElsewhere()` matched the function's definition, not its call;
 *   - the SBOM workflow's push guard matched the *other* job's `if:`;
 *   - `"Every one opened and"` matched a comment quoting that message;
 *   - `set MAILDA_EMAIL` matched `recoveryCodes`' prompt fifty thousand characters away;
 *   - and `return route()` matched a comment saying *"this used to be `return route()`"*.
 *
 * Three of those were caught only by mutation testing, which means the others were luck. Stripping comments
 * does not fix the class — a lexical test can still match the wrong call site, and scoping to a function's
 * body is the other half — but it removes the commonest cause, and it removes it by default rather than by
 * each test remembering.
 *
 * ## What it does not do
 *
 * It is line-based, not a tokeniser: a `//` inside a string literal takes the rest of that line with it. That
 * is a known, measured cost — `prose-references-world.test.ts` carries two exemptions for exactly that — and
 * the alternative is a parser for the sake of two lines. Stated rather than discovered.
 */
export function withoutComments(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");
}
