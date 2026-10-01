import type { BodyScript } from "@mailda/contract/schemas";

import { FRAME_SCRIPTS, scriptFamily, themeCss } from "./theme.ts";

/**
 * The whole stylesheet, served at `/app/app.css` rather than written into the document (#97).
 *
 * It was a `<style>` element in the head, and there was nothing wrong with that until the Node acquired a
 * Content-Security-Policy. `style-src 'self'` refuses an inline stylesheet, and the two ways to keep one
 * are `'unsafe-inline'` — which makes the directive decorative — and a per-response nonce, which means the
 * policy and the document have to agree on a random value on every response forever. Serving the bytes
 * from this origin needs neither: the CSS is the same for every viewer, so it is a file, and saying so
 * costs one request that is then cached. `src/ui.ts` serves it.
 *
 * ## Why a module of its own
 *
 * It imports only `./theme.ts`, so a node test can import `SHELL_CSS` and read the artifact the Worker serves
 * rather than the wording of a file (AGENTS.md §2c). `ui.ts` cannot be imported in node: it imports the
 * browser scripts as text.
 *
 * ## What it looks like, and why
 *
 * Dark by default, Light and System by the viewer's choice (`src/theme.ts` holds the tokens, the three theme
 * blocks and the argument for their shape). Background hierarchy rather than lines: the reader is the
 * brightest ground in either theme and interactive surfaces step toward the text colour, so the few lines
 * kept are the pane edges. Every surface is a solid token, never a translucent mix or a gradient, because
 * axe cannot compute contrast over a colour it cannot resolve, and that is what left twelve screens unproven.
 * A selected thing carries a 2px `--accent` indicator as well as a fill: the fills are 1.1 to 1.4:1 against
 * their ground and cannot carry state alone (`docs/receipts/contrast-tokens.md`). One face (Inter, 400 to
 * 700, from this origin), sentence case everywhere but the sidebar's group labels, and a system monospace
 * only where the text is a diagnostic.
 *
 * ## Two hazards of CSS in a template literal
 *
 * A backtick in a comment ends the literal, and a stray comment terminator silently discards the rule after
 * it. `test/node/stylesheet-hazards.test.ts` reads the `RULES` literal by name and fails on either. A `${`
 * would start an interpolation; the compiler catches that one.
 */
