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

// The first argument that is not pnpm's own `--`: `pnpm run axe -- <url>`, as the header writes it, passes the
// `--` through, and taking argv[2] signed in to a Node called "--".
const origin = process.argv.slice(2).find((arg) => arg !== "--") ?? "http://127.0.0.1:8787";
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
 * Each entry is a route, a name, what to do once the shell has mounted, and optionally what to undo afterwards:
 * a reply or forward composer saves a draft while axe reads it, and the run discards it rather than leave one on
 * the Node per run. The undo runs whether or not the state opened, so a claim followed by a state that could not
 * open or settle still gives the case back, and a failed undo names what it could not undo. A state that **fails to open** is
 * reported as `COULD NOT OPEN` and counted as unchecked, not as passing: the whole reason the route sweep
 * distinguishes `SKIPPED` is that a screen nobody looked at must not read as a clean one.
 *
 * And it **fails the run**. It used not to, on the argument that a Node with no paused Butler genuinely has
 * no resume form; the cost was that the reply state's locator ("reply" also matched "reply all") could not
 * open on any Node and the run still exited 0. A run that did not look at a state is not a pass.
 *
 * What a Node needs for every state to open: delivered mail (the reader states), `send.propose` on its
 * mailbox (reply, forward, assign), and `org.admin` (the rule and Butler editors). The Butler editor opens the
 * first Butler, and on a Node with none it presses **New butler**, which creates an unpublished draft Butler
 * called "new butler" exactly as a person would; the line says so, so the write is never silent.
 *
 * One state can be **not applicable**, and only when the Node itself says so: the resume form exists only
 * for a paused Butler, and only the loop detector places a pause (`src/butler/pause-acts.ts`), so it cannot
 * be produced on demand. When the Node's own Butler list holds no pause, the line reads `NOT APPLICABLE` with
 * that reason, the summary lists it, and it counts as neither checked nor passed. It does not fail the run:
 * failing would make a clean Node unable to pass. A locator that stops matching is still `COULD NOT OPEN`,
 * because the decision is read from the Node, never from a locator that failed.
 */
/** Discards the open composer's draft, so an audit leaves none behind. No dock, no draft: a state that never opened one. */
async function discardDraft(page) {
  const dock = page.locator(".composer-dock");
  if ((await dock.count()) === 0) return;
  await dock.getByRole("button", { name: "Discard", exact: true }).click();
  await dock.waitFor({ state: "detached", timeout: 10_000 });
}

/** Selects the newest message, so the reader and its controls are in the DOM. */
async function selectFirstMessage(page) {
  await page.locator(".message-row").first().click();
  await page.waitForSelector("article.reading-pane", { timeout: 10_000 });
}

/** A state this Node cannot show, with the Node's own reason. Thrown by a state; never counted as audited. */
class NotApplicable extends Error {}

/** A view still loading when the wait ran out. Never audited: a loading screen is not the view. */
class Unsettled extends Error {}

/**
 * The pages whose Hand to state claimed a case. It claims only when no case is held here, so afterwards the one row
 * held here (`tr.case-row.mine`) is that case, and the release is that row's Release. The row, not its open Hand to
 * field: a state that failed between the claim and the field opening left no field to find, and its claim was never
 * given back (R3C-RELEASE-NEEDS-FIELD). Not a page-wide Release: the quarantine list has its own. Not the row's
 * merge checkbox ("Pick <subject> for merging"): subjects repeat and a case with none is "Pick this case for
 * merging", so a wait for a Claim in rows found by it was met at once by a twin's Claim, before the release landed,
 * and the page closed under it (R2-AXE-RELEASE-KEY-NOT-UNIQUE).
 */
const claimedHere = new WeakSet();

/**
 * Releases the case the Hand to state claimed, if it claimed one. Only that one: the reply state's Reply claims the
 * newest message's case first, as any reply does, and nothing gives that back, so on a Node where that case was
 * open a run leaves it held by the account that ran it, and the Hand to state then finds it held and claims none.
 */
