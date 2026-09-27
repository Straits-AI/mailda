import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import { WORKER_DIR } from "./wrangler-world";

/**
 * What `scripts/fail-on-uncaught.mjs` does with the output of the command it runs.
 *
 * The workerd suite is run through it so that an `uncaught exception` workerd logs fails the build rather
 * than scrolling past a green report. Most cases run a stand-in Node process that prints what workerd would,
 * so each can decide exactly which bytes arrive and how. The last runs the real pool, because only that shows
 * the lines still arrive at all.
 */

const SCRIPT = join(WORKER_DIR, "scripts", "fail-on-uncaught.mjs");

/** Copied from the CI log of 27 September 2026, the first line of one of the eight. */
const FROM_CI = "uncaught exception; source = Uncaught (in promise); stack = Error: Engine was never started";

/** Runs the guard over a child that executes `program` and exits with `code`. */
function guard(program: string, code = 0): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, process.execPath, "-e", `${program}; process.exitCode = ${code};`], {
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("fail-on-uncaught", () => {
  it("fails a passing command that printed an uncaught exception, and names the line", () => {
    const run = guard(`console.log("✓ every test passed"); console.log(${JSON.stringify(FROM_CI)})`);
    expect(run.status).toBe(1);
    expect(run.stdout, "the command's own output was not passed through").toContain("every test passed");
    expect(run.stderr).toContain("E_UNCAUGHT_EXCEPTION  workerd logged 1 uncaught exception(s)");
    expect(run.stderr).toContain(`  line     ${FROM_CI}`);
  });

  it("reads stderr too, through colour codes and a line split across two writes", () => {
    const run = guard(`
      process.stderr.write("\\x1b[31muncaught exc");
      setTimeout(() => process.stderr.write("eption; source = Uncaught; stack = Error: late\\x1b[39m\\n"), 50);
    `);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("workerd logged 1 uncaught exception(s)");
  });

  it("fails on each form workerd logs, not only the one CI has shown", () => {
    // The installed workerd also logs `uncaught exception` followed by `; exception = …` or `; description = …`.
    const run = guard(`console.log("uncaught exception; exception = kj/async.c++:215: failed: jsg.Error: boom")`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("workerd logged 1 uncaught exception(s)");
  });

  it("passes a command that only mentions the phrase inside a line", () => {
    // A test title, or a doc quoting the log, is not workerd reporting a throw.
    const run = guard(`console.log("stdout | test/x.test.ts > quotes " + ${JSON.stringify(FROM_CI)})`);
    expect(run.stderr).not.toContain("E_UNCAUGHT_EXCEPTION");
    expect(run.status).toBe(0);
  });

  it("keeps the command's own failure as the exit code", () => {
    expect(guard(`console.log("1 test failed")`, 3).status).toBe(3);
  });

  it("is what the package's test script runs the workerd suite through", () => {
    // A guard nothing invokes reads exactly like one that passed.
    const { scripts } = JSON.parse(readFileSync(join(WORKER_DIR, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const vitestRuns = scripts["test"]!.split("&&").map((step) => step.trim()).filter((step) => step.includes("vitest run"));
    // The node and client suites name their config with `-c`; the workerd suite is the one run without it.
    expect(vitestRuns.filter((step) => !/\s-c\s/.test(step)))
      .toEqual(["node scripts/fail-on-uncaught.mjs vitest run"]);
  });

  // Its own timeout because it starts the workerd pool, which took up to 32 s under load; measured in
  // docs/receipts/test-timeout-headroom.md under "A second exemption".
  it("still sees workerd's lines from the real pool, through the workerd suite's own config", { timeout: BUDGETS["test.uncaught_canary_timeout_ms"] }, () => {
    // `test/canary/uncaught.canary.ts` catches a throw across RPC, so its one test passes and workerd logs the
    // throw. If `verbose` is off, the pool stops forwarding the lines, or workerd rewords them, the guard reads
    // nothing and exits 0, which is also what it does for a clean suite; only this case tells the two apart.
    const run = spawnSync(process.execPath, [
      SCRIPT, join(WORKER_DIR, "node_modules", ".bin", "vitest"), "run", "-c", "vitest.canary.config.ts",
    ], { cwd: WORKER_DIR, encoding: "utf8" });
    const stdout = stripVTControlCharacters(run.stdout);
    expect(stdout, "the canary test itself did not pass, so the exit code below says nothing").toMatch(/Tests\s+1 passed \(1\)/);
    expect(run.stderr).toContain("E_UNCAUGHT_EXCEPTION");
    expect(run.stderr).toMatch(/^ {2}line {5}uncaught exception/m);
    expect(run.status).toBe(1);
  });
});
