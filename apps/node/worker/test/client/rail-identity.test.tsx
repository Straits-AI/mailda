import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MARK_DOT, MARK_PATH } from "../../src/brand.ts";
import { Mark } from "../../src/client/app/mark.tsx";

/**
 * The mark reaches the screen a person works in (#128).
 *
 * ## What was wrong, and why nothing noticed
 *
 * `brand.ts` and its `markSvg()` shipped, and were consumed **exactly once** — by `ui.ts`, which builds the
 * pre-authentication shell. The React chrome, which is the whole product after sign-in, went on rendering
 * `MAIL<span class="accent">DA</span>`: the instrument panel's idea of a wordmark, left behind because
 * nothing connected the two files.
 *
 * So the identity was present on the sign-in page and absent everywhere else, which is the one place it
 * matters. Reported by the operator looking at their own Node.
 *
 * ## What these tests hold
 *
 * That the chrome's mark is **the same geometry** as the shell's, not a second drawing of it — which is the
 * failure `brand.ts` names: *"a second copy for the second consumer is how a logo ends up subtly different
 * in two places."* And that it is announced correctly beside a word that already says the name.
 */
describe("the Mailda mark in the React chrome", () => {
  it("draws the geometry brand.ts holds, rather than a second copy of it", () => {
    const { container } = render(<Mark size={26} />);
    const path = container.querySelector("path");

    expect(path?.getAttribute("d")).toBe(MARK_PATH);
    /*
     * The dot too. It is a separate element in the brand's lockup — the blue that the monochrome variant
     * drops — so a mark that drew the stroke from `brand.ts` and hardcoded the dot would pass a path-only
     * assertion and be wrong in the one place the brand has a colour.
     */
    const dot = container.querySelector("circle");
    expect(Number(dot?.getAttribute("cx"))).toBe(MARK_DOT.cx);
    expect(Number(dot?.getAttribute("r"))).toBe(MARK_DOT.r);
  });

  it("inherits its stroke, so one variant serves a dark rail and a light page", () => {
    /*
     * `currentColor` is what lets the rail's own text token reach the mark. A hardcoded Ink stroke would
     * vanish on the Ink rail — which is exactly the surface #128 puts it on.
     */
    const { container } = render(<Mark size={26} />);
    expect(container.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
  });

  it("is silent beside a word, and named when it stands alone", () => {
    /*
     * The lockup is the mark plus "Mailda" as real text, so a mark with its own accessible name makes a
     * screen reader say the product's name twice. Standing alone it is the only thing there and must be
     * named — two cases, and getting the default wrong is how a logo becomes noise in a screen reader.
     */
    const decorative = render(<Mark size={26} />);
    expect(decorative.container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(decorative.container.querySelector("svg")?.getAttribute("role")).toBeNull();
    decorative.unmount();

    render(<Mark size={26} title="Mailda" />);
    expect(screen.getByRole("img", { name: "Mailda" })).toBeTruthy();
  });

  it("keeps the stroke width in user units, so it does not go spindly when small", () => {
    // A line-drawn logo's usual failure in a product: scaled by CSS, the stroke thins with the box. Fixed
    // in the viewBox's units, it scales with the art instead.
    const small = render(<Mark size={16} />);
    const large = render(<Mark size={40} />);
    const widthOf = (r: ReturnType<typeof render>) =>
      r.container.querySelector("svg")?.getAttribute("stroke-width");
    expect(widthOf(small)).toBe(widthOf(large));
  });
});
