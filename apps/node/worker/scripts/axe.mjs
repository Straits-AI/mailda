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
import { APP_ROUTES } from "../src/app-routes.ts";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
/*
 * **Imported, not copied.** This was a hand-maintained list whose own comment said it was "kept in step with
 * `src/app-routes.ts` by hand — five paths" while holding six, so it had already drifted before anybody
 * noticed. That is the exact failure `app-routes.ts` opens by naming — *"in one place because two places
 * would drift"* — and it is worse here than elsewhere: a route missing from this list is not a wrong answer,
 * it is **a screen nobody checked**, which reads as a clean accessibility run over an unaudited page. The
 * same shape as #71's binding allowlists and the cost meter's hand-kept list.
 *
 * Importing a `.ts` from a `.mjs` is why `pnpm axe` runs with `--experimental-strip-types`. `app-routes.ts`
 * imports nothing and holds one array and one predicate, so there is no bundle to build to read it.
 */

const ROUTES = APP_ROUTES;

/**
 * The states that only exist after somebody clicks something.
 *
 * `ROUTES` above audits what renders on load, which is every screen and **none of the forms**. The composer
 * dock, the Butler editor, the resume form and the rule editor are the largest interactive surfaces in this
 * product and they were never in the DOM when axe looked (#82).
 *
 * That matters here more than it would elsewhere, because every defect axe has caught in this project was in
 * an interactive control rendered with real content: `aria-allowed-attr` on a listitem, `nested-interactive`
 * on the message list — which "surfaced only once the inbox had a message in it" — and `empty-table-header`
 * on the Butler screen's action column. Opened states are strictly more of that.
 *
 * Each entry is a route, a name, and what to do once the shell has mounted. A state that **fails to open** is
 * reported as `COULD NOT OPEN` and counted as unchecked, not as passing: the whole reason the route sweep
 * distinguishes `SKIPPED` is that a screen nobody looked at must not read as a clean one.
 *
 * They are best-effort about content — a Node with no paused Butler has no resume form — so a state that
 * cannot be reached on this Node says so and moves on rather than failing the run. Seed a Node with content
 * on every screen if you want the whole list.
 */
const STATES = [
  ["/", "composer — reply", async (page) => {
    await page.locator(".message-row").first().click();
    await page.getByRole("button", { name: "reply" }).click();
    await page.waitForSelector(".composer-dock", { timeout: 10_000 });
  }],
  ["/", "composer — new message", async (page) => {
    await page.getByRole("button", { name: "new message" }).click();
    await page.waitForSelector(".composer-dock", { timeout: 10_000 });
  }],
  ["/rules", "rule editor", async (page) => {
    await page.getByRole("button", { name: "new rule" }).click();
    await page.waitForSelector(".policy-editor", { timeout: 10_000 });
  }],
  ["/butlers", "butler editor", async (page) => {
    await page.getByRole("button", { name: "open" }).first().click();
    await page.waitForSelector(".butler-source", { timeout: 10_000 });
  }],
  ["/butlers", "butler resume form", async (page) => {
    await page.waitForSelector(".butler-pause", { timeout: 10_000 });
  }],
  ["/queue", "a case open", async (page) => {
    await page.locator("tbody tr").first().click();
  }],
];
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

/**
 * Runs both tag sets over whatever is currently rendered, and reports it.
 *
 * Shared by the route sweep and the state sweep so the two cannot drift into auditing different things —
 * which would be the worse half of having two sweeps at all.
 */
async function audit(page, label) {
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

  const suffix = `${aa.passes.length} passed, ${aa.incomplete.length} unproven, ${advisory.violations.length} advisory`;
  console.log(aa.violations.length === 0
    ? `${label}  ok    ${suffix}`
    : `${label}  ${aa.violations.length} AA violation(s), ${suffix}`);
  for (const violation of [...aa.violations, ...advisory.violations]) {
    const gate = aa.violations.includes(violation) ? "AA" : "advisory";
    console.log(`    [${gate}/${violation.impact}] ${violation.id} — ${violation.help} (${violation.nodes.length} node(s))`);
    console.log(`        ${violation.nodes[0]?.target.join(" ")}`);
  }
}

