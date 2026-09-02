import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

/**
 * WCAG 2.2 AA contrast, computed from the tokens rather than observed in a browser.
 *
 * Computed because **axe-core cannot check it here.** `body` carries a top-lit gradient, and axe will
 * not guess a background it cannot resolve to one colour — so it moves 13 of the 14 text nodes on the
 * shipped page into `incomplete` and returns zero violations. A harness reading only `violations`
 * reports AA green on this design language forever (receipt: `contrast-tokens.md`).
 *
 * The gradient interpolates between `--ground-2` and `--ground` and never leaves that range, so
 * checking both endpoints proves every point between them. Two sums, no browser, deterministic.
 *
 * This does not replace axe — axe catches the structural things this cannot see, like `aria-selected`
 * on a `role` that forbids it. It covers the one thing axe provably cannot.
 */

const here = dirname(fileURLToPath(import.meta.url));
const uiSource = readFileSync(resolve(here, "../../src/ui.ts"), "utf8");

/** AA thresholds, ×100 to match the receipt — a ratio needs two decimals to be checkable. */
const AA_NORMAL = BUDGETS["contrast.aa_normal_ratio"] / 100;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const one = luminance(a);
  const two = luminance(b);
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

/** What the browser actually composites: a translucent foreground over an opaque ground. */
function over(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number],
): [number, number, number] {
  return [0, 1, 2].map((i) => alpha * fg[i]! + (1 - alpha) * bg[i]!) as [number, number, number];
}

