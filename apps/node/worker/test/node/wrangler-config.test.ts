import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const { tokenFrom } = await import("../../../../../packages/cli/src/wrangler-config.mjs");

/**
 * `mailda install` reuses wrangler's login token for the account work, read from `wrangler auth token --json`
 * since 30 September 2026 (`docs/receipts/wrangler-json-output.md`). What would be wrong and still look
 * right: a Global API Key sent where a Bearer token belongs, a token read out of an answer that was not a
 * success, or the token printed where an operator or a build log can see it.
 *
 * The three shapes below are what wrangler 4.118.0 printed in an isolated HOME: `api_token` and `api_key`
 * with made-up values in the environment, and not-signed-in as exit 1 with nothing on stdout. The `oauth`
 * shape is from its bundled source (`authTokenCommand`), since a real one would be a real login.
 */
describe("reading `wrangler auth token --json`", () => {
  it("takes the token from a login and from CLOUDFLARE_API_TOKEN", () => {
    expect(tokenFrom('\n{\n  "type": "oauth",\n  "token": "tok-login"\n}\n', 0)).toEqual({ token: "tok-login", error: null });
    expect(tokenFrom('{\n  "type": "api_token",\n  "token": "fake-not-a-token"\n}\n', 0))
      .toEqual({ token: "fake-not-a-token", error: null });
  });

  it("refuses a Global API Key, which has no token to send", () => {
    const read = tokenFrom('{\n  "type": "api_key",\n  "key": "fakekey",\n  "email": "a@b.c"\n}\n', 0);
    expect(read.token).toBeNull();
    expect(read.error).toContain("CLOUDFLARE_API_TOKEN");
    // The key is a credential too: the reason never repeats it.
    expect(read.error).not.toContain("fakekey");
  });

  it("reads nothing from a failed call or an answer it does not know", () => {
    expect(tokenFrom("", 1).token).toBeNull();
    // A success whose stdout is not the JSON shape is not a token, and the reason does not quote stdout.
    const odd = tokenFrom("tok-plain-text", 0);
    expect(odd.token).toBeNull();
    expect(odd.error).not.toContain("tok-plain-text");
    expect(tokenFrom('{"type":"oauth"}', 0).token).toBeNull();
    // Exit status wins over a body: wrangler failed, whatever it printed.
    expect(tokenFrom('{"type":"oauth","token":"stale"}', 1).token).toBeNull();
  });
});

/**
 * The credential never reaches the terminal. `capture` echoes what it reads unless told `quiet`, so the token
 * read is run here for real, against a stub `npx` on PATH that answers the way wrangler does, and the child's
 * whole stdout is searched for the token. Break it by dropping `quiet: true` from `wranglerTokenRead` and this
 * fails.
 *
 * The stub's "token" is a shell string, so it can answer with the environment it was started in: that is how
 * these tests see what the CLI gives wrangler. Metrics off unless the operator said otherwise (AGENTS.md
 * principle 1; `childEnv` in `support.mjs`); the log level and colour pinned whatever the operator's shell says,
 * since both change what wrangler prints; and wrangler's debug log kept off disk. That last one is wrangler's own
 * write, which no stub performs, so what is asserted is the environment that stops it
 * (`docs/receipts/wrangler-json-output.md` has the run against the real 4.118.0 and 4.90.1).
 */
describe("the token read, run", () => {
  const PROVISION = resolve(import.meta.dirname, "../../../../../packages/cli/src/verbs/provision.mjs");
  const TOKEN = "tok-must-not-be-printed-7f3a";

  function readWith(env: Record<string, string>, token = TOKEN, before = "") {
    const dir = mkdtempSync(join(tmpdir(), "mailda-npx-"));
    try {
      writeFileSync(join(dir, "npx"), [
        "#!/bin/sh",
        before,
        `printf '{\n  "type": "oauth",\n  "token": "%s"\n}\n' "${token}"`,
      ].join("\n"));
      chmodSync(join(dir, "npx"), 0o755);
      const script = `const m = await import(${JSON.stringify(PROVISION)}); const t = m.wranglerTokenRead();`
        + " process.stderr.write(`returned=${t.token}\\nerror=${t.error}\\n`);";
      const base = { ...process.env };
      for (const name of ["CLOUDFLARE_API_TOKEN", "WRANGLER_SEND_METRICS", "WRANGLER_LOG", "FORCE_COLOR", "WRANGLER_WRITE_LOGS", "WRANGLER_LOG_PATH"]) delete base[name];
      return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { ...base, PATH: `${dir}:${process.env.PATH}`, ...env },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("returns the token and prints none of it", () => {
    const child = readWith({});
    expect(child.stderr).toContain(`returned=${TOKEN}`);
    expect(child.stdout).not.toContain(TOKEN);
  });

  it("asks wrangler even with CLOUDFLARE_API_TOKEN set, so a Global API Key beside it is refused as wrangler would use it", () => {
    // wrangler 4.118.0 answers api_key when CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL are set, whatever the token says.
    const child = readWith({ CLOUDFLARE_API_TOKEN: "env-token" }, "", `printf '{"type":"api_key","key":"k","email":"a@b.c"}\\n'; exit 0`);
    expect(child.stderr).toContain("returned=null");
    expect(child.stderr).toContain("Global API Key");
  });

  it("says what wrangler said when it exits without a token, not that there is no login", () => {
    const child = readWith({}, "", "echo 'Invalid TOML document: only letter, numbers' >&2; exit 1");
    expect(child.stderr).toContain("wrangler said: Invalid TOML document");
    // npx appends npm's update notice after wrangler exits, and wrangler colours its error on a pipe (both measured).
    const behind = readWith({}, "", "printf '\\033[31m✘ [ERROR]\\033[0m Not logged in.\\n\\nnpm notice\\nnpm notice New major version of npm available!\\nnpm notice\\n' >&2; exit 1");
    expect(behind.stderr).toContain("wrangler said: ✘ [ERROR] Not logged in.");
  });

  it("starts wrangler with its usage metrics off, unless the operator set them", () => {
    expect(readWith({}, "metrics-$WRANGLER_SEND_METRICS").stderr).toContain("returned=metrics-false");
    expect(readWith({ WRANGLER_SEND_METRICS: "true" }, "metrics-$WRANGLER_SEND_METRICS").stderr)
      .toContain("returned=metrics-true");
  });

  it("asks at the log level whose answer it reads, without colour, whatever the operator's shell says", () => {
    // At WRANGLER_LOG=error wrangler 4.118.0 prints no token at all (exit 0); FORCE_COLOR colours a pipe.
    expect(readWith({ WRANGLER_LOG: "error", FORCE_COLOR: "1" }, "level-$WRANGLER_LOG-colour-$FORCE_COLOR").stderr)
      .toContain("returned=level-log-colour-0");
  });

  it("keeps wrangler's debug log, which records the token, off disk", () => {
    // What wrangler below 4.91.0 does with WRANGLER_LOG_PATH: writes its log, token included, into that directory.
    const child = readWith({}, "writes-$WRANGLER_WRITE_LOGS-into-$WRANGLER_LOG_PATH",
      `echo "${TOKEN}" > "$WRANGLER_LOG_PATH/wrangler-log.log"`);
    const said = /returned=writes-(\w+)-into-(\S+)/.exec(child.stderr);
    expect(said?.[1]).toBe("false");
    expect(said?.[2]).toMatch(/mailda-wrangler-log-/);
    expect(existsSync(said![2]!), "the directory holding wrangler's log outlived the call").toBe(false);
  });
});