/** Opens a route and waits for the application to exist. Null when the shell never mounted. */
async function open(theme, route) {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
  // The shell mounts after the session module resolves, so a snapshot taken on DOMContentLoaded would
  // measure an empty div. Waiting for the rail is waiting for the application to exist.
  const mounted = await page
    .waitForSelector(".app-shell", { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (mounted) return page;
  await page.close();
  return null;
}

/**
 * The **pre-authentication** surface, audited before anything signs in (#84).
 *
 * ADR 30 splits the interface at authentication, and this harness only ever saw the half behind it: the
 * sign-in form, the first-run claim and the invitation redemption were never in the DOM when axe looked,
 * because the very first thing this script does is sign in.
 *
 * That is the wrong half to skip. Those screens are the ones an operator meets **when the Node is broken** —
 * #23 was that case literally — and they are framework-free precisely so they render when nothing else
 * does. A page you debug a broken bundle from is a page that has to be usable.
 *
 * It found a WCAG 2.2 AA failure on its first run: `I have an invitation` measured 134.9 x 18.4 CSS pixels
 * against 2.5.8's 24 x 24 minimum, and had been shipping since #83.
 *
 * **One advisory is known and left alone**, recorded here rather than quietly tolerated. `region` flags the
 * `.rack` banner as content outside a landmark. It is a `<div>` in `page()`, shared with the authenticated
 * shell — which reports zero advisories, because the mounted application supplies its own landmarks around
 * it. Making it a `<header>` would fix two advisories on this page at the risk of a duplicate-banner
 * advisory on the thirty behind it, so the trade is recorded and not taken. It is an advisory rather than a
 * violation: this run still fails on violations alone.
 *
 * A separate context, because these pages are defined by *not* being signed in — reusing the authenticated
 * one would put a session cookie on them and render something else entirely.
 */
const anonymous = await browser.newContext();
for (const theme of THEMES) {
  const page = await anonymous.newPage();
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(origin, { waitUntil: "networkidle" });
  const ready = await page.waitForSelector("form", { timeout: 10_000 }).then(() => true).catch(() => false);
  if (!ready) {
    console.log(`${theme.padEnd(5)} sign-in      SKIPPED — no form rendered`);
  } else {
    await audit(page, `${theme.padEnd(5)} sign-in    `);
  }
  await page.close();
}
await anonymous.close();

for (const theme of THEMES) {
  for (const route of ROUTES) {
    const page = await open(theme, route);
    if (page === null) {
      console.log(`${theme.padEnd(5)} ${route.padEnd(11)}  SKIPPED — the shell did not mount (signed in?)`);
      continue;
    }
    await audit(page, `${theme.padEnd(5)} ${route.padEnd(11)}`);
    await page.close();
  }
}

let unopened = 0;
for (const theme of THEMES) {
  for (const [route, name, reach] of STATES) {
    const page = await open(theme, route);
    if (page === null) {
      console.log(`${theme.padEnd(5)} ${name.padEnd(26)} SKIPPED — the shell did not mount`);
      continue;
    }
    try {
      await reach(page);
      await page.waitForTimeout(300);
    } catch (error) {
      /*
       * Counted, and reported as its own thing. A state that did not open is **unaudited**, and letting it
       * read as absent is how the interactive surfaces went unchecked in the first place. It does not fail
       * the run, because a Node with no paused Butler genuinely has no resume form — the count at the end is
       * what tells an operator how much of the list their Node could actually show.
       */
      unopened += 1;
      console.log(`${theme.padEnd(5)} ${name.padEnd(26)} COULD NOT OPEN — ${String(error).split("\n")[0].slice(0, 80)}`);
      await page.close();
      continue;
    }
    await audit(page, `${theme.padEnd(5)} ${name.padEnd(26)}`);
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
    `\n${checked} view(s) checked · ${violations} AA violation(s) · ${incomplete} unproven · ` +
    `${advisories} advisory` + (unopened > 0 ? ` · ${unopened} state(s) could not be opened` : ""),
  );
  console.log("Contrast is not measured here — it is computed in test/node/contrast.test.ts. See ADR 30.");
  process.exitCode = violations === 0 ? 0 : 1;
}
