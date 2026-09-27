import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import { SHELL_CSS } from "../../src/shell-css.ts";
import { GROUNDS, NON_TEXT_TOKENS, TEXT_TOKENS, THEMES, declarations, themeCss, type TokenName } from "../../src/theme.ts";
import { cssRules, themeBlocks } from "./support/theme-blocks.ts";

/**
 * WCAG 2.2 AA contrast, computed from the token registry the Worker serves, and where the sheet uses it.
 *
 * Computed rather than observed because a browser audit sees only the states it renders, and a token table
 * sees every pair at once: every text token against every ground, in both themes, is 128 pairs, and a
 * rendered page shows a handful. axe still runs over the rendered screens and catches what this cannot.
 *
 * The tokens are imported from `src/theme.ts` and the sheet from `src/shell-css.ts`: the artifacts, not
 * the wording of a file (AGENTS.md §2c). The numbers are pinned in `docs/receipts/contrast-tokens.md`, so a
 * token that moves without a remeasure fails here.
 */

type Rgb = readonly [number, number, number];
type Theme = keyof typeof THEMES;
const BOTH: readonly Theme[] = ["dark", "light"];

/** AA thresholds, stored ×100 in the receipt because a ratio needs two decimals to be checkable. */
const AA_NORMAL = BUDGETS["contrast.aa_normal_ratio"] / 100;
const AA_NONTEXT = BUDGETS["contrast.aa_nontext_ratio"] / 100;

