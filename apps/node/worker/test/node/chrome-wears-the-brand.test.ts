import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SHELL_CSS } from "../../src/shell-css.ts";
import { GROUNDS } from "../../src/theme.ts";
import { withoutComments } from "../without-comments.ts";
import { cssRules } from "./support/theme-blocks.ts";

/**
 * The brand reaches both shells, and the sidebar and the search field are styled as the controls they are
 * (#128).
 *
 * ## The defect this closed was a *connection*, not a value
 *
 * `brand.ts`, the palette and the mark all shipped. `markSvg()` was consumed exactly once — by `ui.ts`, the
 * pre-authentication shell — and the React chrome went on rendering a text wordmark from the instrument
 * panel it replaced. Every value was right and nothing joined them.
 *
 * ## What moved to render tests, and why
 *
 * This file used to pin JSX strings in `chrome.tsx` and `inbox.tsx`: the wordmark's `<span>`, the mark's
 * gate, the search button's attributes. Those were lexical checks on the wording of a component, which fail
 * when the code is rewritten rather than when the property breaks (AGENTS.md §2c). The wordmark is now held by
 * the sidebar's render test and the search field's names by the search field's render test, both of which
 * mount the component and read what a person or a screen reader gets. What stays here reads an artifact (the
 * served `SHELL_CSS`) or literal path data, which has no rendered form to test.
 */

const worker = join(import.meta.dirname, "../..");
const source = (path: string): string => withoutComments(join(worker, path));
const rules = cssRules(SHELL_CSS);

describe("the mark is drawn from brand.ts", () => {
  it("gates the pre-authentication page's mark on the artwork being real", () => {
    /*
     * The mark in `brand.ts` is a by-eye reconstruction and at 26px it renders as a squiggle with a dot, so no
     * shell draws it until the designer's vector lands and `MARK_IS_AUTHORED` flips. The document is a string
     * in `ui.ts`, not a component, so this is its only test.
     */
    expect(source("src/ui.ts")).toMatch(/MARK_IS_AUTHORED \? markSvg/);
  });

  it("gates the favicon too, which is the smallest and least forgiving place a mark appears", () => {
    expect(source("src/brand.ts")).toMatch(/if \(!MARK_IS_AUTHORED\) \{/);
  });

  it("never carries its own path data in either shell", () => {
    /*
     * The rule `brand.ts` states: one geometry, two consumers. A path pasted into either file is the way a
     * logo ends up subtly different in two places, and it is invisible in review because both look right.
     */
    for (const path of ["src/client/app/chrome.tsx", "src/ui.ts"]) {
      expect(source(path), `${path} carries its own path data`).not.toMatch(/d="M\d/);
    }
  });
});

describe("the sidebar's surfaces are ones the contrast matrix measured", () => {
  /**
   * The rail used to be an Ink island inside a light page, and this block held that no rail rule reached for
   * a colour tuned against the page: on Ink, every page-tuned token failed AA. That ban is retired because
   * its premise is gone, not because it was inconvenient. The sidebar is `--bg-sidebar` in both themes now,
   * and `contrast.test.ts` checks every text token against every ground, the sidebar's included.
   *
   * What that matrix cannot see is a sidebar rule painting a surface that is **not** a ground: a text token
   * on it would then sit on a colour nobody measured. So this is the property the old ban approximated,
   * stated exactly: every fill a sidebar rule sets is transparent or one of the measured grounds.
   */
  const rail = rules.filter((rule) => rule.selectors.some((selector) => /\.rail(?![a-z])/.test(selector)));

  it("finds the sidebar's rules, so nothing below passes by reading none", () => {
    expect(rail.length).toBeGreaterThan(6);
    expect(rail.some((rule) => rule.selectors.includes(".rail-row"))).toBe(true);
  });

  it("paints no sidebar surface outside the measured grounds", () => {
    const allowed = new Set(["transparent", "none", ...GROUNDS.map((ground) => `var(--${ground})`)]);
    const offending = rail.flatMap((rule) => rule.declarations
      .filter(({ property }) => property === "background" || property === "background-color")
      .filter(({ value }) => !allowed.has(value))
      .map(({ property, value }) => `${rule.selectors.join(", ")} { ${property}: ${value} }`));
    expect(offending, "a sidebar fill the contrast matrix does not cover: use a ground token").toEqual([]);
  });

  it("marks the current row with the accent as well as the active fill", () => {
    // The fill is 1.38:1 against the sidebar, so the accent bar is what carries "you are here".
    const current = rules.find((rule) => rule.selectors.includes(".rail-row.current"));
    const body = current?.declarations.map(({ value }) => value).join(";") ?? "";
    expect(body).toContain("var(--accent)");
    expect(body).toContain("var(--surface-active)");
  });
});

describe("the search field is styled as a field", () => {
  it("styles the form at all, which is what was first reported", () => {
    // `.inbox-search` had no rule anywhere in the stylesheet: the one control that had never been dressed.
    expect(rules.some((rule) => rule.selectors.includes(".inbox-search"))).toBe(true);
  });

  it("gives the pill an edge that identifies it, not just a fill", () => {
    /*
     * WCAG 1.4.11 wants 3:1 for the visual information identifying a control, and the pill's fill is about
     * 1.1:1 against the list. `contrast.test.ts` measures the token; this holds that the pill uses it.
     */
    const pill = rules.find((rule) => rule.selectors.includes(".search-pill"));
    expect(pill?.declarations.find(({ property }) => property === "border")?.value).toContain("var(--control-edge)");
  });
});
