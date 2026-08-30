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
 * Reads the reports the test run already produced (each config adds a json reporter when CI is set)
 * rather than running the suite again for a number the first run knows.
 *
 * **All three suites**, which took a flake to notice. This read only the workerd report, so the ceiling
 * designed to catch a test creeping toward the timeout could not see `test/node/` or `test/client/` at
 * all — and `test/node/attach-queue-consumer.test.ts` is the file that went on to breach 5,000 ms under
 * load. It was invisible twice over: its config had no measured timeout, and this check never read it.
 *
 * It gates as well as reports, because a printed warning nobody fails on is the muted check AGENTS.md
 * warns about. The threshold comes from measurement rather than taste: the first CI run put the slowest
 * test at 753ms against a 30,000ms timeout — 2.5%, or 39.8x headroom, since this hardware derives
 * PBKDF2 roughly nine times faster than the laptop the timeout was sized on. Failing at half the
 * timeout therefore leaves ~20x margin over what was observed, which is loose enough that ordinary
 * noisy-neighbour variance cannot reach it and tight enough to catch a test that has genuinely grown.
 */

/**
 * One report per config, because one config is one `testTimeout` and each has its own way to be slow.
 * Named individually rather than globbed: a config that stops emitting its report should show up as a
 * suite this check can no longer see, and a glob would simply find one fewer file and say nothing.
 */
const REPORTS = [
  { suite: "workerd", path: "apps/node/worker/.vitest-report.json" },
  { suite: "node", path: "apps/node/worker/.vitest-report-node.json" },
  { suite: "client", path: "apps/node/worker/.vitest-report-client.json" },
];

/**
 * Both numbers come from the generated budgets, so neither can drift from the receipt that measured it
 * — the same rule the rest of the codebase follows. Read by regex rather than imported because this is
 * plain Node running before any build step, and generated.ts is TypeScript.
 */
function budget(name) {
  const generated = readFileSync("packages/budgets/src/generated.ts", "utf8");
  const found = new RegExp(`"${name.replace(".", "\\.")}":\\s*(\\d+)`).exec(generated);
  if (found === null) throw new Error(`${name} is not in the generated budgets`);
  return Number(found[1]);
}

function emit(markdown) {
  console.log(markdown);
  // Absent when this script is run outside Actions, which is how it stays runnable by hand.
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

const present = REPORTS.filter((r) => existsSync(r.path));
const missing = REPORTS.filter((r) => !existsSync(r.path));

if (present.length === 0) {
  // A failed suite may not have written any. Silence here is honest; the test step already failed.
  emit(`No test reports found — the suite did not finish.`);
  process.exit(0);
}

/*
 * Which suites are absent is stated rather than left to a smaller number. This step runs under
 * `if: always()`, so a crashed suite legitimately writes nothing and gating on that would fail every run
 * that already failed for a better reason. But a report quietly disappearing is how the coverage this
 * commit just added would be lost, and an unmentioned absence is indistinguishable from a fast suite.
 */
const tests = present
  .flatMap(({ suite, path }) =>
    JSON.parse(readFileSync(path, "utf8")).testResults
      .flatMap((file) => file.assertionResults.map((a) => ({ suite, name: a.fullName, ms: a.duration ?? 0 })))
  )
  .sort((a, b) => b.ms - a.ms);

const timeout = budget("test.timeout_ms");
const worst = tests[0]?.ms ?? 0;

const rows = tests
  .slice(0, 8)
  .map((t) => `| ${t.ms} | ${((t.ms / timeout) * 100).toFixed(1)}% | ${t.suite} | ${t.name.slice(0, 90)} |`);

/**
 * The share of the timeout a single test may take before this fails.
 *
 * Not a performance budget — tests are allowed to be slow, and the PBKDF2 ones are slow on purpose. It
 * is a warning that the *timeout* is becoming the binding constraint, which is the condition that
 * produced the cascading failures this receipt exists to explain.
 */
const CEILING = budget("test.headroom_ceiling_percent") / 100;

emit(
  [
    "### Test headroom on this hardware",
    "",
    `Cores: **${cpus().length}** · timeout: **${timeout}ms** · tests: **${tests.length}** · ` +
      `suites read: **${present.map((r) => r.suite).join(", ")}**`,
    "",
    ...(missing.length === 0
      ? []
      : [`> No report from: **${missing.map((r) => r.suite).join(", ")}** — those suites are unmeasured here.`, ""]),
    `Slowest test used **${worst}ms**, which is **${((worst / timeout) * 100).toFixed(1)}%** of the timeout ` +
      `(**${(timeout / Math.max(worst, 1)).toFixed(1)}x** headroom).`,
    "",
    "| ms | % of timeout | suite | test |",
    "|---:|---:|:---|:---|",
    ...rows,
    "",
    `Fails above **${CEILING * 100}%** of the timeout. See ` +
      "`docs/receipts/test-timeout-headroom.md` for where that threshold comes from.",
  ].join("\n"),
);

if (worst > timeout * CEILING) {
  const slowest = tests[0];
  emit(
    [
      "",
      `> **Over the headroom ceiling.** \`${slowest.name}\` (${slowest.suite}) took ${slowest.ms}ms, past ` +
        `${CEILING * 100}% of the ${timeout}ms timeout.`,
      ">",
      "> The fix is usually *not* to raise the timeout. A test this close to it will start timing out " +
        "under ordinary load, and one timeout leaves the isolated-storage undo stack unbalanced, so " +
        "later tests in the same file fail for reasons of their own — which is what makes the suite " +
        "look flaky rather than slow.",
      ">",
      "> Either the test got slower and should be understood, or the machine did and " +
        "`test.slowest_test_ms_under_load` needs re-measuring. Both are in " +
        "`docs/receipts/test-timeout-headroom.md`.",
    ].join("\n"),
  );
  process.exitCode = 1;
}
