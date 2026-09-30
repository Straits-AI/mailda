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
 *   pnpm --filter @mailda/worker run axe -- --locale zh-Hans http://127.0.0.1:8787
 *
 * The authenticated screens need a session, which is why the URL is an argument rather than a constant —
 * a harness that could only ever see the sign-in form would be measuring the wrong half of the product.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { APP_ROUTES } from "../src/app-routes.ts";
import { NotApplicable, SETTLE_MS, STATES, address, sweepArgs, themed, tracked, unsettled, wholePage, wordsFor } from "./sweep.mjs";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

// The first argument that is not pnpm's own `--` (`pnpm run axe -- <url>` passes it through, and taking argv[2] signed
// in to a Node called "--"), and `--locale <tag>`, which runs every view under the review flag (`sweep.mjs`, ADR 46).
const { origin, locale } = sweepArgs(process.argv);
const words = wordsFor(locale);
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

/** A view still loading when the wait ran out. Never audited: a loading screen is not the view. */
class Unsettled extends Error {}

/**
 * The viewer's theme choice, stored before the first navigation of every page (`/app/theme.js` reads it
 * first thing), so each theme is audited as a viewer who chose it sees it. System is not a third run: it
 * resolves to one of these two by definition.
 */
const THEMES = /** @type {const} */ (["dark", "light"]);
/** Playwright's default, which is the wide layout; a state that narrows the page puts this back. */
const VIEWPORT = { width: 1280, height: 720 };
/**
 * The widths every route is audited at: the wide layout, the narrow one with two panes (below 1120px the rail is a
 * drawer), and a phone (one pane below 768px). One width saw none of the narrow layouts' own defects: at 390 the
 * breakers on /limits scroll sideways, at 1024 the capability rows on /agents crowd their checkboxes (R2AXE-2).
 */
const ROUTE_VIEWPORTS = [VIEWPORT, { width: 1024, height: 768 }, { width: 390, height: 844 }];
/** The gate. ADR 30 names WCAG 2.2 AA, and only these can fail the run. */
const AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
/** Reported, never failing. `landmark-one-main` lives here — see the header. */
const ADVISORY_TAGS = ["best-practice"];

const browser = await chromium.launch();
const signedIn = await browser.newContext();

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
  const response = await signedIn.request.post(`${origin}/api/auth/login`, {
    data: { email, password },
  });
  if (!response.ok()) {
    console.log(`Sign-in failed (${response.status()}). The screens below will be skipped.`);
  }
}

/** One browser context per theme, each carrying the session and the stored choice. */
const session = await signedIn.storageState();
await signedIn.close();

let violations = 0;
/** Unproven, counted both ways: rule results, the unit earlier runs recorded, and the nodes behind them. */
let incomplete = 0;
let incompleteNodes = 0;
let advisories = 0;
let checked = 0;
const violationsByTheme = { dark: 0, light: 0 };
let currentTheme = "dark";

/**
 * Runs both tag sets over whatever is currently rendered, and reports it.
 *
 * Shared by the route sweep and the state sweep so the two cannot drift into auditing different things —
 * which would be the worse half of having two sweeps at all.
 */
