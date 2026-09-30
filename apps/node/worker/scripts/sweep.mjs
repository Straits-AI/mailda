/**
 * What the two browser sweeps share: the opened states, how to reach each one, and when a view has loaded.
 *
 * `axe.mjs` audits every view for structure and ARIA; `spacing.mjs` measures the gaps between its controls. Both walk
 * `APP_ROUTES` and the `STATES` below, set the theme and the first-run override the same way (`themed`), and measure
 * nothing until `unsettled` says the view has loaded. A copy of any of it in each would drift, which is
 * `src/app-routes.ts`'s own argument, and `axe.mjs` could not simply be imported: it launches a browser and runs when
 * it loads (AGENTS.md 2b, the seam is the pure part in one module and the effect in another).
 *
 * Nothing here launches a browser or signs in. Each state is `[route, name, reach(page), leave?]`, and a `reach` may
 * throw `NotApplicable` with the Node's own reason.
 */

/**
 * Before any page script runs: the theme choice, and the first-run override. The override is the "Open the
 * app anyway" a person can press, set here because a Node with no routed address (the local harness is one)
 * otherwise renders only the first-run screen on every route, and every route would audit that one screen.
 * Each write is in a `try`: the initial `about:blank` of a new page has no storage to write to.
 */
export async function themed(browserContext, theme, { overridden = true } = {}) {
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

/** How long a view may take to load before it is reported as not settling. A harness bound, not a measurement. */
export const SETTLE_MS = 15_000;
/** How long nothing may be in flight before the network counts as quiet. A harness bound, as Playwright's own 500 ms. */
const QUIET_MS = 500;

/** Every request a page has started and not finished, child frames included. Filled from before its navigation. */
const inFlight = new WeakMap();

/** The requests still in flight, as the COULD NOT SETTLE line names them. */
function named(requests) {
  return [...requests].map((request) => `${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search}`).join(", ");
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
export async function unsettled(page) {
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

/** A new page whose requests `unsettled` counts, from before its first navigation so that one's are counted too. */
export async function tracked(browserContext) {
  const page = await browserContext.newPage();
  const requests = new Set();
  inFlight.set(page, requests);
  page.on("request", (request) => requests.add(request));
  page.on("requestfinished", (request) => requests.delete(request));
  page.on("requestfailed", (request) => requests.delete(request));
  return page;
}

/**
 * How tall `wholePage` may make the viewport: a harness bound, not a measurement. Past it, the lowest part of the
 * page was never on screen, and the line and the summary say so.
 */
const MAX_HEIGHT = 16_000;
/**
 * Makes the viewport tall enough that nothing on the page scrolls, so axe sees all of it. `target-size` and
 * `color-contrast` judge only what is on screen: /agents audited at its top read clean, and with its pane scrolled
 * 500px it failed target-size, twice (R2AXE-2). `spacing.mjs` grows the page for the other reason: a box a scroller
 * clips still reports where it would be, so a field below a pane's fold measured as overlapping the status bar. What scrolls is measured, not named: the document, and every
 * element that scrolls vertically without a `max-height`. A region with one (the notices band, the header block)
 * is bounded on purpose and is audited as it scrolls, since `scrollable-region-focusable` only judges a region
 * that does; which is also why the opened states below keep their own viewport.
 *
 * What it did, for the caller to print after the view's own line, where it reads as that view's: `grown`, how
 * far the window grew (null when it already fitted), and `unseen`, how much is still below the bound (null once the
 * page fits). Printed from here, the growth landed above the view's line and read as the previous view's.
 */
export async function wholePage(page) {
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

/**
 * The states that only exist after somebody clicks something.
 *
 * The route sweep (`APP_ROUTES`) audits what renders on load, which is every screen and **none of the forms**. The composer
 * dock, the Butler editor, the resume form and the rule editor are the largest interactive surfaces in this
 * product and they were never in the DOM when axe looked (#82).
 *
 * That matters here more than it would elsewhere, because every defect axe has caught in this project was in
 * an interactive control rendered with real content: `aria-allowed-attr` on a listitem, `nested-interactive`
 * on the message list — which "surfaced only once the inbox had a message in it" — and `empty-table-header`
 * on the Butler screen's action column. Opened states are strictly more of that.
 *
 * Each entry is a route, a name, what to do once the shell has mounted, and optionally what to undo afterwards:
 * a reply or forward composer saves a draft while a sweep reads it, and the run discards it rather than leave one on
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
export class NotApplicable extends Error {}

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

export const STATES = [
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
