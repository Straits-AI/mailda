/**
 * How close the controls sit: every pair of controls less than 8px apart, measured in a real browser.
 *
 * ## What it measures, and what it does not
 *
 * Every route in `src/app-routes.ts` and every opened state `sweep.mjs` knows, at 1440x900 and 390x844, in Dark and
 * in Light. In each view it takes every visible control (a button, an `a.btn` or `a.primary`, an input, a select, a
 * textarea, a summary) and, for each pair on one row or one column, the gap between their boxes: horizontal when they
 * share a row, vertical when one sits over the other. A pair closer than `MIN_GAP`, or overlapping, is reported with
 * the view, both controls, the gap, and a screenshot with both outlined.
 *
 * It is a layout measurement and nothing else. It does not judge a pair that shares neither a row nor a column (a
 * corner), a pair on different layers (a popover over the page, a dialog over the shell: overlap there is the point),
 * a control and the thing it sits inside, or the items of one composite control (`JOINED` below, the one judgement it
 * makes). Each view is first grown until nothing on it scrolls, where it can be (`wholePage`), so a scroller does not
 * clip the boxes it compares; a view that still scrolls (the reader on a phone, whose frame follows the column's
 * height) says so on its line, and there two boxes a scroller clips apart could be compared as touching.
 *
 * It measures what the Node it runs against renders. A surface that needs data the Node does not have (an approval
 * waiting, a send whose outcome is unknown, a Cloudflare connection) is not in the DOM and was not measured.
 *
 * ## Why it is not in CI
 *
 * It needs a real browser and a running Node with content on it, as `axe.mjs` does, and it is run the same way, by
 * hand. What CI holds instead is `test/node/control-spacing.test.ts`: that the shared rules it relies on are in the
 * served sheet. That test reads CSS text; it measures no layout, and a pass there is not a pass here.
 *
 *   MAILDA_EMAIL=you@example.com MAILDA_PASSWORD=... pnpm --filter @mailda/worker run spacing -- http://127.0.0.1:8787
 *
 * `--locale zh-Hans` before the origin runs every view under the review flag (`sweep.mjs`, ADR 46).
 *
 * Screenshots and the report go to `MAILDA_SPACING_OUT`, or a `mailda-spacing` directory under the system's temp
 * directory. It exits 1 on any pair under the minimum and on any view it could not open or that did not load.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { APP_ROUTES } from "../src/app-routes.ts";
import { NotApplicable, STATES, address, sweepArgs, themed, tracked, unsettled, wholePage, wordsFor } from "./sweep.mjs";

// `--locale <tag>` runs every view under the review flag (`sweep.mjs`, ADR 46).
const { origin, locale } = sweepArgs(process.argv);
const words = wordsFor(locale);
const OUT = process.env.MAILDA_SPACING_OUT ?? join(tmpdir(), "mailda-spacing");

/**
 * The least room between two controls, in CSS px. A presentation rule, not a measurement: it is the gap the sheet's
 * shared rows already give their controls (`.row-actions`, `.details-actions`, `.butler-actions`), so a pair closer
 * than that is a pair no shared rule placed.
 */
const MIN_GAP = 8;
/** The wide layout at a common laptop size, and a phone (one pane below 768px). */
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const THEMES = /** @type {const} */ (["dark", "light"]);
/** What counts as a control here. A plain link is text in a sentence; `a.btn` and `a.primary` are drawn as buttons. */
const CONTROLS = "button, a.btn, a.primary, input:not([type=hidden]), select, textarea, summary";
/**
 * The one judgement this script makes, written down because it is one: the items of one composite control are that
 * control's own idiom, not two controls set too close, so a pair whose nearest common ancestor is one of these is not
 * measured. A search field and its magnifier share one edge (`.search-pill`); a chip carries its own small buttons; tabs
 * abut in a tablist, items in a menu, options in a listbox; and the message, thread and draft lists are rows that are
 * each one full-width control, which touch as the rows of any list do.
 */
const JOINED = ".search-pill, .chip, [role=tablist], [role=menu], [role=listbox], .message-list, .thread-list, .draft-list";

/**
 * Measures the view in the page. Returns each visible control's description and every pair under the minimum. Each
 * control is stamped `data-spacing` with its index, so the screenshot can find the pair again.
 */
