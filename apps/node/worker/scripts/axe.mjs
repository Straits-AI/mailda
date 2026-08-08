/**
 * ADR 30's accessibility check: axe-core per screen, against the real rendered DOM.
 *
 * ## What this proves, and what it emphatically does not
 *
 * axe is here for **structure and ARIA**. It earned its place by catching a real defect in #32's
 * prototype that no amount of reading would have: `aria-selected` on a plain `listitem`, which is
 * `aria-allowed-attr` and genuinely WCAG 2 A.
 *
 * This shell shipped a second defect of the same family — a `main` landmark nested inside the `<main
 * id="app">` it mounts into — and it is worth being exact about what found it, because the tempting
 * sentence is "axe caught it". **It did not.** The rule is `landmark-one-main`, whose tags are
 * `["cat.semantics", "best-practice"]`, so a run restricted to the WCAG tags ADR 30 names never looks at
 * it. It was caught by reading the rendered accessibility tree by hand.
 *
 * That is why best-practice rules are now run *as well*, and reported separately: they are not the AA
 * gate, and they demonstrably catch things the gate cannot. A check whose scope nobody has measured is
 * the same shape as a number with no receipt.
 *
 * It is **not** the contrast check, and believing otherwise was a false clean that nearly shipped.
 * Measured on the prototype: 1 text node proven to pass, 0 failed, **13 unproven** — twelve of them
 * "background color could not be determined due to a background gradient". axe will not guess a
 * background it cannot resolve, so on this design language it files almost everything as `incomplete` and
 * reports no violations. "AA proven by axe-core" would have been satisfied by a check examining one node
 * in fourteen. Contrast is therefore **computed** from the tokens in `test/node/contrast.test.ts`, which
 * runs in CI and needs no browser. Neither half is sufficient alone.
 *
 * So this script fails on violations *and* prints the incomplete count, because a run that says "clean"
 * while declining to examine most of the page should not be able to read as a pass.
 *
 * ## Why it is not in CI
 *
 * It needs a real browser, and #32's resolution kept it manual for now: the computed half is what gates
 * every push. Run it by hand against a Node you have signed into:
 *
 *   pnpm --filter @mailda/worker run axe -- http://127.0.0.1:8787
 *
 * The authenticated screens need a session, which is why the URL is an argument rather than a constant —
 * a harness that could only ever see the sign-in form would be measuring the wrong half of the product.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
/** Kept in step with `src/app-routes.ts` by hand — five paths, and a missing one shows up as a screen
 *  nobody checked rather than as a wrong answer. */
const ROUTES = ["/", "/outbox", "/audit", "/log", "/doctor"];
const THEMES = /** @type {const} */ (["dark", "light"]);
/** The gate. ADR 30 names WCAG 2.2 AA, and only these can fail the run. */
const AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** Reported, never failing. `landmark-one-main` lives here — see the header. */
const ADVISORY_TAGS = ["best-practice"];

const browser = await chromium.launch();
const context = await browser.newContext();

/**
 * Signs in, if the operator supplied credentials for their own Node.
 *
 * Through the API rather than by typing into the form, so the cookies land in the browser context without
 * the harness depending on the sign-in screen's markup — that screen is framework-free and deliberately
 * separate, and coupling the accessibility check for the *application* to it would make one break the
 * other.
 *
 * Environment variables rather than arguments: a password on a command line ends up in shell history.
 */
const email = process.env.MAILDA_AXE_EMAIL;
const password = process.env.MAILDA_AXE_PASSWORD;
if (email !== undefined && password !== undefined) {
  const response = await context.request.post(`${origin}/api/auth/login`, {
    data: { email, password },
  });
  if (!response.ok()) {
    console.log(`Sign-in failed (${response.status()}). The screens below will be skipped.`);
  }
}

let violations = 0;
let incomplete = 0;
let advisories = 0;
let checked = 0;

for (const theme of THEMES) {
  for (const route of ROUTES) {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
    // The shell mounts after the session module resolves, so a snapshot taken on DOMContentLoaded would
    // measure an empty div. Waiting for the rail is waiting for the application to exist.
    const mounted = await page
      .waitForSelector(".app-shell", { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!mounted) {
      console.log(`${theme.padEnd(5)} ${route.padEnd(9)}  SKIPPED — the shell did not mount (signed in?)`);
      await page.close();
      continue;
    }

    await page.addScriptTag({ content: AXE });
    const aa = await page.evaluate(
      `axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(AA_TAGS)} } })`,
    );
    const advisory = await page.evaluate(
      `axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(ADVISORY_TAGS)} } })`,
    );

    checked += 1;
    violations += aa.violations.length;
    incomplete += aa.incomplete.length;
    advisories += advisory.violations.length;

    const head = `${theme.padEnd(5)} ${route.padEnd(9)}`;
    const suffix = `${aa.passes.length} passed, ${aa.incomplete.length} unproven, ${advisory.violations.length} advisory`;
    if (aa.violations.length === 0) {
      console.log(`${head}  ok    ${suffix}`);
    } else {
      console.log(`${head}  ${aa.violations.length} AA violation(s), ${suffix}`);
    }
    for (const violation of [...aa.violations, ...advisory.violations]) {
      const gate = aa.violations.includes(violation) ? "AA" : "advisory";
      console.log(`    [${gate}/${violation.impact}] ${violation.id} — ${violation.help} (${violation.nodes.length} node(s))`);
      console.log(`        ${violation.nodes[0]?.target.join(" ")}`);
    }
    await page.close();
  }
}

await browser.close();

if (checked === 0) {
  console.log("\nNothing was checked. Sign in to the Node first — these are the authenticated screens.");
  process.exitCode = 1;
} else {
  // The unproven count is printed rather than swallowed. It is the number that made an earlier run read
  // as clean while examining almost nothing.
  console.log(
    `\n${checked} screen(s) checked · ${violations} AA violation(s) · ${incomplete} unproven · ` +
    `${advisories} advisory`,
  );
  console.log("Contrast is not measured here — it is computed in test/node/contrast.test.ts. See ADR 30.");
  process.exitCode = violations === 0 ? 0 : 1;
}
