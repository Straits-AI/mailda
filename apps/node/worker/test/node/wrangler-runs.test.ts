import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { zonesOf } = await import("../../../../../packages/cli/src/verbs/provision.mjs");

/**
 * The CLI's reads of wrangler and the API that page or that read a file, run for real (30 September 2026).
 *
 * Each runs the CLI's own function in a child `node` with a stub `npx` first on PATH, written per test to
 * answer the way wrangler 4.118.0 does (`docs/receipts/wrangler-json-output.md`), or with a fake `fetch`. The
 * defects they were written against were all a first page or a first answer taken for the whole: a Workflow
 * on page two, a 51st zone, and an output-file entry an earlier command left behind.
 */

const CLI = resolve(import.meta.dirname, "../../../../../packages/cli/src");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dir(): string {
  const made = mkdtempSync(join(tmpdir(), "mailda-run-"));
  scratch.push(made);
  return made;
}

/** Runs `body` (an ES module's statements) with a stub `npx` whose shell script is `stub`. */
function withStub(stub: string, body: string, env: Record<string, string> = {}, cwd?: string) {
  const bin = dir();
  writeFileSync(join(bin, "npx"), `#!/bin/sh\n${stub}\n`);
  chmodSync(join(bin, "npx"), 0o755);
  const base = { ...process.env };
  for (const name of ["WRANGLER_OUTPUT_FILE_PATH", "WRANGLER_OUTPUT_FILE_DIRECTORY"]) delete base[name];
  // Bounded, so a listing that never ends fails here rather than hanging the suite.
  return spawnSync(process.execPath, ["--input-type=module", "-e", body], {
    encoding: "utf8", timeout: 20_000, cwd, env: { ...base, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
}

describe("wrangler's output file, read for this call only", () => {
  // Appends an upload entry naming the id it was given, as `writeOutput` does: one JSON line.
  const UPLOAD = `printf '{"type":"version-upload","version":1,"version_id":"%s"}\\n' "$MAILDA_TEST_ID" >> "$WRANGLER_OUTPUT_FILE_PATH"`;
  const read = `const { capture } = await import(${JSON.stringify(join(CLI, "support.mjs"))});`
    + ' const r = capture("npx", ["wrangler", "versions", "upload"], { quiet: true, output: true });'
    + " process.stdout.write(JSON.stringify({ entries: r.entries, file: process.env.WRANGLER_OUTPUT_FILE_PATH ?? null }));";

  it("reads the entry wrangler wrote, from a file of its own that is then removed", () => {
    const seen = join(dir(), "seen");
    const child = withStub(`echo "$WRANGLER_OUTPUT_FILE_PATH" > "$MAILDA_TEST_SEEN"; ${UPLOAD}`, read,
      { MAILDA_TEST_ID: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d", MAILDA_TEST_SEEN: seen });
    const { entries } = JSON.parse(child.stdout);
    expect(entries.map((one: { version_id: string }) => one.version_id)).toEqual(["1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"]);
    const used = readFileSync(seen, "utf8").trim();
    expect(used).not.toBe("");
    expect(existsSync(used), "the scratch output file is left behind").toBe(false);
  });

  it("honours the operator's WRANGLER_OUTPUT_FILE_PATH, and never takes an older entry in it for this call's", () => {
    const file = join(dir(), "theirs.json");
    // An upload from an earlier command is already in their file; this call's upload fails to write one.
    writeFileSync(file, `${JSON.stringify({ type: "version-upload", version_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })}\n`);
    const child = withStub("exit 0", read, { WRANGLER_OUTPUT_FILE_PATH: file });
    expect(JSON.parse(child.stdout).entries).toEqual([]);
    // And an upload that does write is read from their file, which keeps both.
    const again = withStub(UPLOAD, read, { WRANGLER_OUTPUT_FILE_PATH: file, MAILDA_TEST_ID: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" });
    expect(JSON.parse(again.stdout).entries.map((one: { version_id: string }) => one.version_id))
      .toEqual(["bbbbbbbb-cccc-dddd-eeee-ffffffffffff"]);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  /*
   * `mailda deploy` runs from the repository root and starts wrangler in apps/node/worker, and wrangler resolves a
   * relative path against its own directory. Here the CLI runs in `here` and wrangler in `there`.
   */
  const readThere = (there: string) => `const { capture } = await import(${JSON.stringify(join(CLI, "support.mjs"))});`
    + ` const r = capture("npx", ["wrangler", "versions", "upload"], { quiet: true, output: true, cwd: ${JSON.stringify(there)} });`
    + " process.stdout.write(JSON.stringify({ entries: r.entries }));";

  it("reads a relative WRANGLER_OUTPUT_FILE_PATH from where it was set, when wrangler runs elsewhere", () => {
    const [here, there] = [dir(), dir()];
    const child = withStub(UPLOAD, readThere(there), { WRANGLER_OUTPUT_FILE_PATH: "out.json", MAILDA_TEST_ID: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" }, here);
    expect(JSON.parse(child.stdout).entries).toHaveLength(1);
    expect(existsSync(join(here, "out.json"))).toBe(true);
    expect(existsSync(join(there, "out.json"))).toBe(false);
  });

  it("does the same for a relative WRANGLER_OUTPUT_FILE_DIRECTORY", () => {
    const [here, there] = [dir(), dir()];
    const child = withStub(`mkdir -p "$(dirname "$WRANGLER_OUTPUT_FILE_PATH")"; ${UPLOAD}`, readThere(there),
      { WRANGLER_OUTPUT_FILE_DIRECTORY: "outs", MAILDA_TEST_ID: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" }, here);
    expect(JSON.parse(child.stdout).entries).toHaveLength(1);
    expect(existsSync(join(there, "outs"))).toBe(false);
  });

  it("writes inside WRANGLER_OUTPUT_FILE_DIRECTORY when that is what is set, and leaves the file there", () => {
    const where = dir();
    const child = withStub(UPLOAD, read, { WRANGLER_OUTPUT_FILE_DIRECTORY: where, MAILDA_TEST_ID: "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d" });
    expect(JSON.parse(child.stdout).entries).toHaveLength(1);
    expect(readdirSync(where)).toHaveLength(1);
    expect(readdirSync(where)[0]).toMatch(/^wrangler-output-.*\.json$/);
  });
});

describe("the account's Nodes, every page of them", () => {
  // `wrangler workflows list --page N`: a ButlerRun on page 1 and on page 2, then an empty page 3.
  const row = (name: string, script: string, cls: string) => `echo "│ ${name} │ ${script} │ ${cls} │ 1/1 │ 1/1 │"`;
  const PAGED = [
    'case "$5" in',
    `  1) echo "│ Name │ Script name │ Class name │ Created │ Modified │"; ${row("mailda-butler-runs", "mailda", "ButlerRun")}; ${row("x", "billing", "SyncFlow")} ;;`,
    `  2) ${row("support-butler-runs", "support", "ButlerRun")} ;;`,
    '  *) echo "No Workflows found on page $5. Please try a smaller page number." >&2 ;;',
    "esac",
  ].join("\n");
  const list = `const { existingNodes } = await import(${JSON.stringify(join(CLI, "verbs/install.mjs"))});`
    + " process.stderr.write(`nodes=${JSON.stringify(existingNodes())}\\n`);";

  it("offers a Node that is on the second page", () => {
    const child = withStub(PAGED, list);
    expect(child.stderr).toContain('nodes=["mailda","support"]');
  });

  it("says how far it got when a later page fails, and offers what it read", () => {
    // npx appends npm's update notice after wrangler's own reason; the reason is what is quoted.
    const failing = PAGED.replace('  2) ', '  2) printf "fetch failed\\nnpm notice New major version of npm available!\\nnpm notice\\n" >&2; exit 1; ');
    const child = withStub(failing, list);
    expect(child.stderr).toContain('nodes=["mailda"]');
    expect(child.stdout).toContain("could not be listed past page 1 (wrangler exited 1: fetch failed)");
  });

  it("stops at the second page, and says so, on a wrangler that answers every page the same", () => {
    const calls = join(dir(), "calls");
    const child = withStub(`echo x >> "${calls}"; ${row("mailda-butler-runs", "mailda", "ButlerRun")}`, list);
    expect(child.stderr).toContain('nodes=["mailda"]');
    expect(child.stdout).toContain("the page repeated");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
  });
});

describe("signing in before an install", () => {
  /*
   * A stored login whose refresh fails answers `whoami --json` with exit 1, nothing on stdout and "Not logged
   * in" on stderr (wrangler 4.118.0: the stored token is found, the refresh inside the account read throws).
   * That is `unreadable`, and the remedy is a login, so the install opens one rather than stopping. The stub
   * answers that way until `wrangler login` has run, then signed in with one account.
   */
  it("opens a login for an unreadable answer, then reads the account", () => {
    const state = join(dir(), "logged-in");
    const stub = [
      'case "$2" in',
      `  login) touch "${state}" ;;`,
      `  whoami) if [ -f "${state}" ]; then echo '{"loggedIn":true,"authType":"OAuth Token","accounts":[{"id":"0a1b2c3d4e5f60718293a4b5c6d7e8f9","name":"Ops"}]}'; else echo "✘ Not logged in." >&2; exit 1; fi ;;`,
      "esac",
    ].join("\n");
    const body = `const { signInAndChooseAccount } = await import(${JSON.stringify(join(CLI, "verbs/install.mjs"))});`
      + " await signInAndChooseAccount(); process.stderr.write(`account=${process.env.CLOUDFLARE_ACCOUNT_ID}\\n`);";
    const child = withStub(stub, body, { CLOUDFLARE_ACCOUNT_ID: "" });
    expect(child.stdout).toContain("wrangler could not say who is signed in");
    expect(child.stdout).toContain("== signing in to Cloudflare");
    expect(child.stderr).toContain("account=0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  });
});

describe("the account's zones, every page of them", () => {
  /** A fake API holding `count` zones, 50 a page, whose page `failAt` (if any) answers 500. */
  function api(count: number, failAt: number | null = null) {
    const asked: number[] = [];
    const fake = (async (url: string | URL | Request) => {
      const page = Number(new URL(String(url)).searchParams.get("page"));
      asked.push(page);
      if (page === failAt) return new Response("{}", { status: 500 });
      const names = Array.from({ length: count }, (_, i) => `zone${i + 1}.example`).slice((page - 1) * 50, page * 50);
      return Response.json({ result: names.map((name) => ({ name })), result_info: { page, per_page: 50, total_pages: Math.ceil(count / 50) } });
    }) as typeof fetch;
    return { fake, asked };
  }

  it("reads past the first 50", async () => {
    const { fake, asked } = api(120);
    const zones = await zonesOf("0a1b2c3d4e5f60718293a4b5c6d7e8f9", "tok", fake);
    expect(zones).toHaveLength(120);
    expect(zones.at(-1)).toEqual({ name: "zone120.example" });
    expect(asked).toEqual([1, 2, 3]);
  });

  it("keeps what it read when a later page fails, and says where it stopped", async () => {
    const { fake } = api(120, 2);
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await zonesOf("0a1b2c3d4e5f60718293a4b5c6d7e8f9", "tok", fake)).toHaveLength(50);
    } finally {
      process.stdout.write = original;
    }
    expect(written.join("")).toContain("stopped at page 2 (answered 500); 50 zone(s) were read");
  });
});