function hex(value: string): Rgb {
  if (!/^#[0-9A-F]{6}$/i.test(value)) throw new Error(`not a #RRGGBB colour: ${value}`);
  return [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as unknown as Rgb;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const one = luminance(hex(a));
  const two = luminance(hex(b));
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
}

/** A token's value in a theme. */
const v = (theme: Theme, token: TokenName): string => THEMES[theme][token];

/** The worst ratio a token reaches over every ground in a theme, and the ground it reaches it on. */
function worst(theme: Theme, token: TokenName): { ratio: number; ground: TokenName } {
  let found = { ratio: Infinity, ground: GROUNDS[0]! };
  for (const ground of GROUNDS) {
    const ratio = contrast(v(theme, token), v(theme, ground));
    if (ratio < found.ratio) found = { ratio, ground };
  }
  return found;
}

/** The primary button's label on either of its fills. */
const onAccent = (theme: Theme): number => Math.min(
  contrast(v(theme, "on-accent"), v(theme, "accent-text")),
  contrast(v(theme, "on-accent"), v(theme, "accent-hover")),
);

const round = (n: number): number => Math.round(n * 100);

describe("every text token clears AA on every ground, in both themes", () => {
  for (const theme of BOTH) {
    it(`text on the ${theme} grounds (4.5:1)`, () => {
      const failing = TEXT_TOKENS.flatMap((token) => GROUNDS.flatMap((ground) => {
        const ratio = contrast(v(theme, token), v(theme, ground));
        return ratio < AA_NORMAL ? [`--${token} on --${ground}: ${ratio.toFixed(2)}`] : [];
      }));
      // Raise the token, never lower the threshold: every ground is a surface text can sit on.
      expect(failing, `${theme} text below 4.5:1`).toEqual([]);
    });

    it(`non-text on the ${theme} grounds (3:1)`, () => {
      // The accent (selection bar, focus ring, unread dot) and a field's edge: WCAG 1.4.11.
      const failing = NON_TEXT_TOKENS.flatMap((token) => GROUNDS.flatMap((ground) => {
        const ratio = contrast(v(theme, token), v(theme, ground));
        return ratio < AA_NONTEXT ? [`--${token} on --${ground}: ${ratio.toFixed(2)}`] : [];
      }));
      expect(failing, `${theme} non-text below 3:1`).toEqual([]);
    });

    it(`the ${theme} primary button's label clears AA on its fill and its hover`, () => {
      expect(onAccent(theme)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  }

  it("covers the eight grounds, so a ground dropped from the list cannot pass by not being measured", () => {
    expect(GROUNDS.length).toBe(8);
    expect(new Set(GROUNDS).size).toBe(8);
  });
});

describe("the receipt's figures", () => {
  it("match the tokens, so a token cannot move without a remeasure", () => {
    const measured: Record<string, number> = {
      "contrast.on_accent_dark": round(onAccent("dark")),
      "contrast.on_accent_light": round(onAccent("light")),
    };
    for (const token of [...TEXT_TOKENS, ...NON_TEXT_TOKENS]) {
      for (const theme of BOTH) {
        measured[`contrast.${token.replaceAll("-", "_")}_${theme}_worst`] = round(worst(theme, token).ratio);
      }
    }
    const recorded = Object.fromEntries(Object.keys(measured).map((key) => [key, (BUDGETS as Record<string, number>)[key]]));
    expect(recorded, "docs/receipts/contrast-tokens.md disagrees with src/theme.ts: remeasure, then pnpm receipts")
      .toEqual(measured);
  });
});

describe("the defects the palette was adjusted for, stated", () => {
  /*
   * Inequalities rather than numbers, so each says why a value is what it is. These are the design memo's
   * values and the previous light accent, measured against the grounds they would have met.
   */
  it("the memo's --text-muted #6F7D8D fails on the selected row (3.10)", () => {
    expect(contrast("#6F7D8D", v("dark", "surface-active"))).toBeLessThan(AA_NORMAL);
  });

  it("the memo's --danger #E46B72 fails on the selected row (4.13)", () => {
    expect(contrast("#E46B72", v("dark", "surface-active"))).toBeLessThan(AA_NORMAL);
  });

  it("light text on the dark accent fails (2.15), which is why Compose's label is --on-accent", () => {
    expect(contrast(v("dark", "text-primary"), v("dark", "accent"))).toBeLessThan(AA_NORMAL);
  });

  it("the previous light --accent-text #436BA8 fails on the light selected row (4.27)", () => {
    expect(contrast("#436BA8", v("light", "surface-active"))).toBeLessThan(AA_NORMAL);
  });
});

describe("the hierarchy the design depends on", () => {
  for (const theme of BOTH) {
    it(`${theme}: interactive surfaces step toward the text colour`, () => {
      // Each step closer to the text is what lets a fill say "hover" or "selected" without a line.
      const steps = (["surface-1", "surface-2", "surface-hover", "surface-active"] as const)
        .map((ground) => contrast(v(theme, "text-primary"), v(theme, ground)));
      for (let i = 1; i < steps.length; i += 1) expect(steps[i]!).toBeLessThan(steps[i - 1]!);
    });
  }

  it("dark: every ground is lighter than the one before it", () => {
    const lum = GROUNDS.map((ground) => luminance(hex(v("dark", ground))));
    for (let i = 1; i < lum.length; i += 1) expect(lum[i]!, `--${GROUNDS[i]}`).toBeGreaterThan(lum[i - 1]!);
  });

  it("light: the reader is the brightest ground, and the page the darkest", () => {
    const lum = (["bg-app", "bg-sidebar", "bg-list", "bg-reader"] as const).map((ground) => luminance(hex(v("light", ground))));
    for (let i = 1; i < lum.length; i += 1) expect(lum[i]!).toBeGreaterThan(lum[i - 1]!);
  });
});

describe("the theme wiring in the served sheet", () => {
  /*
   * The property: a page with no choice, or Dark, is dark on every operating system; Light is light; System
   * follows the OS. It breaks three ways, each of which reads fine in isolation: the blocks swapped, the
   * system block's selector dropped (a Dark chooser on a light OS then sees Light), or a second media query.
   */
  // Located inside each test, so a missing, duplicated or misplaced block fails that test by name.
  const blocks = () => themeBlocks(themeCss());

  it("opens with the dark block, which carries the dark tokens", () => {
    expect(blocks().dark).toContain("color-scheme: dark");
    expect(blocks().dark).toContain(declarations(THEMES.dark));
  });

  it("gives Light and System the light tokens", () => {
    for (const [name, body] of [["light", blocks().light], ["system", blocks().system]] as const) {
      expect(body, name).toContain("color-scheme: light");
      expect(body, name).toContain(declarations(THEMES.light));
    }
  });

  it("serves exactly those blocks at the start of the shell's sheet", () => {
    expect(SHELL_CSS.startsWith(themeCss())).toBe(true);
  });

  it("holds one theme media query, and it is the system block's", () => {
    const queries = SHELL_CSS.match(/prefers-color-scheme/g) ?? [];
    if (queries.length !== 1) {
      throw new Error(`${queries.length} prefers-color-scheme queries: a second theme media query means a Dark chooser on a light OS would see Light`);
    }
    if (/prefers-color-scheme\s*:\s*dark/.test(SHELL_CSS)) throw new Error("a prefers-color-scheme: dark query: a half-flipped sheet");
  });
});

describe("the readers those checks rely on", () => {
  /*
   * The two tests above are only as good as the readers they use: a locator that accepted a misplaced block
   * would pass a sheet with Light where System should be. So the readers are held against sheets built to be
   * wrong, and each refusal must name the block.
   */
  const dark = ":root {\n  --a: #000000;\n}\n";
  const light = ':root[data-theme="light"] {\n  --a: #FFFFFF;\n}\n';
  const media = (inner: string) => `@media (prefers-color-scheme: light) {\n${inner}}\n`;
  const system = ':root[data-theme="system"] {\n  --a: #FFFFFF;\n  }\n';

  it("reads a well-formed sheet", () => {
    expect(themeBlocks(dark + light + media(system))).toMatchObject({ dark: "\n  --a: #000000;\n", light: "\n  --a: #FFFFFF;\n" });
  });

  it.each([
    ["a sheet that does not open with the dark block", light + dark + media(system), /no dark block/],
    ["a second dark block", dark + light + media(system) + dark, /dark block appears 2 times/],
    ["no light block", dark + media(system), /no light block/],
    ["a second light block", dark + light + light + media(system), /light block appears 2 times/],
    ["the light block inside the dark one", ':root {\n:root[data-theme="light"] {\n}\n}\n' + media(system), /light block is inside or before/],
    ["the media query before the light block", dark + media(system) + light, /comes before the light block/],
    ["no system block", dark + light + media(""), /no system block/],
    ["the system block outside the media query", dark + light + media("") + system, /not inside @media/],
    ["no media query", dark + light + system, /no prefers-color-scheme: light block/],
  ])("refuses %s", (_, css, error) => {
    expect(() => themeBlocks(css)).toThrow(error);
  });

  it("reads rules inside a media query, and declarations without the empty tail", () => {
    expect(cssRules("/* .gone { color: red } */ @media (x) { .a, .b { color: red; margin: 0; } } @font-face { src: none; }"))
      .toEqual([{ selectors: [".a", ".b"], declarations: [{ property: "color", value: "red" }, { property: "margin", value: "0" }] }]);
  });
});

describe("where the sheet uses the tokens", () => {
  const rules = cssRules(SHELL_CSS);
  const all = rules.flatMap((rule) => rule.declarations.map((declaration) => ({ ...declaration, selectors: rule.selectors })));
  const uses = (value: string, token: string): boolean => new RegExp(`var\\(--${token}\\)`).test(value);

  it("reads the sheet's rules, so nothing below passes by reading none", () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it("never sets text in a token measured only for fills and edges", () => {
    /*
     * The matrix above proves a token is readable where it is allowed; this proves where it is used. The
     * non-text tokens clear 3:1, not 4.5:1 (light --accent is 3.60 on the selected row), and the borders are
     * 1.00 to 1.48:1. An icon is not text, so an svg selector may use them.
     */
    const forbidden = [...NON_TEXT_TOKENS, "border", "border-soft"];
    const svg = /(^|[\s>+~])svg([.:#[][^\s>+~]*)?$/;
    const offending = all
      .filter(({ property }) => property === "color" || property === "-webkit-text-fill-color")
      .filter(({ value }) => forbidden.some((token) => uses(value, token)))
      .filter(({ selectors }) => !selectors.every((selector) => svg.test(selector)))
      .map(({ selectors, property, value }) => `${selectors.join(", ")} { ${property}: ${value} }`);
    expect(offending).toEqual([]);
  });

  it("edges every field with --control-edge, never a divider token", () => {
    // WCAG 1.4.11: the edge identifies a field, and --border is 1.00 to 1.48:1.
    const field = /(^|[\s>+~(])(input|select|textarea)(?![\w-])/;
    const offending = all
      .filter(({ selectors }) => selectors.some((selector) => field.test(selector)))
      .filter(({ property, value }) => property.startsWith("border") && (uses(value, "border") || uses(value, "border-soft")))
      .map(({ selectors, property, value }) => `${selectors.join(", ")} { ${property}: ${value} }`);
    expect(offending).toEqual([]);

    const global = rules.find((rule) => ["input", "select", "textarea"].every((name) =>
      rule.selectors.some((selector) => new RegExp(`^${name}(?![\\w-])`).test(selector))));
    expect(global, "no rule styles input, select and textarea together").toBeDefined();
    expect(global!.declarations.find(({ property }) => property === "border")?.value).toContain("var(--control-edge)");
  });

  it("marks every selected thing with the accent, not only a fill", () => {
    /*
     * The fills are 1.1 to 1.4:1 against their ground, so a selection they alone carry is invisible to
     * somebody who cannot see that difference. The first rule for each selected state is its definition.
     */
    const SELECTED = [
      ".rail-row.current",
      ".message-row.current",
      '.list-tab[aria-selected="true"]',
      ".section-tab.current",
      '.palette-option[aria-selected="true"]',
    ];
    for (const selected of SELECTED) {
      const first = rules.find((rule) => rule.selectors.includes(selected));
      expect(first, `no rule for ${selected}`).toBeDefined();
      expect(first!.declarations.some(({ value }) => uses(value, "accent")), `${selected} has no accent indicator`).toBe(true);
    }
  });
});
