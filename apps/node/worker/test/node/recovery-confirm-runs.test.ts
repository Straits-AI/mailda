import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = join(import.meta.dirname, "../../../../../packages/cli/src/mailda.mjs");

/**
 * `recovery-codes confirm` can actually be run (#136 follow-up).
 *
 * ## Why this file exists, which is the useful part
 *
 * `recovery-code-entry.test.ts` holds a real rule — no recovery code reaches the CLI through an argument —
 * and holds it well, lexically, over the whole function. The guard enforcing it read:
 *
 * ```js
 * if (flag(argv, "code") !== undefined) fail("--code is not accepted…")
 * ```
 *
 * `flag` answers **null** when a flag is absent. So the condition was true on every invocation and `confirm`
 * refused unconditionally — including the command its own `fix` line printed. It shipped that way.
 *
 * **Every existing test was about `--code` being present**, and that is the branch the guard gets right. A
 * guard that cannot pass is the mirror of an assertion that cannot fail: both look like enforcement, and
 * neither is checked by a test that only exercises the side it was written for.
 *
 * The cost was not cosmetic. `recovery_escrow` is ADR 28's shipping precondition, `confirm` is its only
 * remedy, and a Node could mint an escrow that nobody could ever confirm holding.
 *
 * ## What this checks, and what it deliberately does not
 *
 * That the command **reaches the prompt** rather than refusing at the door. It does not sign in, reach a
 * Node, or confirm anything — those need a live Node, and the defect was three lines earlier than any of it.
 */

/** Runs the CLI with no terminal, so a prompt fails fast rather than hanging this suite. */
function run(args: string[]): { status: number | null; output: string } {
  const done = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    input: "",
    timeout: 20_000,
    env: { ...process.env, MAILDA_EMAIL: "nobody@example.test", MAILDA_PASSWORD: "unused" },
  });
  return { status: done.status, output: `${done.stdout ?? ""}${done.stderr ?? ""}` };
}

const REFUSAL = "--code is not accepted";

describe("recovery-codes confirm", () => {
  it("does not refuse the command it tells the operator to run", () => {
    /*
     * The regression, stated as the operator's own command. It exits non-zero here — there is no terminal to
     * type into and no Node at that address — but it must not exit on the flag guard, because that is a
     * refusal about an argument nobody passed.
     */
    const { output } = run(["recovery-codes", "confirm", "--url", "https://node.invalid"]);
    expect(output).not.toContain(REFUSAL);
  });

  it("still refuses a code passed as a flag", () => {
    // The other side, which was the only side anything tested. Both directions, or neither is checked.
    const { output, status } = run([
      "recovery-codes", "confirm", "--url", "https://node.invalid", "--code", "AAAA-BBBB",
    ]);
    expect(output).toContain(REFUSAL);
    expect(status).not.toBe(0);
  });

  it("refuses a code passed to redeem too, from the same rule", () => {
    const { output } = run(["recovery-codes", "redeem", "--url", "https://node.invalid", "--code", "X"]);
    expect(output).not.toContain("the vault is restored");
  });

  it("finds the CLI at all, so nothing above passes by failing to start", () => {
    // Anti-vacuity: a missing file would make every `not.toContain` above pass.
    const { output } = run(["recovery-codes"]);
    expect(output).toContain("usage: mailda recovery-codes");
  });
});
