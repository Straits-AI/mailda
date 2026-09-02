/**
 * The Mailda mark, and the colour and type tokens that go with it.
 *
 * ## The mark in this file is a reconstruction, not the authored artwork
 *
 * **Read this before using it anywhere that matters.** The path below was drawn by eye from raster
 * screenshots of the brand sheet, because that is what was available. It is *not* the designer's vector: the
 * curve tensions, the exact stroke weight, the loop's proportions and the optical corrections are
 * approximations.
 *
 * ## And it does not work — measured, not supposed (#128)
 *
 * This paragraph used to say the reconstruction "reads as the Mailda symbol at interface sizes" and that
 * this was "fine for a screen at 24–40 px". **Both are false.** Rendered at 26 px in the rail and zoomed,
 * it is a small squiggle with a dot beside it: it does not read as an M, and nobody shown it would connect
 * it to the brand sheet. It was on the sign-in page for a week on the strength of a sentence nobody checked
 * against a screenshot.
 *
 * So `MARK_IS_AUTHORED` is false and **nothing renders it**. The geometry stays because it is the drop-in
 * point the next paragraph describes, and because deleting it would lose the coordinate space the dot and
 * the stroke width are expressed in. A logo that is nearly right is wrong; one that is not even nearly right
 * is worse, and the honest interim is the wordmark set in type, which is a real design decision rather than
 * an approximation of somebody else's.
 *
 * **Replacing it is one edit.** `MARK_PATH` and `MARK_VIEWBOX` are the only two values that describe the
 * geometry; every consumer — the pre-authentication shell, the React chrome, the favicon, the app icon —
 * derives from `markSvg()`. Drop the real path in and everything follows.
 *
 * ## Why the wordmark is text and not a path
 *
 * "Mailda" is set as real text in the display face rather than traced. Three reasons and the first is
 * decisive: it is **selectable, translatable and readable by a screen reader**, where a path is a picture of
 * a word. It also costs no bytes beyond the font already being loaded, and it stays crisp at any size
 * without a second set of optical sizes.
 *
 * The cost is that the wordmark renders in Plus Jakarta Sans rather than Satoshi wherever Satoshi is not
 * installed — see `fonts/README.md` for why Satoshi is named in the stack and not shipped. For the
 * lockup that appears in the product this is the right trade; for a logo file handed to a printer it is
 * not, and that file should come from the designer.
 */

/**
 * The palette, from the brand sheet.
 *
 * Kept here as the single source rather than only in the stylesheet, because the favicon and the app icon
 * are generated SVG strings and would otherwise carry their own copy of the blue.
 */
export const BRAND = {
  /** Ink. Text, the mark's stroke, dark surfaces. */
  ink: "#0F1720",
  /**
   * Flow Blue. The accent, and **not a text colour on anything but pure white.**
   *
   * Measured: 4.53:1 on white — which passes AA by 0.03 — and 4.11:1 on Mist, 3.87:1 on Sky, which fail.
   * So it is for the dot, icons, fills, borders and focus rings, all of which need 3:1 rather than 4.5:1.
   * Body-size text in the brand blue uses `blueText` below. `docs/receipts/contrast-tokens.md` has the table.
   */
  blue: "#4C77B8",
  /**
   * The same hue and saturation, 5% darker, so brand blue can carry small text.
   *
   * 216° and 0.432 saturation are Flow Blue's own; only lightness moves, 0.510 → 0.460. That buys 5.37:1 on
   * White, 4.88:1 on Mist and 4.59:1 on Sky — AA on all three of the brand's own grounds, which Flow Blue
   * manages on none of them but white.
   */
  blueText: "#436BA8",
  /** Sky. Selected rows, quiet fills, the pattern. */
  sky: "#E6EEF7",
  /** Mist. The page ground in light mode. */
  mist: "#F2F4F7",
  white: "#FFFFFF",
} as const;

/**
 * The symbol's viewBox. Wider than tall, matching the brand sheet's proportion.
 *
 * One of the two values that describe the geometry. See the header.
 */
/**
 * Whether `MARK_PATH` is the designer's artwork rather than the by-eye reconstruction (#128).
 *
 * **The one line to flip when the real SVG arrives.** While it is false, both shells render the wordmark as
 * type alone and no consumer draws the mark — because the reconstruction does not read as the symbol, which
 * is stated with the evidence in this file's header.
 *
 * A flag rather than deleting the path: the geometry is the drop-in point, the dot and the stroke width are
 * expressed in its coordinate space, and `markSvg()` and the React `Mark` are both tested against it. What
 * is wrong is the curve data, and that is exactly one edit away from being right.
 */
export const MARK_IS_AUTHORED = false;

export const MARK_VIEWBOX = "0 0 60 52";

/**
 * The symbol as one continuous stroke, drawn with round caps.
 *
 * One of the two values that describe the geometry. See the header — this is a reconstruction.
 *
 * The reading it is built on: an **M** drawn without lifting the pen, where the first stem falls and turns
 * through a bowl, a long diagonal climbs to the right, a loop drops below the join, and the final stem rises
 * to meet the dot. The loop is the feature that makes it Mailda's rather than any geometric M — it is where
 * "flowing" lives in a shape otherwise made of straight lines.
 *
 * The dot is **not** in this path. It is a separate element so it can be the accent colour while the stroke
 * stays ink, and so the monochrome variant can drop it to ink without touching the geometry.
 */