const RULES = `
/* The four weights of the one face this Node serves, from its own origin (fonts/README.md).
   font-display: swap on purpose: the alternative is a page that shows nothing until 97 KB has arrived,
   and on a Node whose whole job is showing somebody their mail, text that arrives in a fallback and then
   settles is better than text that is briefly absent. */
@font-face {
  font-family: Inter;
  src: url("/app/fonts/inter-400.woff2") format("woff2");
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: Inter;
  src: url("/app/fonts/inter-500.woff2") format("woff2");
  font-weight: 500; font-style: normal; font-display: swap;
}
@font-face {
  font-family: Inter;
  src: url("/app/fonts/inter-600.woff2") format("woff2");
  font-weight: 600; font-style: normal; font-display: swap;
}
@font-face {
  font-family: Inter;
  src: url("/app/fonts/inter-700.woff2") format("woff2");
  font-weight: 700; font-style: normal; font-display: swap;
}

/* ---- Simplified Chinese (ADR 30 as amended, ADR 46) --------------------------------------
   No CJK webfont: four weights of an SC face are about 9.7 MB, and every platform this interface targets
   already has one. The stack names them after Inter and before system-ui, so Latin letters stay Inter and Han gets a
   real Simplified face in real weights; left to system-ui, Linux Chromium drew Japanese glyph forms and a
   faux bold. :lang(zh) matches zh-Hans, which bootLocale puts on the html element. Tracking is zeroed,
   because letter-spacing breaks the even grid Han is set on. The rail labels move from 11px to 12px, a size
   already on the scale, since their strokes are what 11px loses first; and the group toggle, set solid at
   11px/1, gets a line-height of 1.3 so a Han face's taller glyphs are not clipped. Presentation values with
   that basis, not measurements.
   The stack starts with "Inter Latin": Inter's own four files again, so no byte is added, with a unicode-range
   that leaves out the punctuation Chinese shares with Latin (U+00B7, U+2014, U+2018-2019, U+201C-201D, U+2026).
   Inter has those glyphs, so under its plain name a quote, dash or ellipsis inside a Chinese sentence would be set
   narrow and on the Latin baseline; left out, they fall through to the SC face with the Han around them. */
@font-face {
  font-family: "Inter Latin";
  src: url("/app/fonts/inter-400.woff2") format("woff2");
  font-weight: 400; font-style: normal; font-display: swap;
  unicode-range: U+0000-00B6, U+00B8-2013, U+2015-2017, U+201A-201B, U+201E-2025, U+2027-FFFF;
}
@font-face {
  font-family: "Inter Latin";
  src: url("/app/fonts/inter-500.woff2") format("woff2");
  font-weight: 500; font-style: normal; font-display: swap;
  unicode-range: U+0000-00B6, U+00B8-2013, U+2015-2017, U+201A-201B, U+201E-2025, U+2027-FFFF;
}
@font-face {
  font-family: "Inter Latin";
  src: url("/app/fonts/inter-600.woff2") format("woff2");
  font-weight: 600; font-style: normal; font-display: swap;
  unicode-range: U+0000-00B6, U+00B8-2013, U+2015-2017, U+201A-201B, U+201E-2025, U+2027-FFFF;
}
@font-face {
  font-family: "Inter Latin";
  src: url("/app/fonts/inter-700.woff2") format("woff2");
  font-weight: 700; font-style: normal; font-display: swap;
  unicode-range: U+0000-00B6, U+00B8-2013, U+2015-2017, U+201A-201B, U+201E-2025, U+2027-FFFF;
}
:root:lang(zh) {
  --body: "Inter Latin", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans SC", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans SC", monospace;
  --track-wordmark: 0; --track-hero: 0; --track-display: 0; --track-caps: 0; --track-label: 0;
}
:root:lang(zh) .rail-heading { font-size: 12px; }
:root:lang(zh) .rail-group-toggle { font-size: 12px; line-height: 1.3; }
/* A column header is a word. Han may break between any two characters, so a narrow column (the Queue's Response,
   over a dash) stacked 响应 one character per line at 1440; keep-all breaks a Han run only where a space is. */
:root:lang(zh) thead th { word-break: keep-all; }
/* A control in a cell is a word as well: at 390 a rule's 发布 stacked one character per line and a pause's 恢复发信
   four, where the English (one unbreakable word) kept its column wide enough to read. */
:root:lang(zh) td button, :root:lang(zh) td a { word-break: keep-all; }
/* Prose in a cell still breaks per character, so at 390 the cell shrank to one: Rules' 作用, a Butler's 有未发布的修改,
   Limits' 已启用 (the owner's round three, G16). Four Han characters is a presentation constant: the shortest of those
   words reads on one line, and a sentence wraps inside the column rather than down a single character's width. */
:root:lang(zh) td { min-width: 4em; }

/* ---- base ------------------------------------------------------------------------------- */

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

/* No gradient and no grain. Both were decoration, and the gradient was also the reason axe moved thirteen of
   fourteen text nodes into incomplete: it will not guess a background it cannot resolve to one colour. */
body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg-app);
  color: var(--text-primary);
  font: 400 14px/1.45 var(--body);
}

/* One focus ring for everything, in the one token that clears 3:1 on every ground in both themes. No rule in
   this sheet sets outline: 0 on a focusable thing without drawing the ring somewhere else. */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

a {
  color: var(--accent-text);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
a:hover { color: var(--accent-hover); }

h2 { font: 600 15px/1.35 var(--body); margin: 0 0 8px; }
h3 { font: 600 14px/1.4 var(--body); margin: 0 0 6px; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { font: 600 12px/1.4 var(--body); color: var(--text-secondary); padding: 0; }
dialog { color: var(--text-primary); }

/* Text for a screen reader and not for the eye. clip-path rather than display: none, which would take it
   out of the accessibility tree along with the layout. .sr-only is the same thing under the other common
   name, which agents.tsx uses; it had no rule, so its "Withdraw" label was visible. */
.visually-hidden, .sr-only {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* Figures in the one family: tabular digits keep a column of costs aligned, and weight 500 marks an id, a
   hash or an address as something to copy rather than read. Not a monospace, which is reserved below. */
.mono, .num, .state, td { font-variant-numeric: tabular-nums; }
.mono { font-weight: 500; }

/* Monospace is for diagnostics only: code, raw headers, a Butler's source and the checker's findings. */
code, pre, kbd, samp, .headers-text, .butler-source, .butler-findings { font-family: var(--mono); }
kbd {
  font-size: 12px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-2);
}

/* The two tone classes every screen uses: explanation, and a failed thing. */
.dim { color: var(--text-secondary); }
.bad { color: var(--danger); }

/* ---- controls (WCAG 1.4.11) ------------------------------------------------------------- */

/* A field's edge is what identifies it, so it is --control-edge (3:1 on every ground) and never --border or
   --border-soft, which are 1.00 to 1.48:1. :where() keeps the checkbox exclusion from raising the rule's
   specificity, so a field inside a container (the search pill, the palette) can restyle itself with a class. */
input:where(:not([type="checkbox"]):not([type="radio"])), select, textarea {
  font: 400 14px/1.4 var(--body);
  color: var(--text-primary);
  background: var(--surface-1);
  border: 1px solid var(--control-edge);
  border-radius: var(--r-input);
  min-height: 32px;
  padding: 5px 10px;
  transition: border-color var(--t-hover) ease-out;
}
input:where(:not([type="checkbox"]):not([type="radio"])) { width: 100%; }
select { width: auto; max-width: 100%; }
textarea { width: 100%; line-height: 1.5; padding: 8px 10px; resize: vertical; }
input:where(:not([type="checkbox"]):not([type="radio"])):focus, select:focus, textarea:focus { border-color: var(--accent); }
input::placeholder, textarea::placeholder { color: var(--text-muted); opacity: 1; }
input[type="checkbox"], input[type="radio"] {
  width: 16px; height: 16px; flex: none; margin: 2px 0 0;
  accent-color: var(--accent);
}
/* The native file control, restyled rather than hidden behind a label: it keeps its own focus ring, keyboard
   and accessible name. Its button wears the .btn look; the chosen files are listed under it. */
input[type="file"] { min-height: 30px; padding: 0; border: 0; background: transparent; font-size: 12px; color: var(--text-secondary); }
input[type="file"]::file-selector-button {
  height: 30px;
  margin-right: 10px;
  padding: 0 12px;
  font: 500 14px/1 var(--body);
  color: var(--text-primary);
  background: var(--surface-2);
  border: 0;
  border-radius: var(--r-button);
  cursor: pointer;
}
input[type="file"]:not(:disabled)::file-selector-button:hover { background: var(--surface-hover); }
/* And .btn's disabled look, since the colours above override the browser's own greying of a disabled control. */
input[type="file"]:disabled { cursor: not-allowed; }
input[type="file"]:disabled::file-selector-button { opacity: .55; cursor: not-allowed; }

/* The primary act. Its label is --on-accent: light text on the dark theme's #78A9FF is 2.15:1, so the dark
   theme puts dark text on it and the light theme white (contrast.test.ts pins both pairs). a.primary too: a
   page whose one next step is a link is owed the same control as one whose step is a form. */
button.primary, a.primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 14px;
  font: 600 14px/1 var(--body);
  color: var(--on-accent);
  background: var(--accent-text);
  border: 0;
  border-radius: var(--r-button);
  text-decoration: none;
  cursor: pointer;
  justify-self: start;
}
button.primary:hover:not(:disabled), a.primary:hover { background: var(--accent-hover); color: var(--on-accent); }
button.primary:disabled { opacity: .55; cursor: not-allowed; }

/* The secondary act. A fill, not an edge: a button is identified by its text or its icon, and a fill that
   steps toward the text colour says "pressable" without a line. .quiet is the same control under the name
   nine ledger screens already use. */
.btn, button.quiet {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  font: 500 14px/1 var(--body);
  color: var(--text-primary);
  background: var(--surface-2);
  border: 0;
  border-radius: var(--r-button);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
.btn:hover:not(:disabled), button.quiet:hover:not(:disabled) { background: var(--surface-hover); color: var(--text-primary); }
.btn:disabled, button.quiet:disabled { opacity: .55; cursor: not-allowed; }
.btn-icon { min-width: 30px; padding: 0 7px; }
.btn-ghost { background: transparent; }
.btn > svg, .chip-action > svg, button.primary > svg { flex: none; }

/* A link-shaped button. Underlined wherever it sits, because hue alone is about 1.1:1 in luminance against
   the secondary text around it (WCAG 1.4.1).

   WCAG 2.2 AA 2.5.8 (target size, minimum): a pointer target must be at least 24x24 CSS pixels. These are
   text-sized buttons, so the width was never the problem and the height always was. Found on the sign-in
   screen, which had never been audited: "I have an invitation" measured 134.9 x 18.4. inline-flex with a
   min-height rather than vertical padding, so the underline stays with the text. */
.linkish {
  font: inherit;
  letter-spacing: inherit;
  color: var(--accent-text);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
}
button.linkish { display: inline-flex; align-items: center; min-height: 24px; }
.linkish:hover { color: var(--accent-hover); }
.linkish:disabled { opacity: .55; cursor: not-allowed; }

/* A small action that reads as a chip: "Add label", and the Next steps. The same fill as .btn and no AI
   styling, because nothing here is a suggestion from a model. */
.chip-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  font: 500 14px/1 var(--body);
  color: var(--text-primary);
  background: var(--surface-2);
  border: 0;
  border-radius: var(--r-button);
  cursor: pointer;
}
.chip-action:hover:not(:disabled) { background: var(--surface-hover); }
.chip-action:disabled { opacity: .55; cursor: not-allowed; }

/* ---- the pre-authentication page (claim, sign-in, recovery codes, join) ---------------------- */

/* Styled by the same tokens as the shell and nothing else. The rack is solid now: it was translucent with a
   backdrop blur, which is glass, and a surface axe cannot resolve. */
.rack {
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-app);
  position: sticky;
  top: 0;
  z-index: 8;
}
.rack-inner {
  max-width: 74rem;
  margin-inline: auto;
  padding: .7rem clamp(1rem, 4vw, 2.5rem);
  display: flex;
  align-items: center;
  gap: clamp(.9rem, 3vw, 2rem);
  flex-wrap: wrap;
}

/* The lockup: symbol then word, per the brand sheet's primary logo. One word, initial capital, the symbol
   carrying the colour. The mark's stroke inherits; its dot keeps Flow Blue, set in the SVG itself. */
.wordmark {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font: 700 18px/1.2 var(--body);
  letter-spacing: var(--track-wordmark);
  white-space: nowrap;
  color: var(--text-primary);
}
.wordmark svg { flex: none; }

/* The status strip: this host and the session's countdown. Its figures are diagnostics, so they are the one
   place outside code the monospace appears. */
#status {
  display: flex;
  align-items: center;
  gap: clamp(.8rem, 2.5vw, 1.75rem);
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: auto;
}
#status .field { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
#status .mono { font-family: var(--mono); font-weight: 400; color: var(--text-primary); }
#status .session { color: var(--accent-text); }

/* A state dot. The word beside it carries the state; the colour repeats it. No pulse: an infinite animation
   is a loop, and this interface has none. */
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dot.live { background: var(--success); }
.dot.idle { background: var(--text-muted); }

main {
  max-width: 74rem;
  margin-inline: auto;
  padding: clamp(2.5rem, 7vw, 5rem) clamp(1rem, 4vw, 2.5rem) 6rem;
}

[data-reveal] {
  animation: rise .5s cubic-bezier(.2, .7, .3, 1) both;
  animation-delay: var(--reveal-delay, 0ms);
}
@keyframes rise { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }

/* The pre-authentication hero heading. The shell's page titles are .ledger-head h1 and .list-title. */
h1 {
  font: 700 clamp(1.9rem, 4.6vw, 3rem)/1.1 var(--body);
  letter-spacing: var(--track-hero);
  margin: 0 0 1rem;
  max-width: 30ch;
  text-wrap: balance;
}

/* Asymmetric, and offset rather than centred: the claim sits left at reading width, the form sits right in
   its own panel. The pre-authentication pages alone use .split now. The React list and reader had a .split
   of their own later in the sheet, equal in specificity, so it won everywhere and this layout had not been
   rendering (measured at 1280px: 352px and 752px columns, no gap). The panes are .mail-panes now. */
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr);
  gap: clamp(2rem, 6vw, 5rem);
  align-items: start;
}
.split-lede { padding-top: .4rem; }
.split-lede p { color: var(--text-secondary); max-width: 42ch; font-size: 16px; }
@media (max-width: 54rem) {
  .split { grid-template-columns: 1fr; }
  .split-lede p { max-width: none; }
}

.panel {
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface-1);
  padding: clamp(1.4rem, 3vw, 2rem);
}
.panel h2 { font: 600 14px/1.3 var(--body); color: var(--text-secondary); margin: 0 0 1.4rem; }
.sub { color: var(--text-secondary); margin: -1rem 0 1.4rem; }

form { display: grid; gap: 1rem; }

/* A field and its label, one above the other. */
.field-row { display: grid; gap: 4px; }
.field-row > span { font: 500 12px/1.4 var(--body); color: var(--text-secondary); }
/* A grid item stretches, so a button in a field row was a bar across the column (People's Rename), and so was the
   Mailbox picker after an address. */
.field-row > button, .field-row > .address-field + select { justify-self: start; }
/* The 4px above is a caption's distance from its field. A second control after the field (Add the address, Rename,
   Create, the Mailbox picker, the Cc / Bcc link) stood at that distance too and read as stuck to it, so it takes 4px
   more: 8px, the gap every row of controls in this sheet keeps. The field rows laid out as flex (Setup's catch-all)
   hold one control each, so this never fires in a row. test/node/control-spacing.test.ts holds the sum. */
.field-row > :is(input, select, textarea, .address-field) + :is(input, select, textarea, button, .btn, .address-field) { margin-top: 4px; }
/* An address typed as its local part, the domain fixed or picked beside it (People): one grid item, wrapping on a phone.
   8px across and down, like any two controls. At 4px the @ sat inside the focus ring: the sheet's ring is drawn
   2px out from a control and 2px wide, so a focused local-part field's ring touched it (29 September 2026). */
.address-field { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
/* It is a span in a field row, whose spans are its 12px captions; the suffix reads at the input's own size. */
.field-row > .address-field { font: 400 14px/1.4 var(--body); color: var(--text-primary); }
.address-field > input { flex: 0 1 14rem; min-width: 8rem; }
.address-domain { color: var(--text-secondary); overflow-wrap: anywhere; }
/* The @ and the domain picker, one item, so they wrap together on a phone rather than leaving the @ behind; 8px
   apart for the same ring, the picker's this time. */
.address-pick { display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; }
/* Beats .field-row select's 18rem, so the pair fits beside a short local part. */
.field-row .address-pick > select { min-width: 0; }

.hint { font-size: 12px; line-height: 1.5; color: var(--text-secondary); margin: 6px 0 0; }
/* A hint that reports a limit already crossed: two classes, so the danger tone beats .hint's own colour. */
.hint.bad { color: var(--danger); }
/* Pulled up to hug the field it explains, inside a form only. Outside a form the same negative margin
   dragged the sign-in page's "I have an invitation" up over the Sign in button. */
form > .hint { margin: -.6rem 0 0; }

.notice {
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  border-left: 2px solid var(--border);
  padding: 6px 12px;
  margin: 0 0 8px;
  color: var(--text-secondary);
}
.notice.bad { border-left-color: var(--danger); color: var(--text-primary); }
.errors:empty { display: none; }

/* The ten recovery codes (#134). Spaced and numbered, because they are read off a screen and typed
   somewhere else, and a dense block is where a transcription error hides. Each item selects whole, so one
   click takes a complete code rather than part of one. */
.codes { margin: 0 0 1rem; padding-left: 1.9rem; display: grid; gap: .34rem; }
.codes li { font-size: 14px; letter-spacing: .02em; user-select: all; }
/* The same codes minted again from the recovery ledger: set on a surface of their own, because they are the
   one thing on that screen that must leave it. */
.codes-sheet { max-width: 46rem; margin: 12px 0; padding: 16px; background: var(--surface-1); border-radius: var(--r-card); }

/* ---- the handover to the shell ------------------------------------------------------------ */

/* body.shell is set by app.client.js the moment the React application mounts, and it is what retires the
   pre-authentication chrome rather than leaving two of everything on the page. */
body.shell .rack { display: none; }
body.shell main#app { max-width: none; margin: 0; padding: 0; }

/* ---- the application grid ---------------------------------------------------------------- */

/* A sidebar, a main column, and the status bar. Grid rather than flex so the bar is pinned to the bottom
   without position: fixed, which would overlap the last row of a ledger. The grid is the viewport and the
   panes scroll inside it, so nothing scrolls the page. */
.app-shell {
  display: grid;
  grid-template-rows: minmax(0, 1fr) var(--status-h);
  height: 100dvh;
  overflow: hidden;
}
.app-shell[data-layout="wide"] { grid-template-columns: var(--sidebar-w) minmax(0, 1fr); }
/* Narrow has one column, not an empty sidebar column: the sidebar is the drawer there. */
.app-shell[data-layout="narrow"] { grid-template-columns: minmax(0, 1fr); }
.app-shell > .rail { grid-row: 1; grid-column: 1; }
.app-shell > .status-bar { grid-row: 2; grid-column: 1 / -1; }

/* The last column at either width. The ledger screens scroll in it; the mail screens hand the scrolling to
   their panes. --pad-top and --pad-x are the column's padding, named so the bands can cancel exactly it. */
.app-main {
  --pad-top: 28px;
  --pad-x: 40px;
  grid-row: 1;
  grid-column: -2 / -1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--pad-top) var(--pad-x) 48px;
  background: var(--bg-reader);
}
/* A column of bands above the panes, and the panes take the rest. */
.app-main.mail { --pad-top: 0px; --pad-x: 0px; display: flex; flex-direction: column; overflow: hidden; padding: 0; }

/* The bands: SetupUnfinished, and the notices blueprint 7 requires (#63 part B). They span the column, so
   they cancel its padding, and the content after the last one starts a padding below it. Named by their own
   classes: a screen whose root is a fragment puts its own p.notice[role=status] straight into .app-main too.

   The notices are deliberately not dismissible -- there is no control here because there is no endpoint
   behind one, and blueprint 7 requires the notification not be disableable by the investigator. Bounded, so
   fifty of them can never squeeze the panes to nothing, and the region is focusable (chrome.tsx gives it
   tabindex 0) so a keyboard can scroll it. */
.app-main > .setup-unfinished, .app-main > .notices {
  flex: none;
  margin: calc(-1 * var(--pad-top)) calc(-1 * var(--pad-x)) var(--pad-top);
  /* The text starts where the column's content does: the page title at --pad-x, the mail list's title at
     16px (its pane's inset, where --pad-x is 0). */
  padding: 8px max(16px, var(--pad-x));
  font-size: 14px;
  color: var(--text-primary);
  background: var(--surface-1);
  border: 0;
  border-bottom: 1px solid var(--border-soft);
}
.notices { display: grid; gap: 6px; max-height: min(30vh, 240px); overflow-y: auto; }
/* Inset: the band spans the column edge to edge and .app-main clips, so an outside ring was cut off. */
.notices:focus-visible { outline-offset: -2px; }
.notices > .notice { margin: 0; padding: 2px 0 2px 10px; }
.notice.told { border-left: 2px solid var(--warning); color: var(--text-primary); }
/* A warning the author may act past: a file the Node will send because they said so. The warning hue as an edge only. */
.notice.warn { border-left-color: var(--warning); color: var(--text-primary); }
.notice .told-meta { color: var(--text-secondary); }

/* ---- the sidebar ------------------------------------------------------------------------- */

/* The same ground in both themes' terms (--bg-sidebar), so every colour on it is one the contrast matrix
   measured against it. It used to be an Ink island inside a light page, with seven tokens of its own. */
.rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 10px 10px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-soft);
}
/* The rail scrolls; its children never shrink to fit. Flex items shrink by default, and with Admin open at
   1280x720 that squeezed the Admin toggle from 24px to 16px (WCAG 2.5.8) and Compose from 36px to 32px. */
.rail > * { flex-shrink: 0; }
.rail .wordmark { font-size: 15px; font-weight: 600; letter-spacing: var(--track-display); padding: 2px 8px 12px; }
.rail .wordmark svg { width: 20px; height: 20px; }
.compose-button { width: 100%; height: 36px; margin: 0 0 14px; }
.compose-button.compact { width: 36px; height: 36px; padding: 0; margin: 0; flex: none; }

/* The group labels are the one uppercase text in the interface. */
.rail-heading {
  font: 600 11px/1.3 var(--body);
  letter-spacing: var(--track-caps);
  text-transform: uppercase;
  color: var(--text-muted);
  margin: 16px 10px 4px;
}
.rail-group-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
  margin: 12px 0 0;
  padding: 0 8px 0 10px;
  font: 600 11px/1 var(--body);
  letter-spacing: var(--track-caps);
  text-transform: uppercase;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: var(--r-button);
  cursor: pointer;
}
.rail-group-toggle:hover { color: var(--text-secondary); }
/* One column no wider than the rail. An implicit auto track took the rows' min-content (a nowrap name and
   its count), so a long mailbox name widened the row past the rail instead of ending in an ellipsis. */
.rail-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; }
.rail-foot { margin-top: auto; padding-top: 12px; }
.rail-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 8px 0 10px;
  border-radius: var(--r-button);
  font: 500 14px/1 var(--body);
  color: var(--text-secondary);
  text-decoration: none;
}
.rail-row > svg { flex: none; color: var(--text-muted); }
.rail-row:hover { background: var(--surface-hover); color: var(--text-primary); }
/* The current row: the fill is 1.38:1 against the sidebar and cannot carry the state, so the inset 2px accent
   bar does (5.54:1 dark, 3.60:1 light), with the aria-current the link carries. */
.rail-row.current { background: var(--surface-active); color: var(--text-primary); box-shadow: inset 2px 0 0 var(--accent); }
.rail-row.current > svg { color: var(--text-primary); }
.rail-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-row .num { flex: none; margin-left: auto; white-space: nowrap; font: 500 12px/1 var(--body); font-variant-numeric: tabular-nums; color: var(--text-muted); }
.rail-mine { font-size: 12px; color: var(--success); white-space: nowrap; }
.rail-note { margin: 2px 10px; }

/* ---- the status bar ---------------------------------------------------------------------- */

.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-app);
  border-top: 1px solid var(--border-soft);
}
.connection { display: inline-flex; align-items: center; gap: 6px; }
.dot-connected { background: var(--success); }
.dot-offline, .dot-unreachable { background: var(--danger); }
.dot-checking { background: var(--text-muted); }
.health-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  font: 400 12px/1 var(--body);
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--r-button);
  cursor: pointer;
}
.health-button:hover { background: var(--surface-hover); color: var(--text-primary); }
/* Inset, as the rows and menu items: 2.5px above the viewport's bottom edge an outside ring was clipped. */
.health-button:focus-visible { outline-offset: -2px; }
.health-button .state { height: auto; padding: 0; border: 0; font-size: 12px; }

/* ---- popovers and menus ------------------------------------------------------------------ */

/* React state and a conditional render, not the Popover API (D7). The caller wraps the anchor and the popover
   in .popover-wrap and says which way it prefers to open; useInside (ui/popover.tsx) takes the other side as it
   opens when that one would be clipped. */
.popover-wrap { position: relative; display: inline-flex; }
.popover, .menu {
  position: absolute;
  z-index: 40;
  max-width: calc(100vw - 16px);
  /* Its own size, not the anchor's: the health popover opens from the 12px status bar. */
  font-size: 14px;
  color: var(--text-primary);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  box-shadow: 0 8px 24px rgb(0 0 0 / .35);
  text-align: left;
}
.popover { padding: 12px; }
/* Focused by script when it has no field to focus (Popover); the popover itself is the visible thing. */
.popover:focus { outline: none; }
.popover-up { bottom: calc(100% + 6px); }
.popover-down { top: calc(100% + 6px); }
.popover-start { left: 0; }
.popover-end { right: 0; }
.popover form { gap: 10px; }
/* form > .hint's pull is sized for a form's 1rem gap; against this 10px one it left the hint under the field's
   focus ring. -4px keeps it close to its field and 6px clear, past the ring's 2px offset and 2px width. */
.popover form > .hint { margin-top: -4px; }
.popover label { display: grid; gap: 4px; font-size: 12px; color: var(--text-secondary); }

.menu { min-width: 220px; padding: 4px; display: grid; }
.menu-item {
  display: block;
  width: 100%;
  min-height: 32px;
  padding: 6px 10px;
  font: 400 14px/1.4 var(--body);
  color: var(--text-primary);
  text-align: left;
  text-decoration: none;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.menu-item:hover, .menu-item:focus-visible { background: var(--surface-hover); color: var(--text-primary); }
.menu-item:focus-visible { outline-offset: -2px; }
.menu-item:disabled { opacity: .55; cursor: not-allowed; }
.menu-note { display: block; font-size: 12px; color: var(--text-muted); }
.menu-sep { border: 0; border-top: 1px solid var(--border-soft); margin: 4px 0; }

.health-popover { width: 340px; }
.health-title { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; font: 600 14px/1.3 var(--body); }
.health-rows { list-style: none; margin: 0; padding: 0; }
.health-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  column-gap: 12px;
  min-height: 28px;
  font-size: 14px;
}
.health-area { color: var(--text-primary); }
.health-row .state { height: auto; padding: 0; border: 0; margin-left: auto; font-size: 12px; }
.health-absent { margin-left: auto; font-size: 12px; color: var(--text-muted); }
.health-note, .health-meta { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); }
.health-meta { border-top: 1px solid var(--border-soft); padding-top: 8px; margin-top: 8px; }
.health-open { display: inline-block; margin-top: 6px; }

/* ---- dialogs ------------------------------------------------------------------------------ */

/* Every dialog is rendered only while open and shown with showModal(), so the page behind is inert. No rule
   here sets display on a dialog: that would override the browser's hiding of a closed one. */
dialog.compose-chooser, dialog.headers-dialog, dialog.palette {
  color: var(--text-primary);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  box-shadow: 0 8px 24px rgb(0 0 0 / .35);
}
dialog.compose-chooser::backdrop, dialog.headers-dialog::backdrop, dialog.palette::backdrop { background: rgb(0 0 0 / .5); }
dialog.compose-chooser { width: min(320px, 100vw - 32px); padding: 16px; }
.compose-chooser form { gap: 6px; }
.compose-chooser label { font-size: 12px; color: var(--text-secondary); }
.compose-chooser select { width: 100%; min-height: 34px; }
.compose-chooser .row-actions { justify-content: flex-end; margin: 10px 0 0; }

dialog.headers-dialog { width: min(760px, 100vw - 32px); max-height: 80vh; padding: 16px; }
.headers-dialog > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 0 8px; }
.headers-dialog h2 { margin: 0; font-size: 14px; }
.headers-note { margin: 0 0 8px; font-size: 12px; color: var(--text-secondary); }
.headers-text {
  margin: 0;
  max-height: calc(80vh - 120px);
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  /* The pre's own white-space: pre. A soft-wrapped remainder started flush left, where only a new field starts (a
     folded line keeps its leading whitespace), so the block scrolls sideways instead: it is a region in the Tab
     order (reader.tsx), and a keyboard scrolls it. */
}

dialog.palette { margin: 15vh auto auto; width: min(560px, 100vw - 32px); padding: 0; }
.palette-input {
  display: block;
  width: 100%;
  height: 46px;
  padding: 0 16px;
  font: 400 15px/1 var(--body);
  color: var(--text-primary);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--control-edge);
  border-radius: 0;
}
.palette-input:focus-visible { outline-offset: -2px; }
.palette-list { list-style: none; margin: 0; max-height: 320px; overflow-y: auto; padding: 6px; }
.palette-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 34px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
.palette-option[aria-selected="true"] { background: var(--surface-active); box-shadow: inset 2px 0 0 var(--accent); }
.palette-option:hover { background: var(--surface-hover); }
.palette-group { flex: none; font-size: 12px; color: var(--text-muted); }
.palette-hint { flex: none; margin-left: auto; }

/* The narrow layout's sidebar: a modal dialog, in the DOM only while open, so a closed drawer puts no
   off-screen link in the tab order. */
dialog.drawer {
  margin: 0;
  inset: 0 auto 0 0;
  width: 280px;
  max-width: none;
  height: 100dvh;
  max-height: none;
  padding: 0;
  border: 0;
  background: var(--bg-sidebar);
}
dialog.drawer::backdrop { background: rgb(0 0 0 / .45); }
.drawer > .rail { height: 100%; border-right: 0; }
/* Last in the drawer's DOM, so focus still opens on the first link; drawn at the top right. */
.drawer-close { position: absolute; top: 10px; right: 10px; }

/* The narrow layout's top bar: the menu button, the screen's name, and Compose. */
.mobile-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--mobile-bar-h);
  padding: 0 8px;
  margin: calc(-1 * var(--pad-top)) calc(-1 * var(--pad-x)) var(--pad-top);
  flex: none;
  /* Sticky offsets are measured from the scroll container's padding edge, so the bar that cancels the
     padding sticks at minus that padding: at the column's very top. */
  position: sticky;
  top: calc(-1 * var(--pad-top));
  z-index: 20;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-soft);
}
.menu-button { background: transparent; }
.mobile-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 14px/1 var(--body); }

/* ---- toasts ------------------------------------------------------------------------------- */

/* Above the status bar, centred. The two live regions inside are always in the DOM, empty when idle. */
.toast-region {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--status-h) + 16px);
  z-index: 50;
  display: grid;
  gap: 8px;
  max-width: calc(100vw - 32px);
}
/* While the composer is docked it covers the reader column, never the list, so the toast moves over the list:
   centred, it sat on Seal and send, took the click meant for it, and hid it from focus (WCAG 2.4.11). The
   action toast is not shortened instead: an Undo that times out is out of reach (2.2.1). */
body:has(.composer-dock) .toast-region {
  left: calc(var(--sidebar-w) + 16px);
  transform: none;
  max-width: calc(var(--list-w) - 32px);
}
.toast {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  font-size: 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  box-shadow: 0 8px 24px rgb(0 0 0 / .35);
}
.toast-text { color: var(--text-primary); }
.toast-action {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0;
  font: 600 14px/1 var(--body);
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;
  background: none;
  border: 0;
  cursor: pointer;
}
.toast-dismiss {
  width: 24px;
  height: 24px;
  padding: 0;
  font: 400 15px/1 var(--body);
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.toast-dismiss:hover { background: var(--surface-hover); color: var(--text-primary); }

/* ---- section tabs (Automations: Butlers and Rules) --------------------------------------------- */

.section-tabs { display: flex; gap: 4px; margin: 0 0 18px; }
.section-tab {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-button);
  font: 500 14px/1 var(--body);
  color: var(--text-secondary);
  text-decoration: none;
}
.section-tab:hover { background: var(--surface-hover); color: var(--text-primary); }
.section-tab.current { background: var(--surface-2); color: var(--text-primary); box-shadow: inset 0 -2px 0 var(--accent); }

/* ---- the mail panes: list and reader ------------------------------------------------------- */

.mail-panes {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--list-w) minmax(var(--reader-min), 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.list-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--bg-list);
  border-right: 1px solid var(--border-soft);
}
.list-head { display: flex; align-items: baseline; gap: 8px; padding: 18px 16px 10px; }
.list-title { margin: 0; font: 600 26px/1.2 var(--body); letter-spacing: var(--track-display); max-width: none; }
.list-count { font: 500 14px/1 var(--body); font-variant-numeric: tabular-nums; color: var(--text-muted); }
.list-tools { display: flex; align-items: center; gap: 8px; padding: 0 16px 10px; }

/* The search field. The pill's edge identifies it (3:1); its fill alone is about 1.1:1 against the list. */
.inbox-search { display: flex; flex: 1; min-width: 0; gap: 0; }
.search-pill {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 2px 0 10px;
  background: var(--surface-1);
  border: 1px solid var(--control-edge);
  border-radius: var(--r-input);
}
.search-pill input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  padding: 0;
  font-size: 14px;
  background: transparent;
  border: 0;
  border-radius: 0;
}
/* The pill takes the focus ring, not the input inside it: a ring around a borderless input inside a rounded
   field reads as a rectangle inside a field. The ring is moved, not removed. */
.search-pill input:focus-visible { outline: none; }
.search-pill:focus-within { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; }
/* Chrome and Safari draw their own clear affordance on a search input, in their own idiom. */
.search-pill input::-webkit-search-decoration,
.search-pill input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
/* The magnifier is the submit button, so a keyboard reaches it and a screen reader is told the search can be
   run. A decorative glyph beside a field that submits on Enter loses both. */
.search-go {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.search-go:hover { background: var(--surface-hover); color: var(--text-primary); }

.filter-count { font: 600 12px/1 var(--body); font-variant-numeric: tabular-nums; color: var(--accent-text); }
.filter-popover { width: 300px; }
.assign-popover { width: 300px; }
.assign-holder { margin: 0 0 8px; font-size: 14px; }

.list-tabs { display: flex; gap: 4px; padding: 0 16px 10px; }
.list-tab {
  height: 28px;
  padding: 0 10px;
  font: 500 14px/1 var(--body);
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: var(--r-button);
  cursor: pointer;
}
.list-tab:hover { background: var(--surface-hover); color: var(--text-primary); }
.list-tab[aria-selected="true"] { background: var(--surface-2); color: var(--text-primary); box-shadow: inset 0 -2px 0 var(--accent); }

.list-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0 16px 8px;
  font-size: 12px;
  color: var(--text-secondary);
}
/* 8px of room after the last row, so a list scrolled to its end does not set that row against the status bar's
   Health button (3px apart on a phone, where both span the width). */
.list-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
.message-list { list-style: none; margin: 0; padding: 0; }

/* A row: three lines, no box and no line between rows. The selected row's fill is 1.38:1 against the list,
   so the 2px accent edge carries the selection, with aria-current. */
.message-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-content: start;
  column-gap: 8px;
  row-gap: 2px;
  width: 100%;
  min-height: 76px;
  padding: 10px 16px 10px 22px;
  font: inherit;
  line-height: 20px;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: 0;
  border-left: 2px solid transparent;
  cursor: pointer;
}
.message-row:hover { background: var(--surface-hover); }
.message-row.current { background: var(--surface-active); border-left-color: var(--accent); }
.message-row:focus-visible { outline-offset: -2px; }
.unread-dot {
  position: absolute;
  left: 9px;
  top: 17px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.message-row:not(.unread) .unread-dot { display: none; }
.row-sender, .row-subject, .row-preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-sender { grid-column: 1; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.row-time { grid-column: 2; justify-self: end; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-muted); white-space: nowrap; }
.row-subject { grid-column: 1 / -1; font-size: 14px; font-weight: 400; color: var(--text-secondary); }
.message-row.unread .row-subject { font-weight: 500; color: var(--text-primary); }
.row-preview { grid-column: 1; font-size: 14px; color: var(--text-muted); }
.row-chips { grid-column: 2; justify-self: end; display: flex; align-items: center; gap: 4px; }

/* A chip: a word on a thing. The colour repeats the word; it never carries it alone. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 18px;
  padding: 0 6px;
  font: 500 12px/1 var(--body);
  color: var(--text-secondary);
  background: var(--surface-2);
  border-radius: var(--r-chip);
  white-space: nowrap;
}
.chip-mine { color: var(--success); }
.chip-auth-fail { color: var(--danger); }
.chip-held, .chip-place { color: var(--text-secondary); }
/* A filter or a label with its own buttons inside: tall enough for them, and they for a pointer. A row's
   label chip has no buttons and keeps the row's 18px. */
.list-status .chip-filter, .reader-labels .chip-label { height: 24px; padding-right: 2px; }
.chip .linkish { min-height: 0; color: inherit; }
.chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  font: inherit;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
  border-radius: 3px;
  cursor: pointer;
}
.chip-remove:hover { background: var(--surface-hover); color: var(--text-primary); }

.pager { display: flex; justify-content: space-between; gap: 8px; padding: 8px 16px 12px; }
.pager .btn { height: 28px; }
.list-empty { padding: 24px 16px; font-size: 14px; color: var(--text-secondary); }
.list-empty .notice { border-left: 0; padding: 0; }

/* The reader column scrolls; the article inside it grows to fill it, and the frame fills the article, so the
   body reaches the status bar and the only scroll is the frame's own. */
.reader-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-reader);
}
.reader-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  font-size: 14px;
  color: var(--text-muted);
  text-align: center;
}
.reader-empty p { margin: 0; }

.reading-pane { flex: 1 0 auto; display: flex; flex-direction: column; padding: 28px 44px 24px; }
/* Not the visually hidden h1 of the single-pane reader: at width 100% its absolute 1px box spanned the page
   and scrolled it sideways at 390px. Not the headers dialog either: a modal's 100% is the viewport's, and this
   rule outranked its own width, so below 792px its gutter shrank under 16px, and at 760px or narrower it ran
   edge to edge. */
.reading-pane > :not(.visually-hidden, dialog) { width: 100%; max-width: 760px; }
/* Pulled left by the ghost button's own padding, so its arrow lines up with the subject under it. */
.reading-pane > .reader-back { width: auto; align-self: flex-start; margin: 0 0 12px -12px; }
.reader-subject { margin: 0 0 12px; font: 600 22px/1.3 var(--body); overflow-wrap: anywhere; }
.reader-sender { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
.sender-name { font-size: 14px; font-weight: 600; }
.sender-addr { font-size: 14px; font-style: normal; color: var(--text-secondary); overflow-wrap: anywhere; }
.reader-time { margin-left: auto; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-muted); }
/* The "to …" disclosure and the message's labels share a line; opened, the details take the whole row and the
   labels follow under them. */
/* The summary is as tall as the line's tallest state (the label field, 28px), so where the labels and the field fit
   beside it, adding a label, opening the field or moving between a labelled and an unlabelled message does not
   move the actions. Where they do not fit (a phone; a two-pane window at its narrowest, with a label; the details
   open, which take the whole line) they wrap to a line of their own under it, and while that line is there the
   actions sit that line lower. Reserving it would put an empty line under every message that has no label. On the
   summary rather than the line: a 28px line centred the shorter summary while the details were closed and dropped it
   to the top once they opened, so the disclosure jumped under the pointer that opened it. */
.reader-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: 4px 0 0; }
.reader-meta > .reader-details[open] { flex-basis: 100%; }
.reader-to {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  gap: 4px;
  font-size: 14px;
  color: var(--text-secondary);
  list-style: none;
  cursor: pointer;
  border-radius: 4px;
}
.reader-to::-webkit-details-marker { display: none; }
.reader-to > svg { transition: transform var(--t-hover) ease-out; }
.reader-details[open] > .reader-to > svg { transform: rotate(180deg); }
.details-grid {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 6px 16px;
  margin: 8px 0 0;
  padding: 12px 14px;
  background: var(--surface-1);
  border-radius: var(--r-card);
}
.details-grid dt { font-size: 12px; line-height: 20px; color: var(--text-muted); }
.details-grid dd { margin: 0; font-size: 14px; color: var(--text-primary); overflow-wrap: anywhere; }
.details-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.details-note { font-size: 12px; color: var(--text-muted); }

/* A DMARC fail is visible without expanding anything (D11). */
.auth-alert {
  margin: 10px 0 0;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--surface-1);
  border-left: 2px solid var(--danger);
  border-radius: var(--r-card);
}

/* 8px, a row of controls' gap: at 6px Reply, Reply all and Forward read as one strip. */
.reader-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 10px; }
.reader-note { margin: 0 0 10px; font-size: 12px; color: var(--text-secondary); }
.collision { margin: 0 0 12px; }
.reader-labels { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.label-add { width: 160px; min-height: 28px; padding: 2px 8px; }

.next-steps { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 14px; }
.next-steps-label { margin-right: 4px; font: 600 12px/1 var(--body); color: var(--text-muted); }
/* Reserved for a model's output, and deliberately unlike any deterministic control: an edge, a persistent
   "AI" label in --warning and the provenance beside it. */
.ai-finding { flex-basis: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-card); }
.ai-label {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  margin-right: 6px;
  font: 600 12px/1 var(--body);
  color: var(--warning);
  background: var(--surface-2);
  border-radius: var(--r-chip);
}
.ai-provenance { margin-right: 6px; font-size: 12px; color: var(--text-muted); }

/* What the reader must know before the body, and so above it: withheld resources, truncation, attachment
   verdicts and flagged links. */
.reading-pane > .notice, .reading-pane > .attachments { margin: 0 0 10px; font-size: 14px; }
.attachments { list-style: none; padding: 0; margin: 0 0 10px; font-size: 14px; }
.attachments li { padding: 2px 0; }
.links-flagged { margin: 6px 0 0; padding-left: 18px; font-size: 12px; overflow-wrap: anywhere; }

/* An opaque-origin frame with no scripts and no same-origin access; the sandbox is the boundary, not the
   sanitiser (ADR 37). Its own sheet (/app/frame.css) paints the viewer's theme. The element is white so that
   if that sheet ever failed to load, the frame's default black text stays on white rather than on the dark
   reader: ugly, readable, safe. */
.message-body {
  display: block;
  width: 100%;
  flex: 1 0 360px;
  min-height: 360px;
  border: 0;
  background: #FFFFFF;
}
/* The frame's focus ring. A focused frame matches no focus pseudo-class in the page that holds it, so reader.tsx
   marks it (useFrameFocus) and it wears the ring every other control wears on :focus-visible. */
.message-body[data-focused] { outline: 2px solid var(--accent); outline-offset: 2px; }
.message-text {
  flex: 1 0 auto;
  margin: 0;
  font: 15px/1.55 var(--body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* The rest of the conversation, below the message being read. */
.thread { padding: 16px 44px 64px; border-top: 1px solid var(--border-soft); }
.thread > * { max-width: 760px; }
.thread h3 { margin: 0 0 8px; font: 600 12px/1.4 var(--body); color: var(--text-muted); }
.thread-list, .draft-list { list-style: none; margin: 0; padding: 0; }
.thread-row, .draft-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-content: center;
  column-gap: 8px;
  row-gap: 2px;
  width: 100%;
  min-height: 52px;
  padding: 6px 10px;
  font: inherit;
  line-height: 20px;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: var(--r-button);
  cursor: pointer;
}
.thread-row:hover, .draft-row:hover { background: var(--surface-hover); }

/* ---- the composer ------------------------------------------------------------------------ */

/* One host in the shell, so the draft survives navigation. On a screen with no reader column (the Outbox, the
   Queue) it is a card at the bottom right. Over a mail screen it takes the reader column whole, below. */
.composer-host { position: fixed; z-index: 30; right: 12px; bottom: calc(var(--status-h) + 8px); }
/* With no composer open the host is an empty box, and sized to the column (below) it would take its clicks. */
.composer-host:empty { display: none; }
.composer-dock {
  width: min(720px, calc(100vw - var(--sidebar-w) - var(--list-w) - 24px));
  max-height: var(--card-max-h);
  overflow-y: auto;
  padding: 14px 16px;
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  box-shadow: 0 8px 24px rgb(0 0 0 / .35);
}
/* Over a mail screen the composer is the reader column: exactly its box, whatever the bands above take, never
   the list. A card beside the message clipped it mid-word at its left edge, and covering most of a message
   while showing a sliver of it is worse than covering it: the head names the message instead (dock-context).
   Anchored rather than measured, so the browser keeps it on the column as bands come and go.
   ponytail: a browser without anchor positioning keeps the card above; measure the column if one matters. */
.reader-column { anchor-name: --reader-column; }
@supports (anchor-name: --a) {
  @media (min-width: 768px) {
    body:has(.reader-column) .composer-host {
      position-anchor: --reader-column;
      inset: anchor(top) anchor(right) anchor(bottom) anchor(left);
    }
    body:has(.reader-column) .composer-dock {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      max-height: none;
      padding: 28px 44px 24px;
      background: var(--bg-reader);
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }
    body:has(.reader-column) .composer-dock > * { max-width: 760px; }
    /* What the dock covers leaves the Tab order and the accessibility tree while it does: Tab landed on Reply,
       Assign and the frame behind it, focus nobody could see (WCAG 2.4.11), and nothing but moving focus revealed
       them. The column itself keeps its box, which is the dock's anchor, and stops scrolling: Chromium makes a
       scroller with nothing focusable left in it a Tab stop of its own. */
    body:has(.composer-dock) .reader-column { overflow: hidden; }
    body:has(.composer-dock) .reader-column > * { visibility: hidden; }
  }
  /* The same inset as the reader it covers, which narrows below 1120px. */
  @media (min-width: 768px) and (max-width: 1119.98px) {
    body:has(.reader-column) .composer-dock { padding: 24px; }
  }
}
/* The card covers the bottom of the column a screen scrolls in, and a control under it stayed a Tab stop nobody
   could see (WCAG 2.4.11). So the column makes room for the card's tallest, and focus scrolls a control above it:
   the card's own bound and its 8px from the status bar, 16px in all. Below 768px the dock is the screen, below. */
@media (min-width: 768px) {
  body:has(.composer-dock):not(:has(.reader-column)) .app-main {
    padding-bottom: calc(var(--card-max-h) + 16px);
    scroll-padding-bottom: calc(var(--card-max-h) + 16px);
  }
}
.composer-dock form { gap: 12px; }
.dock-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 10px; }
.dock-head h2 { margin: 0; font-size: 14px; }
/* What the reply is about, since the reader it covers is where that was said. */
.dock-context { flex-basis: 100%; margin: 0; font-size: 14px; color: var(--text-secondary); overflow-wrap: anywhere; }
.dock-context span { color: var(--text-primary); font-weight: 600; }
/* The send, and every fact about it at the weight of a footnote; the long form is one click down. */
.dock-send { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.send-note { font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
.send-how { font-size: 12px; color: var(--text-secondary); }
.send-how > summary { display: inline-flex; align-items: center; min-height: 24px; color: var(--accent-text); cursor: pointer; }
.send-how > p { margin: 4px 0 0; line-height: 1.5; }
/* Where the bytes are. Muted, because it is a reassurance, and a failed save outweighs it: a draft that
   silently stopped saving is worse than one that never saved, because the earlier success taught the person
   to trust it. */
.draft-phase { font-size: 12px; font-weight: 400; color: var(--text-muted); }
.draft-phase.failed { color: var(--danger); }
.dock-actions { margin-left: auto; display: inline-flex; gap: 14px; }
/* The fold that opens Cc and Bcc: a link at the end of the To row, gone once opened. Through .field-row, because
   .field-row > button starts every button in a field row and had put this one at the start, under the field. */
.composer-copies { font-size: 12px; }
.field-row > .composer-copies { justify-self: end; }
.composer-held { margin: 0; padding: 6px 12px; color: var(--text-primary); border-left: 2px solid var(--danger); }

/* A row of actions: the controls a block ends in. Flex, so two controls never stand a text space apart (about 4px,
   which is how a rule's Save draft came to touch its Cancel). .policy-actions and .approval-actions are this row
   under their screens' names; each sets its own margin. */
.row-actions, .policy-actions, .approval-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.row-actions { margin: 12px 0 4px; }
/* The same inside a sentence or a table cell, where a block row would break the line or the cell (display: flex on a
   td replaces its table-cell box): a rule's Publish and Open, a resend's reason and its two answers. */
.inline-actions { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }

/* ---- ledgers ------------------------------------------------------------------------------ */

/* A page's title, then what it counts or says ("0 sends", "Connected.") beside it on its baseline, as the mail
   list's count sits beside its title. Controls go to the right edge: each one takes margin-left: auto. */
.ledger-head {
  display: flex;
  align-items: baseline;
  gap: 8px 16px;
  flex-wrap: wrap;
  min-width: 0;
  margin-bottom: 20px;
}
.ledger-head h1 { margin: 0; max-width: none; font: 600 26px/1.2 var(--body); letter-spacing: var(--track-display); }
.ledger-head p { margin: 0; font-size: 14px; font-variant-numeric: tabular-nums; color: var(--text-secondary); }
/* After .ledger-head p, and as specific: its margin reset otherwise took the auto margin off the New butler and
   New rule paragraphs, which then sat beside the title. */
.ledger-head > button, .ledger-head > .new-message { margin-left: auto; }
.new-message { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; max-width: 100%; }
.new-message select { max-width: min(100%, 20rem); min-width: 0; }

.ledger { min-width: 0; overflow-x: auto; }
.scroller { overflow-x: auto; }
/* A table's caption reads with its rows: left, over the header, not centred above the whole table. */
caption, .table-caption { text-align: left; caption-side: top; padding: 0 0 8px; font-size: 12px; }
table { width: 100%; border-collapse: collapse; }
thead th {
  text-align: left;
  padding: 8px 10px;
  font: 600 12px/1.4 var(--body);
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}
th.num, td.num { text-align: right; }
/* overflow-wrap: break-word, not word-break: break-word. Chromium treats the latter as overflow-wrap: anywhere,
   which lets a cell shrink to one character, so auto layout squeezed Setup's Scope column to "accou/nt" at
   1440. break-word keeps each column at least its longest word; a longer token widens the table, and the
   .ledger or .scroller around it scrolls. */
tbody td {
  padding: 10px;
  font-size: 14px;
  vertical-align: baseline;
  overflow-wrap: break-word;
  border-bottom: 1px solid var(--border-soft);
}
td.num { white-space: nowrap; }
td.dim { color: var(--text-secondary); }

/* The small labels a ledger names its parts with: a recipient's kind, a picker's name, a detail's key. */
.label, .recipient .label, .queue-picker span, .target-edit span, tr.detail dt {
  font: 500 12px/1.4 var(--body);
  color: var(--text-secondary);
}

tr.entry { cursor: pointer; }
tr.entry:hover { background: var(--surface-hover); }
tr.entry:focus-visible { outline-offset: -2px; }
tr.entry:focus-visible td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
tr.entry.open { background: var(--surface-1); }
tr.entry.open td { border-bottom-color: transparent; }
tr.detail td { padding: 4px 10px 16px; background: var(--surface-1); }
tr.detail dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 20px; margin: 0; font-size: 12px; }
tr.detail dt { padding-top: 2px; }
tr.detail dd { margin: 0; word-break: break-all; }

.row-toggle { width: 100%; padding: 0; margin: 0; font: inherit; color: inherit; text-align: left; background: none; border: 0; cursor: pointer; }
.row-toggle:hover { color: var(--accent-text); }

/* One colour per state, because the blueprint requires a state to mean the same thing everywhere. Every state
   also carries its word, so the colour is never the only channel. */
.state {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  font: 500 12px/1 var(--body);
  border: 1px solid var(--border);
  border-radius: var(--r-chip);
  white-space: nowrap;
}
.state-held           { border-color: var(--warning); color: var(--warning); }
.state-handed_over    { border-color: var(--success); color: var(--success); }
.state-cancelled      { color: var(--text-secondary); }
.state-throttled      { border-color: var(--warning); color: var(--warning); }
.state-refused        { border-color: var(--danger); color: var(--danger); }
/* "Did not leave, needs a person" is the same signal as refused. */
.state-withheld       { border-color: var(--danger); color: var(--danger); }
/* A policy gate (#60): a gated send is waiting on a person, which is the same signal as held. */
.state-awaiting       { border-color: var(--warning); color: var(--warning); }
/* The reason chip beside a state: unpainted, since the state already carries the signal. */
.state-reason         { color: var(--text-secondary); }
.state-suppressed     { border-color: var(--danger); color: var(--danger); }
.state-outcome_unknown { border-color: var(--danger); color: var(--danger); }
.state-audit-ok       { border-color: var(--success); color: var(--success); }
.state-audit-refused  { border-color: var(--warning); color: var(--warning); }
.state-audit-failed   { border-color: var(--danger); color: var(--danger); }
.state-log-info       { color: var(--text-secondary); }
.state-log-warn       { border-color: var(--warning); color: var(--warning); }
.state-log-error      { border-color: var(--danger); color: var(--danger); }
/* An agent's audit standing that deserves a look: the same signal as a refused audit. */
.state-audit-warn     { border-color: var(--warning); color: var(--warning); }
.state.label          { color: var(--text-secondary); }

/* Delivery is a different scale from submission (what the receiving world did, not what this Node did), so
   it reuses the same three signal colours rather than inventing a fourth. */
.delivery-accepted    { border-color: var(--success); color: var(--success); }
.delivery-bounced     { border-color: var(--danger); color: var(--danger); }
.delivery-failed      { border-color: var(--danger); color: var(--danger); }
.delivery-rejected    { border-color: var(--danger); color: var(--danger); }
.delivery-deferred    { border-color: var(--warning); color: var(--warning); }
/* Unobserved is deliberately the quietest thing on the row: the absence of news is not a finding. */
.delivery-unobserved  { color: var(--text-secondary); }
/* A verified destination's summary chip: as quiet as unobserved, since it says nothing is coming, not that
   anything went wrong. */
.delivery-verified_destination { color: var(--text-secondary); }
.delivery-chip        { margin-left: 6px; }

/* Doctor's three verdicts and its severities. */
.verdict-ok       { border-color: var(--success); color: var(--success); }
.verdict-degraded { border-color: var(--warning); color: var(--warning); }
.verdict-refuse   { border-color: var(--danger); color: var(--danger); }
/* A health row whose worst failing finding is a report: a note, like .severity-report, not a verdict. */
.verdict-report   { color: var(--text-secondary); }
.severity-refuse   { border-color: var(--danger); color: var(--danger); }
.severity-degraded { border-color: var(--warning); color: var(--warning); }
.severity-report   { color: var(--text-secondary); }

/* Gap larger than the one between an address and its own error below it, so a long SMTP response reads as
   belonging to the recipient above it rather than the one below. */
.recipients { display: grid; gap: 10px; }
.recipient { display: grid; grid-template-columns: 2.6rem minmax(0, 1fr) auto; gap: 8px; align-items: baseline; }
.recipient .mono { font-size: 12px; word-break: break-all; }
/* The provider's own words, on their own line, verbatim: a paraphrase of somebody else's mail server is a
   guess. */
.recipient-error { grid-column: 1 / -1; font-size: 12px; line-height: 1.5; padding-left: 3.1rem; margin-top: 2px; }

/* ---- the Butler screen, the dry run, passkeys, transport ------------------------------------ */

.butler-detail { margin-top: 24px; border-top: 1px solid var(--border-soft); padding-top: 16px; }
.butler-detail h2 { margin: 0; }
.butler-source {
  width: 100%;
  font-size: 12px;
  line-height: 1.5;
  /* A program is read by its indentation, so wrapping is off and the box scrolls instead. */
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}
/* The format selector (#87). A fieldset, so the browser's default border and padding have to go. */
.butler-format { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 12px; border: 0; margin: 0 0 10px; padding: 0; }
/* float rather than display, because a legend set to anything else stops being announced as the group's name
   in several screen readers -- which is the entire reason this is a fieldset. */
.butler-format legend { float: left; padding: 0; margin-right: 12px; font-size: 12px; }
.butler-format label { font-size: 12px; }
.butler-format .dim { font-size: 12px; }
.butler-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0 24px; }
.butler-dry { border-top: 1px solid var(--border-soft); padding-top: 14px; margin-bottom: 24px; }
.butler-dry h3 { margin: 0 0 6px; }
.butler-dry-runs, .export-objects { list-style: none; margin: 8px 0; padding: 0; }
.butler-dry-runs li, .export-objects li { display: flex; gap: 8px; align-items: center; margin: 4px 0; font-size: 12px; }
.butler-dry-result { margin-top: 12px; }
/* The detail is JSON on one line and can be long. It scrolls in its own cell rather than widening the table:
   nothing makes the page scroll sideways. */
.butler-dry-detail { max-width: 26rem; overflow-x: auto; white-space: nowrap; font-size: 12px; }
/* The limits are the sentences that stop this being read as a green light, so they are not dimmed away. */
.butler-dry-limits { margin: 10px 0 0; padding-left: 18px; font-size: 12px; }
.butler-dry-limits li { margin: 4px 0; }
/* The checker's findings arrive as several lines and are the whole value of a refusal: kept as written. */
.butler-findings { white-space: pre-wrap; font-size: 12px; }
.butler-pause { margin-top: 16px; }
.butler-pause > * { margin: 0 0 8px; }
.butler-runs-heading { margin-top: 32px; }

.passkeys { margin: 0 0 24px; max-width: 46rem; }
.passkeys h2 { margin: 0 0 6px; }
.passkeys .dim { font-size: 12px; }
.passkeys .field-row { margin: 12px 0 6px; max-width: 22rem; }

.transport { margin-top: 24px; border-top: 1px solid var(--border-soft); padding-top: 16px; max-width: 40rem; }
.transport h2 { margin: 0 0 6px; }
.transport .field-row { margin: 10px 0; }
.transport .dim { font-size: 12px; }

/* ---- approvals, rules, people, limits ---------------------------------------------------- */

/* One card per decision: a table would make the gravest and the most routine identical. */
.approval-list { display: flex; flex-direction: column; gap: 20px; margin-top: 16px; }
.approval { padding: 16px 18px; background: var(--surface-1); border-radius: var(--r-card); }
.approval h2 { margin: 0 0 4px; }
.approval > p { margin: 0 0 12px; }
/* The requester's own words, set apart from the Node's: whose sentence it is matters when deciding. */
.approval-reason { margin: 0 0 12px; padding: 6px 12px; border-left: 2px solid var(--border); font-style: italic; }
.approval > p.approval-actions { margin: 12px 0 0; }
/* A request's facts: a term and its value, side by side. */
.headers { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 4px 12px; margin: 0 0 12px; }
.headers dt { font-size: 12px; line-height: 20px; color: var(--text-secondary); }
.headers dd { margin: 0; font-size: 14px; word-break: break-word; }

.policy-editor {
  display: grid;
  gap: 16px;
  margin-top: 24px;
  border-top: 1px solid var(--border-soft);
  padding-top: 16px;
  max-width: 44rem;
}
.policy-editor h2 { margin: 0; }
.policy-actions { margin: 16px 0 0; }

.people-mailbox { margin-top: 28px; }
.people-mailbox h2, .people-teams h2 { margin: 0 0 8px; }
.people-teams { margin-top: 32px; border-top: 1px solid var(--border-soft); padding-top: 16px; }
.grant-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.grant-list label { display: flex; gap: 8px; align-items: baseline; font-size: 14px; cursor: pointer; }
/* A capability row: box, name, the content chip, and what it does. The description stays beside the name
   while 20rem of the row is left for it, and otherwise takes a line of its own (every row on a phone), rather
   than squeezing into a column beside the chip or running out of the fieldset. */
/* At least 24px a row, so a 16px checkbox's 24px target (WCAG 2.5.8) never overlaps the next one's: at this body
   size (14px/1.45, a 20.3px line) single-line rows stood 23.3px apart on /agents (R2AXE-3). */
.check { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; min-height: 24px; }
.check > .dim { flex: 1 1 20rem; min-width: 0; overflow-wrap: anywhere; }
.grant-object { margin: 6px 0 0; font-size: 12px; }
/* The agents screen's layout helpers: a column of controls, a list with no bullets, and an id on its own line
   under the name it identifies. */
.stack { display: grid; gap: 8px; }
.bare { list-style: none; margin: 0; padding: 0; }
.block { display: block; }

.limits-pauses { margin-top: 32px; border-top: 1px solid var(--border-soft); padding-top: 16px; }
.limits-pauses h2 { margin: 0 0 6px; }
.limits-ask { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 16px 0; }
.limits-ask .field-row { margin: 0; }

/* ---- setup, first run, matters ----------------------------------------------------------- */

/* Setup progress: five derived steps, a chip each; the count above them is the only number. */
.onboarding { margin: 0 0 16px; }
.onboarding ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.onboarding li { display: grid; grid-template-columns: auto auto 1fr; gap: 12px; align-items: baseline; }
.onboarding-label { font-weight: 500; }
.onboarding-detail { font-size: 12px; }
.setup-catch-all { margin: 12px 0; }
.setup-catch-all .field-row { display: flex; gap: 8px; align-items: baseline; }
.setup-block { margin-top: 32px; border-top: 1px solid var(--border-soft); padding-top: 16px; }
.setup-block h2 { margin: 0 0 6px; }
.setup-block h3 { margin: 12px 0 6px; }
.setup-copy { display: inline-flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.setup-plan { margin: 16px 0; border-left: 2px solid var(--accent); padding-left: 14px; }

/* The first-run screen: the whole app while the Node cannot be used as an inbox. One column, read top down. */
.first-run { max-width: 44rem; margin: 0 auto; padding: clamp(1rem, 2.5vw, 2rem); }
.first-run-next { margin-top: 24px; border-top: 1px solid var(--border-soft); padding-top: 16px; }
.first-run-next h2 { margin: 0 0 8px; }
.first-run-next h3 { margin: 16px 0 4px; }
.first-run-anyway { margin-top: 24px; font-size: 12px; }

.matter-block { margin-top: 32px; border-top: 1px solid var(--border-soft); padding-top: 16px; }
.matter-block h2 { margin: 0 0 6px; }
.matter-block > p { margin: 0 0 10px; }

/* The minted invitation secret (#83): shown once, so it has to be readable and selectable. */
.invite-secret { margin-top: 16px; }
.invite-secret p { margin: 0 0 6px; }
.invite-value {
  font-size: 14px;
  letter-spacing: .04em;
  word-break: break-all;
  user-select: all;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: var(--r-input);
}

/* ---- the queue (Layer 3) ------------------------------------------------------------------ */

/* Addresses are not prose and must not break mid-word: "billing@exam / ple.com" is unreadable and, on a
   ledger of who a message went to, actively misleading. The table gets a floor and its container
   scrolls instead. */
.ledger table { min-width: 52rem; }
/* The queue carries two columns the ledgers do not -- a pick control and the response clock -- and adding them
   first crushed the subject to a few characters per line. A 68rem floor traded that for something worse: at a
   1200px window the response clock and the action buttons both sat past the right edge. So the queue keeps the
   ledgers' 52rem floor and earns its width back: the holder cell wraps between the name and the age and the
   actions stack. One declared width, on the subject, and it is 100%: under auto layout that means "give me the
   surplus", so the font-shaped columns settle at the width their content needs and the prose column takes the
   rest. table-layout: fixed with per-cent shares clipped every address, and a min/max pair on the subject did
   not raise the column at all. */
.queue-table th:nth-child(2), .queue-table td:nth-child(2) { width: 100%; }
.queue-table .case-subject { display: inline-block; }
/* This cell holds two facts, so it may break between them but never inside either. Scoped under .ledger to
   outrank the .ledger td.mono rule below, whatever the order. */
.ledger .queue-table td.case-holder { white-space: normal; }
.ledger .queue-table td.case-holder > span { white-space: nowrap; }
/* Stacked, right-aligned, with block buttons rather than a flex cell: display: flex on a td replaces its
   table-cell box, and the row rule stopped short of the last column. */
.case-actions { text-align: right; white-space: nowrap; }
.case-actions button { display: flex; margin-left: auto; margin-bottom: 8px; }
.hand-to { display: inline-flex; gap: 8px; align-items: baseline; }
.hand-to input { width: 11rem; min-height: 28px; padding: 2px 6px; font-size: 12px; }
.resend-reason { width: 16rem; min-height: 28px; padding: 2px 6px; font-size: 12px; }
.hand-to button { display: inline-flex; margin: 0; }
/* nowrap, not a smarter wrap: overflow-wrap: anywhere still split "billing@example.com" across lines, which
   reads as two addresses. The table has a floor and the ledger scrolls. */
.ledger td.mono { word-break: normal; overflow-wrap: normal; white-space: nowrap; }

/* Three claim states, and colour is not what distinguishes them: every row states its state in a word, and
   the two claimed states differ in a left marker as well as in hue. */
.case-unclaimed { border-color: var(--border); color: var(--text-primary); }
.case-mine      { border-color: var(--success); color: var(--success); }
.case-held      { border-color: var(--warning); color: var(--warning); }
.case-row td { vertical-align: baseline; }
/* A marker, not a fill: a tinted row would put the state in colour alone. */
.case-row.mine td:first-child   { box-shadow: inset 2px 0 0 var(--success); }
.case-row.theirs td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
.case-subject { font-size: 14px; }
.case-count { font-size: 12px; }
/* The withheld-content placeholder: a word, dotted, so it cannot be mistaken for a subject line that happens
   to say "restricted". No strikethrough and no lock glyph: both read as an error, and this is a correct,
   ordinary answer. */
.restricted { font-size: 12px; letter-spacing: var(--track-label); color: var(--text-secondary); border-bottom: 1px dotted var(--border); cursor: help; }

.field-row select { min-width: min(18rem, 100%); }
.queue-picker { display: inline-flex; align-items: baseline; gap: 8px; margin-left: auto; }

/* The first-response clock. Each carries a word, so none depends on colour. */
.clock-answered { border-color: var(--success); color: var(--success); }
.clock-due      { border-color: var(--warning); color: var(--warning); }
.clock-breached { border-color: var(--danger); color: var(--danger); }
.queue-target { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; white-space: normal; }
/* The two quarantine switches: a row each, box then sentence, under the target. */
.queue-switches { display: grid; gap: 12px; margin: 0 0 16px; white-space: normal; }
.queue-switches .case-pick { align-items: start; }
.queue-breached { margin-left: auto; }
.target-edit { display: inline-flex; align-items: baseline; gap: 6px; }
.target-edit input { width: 5rem; }
/* The pick control sits with the state word: a case is picked as a state, and a bare checkbox column reads as
   a table that wants bulk actions it does not have. */
.case-pick { display: inline-flex; align-items: baseline; gap: 8px; cursor: pointer; }

/* ---- settings and drafts ------------------------------------------------------------------ */

.settings-block { max-width: 720px; margin-bottom: 28px; }
.settings-block h2 { margin: 0 0 8px; }
.theme-choice { display: grid; gap: 4px; border: 0; margin: 0; padding: 0; }
.theme-choice legend { margin-bottom: 4px; }
/* A choice and its words on one row: the theme radios, and the single-key shortcuts checkbox. */
.theme-option, .settings-check { display: flex; align-items: center; gap: 8px; min-height: 28px; font-size: 14px; cursor: pointer; }
.theme-option input, .settings-check input { margin: 0; }
.theme-note { font-size: 12px; color: var(--text-muted); }
.shortcut-table { width: auto; }
.shortcut-table td { padding: 6px 16px 6px 0; }
.draft-list { max-width: 720px; }

/* ---- motion ------------------------------------------------------------------------------- */

/* Hover is a colour change over 100ms. Things that appear have nothing to transition from, so they run one
   short keyframe. No springs and no loops. */
.btn, button.quiet, button.primary, a.primary, .linkish, .chip-action, .chip-remove, .rail-row, .rail-group-toggle,
.message-row, .list-tab, .section-tab, .menu-item, .palette-option, .thread-row, .draft-row, .health-button,
.search-go, .toast-dismiss, tr.entry, a {
  transition: background-color var(--t-hover) ease-out, color var(--t-hover) ease-out, border-color var(--t-hover) ease-out;
}
@keyframes pop-in { from { opacity: 0; transform: translateY(4px); } }
@keyframes drawer-in { from { transform: translateX(-100%); } }
@keyframes pane-in { from { opacity: 0; transform: translateX(12px); } }
.popover, .menu, dialog.palette, dialog.compose-chooser, dialog.headers-dialog, .toast { animation: pop-in var(--t-pop) ease-out; }
dialog.drawer { animation: drawer-in var(--t-pane) ease-out; }

/* ---- breakpoints -------------------------------------------------------------------------- */

/* Below 1120px the sidebar is the drawer (the shell reads the same query) and the list narrows to 320px, so
   the three panes are never shown together. */
@media (max-width: 1119.98px) {
  .mail-panes { grid-template-columns: 320px minmax(0, 1fr); }
  .composer-dock { width: min(720px, calc(100vw - 320px - 24px)); }
  /* A 448px reader at 768 kept 44px a side and 360px of text: the narrow panes get 24. */
  .reading-pane { padding: 24px 24px 24px; }
  .thread { padding-left: 24px; padding-right: 24px; }
  /* The sidebar is the drawer and the list is 320px: the toast sits over that. */
  body:has(.composer-dock) .toast-region { left: 16px; max-width: 288px; }
}

/* Below 768px, one pane at a time: the list, or the reader with a back button. */
@media (max-width: 767.98px) {
  .app-main { --pad-top: 20px; --pad-x: 16px; }
  .mail-panes { grid-template-columns: minmax(0, 1fr); }
  .mail-panes[data-view="list"] .reader-column { display: none; }
  .mail-panes[data-view="reader"] .list-pane { display: none; }
  .mail-panes[data-view="list"] .list-pane, .mail-panes[data-view="reader"] .reader-column { animation: pane-in var(--t-pane) ease-out; }
  .list-pane { border-right: 0; }
  /* --reader-end is the pane's bottom padding, named because the frame's height below subtracts it. */
  .reading-pane { --reader-end: 24px; padding: 20px 16px var(--reader-end); }
  .thread { padding: 16px 16px 48px; }
  /* The frame is the column's height (container units: the column, not the viewport, so bands above it do
     not push its top out of view). The header scrolls away once, then the frame is the only scroller. A frame
     sized to its document would need allow-same-origin, which the sandbox forbids (ADR 37). */
  .reader-column { container-type: size; }
  .message-body { flex: none; height: calc(100cqh - var(--reader-end)); }
  /* Label above value: a 112px label column left the values a 200px strip. */
  .details-grid { grid-template-columns: minmax(0, 1fr); row-gap: 2px; }
  .details-grid dd + dt { margin-top: 8px; }
  /* Full screen under the bar and the bands: one pane at a time, and the composer is the pane, but the notices
     blueprint 7 requires stay above every screen, this one included. The top is the bottom of whichever of the
     bar, SetupUnfinished and the notices comes last (the last element carrying an anchor name is the anchor), and
     never above the bar when the bands have scrolled away with a ledger. By the bands' own classes: a screen's
     status line ("Matter opened.") is a direct child of .app-main as well, and anchored the composer under itself.
     ponytail: a browser without anchor positioning starts it under the bar, over the bands. */
  .mobile-bar, .app-main > .setup-unfinished, .app-main > .notices { anchor-name: --above-composer; }
  .composer-host { inset: var(--mobile-bar-h) 0 var(--status-h) 0; }
  @supports (anchor-name: --a) {
    .composer-host { top: max(var(--mobile-bar-h), anchor(--above-composer bottom)); }
  }
  /* What it covers leaves the Tab order while it does (WCAG 2.4.11, as the column above): everything in the
     column but the bar and the bands, and the bands too where it starts under the bar. */
  body:has(.composer-dock) .app-main > :not(.mobile-bar, .setup-unfinished, .notices) { visibility: hidden; }
  @supports not (anchor-name: --a) {
    body:has(.composer-dock) .app-main > :is(.setup-unfinished, .notices) { visibility: hidden; }
  }
  .composer-dock { box-sizing: border-box; width: auto; height: 100%; max-height: none; padding: 20px 16px 24px; border: 0; border-radius: 0; box-shadow: none; background: var(--bg-reader); }
  /* The composer fills everything under the bar, so the toast goes over the bar, where it hides no field. */
  body:has(.composer-dock) .toast-region {
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100vw - 32px);
    top: 2px;
    bottom: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
    animation-iteration-count: 1 !important;
  }
  [data-reveal] { animation: none; }
}
`;

/** The shell's stylesheet: the theme blocks, then every rule. Served as `/app/app.css` by `src/ui.ts`. */
/**
 * A plain-text body is the sender's text in the shell's document, so it is drawn in the message's script, as the
 * frame is (critic M9): `reader.tsx` writes `data-script` on the `<pre>`, and the families are the frame's own
 * (`scriptFamily` in `src/theme.ts`). Class and attribute outrank `.message-text`'s `font`, and so the
 * interface's `:root:lang(zh)` stack.
 */
const MESSAGE_TEXT_SCRIPTS = (Object.keys(FRAME_SCRIPTS) as BodyScript[])
  .map((script) => `.message-text[data-script="${script}"] { font-family: ${scriptFamily(script)}; }`).join("\n") + "\n";

export const SHELL_CSS = themeCss() + RULES + MESSAGE_TEXT_SCRIPTS;
