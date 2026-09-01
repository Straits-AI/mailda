import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withoutComments } from "../without-comments.ts";

/**
 * No recovery code reaches the CLI through an argument (#136).
 *
 * ## The defect this is closing, and why a per-command test would have missed it
 *
 * `redeem` reads the code from a terminal. `confirm`, forty lines away in the same function, **required**
 * `--code` — and confirm's leak is the worse of the two, because confirming deliberately does not spend the
 * code. A redeemed code in a shell history is spent; a confirmed one still opens the escrow holding the
 * organization's content and credential keys.
 *
 * A test written for `confirm` would have closed that one command. What is actually wrong is that the rule
 * lived in a comment next to one caller instead of anywhere a third command would have to meet it — and a
 * third is likely, because every future recovery verb takes the same kind of string. So this is written over
 * the whole function: **every** code sent to a Node must be one somebody typed.
 *
 * ## And the second reason, which is not about secrecy
 *
 * Confirmation asserts exactly one thing: that a person holds the sheet. `doctor` words its warning as that —
 * *"nobody has confirmed holding one"*. A code a script reads from a file clears the warning without the fact
 * becoming true, which is AGENTS.md 2b: an assertion that cannot fail. The agent that found this had just
 * rotated a Node's codes and could have cleared its warning from the file it had written.
 *
 * ## Scope
 *
 * Lexical, over `recoveryCodes`' body with comments stripped, which is both halves of the technique this
 * repository has been bitten by eight times — see `test/without-comments.ts`. It cannot see a code arriving
 * from an environment variable, which would be a different mistake with a different argument against it.
 */

const CLI = join(import.meta.dirname, "../../../../../packages/cli/src/mailda.mjs");

/** `recoveryCodes`' body, comments stripped, so nothing here matches prose about the code it checks. */
function body(): string {
  const source = withoutComments(CLI);
  const start = source.indexOf("async function recoveryCodes(");
  expect(start, "recoveryCodes could not be found in the CLI").toBeGreaterThan(-1);
  /*
   * To the next top-level declaration rather than to a brace count. `readSecret` and the backup verbs live
   * below it, and including them would let this test pass on a rule kept somewhere it does not apply.
   */
  const end = source.indexOf("\nasync function ", start + 1);
  const stop = source.indexOf("\nfunction ", start + 1);
  const finish = Math.min(end === -1 ? source.length : end, stop === -1 ? source.length : stop);
  return source.slice(start, finish);
}

/** Every identifier this function puts in a request's `code` field, including the shorthand `{ code }`. */
function sentAsCode(source: string): string[] {
  const named = [...source.matchAll(/\bcode:\s*([A-Za-z_$][\w$]*)/g)].map((one) => one[1] as string);
  const shorthand = [...source.matchAll(/\{\s*code\s*\}/g)].map(() => "code");
  return [...named, ...shorthand];
}

describe("a recovery code is typed, never passed", () => {
  it("finds the function and the codes it sends, so nothing below passes by reading nothing", () => {
    const source = body();
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain("/api/recovery/redeem");
    expect(source).toContain("/api/recovery-codes/confirm");
    // Both commands send one. A version that found only `redeem`'s would be the defect passing its own test.
    expect(sentAsCode(source).length).toBeGreaterThanOrEqual(2);
  });

  it("takes every code it sends from a prompt", () => {
    const source = body();
    const offending = sentAsCode(source).filter((name) => {
      const bound = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=[^;]*await readSecret\\(`);
      return !bound.test(source);
    });

    expect(
      offending,
      "a recovery code reaches the Node from something other than a prompt. Confirming does not spend the "
      + "code, so one on a command line is a live key to this organization's escrow in shell history — and a "
      + "code a script reads from a file cannot prove a person holds the sheet, which is what confirming is "
      + "for.",
    ).toEqual([]);
  });

  it("never reads a --code flag, which is how the confirmed one used to leak", () => {
    /*
     * The exact shape of the defect: `const typed = flag(argv, "code")`. The flag is still *mentioned*, to
     * refuse it by name — somebody has it in a script, and a silent behaviour change leaves them with a Node
     * that stays degraded for no stated reason. What must not exist is a binding that uses the value.
     */
    expect(body()).not.toMatch(/=\s*flag\(argv,\s*"code"\)/);
  });

  it("refuses the flag by name, with the reason rather than a usage line", () => {
    const source = body();
    expect(source).toMatch(/flag\(argv,\s*"code"\)\s*!==\s*undefined/);
    expect(source).toContain("--code is not accepted");
    // Why it is worse than the one `redeem` already refuses, which is the part a reader will not guess.
    expect(source).toContain("does not spend the code");
  });
});
