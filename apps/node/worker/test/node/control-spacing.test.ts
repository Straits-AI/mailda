import { describe, expect, it } from "vitest";

import { SHELL_CSS } from "../../src/shell-css.ts";
import { cssRules } from "./support/theme-blocks.ts";

/**
 * The spacing rules the controls rely on, read from the served sheet (28 September 2026: "the Add the address button
 * is sticking to the text field").
 *
 * **This reads CSS text and measures no layout.** A rule here can still be beaten by a more specific one, and a screen
 * can set two controls side by side with no rule at all. The measurement is `scripts/spacing.mjs`, run by hand against
 * a running Node with a real browser; a pass here is not a pass there. What this holds is that the shared rules the
 * sweep was brought to zero with are still in the sheet, at the gap they were given.
 */

/** The least room between two controls, px: the same presentation rule `scripts/spacing.mjs` measures against. */
const MIN_GAP = 8;

const rules = cssRules(SHELL_CSS);

/** Every rule whose selector list is exactly `selector` or includes it, in @media blocks too. */
function rulesFor(selector: string) {
  return rules.filter((rule) => rule.selectors.join(", ") === selector || rule.selectors.includes(selector));
}

/** `8px` or `8px 4px` as [row, column] in px; a longhand fills its own half. */
function gaps(selector: string): Array<{ row: number; column: number }> {
  return rulesFor(selector).flatMap((rule) => rule.declarations.flatMap(({ property, value }) => {
    const numbers = value.split(/\s+/).map((one) => (/^(\d+(?:\.\d+)?)px$/.exec(one) === null ? Number.NaN : Number.parseFloat(one)));
    if (property === "gap") return [{ row: numbers[0]!, column: numbers[1] ?? numbers[0]! }];
    if (property === "row-gap") return [{ row: numbers[0]!, column: Number.POSITIVE_INFINITY }];
    if (property === "column-gap") return [{ row: Number.POSITIVE_INFINITY, column: numbers[0]! }];
    return [];
  }));
}

function px(selector: string, property: string): number[] {
  return rulesFor(selector).flatMap((rule) => rule.declarations
    .filter((one) => one.property === property)
    .map((one) => (/^(\d+(?:\.\d+)?)px$/.test(one.value) ? Number.parseFloat(one.value) : Number.NaN)));
}

/**
 * The rows of controls, each spaced by its own gap, wrapping onto a second line on a phone (so both halves count).
 * A new row of controls belongs here.
 */
const CONTROL_ROWS = [
  ".row-actions", ".policy-actions", ".approval-actions", ".inline-actions", ".reader-actions", ".next-steps",
  ".hand-to", ".details-actions", ".butler-actions", ".dock-send", ".pager",
] as const;

/** A second control after the field in a field row: the rule that answers the complaint. */
const FIELD_NEIGHBOUR =
  ".field-row > :is(input, select, textarea, .address-field) + :is(input, select, textarea, button, .btn, .address-field)";

describe("controls stand at least 8px apart, by the sheet's shared rules", () => {
  it("finds a gap on every row it names, so nothing below passes by reading none", () => {
    for (const selector of CONTROL_ROWS) {
      expect(gaps(selector).length, `no gap on ${selector}: drop it from CONTROL_ROWS or give it one`).toBeGreaterThan(0);
    }
  });

  it("spaces every row of controls 8px or more, across and down", () => {
    const tight = CONTROL_ROWS.flatMap((selector) => gaps(selector)
      .filter(({ row, column }) => !(row >= MIN_GAP && column >= MIN_GAP))
      .map(({ row, column }) => `${selector} { gap: ${row}px ${column}px }`));
    expect(tight).toEqual([]);
  });

  it("puts a field row's second control 8px from the field: the caption's 4px gap plus the neighbour's margin", () => {
    const [rowGap] = gaps(".field-row").map((one) => one.row);
    const margins = px(FIELD_NEIGHBOUR, "margin-top");
    expect(margins.length, "the field row's neighbour rule is gone").toBe(1);
    expect(rowGap! + margins[0]!).toBeGreaterThanOrEqual(MIN_GAP);
  });

  it("wraps the address field's rows 8px apart on a phone", () => {
    const rows = gaps(".address-field").map((one) => one.row);
    expect(rows.length).toBe(1);
    expect(rows[0]).toBeGreaterThanOrEqual(MIN_GAP);
  });

  /*
   * The @ is text, not a control, so the sweep does not measure it; what came near it was the focus ring, which the
   * sheet draws 2px out from a control and 2px wide. At 4px across, a focused local-part field's ring touched the @.
   */
  it("keeps the @ 8px from the local-part field and from the domain picker, clear of a focused control's ring", () => {
    const across = [...gaps(".address-field"), ...gaps(".address-pick")].map((one) => one.column);
    expect(across.length).toBe(2);
    expect(across.filter((column) => column < MIN_GAP)).toEqual([]);
  });

  /*
   * Not a gap, and held here because a sweep is run by hand: without it `.field-row select`'s 18rem pushes the
   * domain picker onto a line of its own beside a short local part. Text only; that it wraps is the sweep's to see.
   */
  it("lets the address field's domain picker shrink below a field row's select width", () => {
    const declared = rulesFor(".field-row .address-pick > select").flatMap((rule) => rule.declarations)
      .filter((one) => one.property === "min-width").map((one) => one.value);
    expect(declared).toEqual(["0"]);
  });

  it("stacks a queue row's actions 8px apart", () => {
    expect(px(".case-actions button", "margin-bottom")).toEqual([MIN_GAP]);
  });
});
