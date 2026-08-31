import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cliPath = join(import.meta.dirname, "../../../../../packages/cli/src/mailda.mjs");

/**
 * The CLI's **code**, with comments stripped.
 *
 * Necessary, and a standing reminder of what lexical tests cost. The order assertion below searches for the
 * text each step prints, and `firstInstall`'s own documentation *names those steps in prose* while explaining
 * why they cannot come first — so a search over the raw file found the comment before the code and reported
 * the order backwards. A test that reads source has to read only the part that runs.
 */
const cli = readFileSync(cliPath, "utf8")
  .split("\n")
  .filter((line) => {
    const t = line.trimStart();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  })
  .join("\n");

/*
 * The parsers come from `deploy-parse.mjs`, not from `mailda.mjs`. That file dispatches on `process.argv` at
 * the top level, so importing it would *run* it — the same defect the SDK's generator had, where a top-level
 * `writeFileSync` meant the test checking for a hand edit regenerated the file first.
 */
const { activeVersionFrom, promotionVerdict, servedVersionOf, versionIdFrom } =
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
 * **Two things deliberately not covered**, both properties of Cloudflare rather than of this repository, and
 * both needing a real account to verify — the same gap #99 has:
 *
 *   - that `wrangler versions upload` publishes without shifting traffic, which the whole rollback story
 *     rests on;
 *   - that the canary's **Durable Objects run the previous version's code**, because only one version of each
 *     may run at a time and the canary holds 0% of traffic. So a change inside `KeyVault` or `OutboxSweeper`
 *     is not what the gate checked. Documented in the deploy function, because "checked before promotion" is
 *     not true of that one part and a reader should not have to discover it mid-rollout.
 */

/**
 * The order of the canary path's steps, by the **exact banner** each one prints.
 *
 * The trailing `\\n` is load-bearing and was learned twice. Searching for `"applying migrations"` also
 * matches the first-install branch's `"applying migrations for the first time"`, and
 * `"attaching the delivery-events consumer"` matches `"…on a new Node"` — so a substring search reported the
 * steps in the first-install branch's order and the assertion failed against correct code. Anchoring on the
 * terminator makes each banner match exactly one call site.
 *
 * That is twice in this file that a lexical assertion has been fooled by a substring, which is the standing
 * argument for the value-level tests below it.
 */
