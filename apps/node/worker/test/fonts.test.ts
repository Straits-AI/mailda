import { describe, expect, it } from "vitest";

import { clientAsset } from "../src/ui.ts";

/**
 * The webfonts this Node serves from its own origin (#branding).
 *
 * ## What this is actually guarding
 *
 * Not that a route exists — that a **product rule** holds. Mailda's premise is custody, and `ui.ts` has said
 * since it was written that no webfont is loaded because "a page that fetches a font from a third party hands
 * that third party every viewer's IP address on every load". The interface now loads four fonts and the rule
 * is unchanged: they come from here. The failure this file exists to catch is somebody swapping a local face
 * for a CDN link because it is one line shorter, which no behavioural test would otherwise notice — the page
 * would look *better*, and every viewer's address would go to Google.
 *
 * `test/security-headers.test.ts` guards the other half by asserting `font-src` is exactly `'self'`. Both are
 * needed: a strict policy with no fonts served is a blank page, and fonts served under a widened policy is
 * the leak. Neither test can see the other's failure.
 */

/** Every face the stylesheet's `@font-face` block references. */
const SERVED = [
  "/app/fonts/inter-400.woff2",
  "/app/fonts/inter-500.woff2",
  "/app/fonts/jakarta-600.woff2",
  "/app/fonts/jakarta-700.woff2",
];

describe("the fonts are served from this origin", () => {
  for (const path of SERVED) {
    it(`serves ${path} as woff2 bytes`, async () => {
      const response = clientAsset(path);
      expect(response, `${path} is referenced by @font-face and served by nothing`).not.toBeNull();
      expect(response!.headers.get("content-type")).toBe("font/woff2");

      /*
       * The bytes, checked by their magic number rather than only their length. A route returning *something*
       * of a plausible size would pass a length assertion — the failure mode of the `Data` module rule going
       * wrong is a string of the module's source text, not an empty response.
       */
      const bytes = new Uint8Array(await response!.arrayBuffer());
      expect(bytes.byteLength, `${path} is suspiciously small`).toBeGreaterThan(8_000);
      expect(
        String.fromCharCode(...bytes.slice(0, 4)),
        `${path} does not begin with the woff2 signature — is wrangler's Data rule still in effect?`,
      ).toBe("wOF2");
    });
  }

  it("caches them for a year, unlike every other asset this Node serves", () => {
    /*
     * The asset table beside them is 60 seconds, so an over-the-air update (ADR 24) takes effect on the next
     * load rather than appearing to have silently not happened. A font is the opposite case: the name carries
     * the family and the weight, so a new weight is a new URL and this file will never change. Paying 71 KB
     * on every load to keep a freshness guarantee that cannot apply is waste with no upside.
     */
    const cache = clientAsset(SERVED[0]!)!.headers.get("cache-control");
    expect(cache).toContain("immutable");
    expect(cache).toContain("max-age=31536000");
  });

  it("still serves the short-lived assets short-lived, so the two policies cannot converge", () => {
    // The control. If a refactor gave everything the font policy, the assertion above would still pass and
    // an OTA update would stop arriving for a year — which is a far worse failure than a stale font.
    expect(clientAsset("/app/app.css")!.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("references exactly these four faces from the stylesheet, and no others", async () => {
    /*
     * The closed world. A fifth `@font-face` pointing at a path nothing serves is a face that silently falls
     * back — the page renders, in the wrong type, with no error anywhere. Derived from the stylesheet rather
     * than listed twice, so the list above cannot be the stale copy.
     */
    const css = await clientAsset("/app/app.css")!.text();
    const referenced = [...css.matchAll(/url\("(\/app\/fonts\/[^"]+)"\)/g)].map((m) => m[1]!);
    expect(referenced.length, "no @font-face urls in the stylesheet — has the block moved?")
      .toBeGreaterThan(0);
    expect([...new Set(referenced)].sort()).toEqual([...SERVED].sort());
  });
});
