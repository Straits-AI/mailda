#!/usr/bin/env node
/**
 * Runs a command, passes its output through, and fails if workerd logged an uncaught exception during it.
 *
 *     pnpm exec node scripts/fail-on-uncaught.mjs vitest run [files…]
 *
 * `pnpm exec` because it puts `node_modules/.bin` on PATH, where `vitest` is; the package's `test` script
 * gets that from `pnpm run` and so calls it without the prefix.
 *
 * ## Why a passing suite was not enough
 *
 * workerd logs a line beginning `uncaught exception` for a throw that nothing in the throwing isolate handled,
 * and that includes an RPC method that throws: the object it threw in logs it at the moment of the throw,
 * even when the caller catches the rejection. Measured on 27 September 2026: the same throw logs one line
 * across RPC and none when run inside the object's own isolate, and no `unhandledrejection` event fires in
 * the callee, so no code in the suite can observe it. The line never reaches vitest's report. CI printed
 * eight of them under a green suite in at least two runs (see "Eight lines under a green suite" in
 * docs/history.md).
 *
 * ## Why this reads the output
 *
 * The log line is the only witness, and the pool does not let a config replace the handler that prints it.
 * Both streams are read, since the pool prints workerd's info-level lines to stdout and its warnings and
 * errors to stderr. The pattern is anchored at the start of a line, after colour codes are removed, so a test
 * title or a comment that quotes the phrase does not count. It matches the shared prefix rather than one form:
 * the installed workerd has log sites that continue `; source = …` (the only form CI has shown),
 * `; exception = …` and `; description = …`. Miniflare drops any line that carries a hex stack trace before
 * printing it, so a throw logged that way never reaches this script whatever the pattern.
 *
 * ## What would blind it
 *
 * `verbose: false` in `vitest.config.ts` (the pool's default is true, and the config sets it explicitly): with
 * it workerd prints none of these lines. A pool that stops forwarding them, or a workerd release that rewords
 * them. `test/node/fail-on-uncaught.test.ts` catches all three by running `test/canary/uncaught.canary.ts`, a
 * caught throw across RPC, through this script and the real pool, and expecting it to fail. If that case reads
 * no line because miniflare stopped throwing there, the canary needs a new throw; the case stays.
 */
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const UNCAUGHT = /^uncaught exception\b/;
// Colour codes are stripped first, so a reporter that starts colouring these lines does not hide them.
const isUncaught = (line) => UNCAUGHT.test(stripVTControlCharacters(line));

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  process.stderr.write("usage: node scripts/fail-on-uncaught.mjs <command> [args…]\n");
  process.exit(2);
}

const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
const seen = [];

for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
  // A chunk can end mid-line, so the tail waits for the next chunk before it is tested.
  let tail = "";
  from.setEncoding("utf8");
  from.on("data", (chunk) => {
    to.write(chunk);
    const lines = (tail + chunk).split("\n");
    tail = lines.pop();
    seen.push(...lines.filter(isUncaught));
  });
  from.on("end", () => {
    if (isUncaught(tail)) seen.push(tail);
  });
}

child.on("error", (error) => {
  process.stderr.write(`fail-on-uncaught: could not run ${command}: ${error.message}\n`);
  process.exitCode = 1;
});

child.on("close", (code) => {
  if (seen.length > 0) {
    process.stderr.write([
      "",
      `E_UNCAUGHT_EXCEPTION  workerd logged ${seen.length} uncaught exception(s) during: ${[command, ...args].join(" ")}`,
      ...seen.map((line) => `  line     ${line}`),
      "  why      a throw nothing in its own isolate handled, such as an RPC method that threw; the test report cannot show it",
      "  find     files run in parallel and their output interleaves: run each alone with",
      "           pnpm exec node scripts/fail-on-uncaught.mjs vitest run <file>  (from apps/node/worker)",
      "",
    ].join("\n"));
  }
  // The command's own failure wins; otherwise a logged uncaught exception fails the run. Killed by a signal
  // (`code` is null) is a failure too.
  process.exitCode = code !== 0 ? (code ?? 1) : seen.length > 0 ? 1 : 0;
});
