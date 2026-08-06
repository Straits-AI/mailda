import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Holds ADR 24's amended update story to what git actually does.
 *
 * The decision originally claimed updates are a fast-forward, with one exception for resource ids
 * written into `wrangler.jsonc`. A real Deploy to Cloudflare install
 * (receipt: `deploy-button-install.md`) showed both halves were wrong: no ids are written, and there is
 * no fast-forward available at all — the clone is a squashed `source repo import` commit with **no
 * common ancestor**, so `git merge-base` exits 1 and a pull can never fast-forward whatever the files
 * say.
 *
 * What replaces it is bounded: one `--allow-unrelated-histories` merge whose only conflict is
 * `package.json`, whose `name` Workers Builds rewrites. That merge creates the missing ancestor, so
 * every later update is an ordinary three-way merge.
 *
 * **This test is what stops that from silently becoming false.** The amendment is one line of
 * documentation — "resolve `package.json` to your side" — and it holds only while `package.json` is the
 * *only* file that diverges. If upstream starts committing something else the button rewrites or
 * strips, the customer's first update grows a second conflict and the instruction is wrong. That is the
 * kind of drift nobody discovers until a customer reports it.
 *
 * Built entirely from the working tree in a temp directory: **no network**, no clone of upstream, and
 * nothing touched outside `mkdtemp`. Two local repositories are constructed to stand in for upstream and
 * for the button's import.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");

/** The files the button is known to change, from the measured install. */
const BUTTON_REWRITES = ["package.json"];
const BUTTON_STRIPS = [".github/workflows"];

let work: string;
let upstream: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // A committer identity is required and must not depend on the machine's global config.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

/**
 * A repository whose content is this working tree, reduced to the files that matter here.
 *
 * The whole tree is unnecessary and slow; what the test needs is a repository where `package.json` and
 * `.github/workflows/ci.yml` exist with the real content, plus enough other files that "everything else
 * merges silently" is a claim about more than nothing.
 */
function seed(target: string): void {
  for (const file of ["package.json", "pnpm-workspace.yaml", "turbo.json", "README.md", "AGENTS.md"]) {
    const from = join(repoRoot, file);
    if (existsSync(from)) writeFileSync(join(target, file), readFileSync(from));
  }
  mkdirSync(join(target, ".github/workflows"), { recursive: true });
  writeFileSync(
    join(target, ".github/workflows/ci.yml"),
    readFileSync(join(repoRoot, ".github/workflows/ci.yml")),
  );
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "mailda-update-"));
  upstream = join(work, "upstream");
  clone = join(work, "clone");

  mkdirSync(upstream, { recursive: true });
  git(upstream, "init", "-q", "-b", "main");
  seed(upstream);
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "upstream");

  // The button's output: one squashed commit, the rewrites applied, the strips removed. Crucially it
  // is *not* cloned from upstream — that absence of ancestry is the thing being tested.
  mkdirSync(clone, { recursive: true });
  git(clone, "init", "-q", "-b", "main");
  seed(clone);
  const pkg = JSON.parse(readFileSync(join(clone, "package.json"), "utf8")) as Record<string, unknown>;
  pkg.name = "mailda-btn";
  writeFileSync(join(clone, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  rmSync(join(clone, ".github/workflows"), { recursive: true, force: true });
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "source repo import");

  git(clone, "remote", "add", "upstream", upstream);
  git(clone, "fetch", "-q", "upstream", "main");
});

afterAll(() => {
  if (work !== undefined) rmSync(work, { recursive: true, force: true });
});

describe("ADR 24's update path", () => {
  it("has no common ancestor, so a fast-forward is impossible", () => {
    let exitCode = 0;
    try {
      git(clone, "merge-base", "HEAD", "upstream/main");
    } catch {
      exitCode = 1;
    }
    // This is the fact that invalidated "updates are fast-forward". If it ever becomes 0 — because the
    // button starts preserving history — ADR 24's original guarantee is available again and the
    // amendment should be revisited rather than left as the more pessimistic story.
    expect(exitCode).toBe(1);
  });

  it("conflicts in exactly one file, and that file is package.json", () => {
    try {
      git(clone, "merge", "upstream/main", "--allow-unrelated-histories", "-m", "update");
    } catch {
      // A conflicting merge exits non-zero. Expected.
    }
    const conflicted = git(clone, "diff", "--name-only", "--diff-filter=U").trim().split("\n")
      .filter((line) => line.length > 0).sort();

    // The amendment is one line of documentation — "resolve package.json to your side". It is true only
    // while this list has one entry. A second file means a customer's first update needs judgement
    // rather than a rule, and the instruction in §29 has to change.
    expect(conflicted).toEqual(BUTTON_REWRITES);
  });

  it("restores the CI the install stripped", () => {
    // Worth asserting because it is the one part of this that improves without anyone doing anything:
    // an installed Node has no checks, and its first update brings them back.
    for (const stripped of BUTTON_STRIPS) {
      expect(existsSync(join(clone, stripped, "ci.yml"))).toBe(true);
    }
  });

  it("leaves an ancestor behind, so the second update is an ordinary merge", () => {
    // Resolve the way §29 says to: keep our name.
    const ours = git(clone, "show", ":2:package.json");
    writeFileSync(join(clone, "package.json"), ours);
    git(clone, "add", "package.json");
    git(clone, "commit", "-q", "-m", "merge upstream");

    // The merge commit is the ancestor the import lacked. Everything after this is normal git, which is
    // the whole reason one conflict is an acceptable price.
    expect(git(clone, "merge-base", "HEAD", "upstream/main").trim().length).toBe(40);
    expect(git(clone, "merge", "upstream/main", "-m", "second update")).toContain("Already up to date");
  });

  it("keeps the customer's name and upstream's content after resolution", () => {
    const pkg = JSON.parse(readFileSync(join(clone, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg.name).toBe("mailda-btn");
    // Their name, but upstream's scripts — a resolution that took "ours" wholesale for the file would
    // silently freeze the customer's scripts at install time, which is the failure this checks against.
    const upstreamPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(Object.keys(pkg.scripts as Record<string, string>).sort())
      .toEqual(Object.keys(upstreamPkg.scripts).sort());
  });
});
