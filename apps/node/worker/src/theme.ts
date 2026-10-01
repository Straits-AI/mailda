import type { BodyScript } from "@mailda/contract/schemas";

/**
 * The shell's colour tokens, in both themes, and the two stylesheets built from them.
 *
 * A leaf: this module imports nothing, so a node test can import it and read the palette the Worker serves
 * rather than a copy of it. `test/node/contrast.test.ts` measures every pair it declares; the numbers are
 * pinned in `docs/receipts/contrast-tokens.md`.
 *
 * **Dark is the default because it is the unqualified `:root`.** A page with no `data-theme`, or with
 * `data-theme="dark"`, is dark on every operating system, and no `[data-theme="dark"]` block exists. Light is
 * `:root[data-theme="light"]`, and System is `:root[data-theme="system"]` inside the one
 * `prefers-color-scheme: light` query. Both light selectors are specificity (0,2,0) against `:root`'s (0,1,0),
 * so they win without depending on order. An unqualified `@media (prefers-color-scheme: light) { :root {`
 * would show Light to someone who chose Dark on a light-mode computer, which is why the query only ever wraps
 * the System block. The viewer's choice is set on `<html>` by `src/client/theme.client.js`.
 *
 * The shell (`themeCss()`, the start of `/app/app.css`) and the sandboxed body frame (`frameStylesheet()`,
 * `/app/frame.css`) are told the same three blocks by one private generator, so they cannot disagree on one.
 */

export type TokenName =
  | "bg-app" | "bg-sidebar" | "bg-list" | "bg-reader" | "surface-1" | "surface-2" | "surface-hover" | "surface-active"
  | "border" | "border-soft" | "control-edge"
  | "text-primary" | "text-secondary" | "text-muted"
  | "accent" | "accent-text" | "accent-hover" | "on-accent"
  | "success" | "warning" | "danger";

type Palette = Readonly<Record<TokenName, string>>;

/**
 * Every token in both themes. `Record<TokenName, string>` makes a token missing from either one a compile
 * error. 6-digit `#RRGGBB` only, and solid: a translucent surface is one axe cannot compute contrast on.
 * The values and every adjustment from the design memo are argued in `docs/receipts/contrast-tokens.md`.
 */
export const THEMES: { readonly dark: Palette; readonly light: Palette } = {
  dark: {
    "bg-app": "#0A1118",         // page ground, status bar, pre-auth body
    "bg-sidebar": "#0C141D",
    "bg-list": "#0E1721",
    "bg-reader": "#111A24",      // reader, frame, ledger screens' main area
    "surface-1": "#151F2B",      // fields, popovers, menus, composer
    "surface-2": "#1A2633",      // secondary buttons, selected tab, chips
    "surface-hover": "#1D2A38",
    "surface-active": "#213246", // selected row, current nav row
    "border": "#243241",         // dividers only: never a control's only edge
    "border-soft": "#1B2835",
    "control-edge": "#717E8C",   // a field's or checkbox's edge, 3:1 on every ground (WCAG 1.4.11)
    "text-primary": "#F2F5F7",
    "text-secondary": "#A3AFBD",
    "text-muted": "#8E9BAA",     // the memo's #6F7D8D is 3.10 on surface-active
    "accent": "#78A9FF",         // never text: selection bar, focus ring, unread dot
    "accent-text": "#78A9FF",    // links, readable blue, the primary button's fill
    "accent-hover": "#8EB7FF",
    "on-accent": "#0A1118",      // a label on an accent-text fill: light text on #78A9FF is 2.15
    "success": "#57C785",
    "warning": "#E0A84F",
    "danger": "#E8797F",         // the memo's #E46B72 is 4.13 on surface-active
  },
  light: {
    "bg-app": "#E8ECF1",
    "bg-sidebar": "#EEF1F5",
    "bg-list": "#F7F9FB",
    "bg-reader": "#FFFFFF",
    "surface-1": "#F3F5F8",
    "surface-2": "#ECF0F4",
    "surface-hover": "#E6EBF1",
    "surface-active": "#DCE6F5",
    "border": "#CDD5DF",
    "border-soft": "#E1E6EC",
    "control-edge": "#77818D",
    "text-primary": "#0F1720",
    "text-secondary": "#3F4B5B",
    "text-muted": "#586474",
    "accent": "#4C77B8",
    "accent-text": "#2F5E9E",
    "accent-hover": "#264F87",
    "on-accent": "#FFFFFF",
    "success": "#2F6F4E",
    "warning": "#9A5410",
    "danger": "#A5342A",
  },
};

/** The eight surfaces text can land on. A ninth is a receipt change (stale_when). */
export const GROUNDS: readonly TokenName[] = [
  "bg-app", "bg-sidebar", "bg-list", "bg-reader", "surface-1", "surface-2", "surface-hover", "surface-active",
];

/** Read as text: 4.5:1 on every ground. */
export const TEXT_TOKENS: readonly TokenName[] = [
  "text-primary", "text-secondary", "text-muted", "accent-text", "accent-hover", "success", "warning", "danger",
];

/** Never text: fills, indicators, focus rings, dots, control edges. 3:1 on every ground. */
export const NON_TEXT_TOKENS: readonly TokenName[] = ["accent", "control-edge"];

/** "  --name: #RRGGBB;\n" for every token, in TokenName order. */
export function declarations(theme: Palette): string {
  return Object.entries(theme).map(([name, value]) => `  --${name}: ${value};\n`).join("");
}

