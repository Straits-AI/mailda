import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";

/**
 * Reports how close the slowest test came to the timeout, on the hardware that actually ran it.
 *
 * Exists because `docs/receipts/test-timeout-headroom.md` derives the 30s timeout from a worst case of
 * 5,790ms measured on an 8-core laptop, and names CI hardware as a condition that makes that number
 * stale. The headroom between the slowest test and the timeout is the interesting quantity — not the
 * timeout on its own — because a suite creeping toward its ceiling reads as flakiness only after it
 * starts failing, and by then somebody has usually reached for `retry`.
 *
 * Reads the report the test run already produced (`vitest.config.ts` adds a json reporter when CI is
 * set) rather than running the suite again for a number the first run knows.
 */

const REPORT = "apps/node/worker/.vitest-report.json";

/** Read from the generated constants so this cannot drift from the value vitest actually used. */
function timeoutMs() {
  const generated = readFileSync("packages/budgets/src/generated.ts", "utf8");
  const found = /"test\.timeout_ms":\s*(\d+)/.exec(generated);
  if (found === null) throw new Error("test.timeout_ms is not in the generated budgets");
  return Number(found[1]);
}

function emit(markdown) {
  console.log(markdown);
  // Absent when this script is run outside Actions, which is how it stays runnable by hand.
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

if (!existsSync(REPORT)) {
  // A failed suite may not have written one. Silence here is honest; the test step already failed.
  emit(`No test report at \`${REPORT}\` — the suite did not finish.`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const tests = report.testResults
  .flatMap((file) => file.assertionResults.map((a) => ({ name: a.fullName, ms: a.duration ?? 0 })))
  .sort((a, b) => b.ms - a.ms);

const timeout = timeoutMs();
const worst = tests[0]?.ms ?? 0;

const rows = tests
  .slice(0, 8)
  .map((t) => `| ${t.ms} | ${((t.ms / timeout) * 100).toFixed(1)}% | ${t.name.slice(0, 90)} |`);

emit(
  [
    "### Test headroom on this hardware",
    "",
    `Cores: **${cpus().length}** · timeout: **${timeout}ms** · tests: **${tests.length}**`,
    "",
    `Slowest test used **${worst}ms**, which is **${((worst / timeout) * 100).toFixed(1)}%** of the timeout ` +
      `(**${(timeout / Math.max(worst, 1)).toFixed(1)}x** headroom).`,
    "",
    "| ms | % of timeout | test |",
    "|---:|---:|:---|",
    ...rows,
    "",
    "Recorded rather than enforced — see `docs/receipts/test-timeout-headroom.md` for why the threshold " +
      "is set from measurement rather than chosen in advance.",
  ].join("\n"),
);
