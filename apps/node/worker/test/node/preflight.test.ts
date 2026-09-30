import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { cliSource } from "./support/cli-source.ts";

import { BUDGETS } from "@mailda/budgets";

const preflight = await import("../../../../../packages/cli/src/preflight.mjs");
const { atLeast, reportsItsVersion, resolveAccount, wranglerVersionFrom } = preflight;
const { whoamiFrom } = await import("../../../../../packages/cli/src/wrangler-config.mjs");

/**
 * What a deploy needs, checked before it changes anything (#98).
 *
 * ## The failure these were written from
 *
 * `mailda deploy` refused on an ordinary machine and diagnosed the wrong thing. The operator's wrangler token
 * could see four Cloudflare accounts, which makes every non-interactive wrangler call fail — and the chain
 * was worse than a bad message: the **Workflow-theft guard ran first**, could not read the account, printed a
 * note and returned. #99's protection against one Node stealing another's Butler engine silently did not run,
 * in exactly the situation where nothing else worked either.
 *
 * ## Where the fixtures come from
 *
 * Since 30 September 2026 preflight reads `wrangler whoami --json`, not the box-drawn table
 * (`docs/receipts/wrangler-json-output.md`). The signed-out answer below is what wrangler 4.118.0 printed in an
 * isolated HOME, exit 1. The signed-in one is its shape from `whoami()` in 4.118.0's bundled source, not a signed-in
 * run: `accounts` are the API's account objects, and the two below are the accounts the table fixture this
 * replaced was captured with, on the machine that hit the failure.
 */

