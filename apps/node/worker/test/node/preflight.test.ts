import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

const preflight = await import("../../../../../packages/cli/src/preflight.mjs");
const { accountsFrom, atLeast, reportsItsVersion, resolveAccount, signedIn, wranglerVersionFrom } = preflight;

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
 * ## Why the fixture is real output
 *
 * `WHOAMI` below is what `wrangler whoami` actually printed on the machine that hit this, box-drawing and
 * all. A parser tested against a fixture somebody wrote from memory is a parser tested against the author's
 * belief about the format — and the format is the whole difficulty here, since wrangler offers no structured
 * way to ask.
 */

/** Real `wrangler whoami` output, 4.118.0, from the account that produced the failure. */
const WHOAMI = [
  " ⛅️ wrangler 4.118.0 (update available 4.127.1)",
  "───────────────────────────────────────────────",
  "Getting User settings...",
  "👋 You are logged in with an OAuth Token, associated with the email someone@example.test.",
  "┌───────────────────────────────────┬──────────────────────────────────┐",
  "│ Account Name                      │ Account ID                       │",
  "├───────────────────────────────────┼──────────────────────────────────┤",
  "│ Admin@arbuilder.app's Account     │ e842216b23604d45c318ae890bbd2999 │",
  "├───────────────────────────────────┼──────────────────────────────────┤",
  "│ Mystraits.ai@gmail.com's Account  │ dc8d1b7da0b7adc9a295faad8e519458 │",
  "└───────────────────────────────────┴──────────────────────────────────┘",
].join("\n");

describe("reading what wrangler will do before it does it", () => {
  it("finds every account in the table, and not the header row", () => {
    const accounts = accountsFrom(WHOAMI);
    expect(accounts).toEqual([
      { name: "Admin@arbuilder.app's Account", id: "e842216b23604d45c318ae890bbd2999" },
      { name: "Mystraits.ai@gmail.com's Account", id: "dc8d1b7da0b7adc9a295faad8e519458" },
    ]);
  });

  it("takes the id by its shape, not by its column", () => {
    /*
     * The id is matched as 32 hex characters rather than "the second cell". A column swap would otherwise
     * yield account **names** as ids, which fails later as a permissions error against an account that does
     * not exist — the failure furthest from its cause.
     */
    const swapped = WHOAMI
      .replace("│ Admin@arbuilder.app's Account     │ e842216b23604d45c318ae890bbd2999 │",
        "│ e842216b23604d45c318ae890bbd2999 │ Admin@arbuilder.app's Account     │");
    const [first] = accountsFrom(swapped);
    expect(first?.id).toBe("e842216b23604d45c318ae890bbd2999");
    expect(first?.name).toBe("Admin@arbuilder.app's Account");
  });

  it("knows a signed-out wrangler from a signed-in one", () => {
    expect(signedIn(WHOAMI)).toBe(true);
    expect(signedIn("You are not authenticated. Please run `wrangler login`.")).toBe(false);
  });
});

describe("choosing the account, which is the failure this was built from", () => {
  const accounts = accountsFrom(WHOAMI);

  it("refuses when the token sees several and nothing chose", () => {
    const chosen = resolveAccount({ accounts, chosen: undefined });
    expect(chosen.ok).toBe(false);
    if (chosen.ok) return;
    // The remedy names every candidate with its id, because the operator has to pick and cannot from a count.
    expect(chosen.fix).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(chosen.fix).toContain("dc8d1b7da0b7adc9a295faad8e519458");
    expect(chosen.fix).toContain("e842216b23604d45c318ae890bbd2999");
    // And it names the consequence that is easy to miss: a guard that silently stops guarding.
    expect(chosen.why).toContain("#99");
  });

  it("asks for nothing when there is only one, because there is nothing to choose", () => {
    const single = resolveAccount({ accounts: [accounts[0]!], chosen: undefined });
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.id).toBe("e842216b23604d45c318ae890bbd2999");
  });

  it("accepts a chosen account and reports which one it is", () => {
    const chosen = resolveAccount({ accounts, chosen: "dc8d1b7da0b7adc9a295faad8e519458" });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.name).toBe("Mystraits.ai@gmail.com's Account");
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

  it("reads the version out of wrangler's banner", () => {
    expect(wranglerVersionFrom(WHOAMI)).toBe("4.118.0");
    expect(wranglerVersionFrom("no banner here")).toBeNull();
  });

  it("checks against the measured floor rather than a number typed here", () => {
    // The floor is `workflow.schedules_min_wrangler`: below it a Workflow's `schedules` block is discarded
    // with exit 0, so the deploy looks fine and the Butler engine is not what the config declares.
    const floor = BUDGETS["workflow.schedules_min_wrangler"];
    expect(floor).toBeGreaterThan(0);
    expect(atLeast("4.118.0", floor)).toBe(true);
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
  const cli = readFileSync(
    join(import.meta.dirname, "../../../../../packages/cli/src/mailda.mjs"),
    "utf8",
  )
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
    const guard = cli.indexOf("refuseIfWorkflowBelongsElsewhere();");
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
