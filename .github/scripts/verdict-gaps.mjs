import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Fails when a push to `main` lost its verdict.
 *
 * A cancelled run reads as neither pass nor fail — not in the run list, not on a badge, not to a person
 * glancing at the tab. Commit `14522c1` went unverified exactly that way, because the concurrency
 * policy cancelled it when the next push landed, and it looked fine. That policy is fixed and
 * `test/node/ci-policy.test.ts` stops it regressing; this catches the cases a policy cannot, which is a
 * run cancelled by a person or lost to somebody else's outage (as `51f283e` was, to a GitHub
 * action-download failure that killed it before a single step ran).
 *
 * ## What it does *not* check, and why
 *
 * Not "every commit has a run". GitHub creates one run per **push**, not per commit, so the middle
 * commits of a two-commit push legitimately have none — demanding otherwise would fail correct
 * behaviour, and a check that fires on correct behaviour gets deleted. The invariant is narrower and
 * actually true: **no run that started on main was thrown away**.
 */

const currentRunId = process.argv[2];
const repo = process.env.GITHUB_REPOSITORY;
if (repo === undefined) {
  console.error("GITHUB_REPOSITORY is unset — this only runs inside Actions.");
  process.exit(1);
}

/** How far back to look. Enough to span a busy day without paging. */
const WINDOW = 30;

function gh(path) {
  const out = execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(out);
}

function emit(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

const runs = gh(
  `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=${WINDOW}`,
).workflow_runs ?? [];

// The run doing the checking is still in flight, and an ancestor rerun may legitimately be queued.
const settled = runs.filter((run) => String(run.id) !== String(currentRunId));

function ageHours(iso) {
  return (Date.now() - Date.parse(iso)) / 3_600_000;
}

const lost = settled.filter((run) => run.status === "completed" && run.conclusion === "cancelled");
// A run that never finished is as absent as one that was killed; six hours is far past the 20-minute
// job timeout, so anything older is stuck rather than slow.
const stalled = settled.filter((run) => run.status !== "completed" && ageHours(run.created_at) > 6);

const rows = settled.slice(0, 10).map((run) => {
  const verdict = run.status === "completed" ? run.conclusion : run.status;
  const mark = verdict === "success" ? "ok" : verdict === "cancelled" ? "**lost**" : verdict;
  return `| \`${run.head_sha.slice(0, 7)}\` | ${mark} | ${String(run.display_title).slice(0, 54)} |`;
});

emit([
  "### Verdicts on main",
  "",
  `Checked the last **${settled.length}** push run(s).`,
  "",
  "| commit | verdict | title |",
  "|:--|:--|:--|",
  ...rows,
].join("\n"));

if (lost.length === 0 && stalled.length === 0) {
  emit("\nEvery push to main has a verdict.");
  process.exit(0);
}

emit([
  "",
  `> **${lost.length + stalled.length} push(es) to main have no verdict.**`,
  ">",
  ...lost.map((r) => `> - \`${r.head_sha.slice(0, 7)}\` was **cancelled** — ${r.html_url}`),
  ...stalled.map((r) => `> - \`${r.head_sha.slice(0, 7)}\` has been ${r.status} for ` +
    `${ageHours(r.created_at).toFixed(0)}h — ${r.html_url}`),
  ">",
  "> A cancelled run is not a passing one, and nothing in the interface says so. Re-run it: those",
  "> commits are on main and nothing has checked them.",
  ">",
  "> If this is failing because the concurrency policy started cancelling main again,",
  "> `test/node/ci-policy.test.ts` should have caught it first — fix that too.",
].join("\n"));

process.exitCode = 1;
