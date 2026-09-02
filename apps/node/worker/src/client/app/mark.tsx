import { BRAND, MARK_DOT, MARK_PATH, MARK_VIEWBOX } from "../../brand.ts";

/**
 * The Mailda symbol, for the React chrome (#128).
 *
 * ## Why this exists rather than `markSvg()`
 *
 * `brand.ts` builds the mark as an **SVG string**, because `ui.ts` assembles the pre-authentication shell as
 * HTML text. React cannot take that without `dangerouslySetInnerHTML`, and a component is the honest shape
 * here — but the *geometry* still comes from `brand.ts`, which is the whole point. That file says it:
 *
 * > one geometry, two consumers, and a second copy for the second consumer is how a logo ends up subtly
 * > different in two places.
 *
 * So `MARK_PATH`, `MARK_VIEWBOX` and `MARK_DOT` are imported, never restated. Replacing the reconstruction
 * with the designer's vector stays the one edit `brand.ts` promises, and this component follows.
 *
 * ## Decorative by default
 *
 * The rail's lockup is the mark beside the word "Mailda" in real text, so the mark is `aria-hidden` and the
 * accessible name comes from the word — a screen reader that announced both would say the name twice. A
 * caller using the symbol *alone* passes a `title`, and gets an `img` role with that name.
 */
export function Mark({ size = 26, title = null }: { size?: number; title?: string | null }) {
  const height = Math.round((size * 52) / 60);
  return (
    <svg
      width={size}
      height={height}
      viewBox={MARK_VIEWBOX}
      fill="none"
      /*
       * `currentColor`, so the rail's `--rail-text` reaches it and one variant serves both schemes. The dot
       * keeps Flow Blue: the brand sheet publishes a monochrome lockup *and* a full-colour one, and picking
       * between them is a decision rather than a default — see `MarkOptions.dot` in `brand.ts`.
       */
      stroke="currentColor"
      strokeWidth={4.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title === null ? undefined : "img"}
      aria-hidden={title === null ? true : undefined}
      aria-label={title ?? undefined}
    >
      <path d={MARK_PATH} />
      <circle cx={MARK_DOT.cx} cy={MARK_DOT.cy} r={MARK_DOT.r} fill={BRAND.blue} stroke="none" />
    </svg>
  );
}