/** `wrangler whoami --json`, signed in with an OAuth login that sees two accounts. Shape from 4.118.0's source. */
const WHOAMI = JSON.stringify({
  loggedIn: true,
  authType: "OAuth Token",
  email: "someone@example.test",
  accounts: [
    { id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", name: "Ops@alpha.example's Account", type: "standard" },
    { id: "f9e8d7c6b5a493827160f5e4d3c2b1a0", name: "Ops@beta.example's Account", type: "standard" },
  ],
  tokenPermissions: ["account:read", "user:read"],
}, null, 2);

/** Signed out, as 4.118.0 printed it: a blank line, then the JSON, on stdout, with exit 1. */
const SIGNED_OUT = '\n{"loggedIn":false}\n';

describe("reading what wrangler will do before it does it", () => {
  it("finds every account wrangler lists, by name and id", () => {
    const who = whoamiFrom(WHOAMI, 0);
    expect(who).toEqual({
      state: "signed_in",
      authType: "OAuth Token",
      accounts: [
        { name: "Ops@alpha.example's Account", id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" },
        { name: "Ops@beta.example's Account", id: "f9e8d7c6b5a493827160f5e4d3c2b1a0" },
      ],
    });
  });

  it("reads an API token's answer, which has no permissions list and may have no email", () => {
    // Under CLOUDFLARE_API_TOKEN (the Deploy button's Workers Builds), `tokenPermissions` is the OAuth scope
    // list and is undefined, so it drops out of the JSON; nothing here may depend on it.
    const token = JSON.stringify({
      loggedIn: true, authType: "Account API Token",
      accounts: [{ id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", name: "Ops@alpha.example's Account" }],
    });
    const who = whoamiFrom(token, 0);
    expect(who.state).toBe("signed_in");
    expect(who.state === "signed_in" && who.accounts.map((one) => one.id)).toEqual(["0a1b2c3d4e5f60718293a4b5c6d7e8f9"]);
  });

  it("tells signed out from unreadable, which send an operator to different places", () => {
    expect(whoamiFrom(SIGNED_OUT, 1)).toEqual({ state: "signed_out" });
    // A token that cannot list its accounts: exit 1, nothing on stdout, wrangler's reason on stderr.
    const failed = whoamiFrom("", 1, "✘ [ERROR] Failed to automatically retrieve account IDs for the logged in user.");
    expect(failed.state).toBe("unreadable");
    expect(failed.state === "unreadable" && failed.detail).toContain("Failed to automatically retrieve account IDs");
    // npm's update notice, which npx appends after wrangler exits, is not wrangler's reason (measured 30 Sep 2026).
    const behind = whoamiFrom("", 1, "✘ [ERROR] A request to the Cloudflare API (/accounts) failed.\n\nnpm notice\nnpm notice New major version\nnpm notice\nnpm notice\n");
    expect(behind.state === "unreadable" && behind.detail).toBe("exit 1: ✘ [ERROR] A request to the Cloudflare API (/accounts) failed.");
    // The table this replaced is not JSON, and is not read as a sign-in either way.
    expect(whoamiFrom("You are logged in with an OAuth Token", 0).state).toBe("unreadable");
    // A failed call is not a sign-in, whatever it printed.
    expect(whoamiFrom(WHOAMI, 1).state).toBe("unreadable");
    // A success that lost its accounts is not "no accounts".
    expect(whoamiFrom(JSON.stringify({ loggedIn: true, authType: "OAuth Token" }), 0).state).toBe("unreadable");
  });

  it("keeps only ids that are account ids", () => {
    const odd = JSON.stringify({ loggedIn: true, accounts: [{ id: "not-an-id", name: "x" }, { id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" }] });
    const who = whoamiFrom(odd, 0);
    expect(who.state === "signed_in" && who.accounts).toEqual([{ name: "(unnamed)", id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9" }]);
  });
});

describe("choosing the account, which is the failure this was built from", () => {
  const who = whoamiFrom(WHOAMI, 0);
  const accounts = who.state === "signed_in" ? who.accounts : [];

  it("refuses when the token sees several and nothing chose", () => {
    const chosen = resolveAccount({ accounts, chosen: undefined });
    expect(chosen.ok).toBe(false);
    if (chosen.ok) return;
    // The remedy names every candidate with its id, because the operator has to pick and cannot from a count.
    expect(chosen.fix).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(chosen.fix).toContain("f9e8d7c6b5a493827160f5e4d3c2b1a0");
    expect(chosen.fix).toContain("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    // And it names the consequence that is easy to miss: a guard that silently stops guarding.
    expect(chosen.why).toContain("#99");
  });

  it("asks for nothing when there is only one, because there is nothing to choose", () => {
    const single = resolveAccount({ accounts: [accounts[0]!], chosen: undefined });
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.id).toBe("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  });

  it("accepts a chosen account and reports which one it is", () => {
    const chosen = resolveAccount({ accounts, chosen: "f9e8d7c6b5a493827160f5e4d3c2b1a0" });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.name).toBe("Ops@beta.example's Account");
  });

  it("gives a chosen-but-unknown account its own message, not the ambiguous one", () => {
    /*
     * A different failure with a different remedy. wrangler answers a permissions error against an account
     * the token cannot reach, which reads like an expired login and sends people to re-authenticate rather
     * than to the typo they made. Sharing the ambiguous case's wording would send them the same wrong way.
     */
    const wrong = resolveAccount({ accounts, chosen: "0".repeat(32) });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.what).not.toBe("the Cloudflare account is ambiguous");
    expect(wrong.what).toContain("cannot see");
    expect(wrong.why).toContain("permissions error");
  });

  it("says nobody is signed in rather than blaming the choice", () => {
    const none = resolveAccount({ accounts: [], chosen: undefined });
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.fix).toContain("wrangler login");
  });
});

describe("the wrangler floor, which a string comparison gets backwards", () => {
  it("compares numerically", () => {
    /*
     * The bug this function exists to avoid, asserted directly: as strings, "4.118.0" < "4.97.0", because `1`
     * sorts before `9`. A floor checked that way rejects every wrangler released after 4.99 and accepts the
     * ones actually too old — the exact inversion, presenting as a broken toolchain on an up-to-date machine.
     */
    expect("4.118.0" >= "4.97.0").toBe(false);
    expect(atLeast("4.118.0", "4.97")).toBe(true);

    expect(atLeast("4.97.0", "4.97")).toBe(true);
    expect(atLeast("4.96.9", "4.97")).toBe(false);
    expect(atLeast("5.0.0", "4.97")).toBe(true);
    expect(atLeast("3.99.0", "4.97")).toBe(false);
    // Unknown is not "recent enough". A version that could not be read is one nobody has checked.
    expect(atLeast(null, "4.97")).toBe(false);
  });

  it("reads the version out of `wrangler --version`, which prints it bare", () => {
    // What 4.118.0 printed. `whoami --json` has no banner, which is why the version is asked for separately.
    expect(wranglerVersionFrom("4.118.0\n")).toBe("4.118.0");
    expect(wranglerVersionFrom(WHOAMI)).toBeNull();
    expect(wranglerVersionFrom("no version here")).toBeNull();
  });

  it("checks against the measured floors rather than numbers typed here", () => {
    // `workflow.schedules_min_wrangler`: below it a Workflow's `schedules` block is discarded with exit 0.
    // `wrangler.json_output_min_version`: below it there is no `whoami --json` (and below 4.57.0 no `auth token --json`).
    for (const name of ["workflow.schedules_min_wrangler", "wrangler.json_output_min_version"] as const) {
      const floor = BUDGETS[name];
      expect(floor, name).toBeGreaterThan(0);
      expect(atLeast("4.118.0", floor), name).toBe(true);
    }
    // 4.64.0 had `auth token --json` and not `whoami --json`: the receipt's measured boundary.
    expect(atLeast("4.64.0", BUDGETS["wrangler.json_output_min_version"])).toBe(false);
    expect(atLeast("4.65.0", BUDGETS["wrangler.json_output_min_version"])).toBe(true);
  });
});

/**
 * `runPreflight` run for real against a stub `npx` on PATH that answers `wrangler --version` and
 * `wrangler whoami --json` the way 4.118.0 does. 4.64.0 is below both floors (4.65 and 4.97), so both are
 * named, each with its own reason.
 */
describe("preflight, run against a wrangler that answers", () => {
  const SUPPORT = resolve(import.meta.dirname, "../../../../../packages/cli/src/support.mjs");

  function preflightWith(version: string, whoamiJson: string, whoamiExit: number, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "mailda-npx-"));
    try {
      writeFileSync(join(dir, "npx"), [
        "#!/bin/sh",
        `case "$2" in`,
        `  --version) echo "${version}" ;;`,
        `  whoami) printf '%s\n' '${whoamiJson}'; exit ${whoamiExit} ;;`,
        "  *) echo unexpected >&2; exit 9 ;;",
        "esac",
      ].join("\n"));
      chmodSync(join(dir, "npx"), 0o755);
      const script = `const m = await import(${JSON.stringify(SUPPORT)});`
        + " const r = await m.runPreflight([], { announce: false, needsUrl: false });"
        + " process.stderr.write(JSON.stringify(r));";
      const base = { ...process.env };
      for (const name of ["CLOUDFLARE_ACCOUNT_ID", "MAILDA_URL", "CLOUDFLARE_API_TOKEN"]) delete base[name];
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8", env: { ...base, PATH: `${dir}:${process.env.PATH}`, ...env },
      });
      return JSON.parse(child.stderr) as { ok: boolean; accountId: string | null; report: string | null };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("names a signed-out wrangler and each floor it is below, and nothing else", () => {
    const outcome = preflightWith("4.64.0", '{"loggedIn":false}', 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.report).toContain("wrangler is not signed in");
    expect(outcome.report).toContain(`below the measured floor of ${BUDGETS["wrangler.json_output_min_version"]}`);
    expect(outcome.report).toContain(`below the measured floor of ${BUDGETS["workflow.schedules_min_wrangler"]}`);
    // Signed out is the one problem about the login; "no accounts" beside it would name a second cause.
    expect(outcome.report).not.toContain("wrangler named no accounts");
  });

  it("passes a signed-in wrangler with one account at the locked version, under an API token too", () => {
    const one = JSON.stringify({ loggedIn: true, authType: "Account API Token",
      accounts: [{ id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", name: "Ops" }] });
    const outcome = preflightWith("4.118.0", one, 0, { CLOUDFLARE_API_TOKEN: "fake-not-a-token" });
    expect(outcome.report).toBeNull();
    expect(outcome.ok).toBe(true);
    expect(outcome.accountId).toBe("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  });

  it("refuses a sign-in that sees two accounts when none is chosen, rather than deploying into either", () => {
    const two = JSON.stringify({ loggedIn: true, authType: "User API Token", accounts: [
      { id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", name: "Ops" }, { id: "9f8e7d6c5b4a39281706f5e4d3c2b1a0", name: "Lab" }] });
    const outcome = preflightWith("4.118.0", two, 0);
    expect(outcome.ok).toBe(false);
    expect(outcome.report).toContain("the Cloudflare account is ambiguous");
  });

  it("says wrangler could not answer, rather than that nobody is signed in", () => {
    const outcome = preflightWith("4.118.0", "", 1);
    expect(outcome.report).toContain("wrangler could not say who is signed in");
    expect(outcome.report).not.toContain("wrangler is not signed in");
  });
});

describe("whether a Node can name the version that answered", () => {
  it("treats a report without a version as unable to be gated", () => {
    /*
     * Not fatal, and that is the judgement. A Node deployed before the `version_metadata` binding cannot name
     * itself — but the canary carries the new code and will, so a deploy still works, and a fall-through to
     * the incumbent reports no version at all, which is what the gate refuses on. Worth warning about in
     * advance so that refusal is recognised rather than investigated.
     */
    expect(reportsItsVersion({ version: "d27a228d-384b-45f4-b13c-fdf029ae23a5" })).toBe(true);
    expect(reportsItsVersion({ verdict: "ok" })).toBe(false);
    expect(reportsItsVersion({ version: null })).toBe(false);
    expect(reportsItsVersion({ version: "" })).toBe(false);
    expect(reportsItsVersion(undefined)).toBe(false);
  });
});

describe("the deploy consults it before anything can change", () => {
  const cli = cliSource()
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");

  it("preflights before the Workflow guard, which used to run first and silently skip itself", () => {
    /*
     * Order, and it is the substance rather than tidiness. `refuseIfWorkflowBelongsElsewhere` treats an
     * unreadable account as "nothing to check" and returns — so on an ambiguous account #99's protection did
     * not run, and the operator was told about a Worker probe instead. Settling the account first is what
     * makes that guard's answer mean anything.
     */
    /*
     * `…();` with the semicolon, which matches the **call** rather than the definition. Without it the search
     * found `function refuseIfWorkflowBelongsElsewhere() {` two thousand characters earlier and the assertion
     * failed against correct code — the fifth time in this repository a lexical assertion has been caught by
     * a substring, and the reason the value-level tests above carry the weight.
     */
    const preflighted = cli.indexOf("await runPreflight(argv)");
    const guard = cli.indexOf("refuseIfWorkflowBelongsElsewhere(deployConfig.text);");
    expect(preflighted, "deploy no longer preflights").toBeGreaterThan(-1);
    expect(guard, "the Workflow guard is never called").toBeGreaterThan(-1);
    expect(preflighted).toBeLessThan(guard);
  });

  it("preflights before the first thing that writes", () => {
    // Applying a migration is the first irreversible step. A precondition checked after it is not a
    // precondition — it is a post-mortem with the schema already moved.
    const preflighted = cli.indexOf("await runPreflight(argv)");
    const migrate = cli.indexOf("== applying migrations\\n");
    expect(migrate).toBeGreaterThan(-1);
    expect(preflighted).toBeLessThan(migrate);
  });
});