function measure([selector, min, joined]) {
  const visible = (el) => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const box = el.getBoundingClientRect();
    // A visually hidden control is a 1px box by design (.visually-hidden): nothing to see, nothing to crowd.
    return box.width > 2 && box.height > 2;
  };
  // The nearest box that floats: a fixed thing (a modal dialog is one), or an absolute or sticky one with a z-index.
  const layer = (el) => {
    for (let at = el; at !== null; at = at.parentElement) {
      const style = globalThis.getComputedStyle(at);
      if (style.position === "fixed") return at;
      if ((style.position === "absolute" || style.position === "sticky") && style.zIndex !== "auto") return at;
    }
    return null;
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const classes = [...el.classList].slice(0, 3).map((name) => `.${name}`).join("");
    const type = tag === "input" && el.type !== "text" ? `[type=${el.type}]` : "";
    const field = tag === "input" || tag === "select" || tag === "textarea";
    const name = (el.getAttribute("aria-label")
      ?? (field ? el.labels?.[0]?.textContent ?? el.getAttribute("placeholder") : el.textContent) ?? "")
      .trim().replace(/\s+/g, " ").slice(0, 40);
    let where = "";
    for (let at = el.parentElement; at !== null && where === ""; at = at.parentElement) {
      const label = at.getAttribute("aria-label");
      if (label !== null) where = `${at.tagName.toLowerCase()}[aria-label="${label}"]`;
      else if (at.tagName === "DIALOG") where = `dialog.${[...at.classList].join(".")}`;
    }
    return `${tag}${el.id === "" ? "" : `#${el.id}`}${classes}${type}${name === "" ? "" : ` "${name}"`}${where === "" ? "" : ` in ${where}`}`;
  };

  const controls = [...globalThis.document.querySelectorAll(selector)].filter(visible);
  controls.forEach((el, index) => { el.dataset.spacing = String(index); });
  const boxes = controls.map((el) => ({ el, box: el.getBoundingClientRect(), layer: layer(el) }));
  const pairs = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const across = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const down = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      let axis;
      let gap;
      if (across > 0 && down > 0) { axis = "overlap"; gap = -Math.min(across, down); }
      else if (down > 0) { axis = "row"; gap = -across; }
      else if (across > 0) { axis = "column"; gap = -down; }
      else continue;
      if (gap >= min) continue;
      let common = a.el.parentElement;
      while (common !== null && !common.contains(b.el)) common = common.parentElement;
      if (common?.closest(joined)) continue;
      pairs.push({ a: i, b: j, axis, gap: Math.round(gap * 10) / 10, what: `${describe(a.el)}  |  ${describe(b.el)}` });
    }
  }
  return { count: controls.length, pairs };
}

/** Outlines the pair, screenshots the two with some room around them, and takes the outlines off again. */
async function shoot(page, pair, file) {
  const pick = (index) => page.locator(`[data-spacing="${index}"]`);
  await pick(pair.a).evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
  const clip = await page.evaluate(([a, b]) => {
    const els = [a, b].map((index) => globalThis.document.querySelector(`[data-spacing="${index}"]`));
    els[0].style.outline = "2px solid #FF00FF";
    els[1].style.outline = "2px dashed #00C8C8";
    const boxes = els.map((el) => el.getBoundingClientRect());
    const pad = 24;
    const left = Math.max(0, Math.min(...boxes.map((box) => box.left)) - pad);
    const top = Math.max(0, Math.min(...boxes.map((box) => box.top)) - pad);
    const right = Math.min(globalThis.innerWidth, Math.max(...boxes.map((box) => box.right)) + pad);
    const bottom = Math.min(globalThis.innerHeight, Math.max(...boxes.map((box) => box.bottom)) + pad);
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }, [pair.a, pair.b]);
  await page.screenshot({ path: file, clip });
  await page.evaluate(([a, b]) => {
    for (const index of [a, b]) globalThis.document.querySelector(`[data-spacing="${index}"]`).style.outline = "";
  }, [pair.a, pair.b]);
}