const STEPS = [
  "== checking which migrations are pending\\n",
  "== applying migrations\\n",
  "== reading the version currently serving\\n",
  "== uploading a canary version",
  "== placing the canary in the deployment at 0%\\n",
  "== asking the canary how it is",
  "== moving traffic to the checked version\\n",
  "== attaching the delivery-events consumer\\n",
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
    expect(cli.indexOf("== applying migrations\\n"))
      .toBeLessThan(cli.indexOf("wrangler\", \"versions\", \"upload"));
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
    const check = cli.indexOf("promotionVerdict(");
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
     * This comment used to end *"the canary check needs no `--url` — the URL comes from wrangler"*, which was
     * true of the preview-URL design and is not true now. There is no preview URL for a Worker with Durable
     * Objects, so the gate reaches the canary on the Node's own hostname and an origin is **required**. The
     * skip did not come back: a missing `--url` is a refusal before anything changes, asserted below.
     */
    expect(cli).not.toContain("skipping the health check");
  });

  it("refuses a contracting migration unless the operator asks for one", () => {
    // The whole reason the phase marker exists. A pending contraction applied here breaks the version that
    // is still serving, before the canary has even been uploaded.
    expect(cli).toContain("refusing to apply a contracting migration");
    const refusal = cli.indexOf("refusing to apply a contracting migration");
    const apply = cli.indexOf("== applying migrations\\n");
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

  it("promotes a canary no worse than what is serving, and blocks a new finding", () => {
    /*
     * **The defect the live drill found**, and the reason this replaced `shouldPromote(verdict)`.
     *
     * The old gate promoted only on `ok`. Run against the real Node: the canary reported `degraded` with one
     * finding, `signing_key` — and the incumbent reported `degraded` with *the same one finding*. So a version
     * neither better nor worse than the one already taking every request was withheld, and the operator was
     * told to promote by hand. An unclaimed Node is in that state by construction until somebody signs in, so
     * every deploy to one would have gone that way, and a gate always overridden is not a gate.
     */
    const finding = (check: string) => ({ check, ok: false });
    const clean = { verdict: "ok", findings: [] };

    // The drill's exact case: identical single finding on both sides.
    const carriedOnly = promotionVerdict({
      canary: { verdict: "degraded", findings: [finding("signing_key")] },
      incumbent: { verdict: "degraded", findings: [finding("signing_key")] },
    });
    expect(carriedOnly.promote).toBe(true);
    expect(carriedOnly.carried).toEqual(["signing_key"]);
    expect(carriedOnly.blocking).toEqual([]);

    // A finding the incumbent does not have is the regression a canary exists to catch.
    const regressed = promotionVerdict({
      canary: { verdict: "degraded", findings: [finding("signing_key"), finding("evidence_bucket")] },
      incumbent: { verdict: "degraded", findings: [finding("signing_key")] },
    });
    expect(regressed.promote).toBe(false);
    expect(regressed.blocking).toEqual(["evidence_bucket"]);
    expect(regressed.why).toContain("evidence_bucket");

    // `refuse` refuses regardless: two broken versions is a reason to stop, not to proceed.
    expect(promotionVerdict({
      canary: { verdict: "refuse", findings: [finding("schema")] },
      incumbent: { verdict: "refuse", findings: [finding("schema")] },
    }).promote).toBe(false);

    // The healthy case still promotes.
    expect(promotionVerdict({ canary: clean, incumbent: clean }).promote).toBe(true);

    /*
     * A canary whose report could not be read is not a canary that passed. Treating a missing verdict as "no
     * new findings" would promote on a parse failure — the same shape as the identity check above.
     */
    expect(promotionVerdict({ canary: {}, incumbent: clean }).promote).toBe(false);
    expect(promotionVerdict({ canary: { findings: [] }, incumbent: clean }).why)
      .toContain("no verdict");

    /*
     * An improvement promotes, which is the direction nobody thinks to check: a canary that *fixes* the
     * incumbent's finding has fewer, not more, and must not be blocked by a comparison written backwards.
     */
    const improved = promotionVerdict({
      canary: clean,
      incumbent: { verdict: "degraded", findings: [finding("signing_key")] },
    });
    expect(improved.promote).toBe(true);
    expect(improved.carried).toEqual([]);
  });

  it("reads the serving version as the last one with traffic, not the first named", () => {
    /*
     * `wrangler deployments list` prints oldest-first, and every block looks alike. Taking the first match
     * would build the two-version deployment around a version that stopped serving days ago — and publish it,
     * dropping the one that is actually live. This is the parser whose failure is *not* protected by "a bad
     * check promotes nothing", because it runs before the check.
     */
    const listing = [
      "Created:     2026-08-27T14:52:55.319Z",
      "Version(s):  (100%) f20aa711-a056-4db5-b03d-2d51b1ee3e7c",
      "Created:     2026-08-28T09:46:20.695Z",
      "Version(s):  (100%) d27a228d-384b-45f4-b13c-fdf029ae23a5",
    ].join("\n");
    expect(activeVersionFrom(listing)).toBe("d27a228d-384b-45f4-b13c-fdf029ae23a5");

    /*
     * A split deployment, which is the state this command itself creates at 0%. The canary must not be read
     * back as the incumbent — that would pair a version with itself and leave nothing serving the other half.
     */
    const split = [
      "Version(s):  (0%) aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "             (100%) bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    ].join("\n");
    expect(activeVersionFrom(split)).toBe("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");

    expect(activeVersionFrom("no deployments here")).toBeNull();
  });

  it("treats a report that cannot name its version as unable to be checked", () => {
    /*
     * The gate that makes the override meaningful. Cloudflare routes by traffic percentage when a version
     * override cannot be applied, so the reply may legitimately come from the incumbent with `verdict: "ok"`.
     * A missing or malformed version is therefore a refusal, not a pass — otherwise the whole check is an
     * assertion that cannot fail.
     */
    expect(servedVersionOf({ version: "d27a228d-384b-45f4-b13c-fdf029ae23a5" }))
      .toBe("d27a228d-384b-45f4-b13c-fdf029ae23a5");
    expect(servedVersionOf({ verdict: "ok" })).toBeNull();
    expect(servedVersionOf({ version: null })).toBeNull();
    expect(servedVersionOf({ version: "canary" })).toBeNull();
    expect(servedVersionOf({ version: "d27a228d" })).toBeNull();
    expect(servedVersionOf(undefined)).toBeNull();
  });
});

