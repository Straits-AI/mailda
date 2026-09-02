import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withoutComments } from "../without-comments.ts";

/**
 * The brand reaches both shells, and the search field is a control rather than a shape (#128).
 *
 * ## The defect this closes is a *connection*, not a value
 *
 * `brand.ts`, the palette and the mark all shipped. `markSvg()` was consumed exactly once — by `ui.ts`, the
 * pre-authentication shell — and the React chrome went on rendering a text wordmark from the instrument
 * panel it replaced. Every value was right and nothing joined them, so the identity was on the sign-in page
 * and missing from the product. No test could see that, because each file was individually correct.
 *
 * ## Why lexical, and what it cannot do
 *
 * It cannot tell whether the rail *looks* right — `test/client/rail-identity.test.tsx` drives the component
 * and `test/node/contrast.test.ts` measures the colours. What this holds is that both consumers exist and
 * neither has quietly grown its own copy of the geometry, which is the shape of the failure that happened.
 */

const worker = join(import.meta.dirname, "../..");
const chrome = () => withoutComments(join(worker, "src/client/app/chrome.tsx"));
const inbox = () => withoutComments(join(worker, "src/client/app/screens/inbox.tsx"));
const ui = () => withoutComments(join(worker, "src/ui.ts"));

describe("both shells wear the mark", () => {
  it("sets the name in the display face, and not as two coloured halves", () => {
    /*
     * The lockup the rail actually renders today. `MAIL<span class="accent">DA</span>` was the instrument
     * panel's wordmark, kept alive by nothing connecting `brand.ts` to the chrome — and it is not the brand's
     * anyway: the sheet sets one word, initial capital, in the display face.
     */
    const source = chrome();
    expect(source).toContain("<span>Mailda</span>");
    expect(source).not.toContain("MAIL<span");
  });

  it("gates the symbol on the artwork being real, in both shells", () => {
    /*
     * **The measurement, held.** The mark in `brand.ts` is a by-eye reconstruction and at 26px it renders as
     * a squiggle with a dot — checked against a screenshot, which is what the sentence claiming it "reads as
     * the Mailda symbol at interface sizes" had never been. So neither shell draws it, and both are gated on
     * the same flag rather than one of them being quietly fixed.
     *
     * This asserts the *wiring*, not the flag's value: when the designer's vector lands, `MARK_IS_AUTHORED`
     * flips and both shells start drawing without either being edited. A shell that hardcoded the mark back
     * in would fail here.
     */
    for (const [name, source] of [["chrome", chrome()], ["ui", ui()]] as const) {
      expect(source, `${name} does not gate the mark`).toContain("MARK_IS_AUTHORED");
    }
    expect(chrome()).toMatch(/MARK_IS_AUTHORED \? <Mark/);
    expect(ui()).toMatch(/MARK_IS_AUTHORED \? markSvg/);
  });

  it("gates the favicon too, which is the smallest and least forgiving place a mark appears", () => {
    /*
     * `brand.ts`'s own header said the reconstruction was "not fine for a favicon at 16 px" while the
     * favicon was drawing it. A tab icon is where a wrong shape is least recoverable: nobody looks closely
     * enough to see it is wrong, only that the tab is unfamiliar.
     */
    expect(withoutComments(join(worker, "src/brand.ts"))).toMatch(/if \(!MARK_IS_AUTHORED\) \{/);
  });

  it("draws the mark from brand.ts in both, never from a literal path", () => {
    /*
     * The rule `brand.ts` states: one geometry, two consumers. A path pasted into either file is the way a
     * logo ends up subtly different in two places, and it is invisible in review because both look right.
     */
    for (const [name, source] of [["chrome", chrome()], ["ui", ui()]] as const) {
      expect(source, `${name} carries its own path data`).not.toMatch(/d="M\d/);
    }
    expect(chrome()).toMatch(/from "\.\/mark\.tsx"/);
  });
});

describe("no rail rule reaches for a colour tuned against the page", () => {
  /**
   * The gap a mutation found, and it is the one this whole change turns on.
   *
   * `contrast.test.ts` measures **tokens**. It proves `--live` fails on Ink and `--rail-live` clears it, and
   * both stay true no matter which of them `.rail-mine` actually uses — so putting the failing token back
   * passed every contrast assertion. Measuring a value is not the same as measuring where it is used.
   *
   * And it generalises, because every page-tuned token fails on Ink:
   *
   *     --live        #2F6F4E   3.01
   *     --warn        #9A5410   3.14
   *     --alarm       #A5342A   2.68
   *     --accent-text #436BA8   3.36
   *     --text        #0F1720   1.00   (invisible)
   *
   * So this is a closed world over the rail's rules rather than a patch for the one that broke: any of the
   * five inside a rail rule is unreadable, and the next person to style a rail row will reach for whichever
   * one names the thing they mean.
   */
  const PAGE_TUNED = ["live", "warn", "alarm", "accent-text", "text"] as const;

  /** Every declaration block in the stylesheet whose selector mentions the rail. */
  function railRules(): Array<{ selector: string; body: string }> {
    const found: Array<{ selector: string; body: string }> = [];
    for (const match of ui().matchAll(/([^{}]*\.rail[^{}]*)\{([^}]*)\}/g)) {
      found.push({ selector: (match[1] ?? "").trim(), body: match[2] ?? "" });
    }
    return found;
  }

  it("finds the rail's rules, so nothing below passes by scanning none", () => {
    const rules = railRules();
    expect(rules.length).toBeGreaterThan(6);
    expect(rules.some((rule) => rule.selector.includes(".rail-row"))).toBe(true);
  });

  it("uses none of the page's tuned colours", () => {
    const offending: string[] = [];
    for (const rule of railRules()) {
      /*
       * `.rail-row.current` is the exception, and it is a real one rather than an escape hatch: that row is
       * the brand's **Sky pill**, so its contents sit on a light fill and the page's tokens are the correct
       * ones there. Ink on Sky is 15.41. Named by selector so the exemption cannot silently widen.
       */
      if (rule.selector.includes(".current")) continue;
      for (const token of PAGE_TUNED) {
        if (new RegExp(`var\\(--${token}\\)`).test(rule.body)) {
          offending.push(`${rule.selector} uses var(--${token})`);
        }
      }
    }
    expect(
      offending,
      "a rail rule uses a colour tuned against the light page. On Ink all five fail AA — --text is 1.00, "
      + "which is invisible. Use the --rail-* token beside it.",
    ).toEqual([]);
  });

  it("still allows the accent as a fill, which is a component and not text", () => {
    // Anti-vacuity in the other direction: a rule banning every page token would ban Flow Blue from the
    // current row's marker, where 3.99 on Ink is correct for a 3:1 component.
    const current = railRules().find((rule) => rule.selector.includes(".rail-row.current"));
    expect(current?.body).toContain("var(--accent)");
  });
});

describe("the search field is a control", () => {
  it("has a submit button carrying the icon, not a decorative glyph", () => {
    /*
     * The usual way the mockup's icon-in-a-field is built is a `<span>` with an SVG and a form that submits
     * on Enter — which loses the button, so a keyboard has nothing to land on and a screen reader is told
     * the search cannot be run. The icon has to *be* the button.
     */
    const source = inbox();
    expect(source).toMatch(/<button type="submit"[^>]*className="search-go"/);
    expect(source).toMatch(/aria-label="Search"/);
  });

  it("gives the field and the button different names", () => {
    /*
     * Both were "Search mail" first, and `search-field.test.tsx` could then find neither unambiguously —
     * which is the test noticing what a screen reader would: "Search mail, edit" and "Search mail, button"
     * with nothing to tell them apart.
     */
    const source = inbox();
    expect(source).toContain('className="visually-hidden">Search mail<');
    expect(source).not.toContain('aria-label="Search mail"');
  });

  it("styles the field at all, which is what was reported", () => {
    // `.inbox-search` had **no rule anywhere** in the stylesheet. The field was the one control on the
    // interface that had never been dressed, which is why it was the first thing anybody noticed.
    const source = ui();
    expect(source).toContain(".search-pill");
    expect(source).toContain(".inbox-search {");
  });

  it("gives the pill an edge that identifies it, not just the brand's fill", () => {
    /*
     * WCAG 1.4.11 wants 3:1 for the visual information identifying a control, and the brand's Mist-on-White
     * pill is 1.10 — so the fill is decoration and the edge is the control. `contrast.test.ts` measures the
     * token; this holds that the pill actually uses it rather than a hairline that looks nicer.
     */
    expect(ui()).toMatch(/\.search-pill\s*\{[^}]*var\(--control-edge\)/);
  });
});