async function audit(page, label) {
  /*
   * Injected through the debugger rather than as a `<script>` element, and that changed with #97.
   *
   * `page.addScriptTag({ content: AXE })` creates a real inline script in the document, so the Node's
   * `script-src 'self'` refuses it and every screen below reported `axe is not defined`. **That is the
   * policy working**, not a harness to work around: an inline script is exactly what a CSP exists to stop,
   * and the application ships none. `page.evaluate` runs through Chrome DevTools Protocol, which is not
   * page script and is not subject to the page's policy — the right seam for a harness, because it needs no
   * relaxation of the thing it is measuring.
   *
   * `context.bypassCSP` is the other way and is deliberately not used: it would disable enforcement for the
   * *application* too, so a screen broken by the CSP — the one browser-level regression this harness is now
   * positioned to notice — would keep rendering and keep passing.
   *
   * The expression ends in a check rather than in axe's own completion value: a library evaluated for its
   * side effect returns whatever its last statement happened to be, which may not be serialisable, and
   * `false` here would mean the injection silently did nothing.
   */
  const injected = await page.evaluate(`${AXE}\n;typeof axe === "object" && typeof axe.run === "function"`);
  if (injected !== true) throw new Error("axe-core did not load into the page; nothing below was measured");
  const aa = await page.evaluate(
    `axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(AA_TAGS)} } })`,
  );
  const advisory = await page.evaluate(
    `axe.run(document, { runOnly: { type: "tag", values: ${JSON.stringify(ADVISORY_TAGS)} } })`,
  );

  checked += 1;
  violations += aa.violations.length;
  violationsByTheme[currentTheme] += aa.violations.length;
  incomplete += aa.incomplete.length;
  // A rule result can stand for dozens of nodes (every text node under an open overlay is one), so the rule
  // count alone understated how much went unmeasured.
  const unprovenNodes = aa.incomplete.reduce((total, rule) => total + rule.nodes.length, 0);
  incompleteNodes += unprovenNodes;
  advisories += advisory.violations.length;

  const suffix = `${aa.passes.length} passed, ${unprovenNodes} unproven node(s) in ${aa.incomplete.length} rule(s), `
    + `${advisory.violations.length} advisory`;
  console.log(aa.violations.length === 0
    ? `${label}  ok    ${suffix}`
    : `${label}  ${aa.violations.length} AA violation(s), ${suffix}`);
  for (const violation of [...aa.violations, ...advisory.violations]) {
    const gate = aa.violations.includes(violation) ? "AA" : "advisory";
    console.log(`    [${gate}/${violation.impact}] ${violation.id} — ${violation.help} (${violation.nodes.length} node(s))`);
    console.log(`        ${violation.nodes[0]?.target.join(" ")}`);
  }
}

/**
 * Opens a route and waits for the application to exist. Null when the shell never mounted. The first-run gate
 * renders in place of the shell, so the pass that looks for it names it as a mount too.
 */