export const MARK_PATH = [
  // The left stem: down from the top-left point, then the bowl turning back up.
  "M11.5 10.5 L11.5 33",
  "C11.5 39.5 20.5 39.5 20.5 33",
  // Back up to the inner peak, then the long diagonal climbing right.
  "L20.5 24 L11.5 10.5",
  "M20.5 24 L44 12.5",
  // The loop below the join — one round turn, the shape's "flowing" note.
  "M31 30 C25 33 25 41 31 41 C37 41 37 33 31 30 Z",
  // The right stem rising to the dot, with the short flag that echoes the left peak.
  "M44 41 L44 19 L36.5 25.5",
].join(" ");

/** Where the dot sits, in the same coordinate space as the path. */
export const MARK_DOT = { cx: 48.5, cy: 12.5, r: 3.6 } as const;

export interface MarkOptions {
  /** Rendered width in CSS pixels. Height follows the viewBox. */
  size?: number;
  /** The stroke colour. Defaults to `currentColor`, so the mark inherits from its context. */
  stroke?: string;
  /**
   * The dot's colour, or `null` for the monochrome variant.
   *
   * `null` rather than "same as stroke", because the brand sheet's monochrome lockup keeps the dot as a
   * shape and drops only its colour — so the caller is choosing between two published variants rather than
   * setting a value.
   */
  dot?: string | null;
  /** Accessible name, or `null` for a decorative mark beside text that already says "Mailda". */
  title?: string | null;
}

/**
 * The symbol, as an SVG string.
 *
 * A string rather than JSX because `ui.ts` builds the pre-authentication shell as HTML text and the React
 * chrome renders too — one geometry, two consumers, and a second copy for the second consumer is how a logo
 * ends up subtly different in two places.
 *
 * `stroke-width` is fixed at 4.6 in user units and scales with the viewBox, so the stroke stays optically
 * even at every size rather than getting spindly when the mark is small — which is the usual failure of a
 * line-drawn logo in a product.
 */
export function markSvg(options: MarkOptions = {}): string {
  const size = options.size ?? 32;
  const stroke = options.stroke ?? "currentColor";
  const dot = options.dot === undefined ? BRAND.blue : options.dot;
  const title = options.title ?? null;
  const height = Math.round((size * 52) / 60);

  return [
    `<svg width="${size}" height="${height}" viewBox="${MARK_VIEWBOX}" fill="none"`,
    ` xmlns="http://www.w3.org/2000/svg"`,
    // `aria-hidden` when there is no title: the lockup's text already says Mailda, and a second
    // announcement of the same word is noise for anybody listening to it.
    title === null ? ` aria-hidden="true"` : ` role="img" aria-label="${title}"`,
    `>`,
    `<path d="${MARK_PATH}" stroke="${stroke}" stroke-width="4.6"`,
    ` stroke-linecap="round" stroke-linejoin="round"/>`,
    `<circle cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}"`,
    ` fill="${dot === null ? stroke : dot}"/>`,
    `</svg>`,
  ].join("");
}

/**
 * The favicon, as a `data:` URI.
 *
 * Inline rather than a file, for the reason the fonts are local: a page whose premise is custody must not
 * fetch anything from anywhere. It also fixes a real defect — with no icon declared every browser asks for
 * `/favicon.ico` and every load logs a 404, so a working Node's console has a permanent error in it and
 * anybody debugging starts with a false lead.
 *
 * **The symbol alone, on a rounded ink tile.** At 16 px the stroke detail is past what the reconstruction
 * can honestly carry, which the header says plainly — a real vector should replace this before anybody
 * treats the icon as final.
 */
export function faviconDataUri(): string {
  /*
   * **The letter, until the artwork is real** (#128). This file's header already said the reconstruction was
   * "not fine for a favicon at 16 px", and this is the favicon — a tab icon is the smallest and least
   * forgiving place a mark appears, and the one where a wrong shape is least recoverable because nobody
   * looks at it closely enough to notice it is wrong, only that the tab is unfamiliar.
   *
   * An M in the display face on the brand's Ink is not the identity, and it does not pretend to be: it is a
   * legible placeholder that reads as *something deliberate* rather than as a smudge. `MARK_IS_AUTHORED`
   * flips both this and the two shells at once.
   */
  if (!MARK_IS_AUTHORED) {
    const letter = [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
      `<rect width="64" height="64" rx="14" fill="${BRAND.ink}"/>`,
      `<text x="32" y="45" text-anchor="middle" fill="${BRAND.white}"`,
      ` font-family="Satoshi, 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif"`,
      ` font-size="42" font-weight="700">M</text>`,
      `<circle cx="47" cy="20" r="5" fill="${BRAND.blue}"/>`,
      `</svg>`,
    ].join("");
    return `data:image/svg+xml,${encodeURIComponent(letter)}`;
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`,
    `<rect width="64" height="64" rx="14" fill="${BRAND.ink}"/>`,
    `<g transform="translate(6 12) scale(0.87)">`,
    `<path d="${MARK_PATH}" stroke="${BRAND.white}" stroke-width="5.2"`,
    ` stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
    `<circle cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="4" fill="${BRAND.blue}"/>`,
    `</g></svg>`,
  ].join("");
  // `encodeURIComponent` rather than base64: it is smaller for SVG, and it leaves the markup legible in
  // the document, which matters when the next person needs to see what the icon actually is.
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
