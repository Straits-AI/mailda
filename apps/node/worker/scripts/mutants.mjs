#!/usr/bin/env node
/**
 * Mutation testing, for one source file against one test file (#103).
 *
 * ## Why this exists, which is not the reason the ticket expected
 *
 * #103 was filed about a comment asserting a property the code below it does not have — six instances, and
 * it asked whether any automated check could catch that class. The honest answer to *that* question is still
 * no: prose is not enumerable and nothing can read "the mailbox is chosen, never inferred" and check it.
 *
 * But the session that filed it produced **eight more instances of a different and checkable thing**: an
 * assertion that passes against the code it was written to catch. Every one was found by hand-mutating the
 * fix and re-running the test; none was found by reading. That is a mechanical procedure, so this is it.
 *
 * The eight, because the shapes are the argument for the operators below:
 *
 * | what the test claimed | why it passed anyway |
 * |:--|:--|
 * | MCP forwards a page cursor | an empty page reads the same whether or not it forwarded |
 * | the escrow is not openable from the table | it tried the wrong attack — the route, not the ciphertext |
 * | the parser keeps its balance at any depth | balanced nesting never reaches the capped counter |
 * | the deploy gate refuses a bad canary | `if (false && verdict !== "ok")` satisfied both lexical clauses |
 * | the deploy steps run in order | a renamed banner still matched as a substring |
 * | the empty inbox hides no reassurance | also true of a loading screen |
 * | the vault does not overwrite a live key | nothing asserted it at all |
 * | the SDK is regenerated from the contract | a top-level side effect regenerated it first |
 *
 * ## What it does, and what it deliberately is not
 *
 * Not Stryker. A full mutation run over 1,236 workerd tests would take hours and would be muted within a
 * week, and `doctor-check-cost.md` already records this project's view of a check nobody waits for. This is
 * the manual loop — mutate one line, run one test file, see whether anything fails — automated, so it costs
 * a command instead of twenty minutes of copy-and-paste.
 *
 * It is a **tool an author runs**, not a CI gate. A gate would have to decide which mutants matter, and a
 * surviving mutant is often a legitimately unreachable branch; that judgement is the reviewer's. Printing
 * survivors and letting a person read them is the honest division.
 *
 *     node scripts/mutants.mjs src/csrf.ts test/csrf.test.ts
 *     node scripts/mutants.mjs src/client/app/screens/inbox.tsx test/client/start-message.test.tsx
 *
 * The config is inferred from the test path — `test/node/` runs under the node config, `test/client/` under
 * the client one — because getting that wrong reports every mutant as surviving, which is the failure mode
 * most likely to make somebody stop trusting the output.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The operators, chosen from what actually caught the eight above rather than from a textbook.
 *
 * Each is a *weakening*: it makes a guard admit more than it should. A mutation that made code stricter
 * would fail tests for the wrong reason — the point is to find guards nothing is holding.
 */
const OPERATORS = [
  { name: "negate-equality", find: /!==/g, replace: "===" },
  { name: "negate-equality", find: /(?<![!=<>])===/g, replace: "!==" },
  /*
   * **Whitespace-delimited on purpose.** The first version matched a bare `<` or `>`, which matches every
   * TypeScript generic — `Promise<string>` became `Promise<=string>=`, which does not compile, so the run
   * failed and the tool recorded it as *killed*. Twenty of twenty "killed" on the first real file were
   * syntax errors.
   *
   * A tool that reports a false kill is worse than no tool, because it produces exactly the confidence it
   * was built to withdraw. That is this repository's recurring defect, arriving inside the thing written to
   * find it, which is worth leaving on the record rather than fixing quietly.
   *
   * Comparisons in this codebase are written with spaces (`a > b`); generics are not (`Promise<T>`). So the
   * spaces are the discriminator, and a comparison written without them is missed rather than mis-reported —
   * the safe direction for a tool whose output has to be trusted.
   */
  { name: "widen-comparison", find: / > /g, replace: " >= " },
  { name: "widen-comparison", find: / < /g, replace: " <= " },
  { name: "loosen-conjunction", find: /&&/g, replace: "||" },
];

/**
 * `if (COND)` → `if (false && (COND))`, which removes the guard entirely.
 *
 * The operator that caught the deploy gate, and the one that needs care. Prefixing `false &&` onto the raw
 * condition is **wrong** whenever the condition has a top-level `||`, because `&&` binds tighter:
 * `if (false && a === null || b === null)` parses as `(false && a === null) || (b === null)`, which still
 * fires on `b`. That is not a removed guard, it is a different guard — and it reported two equivalent
 * mutants as survivors on the first real file, which sends a reader looking for a coverage gap that is not
 * there.
 *
 * So the closing parenthesis is found by counting, and the whole condition is wrapped. A tool that reports
 * a false survivor wastes the attention it was built to direct.
 */
