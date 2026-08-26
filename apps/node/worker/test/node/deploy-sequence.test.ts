import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cliPath = join(import.meta.dirname, "../../../../../packages/cli/src/mailda.mjs");
const cli = readFileSync(cliPath, "utf8");

/*
 * The parsers come from `deploy-parse.mjs`, not from `mailda.mjs`. That file dispatches on `process.argv` at
 * the top level, so importing it would *run* it — the same defect the SDK's generator had, where a top-level
 * `writeFileSync` meant the test checking for a hand edit regenerated the file first.
 */
const { previewUrlFrom, shouldPromote, versionIdFrom } =
  await import("../../../../../packages/cli/src/deploy-parse.mjs");

/**
 * The order `mailda deploy` does things in, and the gate it cannot skip (#98).
 *
 * ## What can be tested here and what cannot
 *
 * The sequence is four `wrangler` calls against a real Cloudflare account, so the *outcome* is not testable
 * without one. What **is** testable is the property that made the old order dangerous: which step comes
 * before which, and whether a failing check can be bypassed. That is a fact about this file, so it is read
 * lexically — the same technique `content-deletion-world.test.ts` uses for the one R2 delete, and for the
 * same reason: a property that only holds because nobody has reordered the lines is not a property.
 *
 * The parsers get real tests, because they are pure and because a mis-parsed version id promotes the wrong
 * version — which is the one failure in this sequence that cannot be undone by not promoting anything.
 *
 * **What is deliberately not covered**: that `wrangler versions upload` actually publishes without shifting
 * traffic. That is Cloudflare's behaviour, not this repository's, and the whole rollback story rests on it.
 * It is documented in the deploy function and would need a real account to verify — the same gap #99 has.
 */

/** The order of the steps, by the string each one prints. */
const STEPS = [
  "checking which migrations are pending",
  "applying migrations",
  "uploading a canary version",
  "asking the canary how it is",
  "moving traffic to the checked version",
  "attaching the delivery-events consumer",
];

describe("expand, canary, check, then shift", () => {
  it("runs the steps in that order and no other", () => {
    /*
     * The old order was deploy-then-migrate, on the stated grounds that "the Worker bundles them" — which is
     * false, and the reversal is the smaller half of this change. The larger half is that the canary sits
     * **between** the migration and the traffic shift, because that is what makes a failed check need no
     * rollback.
     */
    const positions = STEPS.map((step) => ({ step, at: cli.indexOf(step) }));
    for (const { step, at } of positions) {
      expect(at, `the step "${step}" is gone — update this list deliberately`).toBeGreaterThan(-1);
    }
    const order = [...positions].sort((a, b) => a.at - b.at).map((one) => one.step);
    expect(order).toEqual(STEPS);
  });

  it("applies migrations before it uploads anything", () => {
    // Stated on its own because it is the defect: new code served against a schema that did not have what
    // it needed, and a failed migration left the incompatible Worker deployed.
    expect(cli.indexOf("applying migrations")).toBeLessThan(cli.indexOf("wrangler\", \"versions\", \"upload"));
  });

  it("consults the promotion gate before moving traffic", () => {
    /*
     * **This assertion was much stronger-looking and proved nothing.** It read the source between the check
     * and the shift and required it to contain `fail(` and to mention `verdict !== "ok"`. Mutating the
     * condition to `if (false && verdict !== "ok")` — which disables the gate completely — left both true,
     * so the test passed against a deploy that promotes a broken canary.
     *
     * The decision now lives in `shouldPromote`, which is tested with values below. What is left here is the
     * one claim a lexical read can actually support: that the call site asks it, before it shifts.
     */
    const check = cli.indexOf("shouldPromote(verdict)");
    const shift = cli.indexOf("\"versions\", \"deploy\", `${version}@100`");
    expect(check, "the promotion gate is not consulted at all").toBeGreaterThan(-1);
    expect(shift).toBeGreaterThan(-1);
    expect(check).toBeLessThan(shift);
  });

  it("cannot be run with the health check omitted, which is how it used to be skippable", () => {
    /*
     * The old command printed "skipping the health check" when `--url` was absent and exited zero. Doctor was
     * therefore the closing courtesy on a deploy that may not have worked, and the file said so in as many
     * words: *"A deploy that ran is not a Node that works."*
     *
     * The canary check needs no `--url` — the URL comes from wrangler — so there is nothing to omit.
     */
    expect(cli).not.toContain("skipping the health check");
  });

  it("refuses a contracting migration unless the operator asks for one", () => {
    // The whole reason the phase marker exists. A pending contraction applied here breaks the version that
    // is still serving, before the canary has even been uploaded.
    expect(cli).toContain("refusing to apply a contracting migration");
    const refusal = cli.indexOf("refusing to apply a contracting migration");
    const apply = cli.indexOf("applying migrations");
    expect(refusal, "the refusal comes after the migrations are applied").toBeLessThan(apply);
  });
});

describe("the parsers, because a mis-read version id promotes the wrong code", () => {
  /*
   * Imported rather than reimplemented. These two are the only impure-looking pure functions in the
   * sequence, and getting either wrong is the one failure the "never shift traffic on a bad check" design
   * cannot protect against: promoting a version that was never checked, because its id was misread.
   */
  it("reads a version id out of wrangler's prose", () => {
    expect(versionIdFrom("Worker Version ID: 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"))
      .toBe("1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d");
    // A bare uuid anywhere in the output, which is the shape wrangler has used in other releases.
    expect(versionIdFrom("uploaded\n  aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n"))
      .toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    // Nothing to find is `null`, not a guess. The caller refuses on null and says the canary is safe.
    expect(versionIdFrom("Total Upload: 512 KiB")).toBeNull();
  });

  it("promotes only an ok canary, and not a degraded one", () => {
    /*
     * `degraded` is the interesting case. It means a real finding — no key escrow, a blind delivery channel,
     * a stalled outbox — and "it started up" is not the bar for moving every request onto it. An operator who
     * has read the finding and accepts it promotes by hand, with the command the refusal prints.
     */
    expect(shouldPromote("ok")).toBe(true);
    expect(shouldPromote("degraded")).toBe(false);
    expect(shouldPromote("refuse")).toBe(false);
    // Anything unrecognised is not a promotion either: an unparseable verdict is not a passing one.
    expect(shouldPromote("")).toBe(false);
    expect(shouldPromote("OK")).toBe(false);
  });

  it("reads the canary's preview URL, and strips the punctuation prose puts after it", () => {
    expect(previewUrlFrom("Preview URL: https://canary-mailda.example.workers.dev"))
      .toBe("https://canary-mailda.example.workers.dev");
    // A trailing full stop is the difference between a URL and a 404 nobody can explain.
    expect(previewUrlFrom("available at https://canary-mailda.example.workers.dev."))
      .toBe("https://canary-mailda.example.workers.dev");
    expect(previewUrlFrom("no url here")).toBeNull();
  });
});
