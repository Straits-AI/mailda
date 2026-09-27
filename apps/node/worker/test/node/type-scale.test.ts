import { describe, expect, it } from "vitest";

import { SHELL_CSS } from "../../src/shell-css.ts";
import { cssRules } from "./support/theme-blocks.ts";

/**
 * The application sets Inter on six sizes (ADR 30 as amended 26 September 2026, and the brand section of
 * `docs/application-shell.md`), and this reads the served sheet to hold it.
 *
 * The claim was false the day it was written (a toast's dismiss glyph at 16px) and drifted again while it was
 * being reviewed (the file control's text at 13px), each a reasonable local choice and together a scale nobody
 * decided. The pre-authentication page is outside it by decision rather than by oversight: the redesign
 * repainted it and did not re-set its type, so it keeps the hero type it had (a fluid heading, an 18px wordmark
 * and a 16px lede), and those three rules are named here so a new one is a question rather than a silent
 * addition. The body frame's sheet is not Inter at all (it uses the platform's UI sans), so it is not read here.
 */

const SCALE = new Set(["26px", "22px", "15px", "14px", "12px", "11px"]);

/** The pre-authentication page's own type, which the redesign left as it was. */
const PRE_AUTH = new Set(["h1", ".wordmark", ".split-lede p"]);

/** The size in a `font` shorthand (`700 18px/1.2 var(--body)`) or a `font-size`; null for `inherit` and kin. */
function sizeOf(property: string, value: string): string | null {
  if (property === "font-size") return /^(inherit|initial|unset)$/.test(value) ? null : value;
  if (property !== "font") return null;
  return /(?:^|\s)(clamp\([^)]*\)|[\d.]+(?:px|rem|em|%))(?=\/|\s|$)/.exec(value)?.[1] ?? null;
}

const set = cssRules(SHELL_CSS).flatMap((rule) => rule.declarations.flatMap(({ property, value }) => {
  const size = sizeOf(property, value);
  return size === null ? [] : [{ selectors: rule.selectors, size }];
}));

describe("the application's type is on six sizes", () => {
  it("finds the sheet's sizes and each pre-authentication exception, so nothing below passes by reading none", () => {
    expect(set.length).toBeGreaterThan(100);
    for (const selector of PRE_AUTH) {
      expect(set.some((one) => one.selectors.includes(selector)), `no size set on ${selector}: drop it from PRE_AUTH`).toBe(true);
    }
  });

  it("sets no size outside 26, 22, 15, 14, 12 and 11 px, the pre-authentication page's own three rules aside", () => {
    const off = set
      .filter((one) => !SCALE.has(one.size) && !one.selectors.every((selector) => PRE_AUTH.has(selector)))
      .map((one) => `${one.selectors.join(", ")} { ${one.size} }`);
    expect(off, "a size off the scale: move it onto one of the six, or amend ADR 30 and the doc").toEqual([]);
  });
});