async function releaseClaimed(page) {
  if (!claimedHere.has(page)) return;
  const mine = page.locator("tr.case-row.mine");
  await mine.getByRole("button", { name: "Release", exact: true }).click();
  // The row stops being mine once the Node has released the case and the queue has been read again.
  await mine.waitFor({ state: "detached", timeout: 10_000 });
  claimedHere.delete(page);
}

/** What a state leaves behind, and the words for it when undoing it fails. */
const DISCARD = { what: "discard the draft this state saved", run: discardDraft };
const RELEASE = { what: "release the case this state claimed", run: releaseClaimed };

/** The Node's Butler list, read with the page's own session. Throws on a refusal: no answer is not "none". */
async function butlers(page) {
  const answer = await page.evaluate(async () => {
    const response = await fetch("/api/butlers");
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  if (answer.status !== 200) throw new Error(`GET /api/butlers answered ${answer.status}`);
  return answer.body.butlers;
}

const STATES = [
  ["/", "composer — reply", async (page) => {
    await selectFirstMessage(page);
    // `exact`: Playwright matches a name as a case-insensitive substring, so "Reply" alone would also
    // match "Reply all" and fail as ambiguous, which read as a state that could not be opened.
    await page.getByRole("button", { name: "Reply", exact: true }).click();
    await page.waitForSelector(".composer-dock", { timeout: 10_000 });
  }, DISCARD],
  ["/", "composer — new message", async (page) => {
    await page.getByRole("button", { name: "Compose", exact: true }).click();
    // With more than one mailbox the shell asks which one first (#94); choose the first real option.
    const chooser = page.getByRole("dialog", { name: "Choose a mailbox" });
    if (await chooser.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await chooser.locator("select").selectOption({ index: 1 });
      await chooser.getByRole("button", { name: "Start message" }).click();
    }
    await page.waitForSelector(".composer-dock", { timeout: 10_000 });
  }],
  ["/", "composer — forward", async (page) => {
    await selectFirstMessage(page);
    await page.getByRole("button", { name: "Forward", exact: true }).click();
    await page.waitForSelector(".composer-dock", { timeout: 10_000 });
  }, DISCARD],
  ["/", "message details", async (page) => {
    await selectFirstMessage(page);
    await page.locator(".reader-details summary").click();
    await page.waitForSelector(".reader-details[open]", { timeout: 10_000 });
  }],
  ["/", "headers dialog", async (page) => {
    await selectFirstMessage(page);
    await page.locator(".reader-details summary").click();
    await page.getByRole("button", { name: "View headers", exact: true }).click();
    // The text, not the dialog: the dialog opens before the headers arrive, and a loading state is not the view.
    await page.waitForSelector("dialog.headers-dialog[open] pre", { timeout: 10_000 });
  }],
  ["/", "assign popover", async (page) => {
    await selectFirstMessage(page);
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    // Past "Reading…": whichever of its answers this case gets (the form, the holder, closed) is the view. A
    // locator rather than `waitForFunction`, which evaluates a string in the page and the CSP refuses it.
    await page.locator(".assign-popover", { hasNotText: "Reading…" }).waitFor({ timeout: 10_000 });
  }],
  ["/", "reader (390px)", async (page) => {
    // One pane at a time below 768px; the viewport is restored after the audit, in `finally`.
    await page.setViewportSize({ width: 390, height: 844 });
    await selectFirstMessage(page);
  }],
  ["/", "overflow menu", async (page) => {
    await selectFirstMessage(page);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.waitForSelector("[role=menu]", { timeout: 10_000 });
  }],
  ["/", "filter popover", async (page) => {
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.waitForSelector(".filter-popover", { timeout: 10_000 });
  }],
  ["/", "health popover", async (page) => {
    await page.getByRole("button", { name: /^Health:/ }).click();
    await page.waitForSelector(".health-popover", { timeout: 10_000 });
  }],
  ["/", "command palette", async (page) => {
    await page.keyboard.press("Control+K");
    await page.waitForSelector("dialog.palette", { timeout: 10_000 });
  }],
  ["/", "navigation drawer (390px)", async (page) => {
    // The narrow layout only exists below 1120px; the viewport is restored after the audit, in `finally`.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForSelector("dialog.drawer", { timeout: 10_000 });
  }],
  ["/rules", "rule editor", async (page) => {
    await page.getByRole("button", { name: "New rule", exact: true }).click();
    await page.waitForSelector(".policy-editor", { timeout: 10_000 });
  }],
  ["/butlers", "butler editor", async (page) => {
    if ((await butlers(page)).length === 0) {
      console.log("      (no Butler on this Node: pressing New butler, which creates an unpublished draft)");
      await page.getByRole("button", { name: "New butler", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "Open", exact: true }).first().click();
    }
    await page.waitForSelector(".butler-source", { timeout: 10_000 });
  }],
  ["/butlers", "butler resume form", async (page) => {
    if (!(await butlers(page)).some((butler) => butler.pause !== null)) {
      throw new NotApplicable("no Butler on this Node is paused, and only the loop detector places a pause");
    }
    await page.waitForSelector(".butler-pause", { timeout: 10_000 });
  }],
  /*
   * The Queue's one opened state: handing a case you hold to a colleague opens a field in its row. A row has
   * nothing to open by itself (it once read as a state, "a case open", while clicking a row that does nothing).
   * With no case held here it claims the first open one, as a person would; the line says so, and `RELEASE`
   * gives it back.
   */
  ["/queue", "hand to a colleague", async (page) => {
    const handTo = page.getByRole("button", { name: "Hand to…", exact: true });
    if ((await handTo.count()) === 0) {
      console.log("      (no case held here: claiming the first open one, which is released after the audit)");
      await page.getByRole("button", { name: "Claim", exact: true }).first().click();
      claimedHere.add(page);
    }
    await handTo.first().click();
    await page.waitForSelector(".hand-to input", { timeout: 10_000 });
  }, RELEASE],
];
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
/**
 * How tall `wholePage` may make the viewport: a harness bound, not a measurement. Past it, the lowest part of the
 * page was never on screen, and the line and the summary say so.
 */
const MAX_HEIGHT = 16_000;
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

/**
 * Before any page script runs: the theme choice, and the first-run override. The override is the "Open the
 * app anyway" a person can press, set here because a Node with no routed address (the local harness is one)
 * otherwise renders only the first-run screen on every route, and every route would audit that one screen.
 * Each write is in a `try`: the initial `about:blank` of a new page has no storage to write to.
 */
async function themed(browserContext, theme, { overridden = true } = {}) {
  await browserContext.addInitScript(([key, value, override]) => {
    try {
      localStorage.setItem(key, value);
      if (override) sessionStorage.setItem("mailda.first-run.override", "1");
    } catch {
      // about:blank, before the navigation that matters; the next document runs this again.
    }
  }, ["mailda.theme", theme, overridden]);
  return browserContext;
}

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

/** How long a view may take to load before it is reported as not settling. A harness bound, not a measurement. */
const SETTLE_MS = 15_000;
/** How long nothing may be in flight before the network counts as quiet. A harness bound, as Playwright's own 500 ms. */
const QUIET_MS = 500;

/** Every request a page has started and not finished, child frames included. Filled from before its navigation. */
const inFlight = new WeakMap();

/** The requests still in flight, as the COULD NOT SETTLE line names them. */
function named(requests) {
  return [...requests].map((request) => `${request.method()} ${request.url().replace(origin, "")}`).join(", ");
}

/**
 * Whether the screen has loaded: nothing in flight for `QUIET_MS`, then no "Reading…" notice left in it
 * (`Nothing`'s loading state in chrome.tsx, the one the shell renders). An audit taken the moment the shell mounted
 * measured that loading notice on the slower routes (/agents, /audit, /people), in one theme and not the other,
 * and a loading screen is not the view.
 *
 * The requests are counted here, not read from Playwright's `networkidle`, which failed both ways (27 September
 * 2026). It fires once per document and is then answered at once, so after a click it waited for nothing while
 * that click's fetches were still out: a body fetch held for 4 s was "idle" in 0 ms. And once the reader's
 * sandboxed srcdoc body frame had attached, it sometimes never fired at all, with no request out and the body
 * frame itself idle, so the run failed on a healthy Node. A count covers both, because what a click starts is in
 * it.
 *
 * Null once it has loaded; otherwise what was still loading, for the COULD NOT SETTLE line.
 */
async function unsettled(page) {
  const requests = inFlight.get(page);
  const end = Date.now() + SETTLE_MS;
  let quietSince = Date.now();
  while (Date.now() - quietSince < QUIET_MS) {
    if (requests.size > 0) quietSince = Date.now();
    if (Date.now() > end) {
      return requests.size > 0 ? `still in flight: ${named(requests)}` : `never ${QUIET_MS} ms without a request in flight`;
    }
    await page.waitForTimeout(50);
  }
  const reading = page.locator("p.notice", { hasText: /^Reading…$/ });
  const gone = await reading.first().waitFor({ state: "detached", timeout: SETTLE_MS }).then(() => true, () => false);
  if (gone) return null;
  const where = await reading.first().evaluate((el) => {
    const path = [];
    for (let at = el.parentElement; at !== null && at !== el.ownerDocument.body && path.length < 4; at = at.parentElement) {
      path.push(at.tagName.toLowerCase() + (at.className === "" ? "" : `.${String(at.className).split(" ").join(".")}`));
    }
    return path.join(" < ");
  }).catch((error) => `somewhere this could not name (${String(error).split("\n")[0]})`);
  return `"Reading…" still shown in ${where}`;
}

/**
 * Makes the viewport tall enough that nothing on the page scrolls, so axe sees all of it. `target-size` and
 * `color-contrast` judge only what is on screen: /agents audited at its top read clean, and with its pane scrolled
 * 500px it failed target-size, twice (R2AXE-2). What scrolls is measured, not named: the document, and every
 * element that scrolls vertically without a `max-height`. A region with one (the notices band, the header block)
 * is bounded on purpose and is audited as it scrolls, since `scrollable-region-focusable` only judges a region
 * that does; which is also why the opened states below keep their own viewport.
 *
 * What it did, for the caller to print after the view's own line, where it reads as that view's: `grown`, how
 * far the window grew (null when it already fitted), and `unseen`, how much is still below the bound (null once the
 * page fits). Printed from here, the growth landed above the view's line and read as the previous view's.
 */
async function wholePage(page) {
  const { width, height } = page.viewportSize();
  // `globalThis`: this runs in the page, where the document is, and this file's lint knows only Node's globals.
  const hiddenNow = () => page.evaluate(() => Math.max(
    globalThis.document.documentElement.scrollHeight - globalThis.document.documentElement.clientHeight,
    ...[...globalThis.document.querySelectorAll("*")].map((element) => {
      const style = globalThis.getComputedStyle(element);
      if (!/^(auto|scroll)$/.test(style.overflowY) || style.maxHeight !== "none") return 0;
      return element.scrollHeight - element.clientHeight;
    }),
  ));
  let tall = height;
  let hidden = await hiddenNow();
  // Rounds, not one step: growing one scroller can leave another (a list under a taller pane) still short.
  for (let round = 0; round < 4 && hidden > 1; round += 1) {
    tall = Math.min(tall + hidden, MAX_HEIGHT);
    await page.setViewportSize({ width, height: tall });
    hidden = await hiddenNow();
    if (tall === MAX_HEIGHT) break;
  }
  return {
    grown: tall === height ? null : `the viewport grown from ${height} to ${tall} px tall`,
    unseen: hidden <= 1 ? null : `${Math.round(hidden)} px of it still scrolled at ${tall} px tall, and were never on screen`,
  };
}

/** A new page whose requests `unsettled` counts, from before its first navigation so that one's are counted too. */
async function tracked(browserContext) {
  const page = await browserContext.newPage();
  const requests = new Set();
  inFlight.set(page, requests);
  page.on("request", (request) => requests.add(request));
  page.on("requestfinished", (request) => requests.delete(request));
  page.on("requestfailed", (request) => requests.delete(request));
  return page;
}

/**
 * Opens a route and waits for the application to exist. Null when the shell never mounted. The first-run gate
 * renders in place of the shell, so the pass that looks for it names it as a mount too.
 */
async function open(browserContext, route, mount = ".app-shell") {
  const page = await tracked(browserContext);
  await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
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
  await page.goto(origin, { waitUntil: "networkidle" });
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
      await view.goto(origin, { waitUntil: "networkidle" });
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
      await reach(page);
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