function hex(value: string): [number, number, number] {
  const h = value.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * Reads a token out of `src/ui.ts`.
 *
 * Parsed from the source rather than duplicated here, which is the whole point: a constant copied into
 * a test is a constant that stops describing the thing it guards the first time somebody edits the CSS.
 * `scope` picks the theme, since the light values live inside a media query.
 */
function token(name: string, scope: "dark" | "light"): string {
  /*
   * **Light is the default `:root` block and dark is inside the media query** — the reverse of what this
   * parser assumed until the brand landed, because the brand's ground is light. Keyed off the media query's
   * own text so that flipping the themes again fails loudly here rather than silently reading the wrong
   * block and reporting the wrong theme's ratios as passing.
   */
  const dark = uiSource.indexOf("@media (prefers-color-scheme: dark)");
  if (dark === -1) throw new Error("no dark-theme media query in src/ui.ts — which theme is which?");
  const region = scope === "light" ? uiSource.slice(0, dark) : uiSource.slice(dark);
  const found = new RegExp(`--${name}:\\s*([^;]+);`).exec(region);
  if (found === null) throw new Error(`--${name} not found in the ${scope} theme of src/ui.ts`);
  return found[1]!.trim();
}

/** `rgba(r, g, b, .52)` -> its parts. The dim token is the only translucent one. */
function rgba(value: string): { rgb: [number, number, number]; alpha: number } {
  const found = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(value);
  if (found === null) throw new Error(`not an rgba() value: ${value}`);
  return {
    rgb: [Number(found[1]), Number(found[2]), Number(found[3])],
    alpha: Number(found[4]),
  };
}

/**
 * The three surfaces a token can land on.
 *
 * `sky` joined the two gradient endpoints with the brand palette, and it is not decoration: it is the
 * darkest of the light grounds, so it is where every figure bottoms out. `--dim` at .60 alpha clears 4.58
 * on Mist and **4.48 on Sky** — a fail by two hundredths, on a ground that would not have been checked at
 * all if this list had stayed at two.
 */
const GROUNDS = ["ground", "ground-2", "sky"] as const;

/** The worst contrast a translucent token reaches across every ground. */
function worstTranslucent(name: string, scope: "dark" | "light"): number {
  const value = rgba(token(name, scope));
  return Math.min(...GROUNDS.map((ground) => {
    const behind = hex(token(ground, scope));
    return contrast(over(value.rgb, value.alpha, behind), behind);
  }));
}

/** The worst contrast a solid token reaches across every ground. */
function worstSolid(name: string, scope: "dark" | "light"): number {
  const value = hex(token(name, scope));
  return Math.min(...GROUNDS.map((ground) => contrast(value, hex(token(ground, scope)))));
}

/** Kept under its old name because the failure message reads better, and it is still the dim token. */
function worstAgainstGradient(scope: "dark" | "light"): number {
  return worstTranslucent("dim", scope);
}

describe("token contrast (WCAG 2.2 AA)", () => {
  for (const scope of ["dark", "light"] as const) {
    it(`--dim clears AA against both ends of the ${scope} gradient`, () => {
      const worst = worstAgainstGradient(scope);
      // If this fails, a token moved and small dim text is now unreadable for someone. Raise the
      // alpha — do not lower the threshold, and do not assume the other theme's value works here:
      // dark text on a light ground is not the mirror of the reverse, which is how this broke.
      expect(worst).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("matches the ratios the receipt recorded, so the receipt cannot go stale unnoticed", () => {
    // Rounded to two decimals because that is the precision a contrast ratio is quoted at.
    const round = (n: number) => Math.round(n * 100);
    expect(round(worstAgainstGradient("dark"))).toBe(BUDGETS["contrast.dim_dark_worst"]);
    expect(round(worstAgainstGradient("light"))).toBe(BUDGETS["contrast.dim_light_worst"]);
  });

  for (const scope of ["dark", "light"] as const) {
    it(`--accent-text clears AA against every ${scope} ground`, () => {
      /*
       * The token that exists because the brand's accent could not do this job. Flow Blue is 4.53:1 on
       * white — AA by 0.03 — and 4.11 on Mist, 3.87 on Sky. So anything a person *reads* in brand blue uses
       * this darker token, and this is the assertion that keeps them apart.
       */
      expect(worstSolid("accent-text", scope)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("keeps --accent above the threshold for the things it is actually used for", () => {
    /*
     * `--accent` is the brand hex and is **not** a text colour: fills, borders, focus rings, icons and the
     * mark's dot. Those are non-text contrast, which WCAG puts at 3:1, and it clears that on every ground
     * in both themes.
     *
     * Asserted at the large/UI threshold rather than the normal one **on purpose**, and the failure this
     * guards is somebody "simplifying" the two accent tokens back into one: that would put 3.87:1 blue
     * behind body text on Sky. `test/node/stylesheet-hazards.test.ts` cannot see it and axe would only
     * catch it on a page that happened to render it.
     */
    for (const scope of ["dark", "light"] as const) {
      expect(worstSolid("accent", scope), `--accent fails 3:1 in the ${scope} theme`)
        .toBeGreaterThanOrEqual(BUDGETS["contrast.aa_large_ratio"] / 100);
    }
  });

  it("matches the accent ratios the receipt recorded", () => {
    const round = (n: number) => Math.round(n * 100);
    expect(round(worstSolid("accent-text", "light"))).toBe(BUDGETS["contrast.accent_text_light_worst"]);
    expect(round(worstSolid("accent-text", "dark"))).toBe(BUDGETS["contrast.accent_text_dark_worst"]);
    expect(round(Math.min(worstSolid("accent", "light"), worstSolid("accent", "dark"))))
      .toBe(BUDGETS["contrast.accent_ui_worst"]);
  });
});

/**
 * The rail is a dark surface in both schemes, so its tokens are measured against Ink and not the page (#128).
 *
 * ## Why the existing checks cannot see it
 *
 * Every assertion above measures against `GROUNDS` — `--ground`, `--ground-2`, `--sky` — which in the light
 * theme are Mist, White and Sky. The rail is Ink there. So a light-theme token placed in the rail is checked
 * against three grounds it never sits on, and passes while being unreadable on the one it does.
 *
 * That is not hypothetical: `.rail-mine` used `--live`, which is `#2F6F4E` in the light theme and reads
 * **3.01 on Ink** — a UI component's threshold, applied to text. Found by measuring the rail's descendants
 * rather than only the rules that name it, and the reason `--rail-live` exists.
 *
 * ## And the one place the brand and WCAG disagree
 *
 * The brand sheet's search field is a Mist pill on a White header. Mist on White is **1.10**, so the fill
 * identifies nothing, and 1.4.11 wants 3:1 for the visual information that identifies a control. Neither
 * rule token reaches it either — `.10` is 1.23 and `.22` is 1.61. `--control-edge` is the measured answer,
 * and this is what stops it drifting back to a hairline that looks nicer and says less.
 */
describe("the rail's own surface, and the edge of a control", () => {
  const RAIL = "rail-ground";

  /** What a token reaches against the rail, which is the only ground its contents sit on. */
  function againstRail(name: string, scope: "dark" | "light"): number {
    const ground = hex(token(RAIL, scope));
    const raw = token(name, scope);
    if (raw.startsWith("rgba")) {
      const value = rgba(raw);
      return contrast(over(value.rgb, value.alpha, ground), ground);
    }
    return contrast(hex(raw), ground);
  }

  for (const scope of ["dark", "light"] as const) {
    it(`the ${scope} rail's text and label clear AA on Ink`, () => {
      /*
       * Both, because they fail differently: `--rail-text` failing would make the rail unreadable and
       * obvious, while `--rail-dim` failing would leave the headings and counts readable-ish to whoever
       * wrote the CSS and not to somebody with low vision.
       */
      expect(againstRail("rail-text", scope)).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(againstRail("rail-dim", scope)).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it(`the ${scope} rail's accent and status colours clear AA on Ink`, () => {
      // Text, so AA and not the 3:1 a fill would need. This is why the rail lifts both rather than
      // inheriting the light theme's, where they are tuned against Mist.
      expect(againstRail("rail-accent", scope)).toBeGreaterThanOrEqual(AA_NORMAL);
      expect(againstRail("rail-live", scope)).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it(`the ${scope} control edge clears 3:1 on every ground a control sits on`, () => {
      /*
       * 1.4.11's threshold, not AA's — this is a boundary rather than text. Measured across all three
       * grounds because a search pill sits on the header and a field can sit on any of them, and the
       * weakest is what decides whether the control is identifiable.
       */
      const worst = worstTranslucent("control-edge", scope);
      expect(worst).toBeGreaterThanOrEqual(BUDGETS["contrast.aa_nontext_ratio"] / 100);
    });
  }

  it("keeps the light theme's status green out of the rail, which is where it fails", () => {
    /*
     * The specific defect, pinned. `--live` is correct on Mist and wrong on Ink, so a version of this change
     * that dressed the rail dark and left `.rail-mine` alone would look finished and be unreadable. Asserted
     * as an inequality rather than a number so it states the reason: this token does **not** belong here.
     */
    const light = hex(token("live", "light"));
    const ink = hex(token(RAIL, "light"));
    expect(contrast(light, ink)).toBeLessThan(AA_NORMAL);
    // And the token that replaced it does clear it, so the fix is the fix and not a second failure.
    expect(againstRail("rail-live", "light")).toBeGreaterThanOrEqual(AA_NORMAL);
  });

  it("matches the ratios the receipt recorded, so the receipt cannot go stale unnoticed", () => {
    const round = (n: number) => Math.round(n * 100);
    expect(round(againstRail("rail-text", "light"))).toBe(BUDGETS["contrast.rail_text_worst"]);
    expect(round(againstRail("rail-dim", "light"))).toBe(BUDGETS["contrast.rail_dim_worst"]);
    expect(round(worstTranslucent("control-edge", "light")))
      .toBe(BUDGETS["contrast.control_edge_light_worst"]);
  });
});
