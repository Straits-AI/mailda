import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  // The dark tokens are the first `:root` block; the light ones are inside the media query.
  const light = uiSource.indexOf("@media (prefers-color-scheme: light)");
  const region = scope === "dark" ? uiSource.slice(0, light) : uiSource.slice(light);
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

/** Every point on the gradient, reduced to the two endpoints that bound it. */
function worstAgainstGradient(scope: "dark" | "light"): number {
  const dim = rgba(token("dim", scope));
  return Math.min(
    ...(["ground", "ground-2"] as const).map((name) => {
      const ground = hex(token(name, scope));
      return contrast(over(dim.rgb, dim.alpha, ground), ground);
    }),
  );
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

  it("keeps the dark margin visible, because it clears AA by 0.01", () => {
    // Deliberately not fixed: it passes, and changing a shipped design on a pass is not justified.
    // Deliberately not silent either — any nudge to --ground-2 breaks AA, and a limit developers can
    // hit is a limit they must see. This test is that visibility.
    const margin = worstAgainstGradient("dark") - AA_NORMAL;
    expect(margin).toBeGreaterThanOrEqual(0);
    expect(margin).toBeLessThan(0.1);
  });
});