function removeGuard(line) {
  const open = line.indexOf("if (");
  if (open === -1) return null;
  let depth = 0;
  for (let at = open + 3; at < line.length; at++) {
    if (line[at] === "(") depth += 1;
    else if (line[at] === ")") {
      depth -= 1;
      if (depth === 0) {
        const condition = line.slice(open + 4, at);
        // Nothing to remove, and `if ()` is not valid anyway.
        if (condition.trim() === "") return null;
        return `${line.slice(0, open)}if (false && (${condition}))${line.slice(at + 1)}`;
      }
    }
  }
  // An unbalanced line: a condition spanning several lines. Skipped rather than guessed at.
  return null;
}

/** Lines that are not code: a mutation inside prose proves nothing and wastes a test run. */
function isProse(line) {
  const t = line.trimStart();
  return t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

const [sourceArg, testArg, ...rest] = process.argv.slice(2);
if (sourceArg === undefined || testArg === undefined) {
  process.stderr.write(
    "\nusage: node scripts/mutants.mjs <source-file> <test-file>\n\n"
    + "  Weakens one line of the source at a time and runs the test file. A mutant that **survives** —\n"
    + "  every test still passing — is a line nothing is holding.\n\n",
  );
  process.exit(1);
}

const limit = Number(rest.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "60");
const sourcePath = resolve(process.cwd(), sourceArg);
const original = readFileSync(sourcePath, "utf8");
const lines = original.split("\n");

/** `test/node/` and `test/client/` have their own configs; using the wrong one fails everything. */
const config = testArg.includes("test/node/")
  ? ["-c", "vitest.node.config.ts"]
  : testArg.includes("test/client/")
    ? ["-c", "vitest.client.config.ts"]
    : [];

/** Every mutation this file admits, as a whole-file variant with a label. */
const mutants = [];
lines.forEach((line, index) => {
  if (isProse(line)) return;
  for (const { name, find, replace } of OPERATORS) {
    if (!new RegExp(find.source).test(line)) continue;
    const mutated = [...lines];
    mutated[index] = line.replace(new RegExp(find.source), replace);
    if (mutated[index] === line) continue;
    mutants.push({ name, line: index + 1, text: line.trim(), source: mutated.join("\n") });
  }
  const guarded = removeGuard(line);
  if (guarded !== null) {
    const mutated = [...lines];
    mutated[index] = guarded;
    mutants.push({ name: "remove-guard", line: index + 1, text: line.trim(), source: mutated.join("\n") });
  }
});

if (mutants.length === 0) {
  process.stdout.write(`\nno mutable sites in ${sourceArg}\n\n`);
  process.exit(0);
}

process.stdout.write(
  `\n${mutants.length} mutant(s) in ${sourceArg}, against ${testArg}`
  + `${mutants.length > limit ? ` — running the first ${limit}` : ""}\n\n`,
);

const survivors = [];
const invalid = [];
let ran = 0;
try {
  for (const mutant of mutants.slice(0, limit)) {
    writeFileSync(sourcePath, mutant.source);
    const outcome = spawnSync("npx", ["vitest", "run", ...config, testArg], {
      encoding: "utf8", env: { ...process.env, CI: "1" },
    });
    ran += 1;
    const output = `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`;
    /*
     * A mutant that does not compile is **not** a killed mutant. It says nothing about the test file — the
     * suite failed to load, not to pass — and counting it as a kill is how a tool reports coverage it has
     * not measured. Reported as `invalid` so the number that matters stays honest.
     */
    if (/Transform failed|error TS\d|Failed to load|SyntaxError/.test(output)) {
      invalid.push(mutant);
      process.stdout.write(`  invalid   ${mutant.name}  :${mutant.line}\n`);
      continue;
    }
    // Exit 0 means every test still passed with the guard weakened: nothing was holding this line.
    const survived = (outcome.status ?? 1) === 0;
    process.stdout.write(`  ${survived ? "SURVIVED" : "killed  "}  ${mutant.name}  :${mutant.line}\n`);
    if (survived) survivors.push(mutant);
  }
} finally {
  /*
   * Restored whatever happened, including on an interrupt. A tool that can leave a mutated source file
   * behind is a tool that will, and the file it leaves behind is a weakened guard in a passing repository —
   * exactly the state this exists to find.
   */
  writeFileSync(sourcePath, original);
}

process.stdout.write(
  `\n${ran} run, ${survivors.length} survived, ${invalid.length} invalid `
  + `(${ran - survivors.length - invalid.length} killed)\n`,
);
if (invalid.length > 0) {
  process.stdout.write(
    "\nAn invalid mutant did not compile, so it measured nothing. If there are many, an operator above is\n"
    + "matching syntax rather than logic — which is how this tool once reported twenty false kills.\n",
  );
}
if (survivors.length > 0) {
  process.stdout.write(
    "\nA survivor is a line the test file does not hold. Some are legitimately unreachable — read each one\n"
    + "and decide; that judgement is not automatable, which is why this prints rather than fails.\n\n",
  );
  for (const survivor of survivors) {
    process.stdout.write(`  ${sourceArg}:${survivor.line}  (${survivor.name})\n    ${survivor.text}\n`);
  }
  process.stdout.write("\n");
}
// Exit 0 either way: this reports, it does not gate. See the header.