const email = process.env.MAILDA_EMAIL;
const password = process.env.MAILDA_PASSWORD;
if (email === undefined || password === undefined) {
  console.log("Set MAILDA_EMAIL and MAILDA_PASSWORD for an account on this Node: every screen here is behind sign-in.");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
/**
 * A session of its own for each context: one snapshot shared by every context was one refresh token, which the first
 * renewal rotated and the next context then presented as a reuse, signing the whole family out mid-run.
 */
async function session() {
  const signedIn = await browser.newContext();
  const login = await signedIn.request.post(`${origin}/api/auth/login`, { data: { email, password } });
  if (!login.ok()) {
    console.log(`Sign-in failed (${login.status()}); nothing was measured.`);
    await browser.close();
    process.exit(1);
  }
  const state = await signedIn.storageState();
  await signedIn.close();
  return state;
}

const report = [];
const say = (line) => { console.log(line); report.push(line); };
/** Each pair is shot once, where it is first seen; later sightings name the view and point at that shot. */
const shot = new Map();
let views = 0;
let crowded = 0;
let unopened = 0;
const notApplicable = [];

/** Opens a route in a page whose requests are counted, and waits for the shell. Null when it never mounted. */
async function open(browserContext, route) {
  const page = await tracked(browserContext);
  await page.goto(address(origin, route, locale), { waitUntil: "domcontentloaded" });
  if (await page.waitForSelector(".app-shell", { timeout: 15_000 }).then(() => true, () => false)) return page;
  await page.close();
  return null;
}

async function check(page, label) {
  const { unseen } = await wholePage(page);
  // What a taller window shows can load too.
  const loading = await unsettled(page);
  if (loading !== null) {
    unopened += 1;
    say(`${label}  COULD NOT SETTLE once grown — ${loading}`);
    return;
  }
  const { count, pairs } = await page.evaluate(measure, [CONTROLS, MIN_GAP, JOINED]);
  views += 1;
  if (count === 0) {
    // A view with no control in it measured nothing, which must not read as a view with nothing too close.
    unopened += 1;
    say(`${label}  NO CONTROLS FOUND — nothing measured`);
    return;
  }
  say(`${label}  ${count} controls, ${pairs.length === 0 ? "ok" : `${pairs.length} pair(s) under ${MIN_GAP}px`}`
    + (unseen === null ? "" : `  (still scrolling once grown, so a clipped box may be compared: ${unseen})`));
  for (const pair of pairs) {
    crowded += 1;
    const key = `${pair.axis} ${pair.what}`;
    if (!shot.has(key)) {
      const file = join(OUT, `${String(shot.size + 1).padStart(3, "0")}.png`);
      await shoot(page, pair, file).catch((error) => say(`      (no screenshot: ${String(error).split("\n")[0]})`));
      shot.set(key, file);
    }
    say(`    ${pair.axis.padEnd(7)} ${String(pair.gap).padStart(5)}px  ${pair.what}  [${shot.get(key)}]`);
  }
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    const context = await themed(await browser.newContext({ storageState: await session(), viewport }), theme);
    const size = `${theme.padEnd(5)} ${String(viewport.width).padStart(4)}`;
    for (const route of APP_ROUTES) {
      const label = `${size} ${route.padEnd(11)}`;
      const page = await open(context, route);
      if (page === null) { unopened += 1; say(`${label}  COULD NOT OPEN — the shell did not mount`); continue; }
      const loading = await unsettled(page);
      if (loading === null) await check(page, label);
      else { unopened += 1; say(`${label}  COULD NOT SETTLE — ${loading}`); }
      await page.close();
    }
    for (const [route, name, reach, leave] of STATES) {
      const label = `${size} ${name.padEnd(26)}`;
      const page = await open(context, route);
      if (page === null) { unopened += 1; say(`${label}  COULD NOT OPEN — the shell did not mount`); continue; }
      try {
        const before = await unsettled(page);
        if (before !== null) throw new Error(`before opening: ${before}`);
        await reach(page, words);
        await page.waitForTimeout(300);
        const after = await unsettled(page);
        if (after !== null) throw new Error(`once open: ${after}`);
        await check(page, label);
      } catch (error) {
        if (error instanceof NotApplicable) {
          notApplicable.push(`${theme} ${viewport.width} ${name}`);
          say(`${label}  NOT APPLICABLE — ${error.message}`);
        } else {
          unopened += 1;
          say(`${label}  COULD NOT OPEN — ${String(error).split("\n")[0].slice(0, 160)}`);
        }
      } finally {
        if (leave !== undefined) {
          await leave.run(page, words).catch((error) => say(`      (could not ${leave.what}: ${String(error).split("\n")[0]})`));
        }
        await page.close();
      }
    }
    await context.close();
  }
}
await browser.close();

say(`\n${views} view(s) measured · ${crowded} pair(s) under ${MIN_GAP}px (${shot.size} distinct, shots in ${OUT})`
  + (unopened > 0 ? ` · ${unopened} view(s) not measured: could not open, settle, or find a control` : ""));
if (notApplicable.length > 0) say(`Not applicable on this Node, and not measured: ${notApplicable.join(", ")}.`);
writeFileSync(join(OUT, "report.txt"), `${report.join("\n")}\n`);
process.exitCode = crowded === 0 && unopened === 0 ? 0 : 1;