/** The shell's properties that are not colours, declared once, in the dark block, since no theme changes them. */
const NON_COLOUR = `  --body: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --track-wordmark: -.02em; --track-hero: -.018em; --track-display: -.01em; --track-caps: .06em; --track-label: .04em;
  --r-button: 7px; --r-input: 8px; --r-card: 10px; --r-chip: 4px;
  --t-hover: 100ms; --t-pop: 120ms; --t-pane: 160ms;
  --sidebar-w: 216px; --list-w: 376px; --reader-min: 520px; --status-h: 28px; --mobile-bar-h: 48px;
  --card-max-h: min(70vh, 640px);
`;

/**
 * The three theme blocks, the only place they are written. `extra` joins the dark block, which is the
 * unqualified `:root` and so the one every page wears whatever it chose.
 */
function themeBlocks(extra: string): string {
  return `:root {
  color-scheme: dark;
${declarations(THEMES.dark)}${extra}}
:root[data-theme="light"] {
  color-scheme: light;
${declarations(THEMES.light)}}
@media (prefers-color-scheme: light) {
  :root[data-theme="system"] {
    color-scheme: light;
${declarations(THEMES.light)}  }
}
`;
}

/**
 * The theme prelude of the shell sheet, exactly: dark on `:root` (plus the non-colour properties), light on
 * `:root[data-theme="light"]`, light on `:root[data-theme="system"]` inside `@media (prefers-color-scheme:
 * light)`. `SHELL_CSS` in `src/shell-css.ts` begins with it.
 */
export function themeCss(): string {
  return themeBlocks(NON_COLOUR);
}

/**
 * The stylesheet served at `/app/frame.css` for the sandboxed body frame: the same three blocks, then rules
 * whose every colour is a `var(--token)`.
 *
 * The sanitiser strips every colour-bearing attribute and all `style`, so mail arrives colourless and this
 * sheet is the whole of its look. The frame's opaque origin cannot see the shell's `<html>`, so the reader
 * writes the viewer's choice on the frame's own root, and the same blocks here make it mean the same thing.
 * No `url()`, no `@import`, no `@font-face`: nothing in the sheet can fetch anything, and a font fetched from
 * the frame's opaque origin would need CORS headers on the fonts. The frame uses the platform's UI sans.
 *
 * Wrapping: `break-word` on the body, not `anywhere`. Both break a token too long for its line, but
 * `anywhere` also lets a table cell shrink to one character, so a 320px reader split "Amount" in an invoice
 * table. Links and code keep `anywhere`, because a tracking URL in a table cell would otherwise widen the
 * table past the frame. A long bare token in a cell (an ID, an unlinked URL) can still do that, and the
 * frame then scrolls sideways; that is rarer than a narrow table of short words, which is most receipts.
 */
/**
 * The Han faces for each script a message can say it is in (`data-script`, `BODY_SCRIPTS` in the contract), named
 * before the UI sans because a system UI face on a Japanese or Chinese system carries Han of its own and would
 * draw it in that system's forms (critic M9). Local faces only, as the rest of this sheet: the Simplified list is
 * the shell's own `:root:lang(zh)` stack (`src/shell-css.ts`), and the Traditional and Japanese lists are each
 * platform's counterpart. A presentation choice with that basis, not a measurement: no frame has been measured.
 *
 * The shell's plain-text body (`.message-text` in `src/shell-css.ts`) draws from the same table, through
 * `scriptFamily`, so a message's Han has one set of forms whether it arrived as HTML or as text.
 */
export const FRAME_SCRIPTS: Readonly<Record<BodyScript, string>> = {
  sc: `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans SC"`,
  tc: `"PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", "Source Han Sans TC", "Noto Sans TC"`,
  jp: `"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "Noto Sans CJK JP", "Source Han Sans JP", "Noto Sans JP"`,
};

/** A script's whole `font-family`: its Han faces, then the UI sans the frame uses for everything else. */
export function scriptFamily(script: BodyScript): string {
  return `${FRAME_SCRIPTS[script]}, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
}

/**
 * The language tags a sender may put on one element of their message, and the script each is drawn in, in source
 * order: `:lang(zh)` also matches `zh-TW`, so the Traditional tags come after it and win at equal specificity, and
 * `:lang(zh-Hant)` does not match `zh-TW`, so the region tags are named too. Only on an element that carries `lang`
 * (`[lang]`), so a `<pre>` or `<code>` inside keeps its monospace by its own rule. The frame's `data-script` is the
 * whole message's; a sender's `<p lang="ja">` inside a GB2312 message is that paragraph's, and it wins there.
 */
const LANG_SCRIPTS: ReadonlyArray<readonly [BodyScript, readonly string[]]> = [
  ["sc", ["zh", "zh-Hans", "zh-CN", "zh-SG"]],
  ["tc", ["zh-Hant", "zh-TW", "zh-HK", "zh-MO"]],
  ["jp", ["ja"]],
];

export function frameStylesheet(): string {
  return themeBlocks("") + `html { background: var(--bg-reader); color: var(--text-primary); }
body { margin: 0; padding: 0 2px 24px; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow-wrap: break-word; }
a { color: var(--accent-text); overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
table { max-width: 100%; border-collapse: collapse; }
td, th { padding: 2px 6px; vertical-align: top; text-align: left; }
blockquote { margin: 8px 0; padding-left: 12px; border-left: 2px solid var(--border); color: var(--text-secondary); }
pre, code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
hr { border: 0; border-top: 1px solid var(--border); }
${(Object.keys(FRAME_SCRIPTS) as BodyScript[]).map((script) => `html[data-script="${script}"] body { font-family: ${scriptFamily(script)}; }`).join("\n")}
${LANG_SCRIPTS.map(([script, tags]) => `${tags.map((tag) => `[lang]:lang(${tag})`).join(", ")} { font-family: ${scriptFamily(script)}; }`).join("\n")}
`;
}