describe("the canary is reached without a preview URL, because it cannot have one", () => {
  /*
   * Cloudflare does not generate preview URLs for Workers that implement a Durable Object, and this one holds
   * both root keys in `KeyVault` (ADR 28). Two rounds of the live deploy drill recorded the resulting 404 as
   * "cause unestablished, possibly an account setting"; the account's own API said
   * `{"enabled": true, "previews_enabled": true}` the whole time. Measured in
   * `docs/receipts/preview-urls-and-durable-objects.md`.
   *
   * So this asserts the *absence* of the mechanism that cannot work, which is the kind of claim that rots
   * silently — somebody reintroduces `--preview-alias`, the gate goes back to checking a 404, and the failure
   * looks like a network problem.
   */
  it("does not gate on a preview URL or a preview alias", () => {
    expect(cli).not.toContain("--preview-alias");
    expect(cli).not.toContain("preview-alias");
    expect(cli).not.toContain("canaryUrl");
  });

  it("puts the canary in the deployment before overriding to it", () => {
    // An override is only applied to a version in the current deployment. Reversed, the header would be
    // ignored and the check would silently interrogate the version already serving.
    const place = cli.indexOf("== placing the canary in the deployment at 0%");
    const override = cli.indexOf("Cloudflare-Workers-Version-Overrides");
    expect(place).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(-1);
    expect(place).toBeLessThan(override);
  });

  it("requires the answering version to be the uploaded one, before it consults the verdict", () => {
    /*
     * Order matters and is the substance of the fix. `shouldPromote` on a report from the incumbent returns
     * `true`, so identity has to be settled first — otherwise the sequence has a path where a healthy
     * incumbent promotes an unexamined canary.
     */
    /*
     * `shouldPromote(` rather than `shouldPromote(verdict)`, and that is the whole lesson of this assertion.
     * Matching the exact spelling let a mutation pass: inserting
     * `shouldPromote(report.verdict ?? "refuse")` **above** the identity check is a different string, so the
     * later `shouldPromote(verdict)` was still found later and the test went green against a sequence that
     * decides on the verdict first. Matching the call rather than one of its call sites is what makes the
     * order a property. This is the third time a lexical assertion in this file has been defeated by a
     * substring, and the reason the value-level tests above carry the real weight.
     */
    const identity = cli.indexOf("servedVersionOf(report)");
    const verdict = cli.indexOf("promotionVerdict(");
    expect(identity, "the responder's identity is never checked").toBeGreaterThan(-1);
    expect(verdict, "the promotion gate is never consulted").toBeGreaterThan(-1);
    expect(identity).toBeLessThan(verdict);
  });

  it("overrides to the canary exactly once, so the incumbent is really the incumbent", () => {
    /*
     * The mutation that survived everything else, and the most dangerous one in this sequence: fetch the
     * incumbent's report **with** the override header and both reports come from the canary — so `blocking`
     * is always empty and every canary promotes, including one that broke the Node. The pure function cannot
     * see it, because it is handed two reports and has no way to know they came from the same version.
     *
     * The property is countable rather than a shape: there is exactly one request in this file that overrides
     * a version, and it is the canary's. A second occurrence means either the incumbent is being overridden
     * or somebody added a call this reasoning has not considered — both worth stopping for.
     */
    const overrides = cli.split("Cloudflare-Workers-Version-Overrides").length - 1;
    expect(overrides, "the canary is no longer reached by a version override").toBeGreaterThan(0);
    expect(overrides, "more than one request overrides a version — is the incumbent one of them?").toBe(1);

    // And the incumbent is asked with no extra headers at all, which is what reaches the version at 100%.
    expect(cli).toContain("await doctorReport(origin)");
  });

  it("refuses a deploy with no origin before it changes anything", () => {
    // The gate needs the Node's hostname now. Refusing after a migration has been applied would leave the
    // schema ahead of the code with no version checked — the exact window this ticket exists to close.
    const refusal = cli.indexOf("this deploy needs the Node's URL");
    const migrate = cli.indexOf("== applying migrations\\n");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(migrate);
  });
});