async function open(browserContext, route, mount = ".app-shell") {
  const page = await tracked(browserContext);
  await page.goto(address(origin, route, locale), { waitUntil: "domcontentloaded" });
  // The shell mounts after the session module resolves, so a snapshot taken on DOMContentLoaded would
  // measure an empty div. Waiting for the rail is waiting for the application to exist.
  const mounted = await page
    .waitForSelector(mount, { timeout: 15_000 })
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
 * `region` used to flag the `.rack` banner's wordmark as content outside a landmark, because the rack was a
 * `<div>` in `page()`. It is a `<header>` since 27 September 2026, which cleared it on both themes and adds no
 * second banner behind sign-in, because the authenticated shell hides the rack (`body.shell .rack { display:
 * none; }` in `src/shell-css.ts`). An advisory still never fails this run: it fails on violations alone.
 *
 * A separate context, because these pages are defined by *not* being signed in — reusing the authenticated
 * one would put a session cookie on them and render something else entirely.
 */
let unopened = 0;
/** States this Node cannot show, by the Node's own answer: listed, never counted as checked. */
const notApplicable = [];
/** Views audited with part of them never on screen (`wholePage`): listed, and they fail the run. */
const partlySeen = [];

/**
 * Audits a view grown to its whole height, and says so when part of it never fit. What a taller window shows can
 * load too, so it settles again first; a view that does not is not audited, and fails the run.
 */
async function auditWhole(page, label, name) {
  const { grown, unseen } = await wholePage(page);
  const loading = await unsettled(page);
  if (loading !== null) {
    unopened += 1;
    console.log(`${label}  COULD NOT SETTLE — once grown: ${loading} after ${SETTLE_MS / 1000} s; not audited`);
    if (grown !== null) console.log(`      (${grown})`);
    return;
  }
  await audit(page, label);
  if (grown !== null) console.log(`      (audited whole: ${grown})`);
  if (unseen !== null) {
    partlySeen.push(name);
    console.log(`      PARTLY SEEN — ${unseen}`);
  }
}

/*
 * Behind the sign-in form, and only on a claimed Node (its `/health` says which; an unclaimed one shows the claim
 * instead): the invitation redemption and a refused sign-in, which the loop above never put in the DOM. The refusal
 * is asked of an address no account has, so a run never counts toward an operator's own lockout.
 */
const PRE_AUTH = [
  ["join", async (page) => {
    await page.getByRole("button", { name: "I have an invitation", exact: true }).click();
    await page.locator("#invitation").waitFor({ timeout: 10_000 });
  }],
  ["sign-in refused", async (page) => {
    await page.getByLabel("Email", { exact: true }).fill("nobody@axe-sweep.invalid");
    await page.getByLabel("Password", { exact: true }).fill("not-a-password-of-this-node");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator(".errors > *").first().waitFor({ timeout: 10_000 });
  }],
];

for (const theme of THEMES) {
  currentTheme = theme;
  const anonymous = await themed(await browser.newContext(), theme);
  const page = await tracked(anonymous);
  await page.goto(address(origin, "/", locale), { waitUntil: "networkidle" });
  const ready = await page.waitForSelector("form", { timeout: 10_000 }).then(() => true).catch(() => false);
  if (!ready) {
    console.log(`${theme.padEnd(5)} sign-in      SKIPPED — no form rendered`);
  } else {
    await auditWhole(page, `${theme.padEnd(5)} sign-in    `, `${theme} sign-in`);
  }
  await page.close();

  const { claimed } = await (await anonymous.request.get(`${origin}/health`)).json();
  for (const [name, reach] of PRE_AUTH) {
    const label = `${theme.padEnd(5)} ${name.padEnd(15)}`;
    if (claimed !== true) {
      notApplicable.push(`${theme} ${name}`);
      console.log(`${label} NOT APPLICABLE — this Node is not claimed, so its first screen is the claim, audited above`);
      continue;
    }
    const view = await tracked(anonymous);
    try {
      await view.goto(address(origin, "/", locale), { waitUntil: "networkidle" });
      await view.waitForSelector("form", { timeout: 10_000 });
      await reach(view);
      await auditWhole(view, label, `${theme} ${name}`);
    } catch (error) {
      unopened += 1;
      console.log(`${label} COULD NOT OPEN — ${String(error).split("\n")[0].slice(0, 120)}`);
    } finally {
      await view.close();
    }
  }
  await anonymous.close();
}

for (const theme of THEMES) {
  currentTheme = theme;
  for (const viewport of ROUTE_VIEWPORTS) {
    const sized = await themed(await browser.newContext({ storageState: session, viewport }), theme);
    for (const route of ROUTES) {
      const label = `${theme.padEnd(5)} ${String(viewport.width).padStart(4)} ${route.padEnd(11)}`;
      const page = await open(sized, route);
      if (page === null) {
        console.log(`${label}  SKIPPED — the shell did not mount (signed in?)`);
        continue;
      }
      const loading = await unsettled(page);
      if (loading === null) {
        await auditWhole(page, label, `${theme} ${viewport.width} ${route}`);
      } else {
        // Unaudited, and it fails the run, as a state that did not open does.
        unopened += 1;
        console.log(`${label}  COULD NOT SETTLE — ${loading} after ${SETTLE_MS / 1000} s; not audited`);
      }
      await page.close();
    }
    await sized.close();
  }

  const context = await themed(await browser.newContext({ storageState: session }), theme);

  for (const [route, name, reach, leave] of STATES) {
    const page = await open(context, route);
    if (page === null) {
      console.log(`${theme.padEnd(5)} ${name.padEnd(26)} SKIPPED — the shell did not mount`);
      continue;
    }
    try {
      // Loaded before anything is pressed, and again before the audit: what a state opens can load too.
      const before = await unsettled(page);
      if (before !== null) throw new Unsettled(`before opening: ${before}`);
      await reach(page, words);
      await page.waitForTimeout(300);
      const after = await unsettled(page);
      if (after !== null) throw new Unsettled(`once open: ${after}`);
      await audit(page, `${theme.padEnd(5)} ${name.padEnd(26)}`);
    } catch (error) {
      if (error instanceof NotApplicable) {
        notApplicable.push(`${theme} ${name}`);
        console.log(`${theme.padEnd(5)} ${name.padEnd(26)} NOT APPLICABLE — ${error.message}; not audited`);
        continue;
      }
      /*
       * Counted, reported as its own thing, and it fails the run. A state that did not open is
       * **unaudited**, and letting it read as absent is how the interactive surfaces went unchecked in the
       * first place — and how a locator that stopped matching ("reply" matching "reply all" too) hid for
       * as long as it did. A Node with no paused Butler has no resume form: seed one, or read this line.
       */
      unopened += 1;
      const what = error instanceof Unsettled ? "COULD NOT SETTLE" : "COULD NOT OPEN";
      console.log(`${theme.padEnd(5)} ${name.padEnd(26)} ${what} — ${String(error).split("\n")[0].slice(0, error instanceof Unsettled ? 200 : 80)}`);
    } finally {
      // Not part of what was audited, and run whether or not the state opened: a claim made before a state failed
      // to open or settle is given back too. A cleanup that fails is reported; the audit above still stands.
      if (leave !== undefined) {
        await leave.run(page).catch((error) => console.log(`      (could not ${leave.what}: ${String(error).split("\n")[0]})`));
      }
      await page.setViewportSize(VIEWPORT);
      await page.close();
    }
  }
  await context.close();

  /*
   * The first-run gate, as an administrator of a Node that cannot receive yet meets it: in place of every route
   * but three, so this context sets no override. Whether it shows is the Node's readiness; a Node that is ready
   * renders the shell in its place, which is its answer, and anything else is a view that did not open. The shell,
   * not the message list: a ready Node with no mail yet renders no list, and was reported as a view that did not
   * open (R3C-GATE-EMPTY-INBOX).
   */
  const gated = await themed(await browser.newContext({ storageState: session }), theme, { overridden: false });
  const label = `${theme.padEnd(5)} ${"first-run gate".padEnd(26)}`;
  const page = await open(gated, "/", ".app-shell, .first-run");
  const loading = page === null ? "neither the shell nor the gate mounted" : await unsettled(page);
  if (loading !== null) {
    unopened += 1;
    console.log(`${label} COULD NOT SETTLE — ${loading}; not audited`);
  } else if ((await page.locator("section.first-run").count()) > 0) {
    await auditWhole(page, label, `${theme} first-run gate`);
  } else if ((await page.locator(".app-shell").count()) > 0) {
    notApplicable.push(`${theme} first-run gate`);
    console.log(`${label} NOT APPLICABLE — this Node is ready to receive, so it renders the shell; not audited`);
  } else {
    unopened += 1;
    console.log(`${label} COULD NOT OPEN — neither the gate nor the shell rendered`);
  }
  await gated.close();
}

await browser.close();

if (checked === 0) {
  console.log("\nNothing was checked. Sign in to the Node first — these are the authenticated screens.");
  process.exitCode = 1;
} else {
  // The unproven count is printed rather than swallowed. It is the number that made an earlier run read
  // as clean while examining almost nothing.
  console.log(
    `\n${checked} view(s) checked · ${violations} AA violation(s) ` +
    `(dark ${violationsByTheme.dark}, light ${violationsByTheme.light}) · ` +
    `${incompleteNodes} unproven node(s) in ${incomplete} rule result(s) · ` +
    `${advisories} advisory` + (unopened > 0 ? ` · ${unopened} view(s) not audited: could not open or settle` : ""),
  );
  if (notApplicable.length > 0) {
    console.log(`Not applicable on this Node, and not audited: ${notApplicable.join(", ")}.`);
  }
  if (partlySeen.length > 0) {
    console.log(`Partly seen, their lowest part never on screen: ${partlySeen.join(", ")}.`);
  }
  console.log("Contrast is not measured here — it is computed in test/node/contrast.test.ts. See ADR 30.");
  // A view that could not be opened, never finished loading, or was not all on screen was not checked, so a run
  // with one is not a pass.
  process.exitCode = violations === 0 && unopened === 0 && partlySeen.length === 0 ? 0 : 1;
}
