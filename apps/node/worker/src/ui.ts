import { BUDGETS } from "@mailda/budgets";

import appScript from "./client/app.client.js";
import shellBundle from "../generated/app.bundle.client.js";
// The webfonts, as ArrayBuffers via wrangler's `Data` rule. Served from this origin and never fetched from
// anywhere else — `fonts/README.md` records why that is a product rule, and why Satoshi is in the stack and
// not in the directory.
import interRegular from "../fonts/inter-400.woff2";
import interMedium from "../fonts/inter-500.woff2";
import jakartaSemibold from "../fonts/jakarta-600.woff2";
import jakartaBold from "../fonts/jakarta-700.woff2";
import deliveryScript from "./client/delivery.client.js";
import sessionScript from "./client/session.client.js";
import { EXPIRY_COOKIE } from "./auth/session.ts";
import { MARK_IS_AUTHORED, faviconDataUri, markSvg } from "./brand.ts";

/**
 * The Node's interface shell.
 *
 * §25 specifies React + TanStack Router/Query and an accessible Mailda component system. This is
 * **not** that, and must not be mistaken for it — it is the smallest surface that genuinely works
 * end to end, and it gets replaced by the real client rather than extended into it. What carries
 * over is the design language established here and the product rules in `app.client.js`.
 *
 * ## Aesthetic direction: instrument panel
 *
 * An operator deployed this into their own Cloudflare account. It is closer to a rack-mounted
 * device's front panel than to a SaaS dashboard, and it is styled that way on purpose: a status
 * strip with live readouts, every figure in monospace with tabular numerals, hairline rules
 * instead of cards and drop shadows, one amber signal colour, and an editorial serif for prose.
 * The project's rule is that every number carries a receipt, so the interface shows its working
 * rather than rounding it away.
 *
 * ## Fonts are local, and that is a product decision
 *
 * No webfont is loaded. Mailda's entire premise is custody — your account, your data, your keys —
 * and a page that fetches a font from a third party hands that third party every viewer's IP
 * address on every load. There is no version of that which is consistent with the promise, so the
 * stacks below are composed from faces already on the machine. It is a real constraint, and the
 * design is built to it rather than around it.
 */
/**
 * The whole stylesheet, served at `/app/app.css` rather than written into the document (#97).
 *
 * It was a `<style>` element in the head, and there was nothing wrong with that until the Node acquired a
 * Content-Security-Policy. `style-src 'self'` refuses an inline stylesheet, and the two ways to keep one
 * are `'unsafe-inline'` — which makes the directive decorative — and a per-response nonce, which means the
 * policy and the document have to agree on a random value on every response forever. Serving the bytes
 * from this origin needs neither: the CSS is the same for every viewer, so it is a file, and saying so
 * costs one request that is then cached.
 *
 * Still CSS inside a TypeScript template literal, and the two hazards that pairing has cost real time are
 * unchanged — a backtick in a comment ends the literal, a stray comment terminator silently discards the
 * rule after it. `test/node/stylesheet-hazards.test.ts` reads this constant by name and fails on either.
 */
const SHELL_CSS = `
:root {
  /* Mailda's palette (src/brand.ts holds the same five values for the generated SVGs — the favicon and
     the app icon are strings, so they cannot read a CSS variable). Light is the default now, which is the
     brand's own ground; dark is the media query below. That is the reverse of what this stylesheet did
     when it was an instrument panel, and the meta color-scheme in the document was flipped with it. */
  --ground: #F2F4F7;        /* Mist */
  --ground-2: #FFFFFF;      /* White */
  --sky: #E6EEF7;           /* Sky — quiet fills, selected rows */
  --text: #0F1720;          /* Ink */

  /* .66, and the number is measured rather than chosen. AA wants 4.5:1 for normal text and every label on
     this interface is normal text at .655rem; .60 gives 4.58 on Mist but 4.48 on Sky, which fails on the
     brand's own third ground. .66 gives 5.40 / 5.61 / 5.26 across Mist, White and Sky.
     See docs/receipts/contrast-tokens.md. */
  --dim: rgba(15, 23, 32, .66);
  --rule: rgba(15, 23, 32, .10);
  --rule-strong: rgba(15, 23, 32, .22);

  /* The edge of a control, and it is the one place the brand sheet and WCAG 1.4.11 disagree (#128).
     1.4.11 wants 3:1 for the visual information that identifies a control. The brand's search field is a
     Mist pill on a White header, and **Mist on White is 1.10** — so the fill does not identify anything, and
     neither rule does either: .10 gives 1.23 and .22 gives 1.61. Measured, not estimated.
     .47 is the first alpha that clears 3:1 on all three light grounds — 3.13 on White, 3.08 on Mist, 3.03
     on Sky. It is heavier than the mockup's hairline and it is what makes the field a field rather than a
     shape somebody has to guess at. The airy version is in the receipt, with the number, so the choice is
     legible rather than looking like a designer's line got thicker by accident. */
  --control-edge: rgba(15, 23, 32, .47);

  /* The rail is a **dark-theme island in a light page**, per the brand sheet's product mockup, so its tokens
     are the dark theme's — already measured there rather than invented here. Named separately because the
     rail keeps them in *both* schemes: at Ink on a Mist page it is a deliberate contrast, and at Ink on an
     Ink page it is the right-hand rule that separates them.
     15.33 for text on Ink, 6.15 for the dim label, and the accent lifts to #6E93CC for anything read on it
     (5.76) while Flow Blue itself stays for fills and borders (3.99 — a UI component, not text). */
  --rail-ground: #0F1720;
  --rail-text: #E8EDF3;
  --rail-dim: rgba(232, 237, 243, .60);
  --rail-accent: #6E93CC;
  --rail-rule: rgba(232, 237, 243, .12);
  /* --live is tuned for a light ground and reads **3.01 on Ink** — a UI component's threshold, not text's,
     and .rail-mine is text. The dark theme's value is 9.37 there, so the rail borrows it for the same
     reason it borrows the rest: the surface is dark, so the tokens that work on a dark surface are the
     right ones. Found by measuring the rail's descendants rather than only its own rules. */
  --rail-live: #86C9A4;

  /* Flow Blue, and it is **not a small-text colour on anything but pure white**: 4.53:1 on white — which
     passes AA by 0.03 — then 4.11 on Mist and 3.87 on Sky, both failing. So --accent is for the things
     that need 3:1 (fills, borders, focus rings, icons, the dot) and --accent-text carries the same hue
     five percent darker for anything a person reads. Splitting them is the honest way to keep the brand
     colour and pass AA; using one token for both would mean either failing contrast or shipping a blue
     that is not the brand's. */
  --accent: #4C77B8;
  --accent-text: #436BA8;

  /* Attention, error, healthy. The brand sheet has no colour for any of these — it is Ink, one blue and
     three neutrals — so they are an extension rather than a mapping, kept from the previous palette
     because all three were already contrast-tuned and all three pass on the new grounds (5.22 / 6.10 /
     5.44 on Mist). --warn was called --signal and carried two jobs: brand emphasis and warning. The
     brand splitting the first out is what made the second nameable. */
  --warn: #9A5410;
  --alarm: #A5342A;
  --live: #2F6F4E;

  /* Satoshi first and never shipped — fonts/README.md records why: its licence permits self-hosting and
     forbids redistribution, and this repository *is* the distribution channel (ADR 24). A designer with it
     installed sees the brand exactly; everybody else gets Plus Jakarta Sans, which is the closest OFL face
     to it and is served from this origin. Inter is the brand's body face and is served the same way.
     Nothing is fetched from a third party, which is the rule the fonts changed the mechanism of but not
     the substance of. */
  --display: Satoshi, "Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --body: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  /* Kept. The brand names no monospace and this product needs one: every figure on this interface is
     tabular by a rule older than the branding — "every number carries a receipt" is not a typographic
     preference, and a proportional 8 beside a proportional 3 in a column of costs is unreadable. */
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ground: #0F1720;       /* Ink becomes the ground */
    --ground-2: #16202B;     /* lifted one step, for surfaces that sit above it */
    --sky: #1C2836;
    --text: #E8EDF3;
    /* .60 rather than light's .66, and the asymmetry is real rather than an oversight: light text on a
       dark ground and dark text on a light one are not mirror images. .55 already passes here (5.36 /
       5.15); .60 takes it to 6.15 / 5.86 for margin. */
    --dim: rgba(232, 237, 243, .60);
    --rule: rgba(232, 237, 243, .12);
    --rule-strong: rgba(232, 237, 243, .26);
    /* .37 rather than light's .47, the same asymmetry --dim carries and for the same reason: it is the
       first alpha clearing 3:1 across Ink, the lifted surface and the dark sky (3.01 at worst). */
    --control-edge: rgba(232, 237, 243, .37);
    /* The rail keeps Ink here too, where it coincides with the page ground — so what separates them is the
       rule, not the fill. A rail lifted *above* a dark page would invert the mockup's relationship, in
       which the rail is the darker surface. */
    --rail-ground: #0F1720;
    --rail-text: #E8EDF3;
    --rail-dim: rgba(232, 237, 243, .60);
    --rail-accent: #6E93CC;
    --rail-rule: rgba(232, 237, 243, .12);
    --rail-live: #86C9A4;

    /* Flow Blue reads 3.99:1 on Ink — fine for a border or a focus ring, short of AA for text. So the dark
       theme lifts the accent rather than keeping the brand hex and failing quietly: #6E93CC is 5.76 on Ink
       and 5.26 on the lifted surface, and both tokens can then be the same value. */
    --accent: #6E93CC;
    --accent-text: #6E93CC;

    --warn: #E9A35C;
    --alarm: #E8695C;
    --live: #86C9A4;
  }
}

/* The four faces this Node serves, from its own origin (fonts/README.md).
   font-display: swap on purpose: the alternative is a page that shows nothing until 71 KB has arrived,
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
  font-family: "Plus Jakarta Sans";
  src: url("/app/fonts/jakarta-600.woff2") format("woff2");
  font-weight: 600; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Plus Jakarta Sans";
  src: url("/app/fonts/jakarta-700.woff2") format("woff2");
  font-weight: 700; font-style: normal; font-display: swap;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--ground);
  color: var(--text);
  /* Inter for body copy, per the brand. The display face is for headings and the wordmark only —
     previously this line set the serif for everything, which is what made the old shell editorial. */
  font: 400 16px/1.6 var(--body);
  /* Faint top-lit gradient, so the panel has depth rather than reading as flat fill. */
  background-image: linear-gradient(180deg, color-mix(in oklab, var(--ground-2) 70%, transparent), transparent 38rem);
}

/* Grain. Generated inline — a texture that needed a network request would break the local-only
   rule the same way a webfont would. */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9;
  opacity: .035;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* ---- front panel ------------------------------------------------------------------------ */

.rack {
  border-bottom: 1px solid var(--rule);
  background: color-mix(in oklab, var(--ground-2) 60%, transparent);
  backdrop-filter: blur(6px);
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

/* The lockup: symbol then word, per the brand sheet's primary logo.
   It used to be MAIL-DA in letter-spaced uppercase with the second half in the accent colour, which was
   the instrument panel's idea of a wordmark. The brand sets it as one word in the display face at bold,
   slightly tightened, with the symbol carrying the colour — so the accent lives in the dot rather than in
   half the letters. */
.wordmark {
  display: flex;
  align-items: center;
  /* The brand sheet's clear-space rule is the height of the blue dot. The dot is 3.6 units in a 60-unit
     viewBox, so at a 26px mark that is about 1.6px — too small to be the whole gap at this size, and the
     rule is a minimum rather than a target. .5rem sits comfortably above it. */
  gap: .5rem;
  font-family: var(--display);
  font-weight: 700;
  font-size: 1.15rem;
  letter-spacing: -.015em;
  margin: 0;
  padding-right: clamp(.9rem, 3vw, 2rem);
  border-right: 1px solid var(--rule);
  white-space: nowrap;
  color: var(--text);
}
/* The mark inherits ink from the lockup; its dot is the accent, set in the SVG itself. */
.wordmark svg { flex: none; }

#status {
  display: flex;
  align-items: center;
  gap: clamp(.8rem, 2.5vw, 1.75rem);
  flex-wrap: wrap;
  font-family: var(--mono);
  font-size: .715rem;
  letter-spacing: .07em;
  text-transform: uppercase;
  color: var(--dim);
  margin-left: auto;
}
#status .field { display: inline-flex; align-items: center; gap: .45rem; white-space: nowrap; }
#status .key { opacity: .6; }
#status .num { color: var(--text); font-variant-numeric: tabular-nums; }
#status .session { color: var(--accent); font-variant-numeric: tabular-nums; }

.dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.dot.live { background: var(--live); animation: pulse 2.8s ease-out infinite; }
.dot.idle { background: var(--dim); }
@keyframes pulse {
  0%   { box-shadow: 0 0 0 0 color-mix(in oklab, var(--live) 55%, transparent); }
  70%  { box-shadow: 0 0 0 7px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}

button.linkish {
  font: inherit; letter-spacing: inherit; text-transform: inherit;
  background: none; border: 0; padding: 0; color: var(--dim); cursor: pointer;
  border-bottom: 1px solid var(--rule);
  /*
   * WCAG 2.2 AA 2.5.8 (target size, minimum): a pointer target must be at least 24x24 CSS pixels. These
   * are text-sized buttons -- "I have an invitation" measured 134.9 x 18.4 -- so the width was never the
   * problem and the height always was.
   *
   * Found on the **sign-in screen**, which had never been audited: the axe harness signs in first, so the
   * one page an operator meets when the Node is broken was the one page nothing checked. It is in the gate
   * now, and this is what it found on its first run.
   *
   * inline-flex with a min-height rather than vertical padding, because padding would push the
   * border-bottom away from the text and turn an underline into a box. The extra height is clickable and
   * invisible, which is exactly what 2.5.8 asks for.
   */
  display: inline-flex;
  align-items: center;
  min-height: 24px;
}
button.linkish:hover { color: var(--text); border-bottom-color: var(--rule-strong); }

/* ---- stage ------------------------------------------------------------------------------ */

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
@media (prefers-reduced-motion: reduce) {
  [data-reveal] { animation: none; }
  .dot.live { animation: none; }
}

h1 {
  font-family: var(--display);
  /* 700, not 400. The old serif carried a display size at book weight; a geometric sans does not — at
     3rem, Plus Jakarta Sans 400 reads as an outline rather than a heading, and the brand's own wordmark is
     bold. Only weights 600 and 700 are served, so nothing here can ask for one that is not there. */
  font-weight: 700;
  font-size: clamp(1.9rem, 4.6vw, 3rem);
  line-height: 1.1;
  letter-spacing: -.018em;
  margin: 0 0 1rem;
  max-width: 30ch;
  text-wrap: balance;
}

/* Asymmetric, and offset rather than centred: the claim sits left at reading width, the form sits
   right in its own panel. Centring both would make this look like every other sign-in page. */
.split {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr);
  gap: clamp(2rem, 6vw, 5rem);
  align-items: start;
}
.split-lede { padding-top: .4rem; }
.split-lede p { color: var(--dim); max-width: 42ch; font-size: 1.02rem; }
@media (max-width: 54rem) {
  .split { grid-template-columns: 1fr; }
  .split-lede p { max-width: none; }
}

.stage { max-width: 52ch; }
.lede { color: var(--dim); font-size: 1.05rem; }
.stage button.primary { margin-top: 1.4rem; }

/* ---- panel ------------------------------------------------------------------------------ */

.panel {
  border: 1px solid var(--rule);
  background: color-mix(in oklab, var(--ground-2) 80%, transparent);
  padding: clamp(1.4rem, 3vw, 2rem);
  position: relative;
}
/* Corner tick — a schematic's registration mark. Cheap, and it makes the panel read as drawn
   rather than as one more rounded card. */
.panel::after {
  content: "";
  position: absolute;
  top: -1px; right: -1px;
  width: 13px; height: 13px;
  border-top: 1px solid var(--accent);
  border-right: 1px solid var(--accent);
}
.panel h2 {
  font-family: var(--mono);
  font-size: .715rem;
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--dim);
  font-weight: 400;
  margin: 0 0 1.4rem;
}

form { display: grid; gap: 1rem; }

.field-row { display: grid; gap: .35rem; }
.field-row > span {
  font-family: var(--mono);
  font-size: .68rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--dim);
}

input {
  font: 400 .95rem/1.5 var(--mono);
  color: var(--text);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--rule-strong);
  padding: .5rem .1rem;
  width: 100%;
  transition: border-color .18s, background-color .18s;
}
input::placeholder { color: color-mix(in oklab, var(--dim) 60%, transparent); }
input:focus {
  outline: 0;
  border-bottom-color: var(--accent);
  background: color-mix(in oklab, var(--accent) 5%, transparent);
}

button.primary {
  font: 400 .72rem/1 var(--mono);
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ground);
  background: var(--accent);
  border: 1px solid var(--accent);
  padding: .8rem 1.3rem;
  cursor: pointer;
  justify-self: start;
  margin-top: .4rem;
  transition: filter .18s, transform .12s;
}
button.primary:hover:not(:disabled) { filter: brightness(1.12); }
button.primary:active:not(:disabled) { transform: translateY(1px); }
button.primary:disabled { opacity: .55; cursor: progress; }

.hint {
  font-family: var(--mono);
  font-size: .7rem;
  line-height: 1.55;
  color: var(--dim);
  /* Pulled up to hug the field it explains. At the uniform form gap it sat equally far from the
     field above and the label below, which reads as belonging to neither. */
  margin: -.6rem 0 0;
  padding-left: .1rem;
}

.notice {
  font-family: var(--mono);
  font-size: .74rem;
  line-height: 1.6;
  white-space: pre-wrap;
  border-left: 2px solid var(--rule-strong);
  padding: .55rem .8rem;
  margin: 0;
  color: var(--dim);
}
.notice.bad { border-left-color: var(--alarm); color: var(--text); }
.errors:empty { display: none; }

/*
 * The notice band (#63 part B): blueprint 7's notification, delivered in the product.
 *
 * Above the stage rather than in the rail, and it is deliberately not dismissible -- there is no control
 * here because there is no endpoint behind one. Blueprint 7 requires the notification not be disableable
 * by the investigator, and the cheapest way to hold that is for nothing in the interface to be able to
 * clear it.
 *
 * No colour of its own: it borrows --warn through .notice.told, so the contrast tokens this stylesheet
 * is checked against (test/node/contrast.test.ts) are unchanged by it.
 */
.notices { display: grid; gap: .4rem; margin: 0 0 1.2rem; }
.notice.told { border-left-color: var(--warn); color: var(--text); }
.notice .told-meta { color: var(--dim); }

/* ---- ledger ----------------------------------------------------------------------------- */

.ledger-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  border-bottom: 1px solid var(--rule-strong);
  padding-bottom: .9rem;
  margin-bottom: .25rem;
}
.ledger-head h1 { margin: 0; font-size: clamp(1.5rem, 3vw, 2rem); }
/*
  The new-message control (#79) is the third child of a space-between header, which would otherwise strand
  it in the middle. margin-left:auto takes up the slack so the heading stays left and the control sits with
  the count on the right, where the other per-screen actions are.
*/
.new-message { margin: 0 0 0 auto; display: flex; align-items: baseline; gap: .4rem; }
.new-message select { font: inherit; font-family: var(--mono); font-size: .8rem; }

/* The Butler screen (#78). */
.butler-detail { margin-top: 1.5rem; border-top: 1px solid var(--rule-strong); padding-top: 1rem; }
.butler-detail h2 { margin: 0; font-size: 1.2rem; }
.butler-source {
  width: 100%;
  font-family: var(--mono);
  font-size: .78rem;
  line-height: 1.5;
  /* A program is read by its indentation, so wrapping is off and the box scrolls instead. */
  white-space: pre;
  overflow-wrap: normal;
  overflow-x: auto;
}
/*
 * The format selector (#87). A fieldset, so the browser's default border and padding have to go -- the
 * question is one line of a form, not a boxed section, and every other field-row here is borderless.
 */
.butler-format {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: .1rem .8rem;
  border: 0;
  margin: 0 0 .6rem;
  padding: 0;
}
.butler-format legend {
  /* float rather than display, because a legend set to anything else stops being announced as the
     group's name in several screen readers -- which is the entire reason this is a fieldset. */
  float: left;
  padding: 0;
  margin-right: .8rem;
  color: var(--dim);
  font-size: .8rem;
}
.butler-format label { font-family: var(--mono); font-size: .8rem; }
.butler-format .dim { font-size: .78rem; }
.butler-actions { margin: .6rem 0 1.2rem; }

/* Your own passkeys (#84), on the People screen. */
.passkeys { margin: 1.4rem 0 2rem; border-top: 1px solid var(--rule); padding-top: 1rem; max-width: 46rem; }
.passkeys h2 { margin: 0 0 .4rem; font-size: 1rem; }
.passkeys .dim { font-size: .82rem; }
.passkeys .field-row { margin: .8rem 0 .4rem; max-width: 22rem; }

/* Sending credentials (#86), on the doctor screen beside the finding they answer. */
.transport { margin-top: 1.6rem; border-top: 1px solid var(--rule); padding-top: 1rem; max-width: 40rem; }
.transport h2 { margin: 0 0 .4rem; font-size: 1rem; }
.transport .field-row { margin: .6rem 0; }
.transport input { width: 100%; }
.transport .dim { font-size: .8rem; }

/* The dry run (#87). A section rather than a card: hairline rules, like everything else on this panel. */
.butler-dry { border-top: 1px solid var(--rule); padding-top: .9rem; margin-bottom: 1.4rem; }
.butler-dry h3 { margin: 0 0 .4rem; font-size: .95rem; }
.butler-dry-runs { list-style: none; margin: .5rem 0; padding: 0; }
.butler-dry-runs li { margin: .25rem 0; font-size: .82rem; }
.butler-dry-result { margin-top: .8rem; }
/* The detail is JSON on one line and can be long. It scrolls in its own cell rather than widening the
   table, which is the rule the whole panel follows: nothing makes the page scroll sideways. */
.butler-dry-detail { max-width: 26rem; overflow-x: auto; white-space: nowrap; font-size: .72rem; }
/* The limits are the sentences that stop this being read as a green light, so they are not dimmed away. */
.butler-dry-limits { margin: .7rem 0 0; padding-left: 1.1rem; font-size: .82rem; }
.butler-dry-limits li { margin: .3rem 0; }
/* The checker's findings arrive as several lines and are the whole value of a refusal — kept as written. */
.butler-findings { white-space: pre-wrap; font-family: var(--mono); font-size: .78rem; }
.butler-pause { margin-top: 1rem; }
.butler-pause p { margin: 0 0 .4rem; }
.butler-runs-heading { margin-top: 2rem; font-size: 1.1rem; }

/* Approvals (#81). One card per decision — a table would make the gravest and the most routine identical. */
.approval-list { display: flex; flex-direction: column; gap: 1.25rem; margin-top: 1rem; }
.approval {
  border: 1px solid var(--rule-strong);
  border-radius: 2px;
  padding: 1rem 1.1rem;
}
.approval h2 { margin: 0 0 .3rem; font-size: 1.05rem; }
.approval > p { margin: 0 0 .8rem; }
.approval .headers { margin: 0 0 .8rem; }
/* The requester's own words, set apart from the Node's — whose sentence it is matters when deciding. */
.approval-reason {
  margin: 0 0 .8rem;
  padding: .5rem .8rem;
  border-left: 2px solid var(--rule-strong);
  font-style: italic;
}
.approval-actions { margin: .8rem 0 0; }

/* Rules (#81). The editor is a column of labelled controls, not a grid — each answer changes the sentence. */
.policy-editor {
  margin-top: 1.5rem;
  border-top: 1px solid var(--rule-strong);
  padding-top: 1rem;
  max-width: 44rem;
}
.policy-editor h2 { margin: 0 0 .8rem; font-size: 1.1rem; }
.policy-editor select, .policy-editor input { font: inherit; font-family: var(--mono); font-size: .82rem; }
.policy-actions { margin: 1rem 0 0; }

/* People (#81). Relations as a list of what each one lets somebody do, not a grid of tokens. */
.people-mailbox { margin-top: 1.75rem; }
.people-mailbox h2, .people-teams h2 { margin: 0 0 .5rem; font-size: 1.05rem; }
.people-teams { margin-top: 2rem; border-top: 1px solid var(--rule-strong); padding-top: 1rem; }
.grant-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .25rem; }
.grant-list label { display: block; font-size: .84rem; cursor: pointer; }
.grant-object { margin: .4rem 0 0; font-size: .7rem; }

/* Sending limits (#81). */
.limits-pauses { margin-top: 2rem; border-top: 1px solid var(--rule-strong); padding-top: 1rem; }
.limits-pauses h2 { margin: 0 0 .4rem; font-size: 1.05rem; }
.limits-ask { display: flex; flex-wrap: wrap; align-items: end; gap: .8rem; margin: 1rem 0; }
.limits-ask .field-row { margin: 0; }

/* Matters (#81): four coupled things down one page, each a block with its own heading. */
.matter-block { margin-top: 2rem; border-top: 1px solid var(--rule-strong); padding-top: 1rem; }
.matter-block h2 { margin: 0 0 .4rem; font-size: 1.05rem; }
.matter-block > p { margin: 0 0 .6rem; }

/* The minted invitation secret (#83): shown once, so it has to be readable and selectable. */
.invite-secret { margin-top: 1rem; }
.invite-secret p { margin: 0 0 .4rem; }
.invite-value {
  font-size: .95rem;
  letter-spacing: .04em;
  word-break: break-all;
  user-select: all;
  padding: .5rem .7rem;
  border: 1px dashed var(--rule-strong);
}
.count { font-size: .7rem; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); margin: 0; }

.scroller { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
thead th {
  font-family: var(--mono);
  font-size: .655rem;
  font-weight: 400;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--dim);
  text-align: left;
  padding: .9rem .7rem;
  border-bottom: 1px solid var(--rule);
}
th.num, td.num { text-align: right; }
tbody td {
  padding: .8rem .7rem;
  border-bottom: 1px solid var(--rule);
  font-size: .92rem;
  vertical-align: baseline;
  word-break: break-word;
}
.mono { font-family: var(--mono); }

/* The ten recovery codes (#134). Spaced and numbered, because they are read off a screen and typed
   somewhere else, and a dense block is where a transcription error hides. Each item selects whole, so one
   click takes a complete code rather than part of one.
   No backticks in this comment: the whole stylesheet is a template literal, and one would end it. */
.codes { margin: 0 0 1rem; padding-left: 1.9rem; display: grid; gap: .34rem; }
.codes li { font-size: .82rem; letter-spacing: .02em; user-select: all; }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
td.dim { color: var(--dim); }

tr.entry { cursor: pointer; transition: background-color .14s; }
tr.entry:hover, tr.entry:focus-visible { background: color-mix(in oklab, var(--accent) 6%, transparent); outline: 0; }
tr.entry:focus-visible td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
tr.entry.open { background: color-mix(in oklab, var(--accent) 7%, transparent); }
tr.entry.open td { border-bottom-color: transparent; }

tr.detail td { padding: .2rem .7rem 1.1rem; background: color-mix(in oklab, var(--accent) 4%, transparent); }
tr.detail dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: .3rem 1.2rem;
  margin: 0;
  font-family: var(--mono);
  font-size: .73rem;
}
tr.detail dt { color: var(--dim); letter-spacing: .1em; text-transform: uppercase; font-size: .655rem; padding-top: .12rem; }
tr.detail dd { margin: 0; word-break: break-all; }

/* ---- body, composer, outbox ------------------------------------------------------------- */

/* The trust boundary is the sandbox attribute, not this styling. Sized generously because an email
   body has no reliable height and clipping it would hide content. */
.body-frame {
  width: 100%;
  min-height: 18rem;
  border: 1px solid var(--rule);
  background: color-mix(in oklab, var(--ground-2) 90%, transparent);
  margin-top: .8rem;
}
.body-text {
  font-family: var(--mono);
  font-size: .8rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  margin: .8rem 0 0;
  padding: .8rem;
  border: 1px solid var(--rule);
  max-height: 26rem;
  overflow: auto;
}
.body-host:empty { display: none; }
.row-actions { margin: .6rem 0 .2rem; display: flex; gap: 1rem; }

textarea {
  font: 400 .9rem/1.6 var(--mono);
  color: var(--text);
  background: transparent;
  border: 1px solid var(--rule-strong);
  padding: .6rem;
  width: 100%;
  resize: vertical;
}
textarea:focus { outline: 0; border-color: var(--accent); }

/* One colour per state, because §16 requires a state to mean the same thing everywhere and a reader
   should not have to remember which grey means which. */
.state {
  font-family: var(--mono);
  font-size: .655rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  padding: .18rem .45rem;
  border: 1px solid var(--rule-strong);
  white-space: nowrap;
}
.state-held           { border-color: var(--warn); color: var(--warn); }
.state-handed_over    { border-color: var(--live); color: var(--live); }
.state-cancelled      { color: var(--dim); }
.state-throttled      { border-color: var(--warn); color: var(--warn); }
.state-refused        { border-color: var(--alarm); color: var(--alarm); }
/* Reuses --alarm rather than introducing a token: a new colour would need its own contrast
   measurement (docs/receipts/contrast-tokens.md) for no gain — "did not leave, needs a person" is the
   same signal as refused. */
.state-withheld       { border-color: var(--alarm); color: var(--alarm); }
/* A policy gate (#60). --warn rather than --alarm, and rather than a new token: a gated send is waiting
   on a person, which is the same signal as held, and a fifth colour would need its own contrast
   measurement in docs/receipts/contrast-tokens.md for no gain. */
.state-awaiting       { border-color: var(--warn); color: var(--warn); }
/* The reason chip beside a state. Deliberately unpainted apart from the default rule colour: the state
   already carries the signal, and two coloured chips side by side would make the reader compare them. */
.state-reason         { color: var(--dim); }

/* Delivery is a different scale from submission — what the receiving world did, not what this Node did —
   so it reuses the same three signal colours rather than inventing a fourth. Every one of these is an
   existing token, which is what keeps contrast-tokens.md's measurement valid without re-measuring. */
.delivery-accepted    { border-color: var(--live); color: var(--live); }
.delivery-bounced     { border-color: var(--alarm); color: var(--alarm); }
.delivery-failed      { border-color: var(--alarm); color: var(--alarm); }
.delivery-rejected    { border-color: var(--alarm); color: var(--alarm); }
.delivery-deferred    { border-color: var(--warn); color: var(--warn); }
/* Unobserved is deliberately the quietest thing on the row. It is not a warning and not a success; it is
   the absence of news, and styling it loudly would make silence look like a finding. */
.delivery-unobserved  { color: var(--dim); }
/* Spacing only. The colour comes from the delivery-<state> class beside it, so a bounce summarised on a
   collapsed row is the same red as the bounce in the expanded one — there is no separate "mixed" amber
   to make a total failure look like a caution. */
.delivery-chip        { margin-left: .35rem; }

/* Gap larger than the .1rem that separates an address from its own error below it, so a long SMTP
   response reads as belonging to the recipient above it rather than the one below. With both gaps equal
   the error sat visually equidistant between two addresses, which in a bounce report is the one
   ambiguity that matters. */
.recipients { display: grid; gap: .65rem; }
.recipient {
  display: grid;
  grid-template-columns: 2.6rem minmax(0, 1fr) auto;
  gap: .5rem;
  align-items: baseline;
}
.recipient .label { font-size: .6rem; }
.recipient .mono { font-size: .73rem; word-break: break-all; }
/* The provider's own words, on their own line so a long SMTP response does not shove the state chip out
   of the row. Shown verbatim: a paraphrase of somebody else's mail server is a guess. */
.recipient-error {
  grid-column: 1 / -1;
  font-size: .66rem;
  line-height: 1.5;
  padding-left: 3.1rem;
  margin-top: .1rem;
}
.state-suppressed     { border-color: var(--alarm); color: var(--alarm); }
.state-outcome_unknown{ border-color: var(--alarm); color: var(--alarm); }
.state-audit-ok       { border-color: var(--live); color: var(--live); }
.state-audit-refused  { border-color: var(--warn); color: var(--warn); }
.state-audit-failed   { border-color: var(--alarm); color: var(--alarm); }
.state-log-info       { color: var(--dim); }
.state-log-warn       { border-color: var(--warn); color: var(--warn); }
.state-log-error      { border-color: var(--alarm); color: var(--alarm); }

/* --accent-text, not --accent: a link is small text and Flow Blue is 4.11:1 on Mist. The underline
   stays the lighter accent, because a 1px rule needs 3:1 rather than 4.5:1 and the brand hue reads
   better there. */
a { color: var(--accent-text); text-decoration: none; border-bottom: 1px solid color-mix(in oklab, var(--accent) 40%, transparent); }
a:hover { border-bottom-color: var(--accent); }
tbody a { font-size: .8rem; }
/* ---- variant B: the application shell (ADR 30) ------------------------------------------- */

/* A rail, a stage, and an instrument bar. Grid rather than flex so the bar is pinned to the bottom
   without position:fixed — a fixed bar overlaps the last row of a ledger, which on a table of send
   outcomes is the row somebody scrolled down to read. */
.app-shell {
  display: grid;
  grid-template-columns: minmax(11rem, 14rem) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas: "rail stage" "bar bar";
  min-height: 100vh;
}

/* The rail is **Ink in both schemes**, which is the brand sheet's product mockup rather than a theme
   decision: the rail is the dark surface and the mail sits on the light one. Its own tokens, so a reader of
   this block can see that every colour inside it is measured against Ink and not against the page.

   What is *not* taken from the mockup is the shape. There the rail is a narrow strip of icons; here it
   carries mailboxes and ledgers with their counts, because chrome.tsx argues for that and the mockup was
   not drawn against this product's information architecture. Adopting the surface and the mark while keeping
   the structure is the honest half to take. */
.rail {
  grid-area: rail;
  border-right: 1px solid var(--rail-rule);
  padding: 1rem 0 1rem 0;
  display: flex;
  flex-direction: column;
  gap: .35rem;
  background: var(--rail-ground);
  color: var(--rail-text);
}
.rail .wordmark {
  border-right: 0;
  padding: 0 1rem .9rem 1rem;
  font-size: 1rem;
  color: var(--rail-text);
}
/* The mark's stroke inherits, so one variant serves both schemes; the dot keeps Flow Blue, which is the
   brand's monochrome-versus-full choice made explicitly rather than by whatever colour was nearest. */
.rail .wordmark svg { color: var(--rail-text); }
.rail-heading {
  font-family: var(--mono);
  font-size: .62rem;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--rail-dim);
  margin: .9rem 1rem .2rem 1rem;
}
.rail-list { list-style: none; margin: 0; padding: 0; }
.rail-foot { margin-top: auto; }
.rail-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: .5rem;
  padding: .34rem 1rem;
  color: var(--rail-text);
  text-decoration: none;
  /* A 2px transparent marker rather than a border that appears on selection: a border that only exists
     when current shifts every other row by two pixels as you navigate. */
  border-left: 2px solid transparent;
}
.rail-row:hover { background: color-mix(in oklab, var(--rail-text) 10%, transparent); }
/* Selected is the brand's Sky pill, and on Ink that is a **light fill in a dark rail** — 15.41 either way,
   so the row's text flips to Ink rather than staying light. The left marker keeps Flow Blue at 3.99 on Ink,
   which is a UI component's 3:1 and not text. */
.rail-row.current {
  border-left-color: var(--accent);
  background: var(--sky);
  color: var(--text);
}
.rail-row .num { font-family: var(--mono); font-size: .74rem; font-variant-numeric: tabular-nums; color: var(--rail-dim); }
/* The count inside a selected row sits on Sky, so it takes the light theme's dim rather than the rail's. */
.rail-row.current .num { color: var(--dim); }
.rail-name { font-size: .95rem; }
.rail-note { padding: .2rem 1rem .4rem 1rem; }

.app-main { grid-area: stage; min-width: 0; padding: clamp(1rem, 2.5vw, 2rem); }

.instrument-bar {
  grid-area: bar;
  border-top: 1px solid var(--rule);
  background: color-mix(in oklab, var(--ground-2) 60%, transparent);
  display: flex;
  align-items: center;
  gap: clamp(.8rem, 2.2vw, 1.6rem);
  flex-wrap: wrap;
  padding: .5rem clamp(1rem, 2.5vw, 2rem);
  font-family: var(--mono);
  font-size: .69rem;
  letter-spacing: .07em;
  text-transform: uppercase;
  color: var(--dim);
}
.instrument-bar .field { display: inline-flex; align-items: center; gap: .45rem; white-space: nowrap; }
.instrument-bar .key { opacity: .6; }
.instrument-bar .num { color: var(--text); font-variant-numeric: tabular-nums; }
.instrument-bar .session { color: var(--accent); font-variant-numeric: tabular-nums; }
.instrument-bar a.linkish { color: var(--dim); text-decoration: none; border-bottom: 1px solid var(--rule); }
.bar-spacer { margin-left: auto; }

/* doctor's three verdicts, reusing the existing signal tokens so contrast-tokens.md stays valid
   without re-measuring. */
.verdict-ok       { border-color: var(--live);   color: var(--live); }
.verdict-degraded { border-color: var(--warn); color: var(--warn); }
.verdict-refuse   { border-color: var(--alarm);  color: var(--alarm); }
.severity-refuse   { border-color: var(--alarm);  color: var(--alarm); }
.severity-degraded { border-color: var(--warn); color: var(--warn); }
.severity-report   { color: var(--dim); }

/* ---- list and reading pane --------------------------------------------------------------- */

.split {
  display: grid;
  grid-template-columns: minmax(14rem, 22rem) minmax(0, 1fr);
  gap: 0;
  align-items: start;
}
@media (max-width: 60rem) {
  /* The reading pane goes under the list rather than beside it. The rail collapses to a row of its own
     at the top, which keeps the mailbox counts visible — they are the thing Layer 3 adds to. */
  .app-shell { grid-template-columns: minmax(0, 1fr); grid-template-areas: "rail" "stage" "bar"; }
  .rail { border-right: 0; border-bottom: 1px solid var(--rule); flex-direction: row; flex-wrap: wrap; align-items: baseline; }
  .rail-foot { margin-top: 0; }
  .split { grid-template-columns: minmax(0, 1fr); }
}

/* Text for a screen reader and not for the eye. The repository had no such utility, which is why the search
   field carried a visible lowercase "search" label beside it — a label doing an accessible name's job and
   taking up the room the brand's pill needs. clip-path rather than display:none, which would take it out of
   the accessibility tree along with the layout. */
.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* ---- the search pill (#128) ---------------------------------------------------------------- */

.inbox-search { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }

/* The brand sheet draws this as a Mist fill on a White header with a hairline. **Mist on White is 1.10**,
   so the fill identifies nothing, and WCAG 1.4.11 wants 3:1 for the visual information that identifies a
   control — see --control-edge, which is the measured answer. The fill is kept because it is the brand's;
   the edge is what makes it a field. */
.search-pill {
  display: inline-flex;
  align-items: center;
  gap: .25rem;
  background: var(--ground);
  border: 1px solid var(--control-edge);
  border-radius: 999px;
  padding: .1rem .3rem .1rem .7rem;
  min-width: min(22rem, 100%);
}
.search-pill input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: .85rem;
  padding: .32rem 0;
}
/* The pill takes the focus ring, not the input inside it: a ring drawn around a borderless input inside a
   rounded container reads as a rectangle inside a pill. */
.search-pill input:focus { outline: none; }
.search-pill:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 30%, transparent);
}
.search-pill input::placeholder { color: var(--dim); opacity: 1; }
/* Chrome and Safari draw their own clear affordance on a search input, inside our pill and in their own
   idiom. Ours is a labelled button that also tells the Node to drop the filter, which theirs does not. */
.search-pill input::-webkit-search-decoration,
.search-pill input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }

/* The magnifier **is** the submit button, so a keyboard reaches it and a screen reader is told the search
   can be run. A decorative glyph beside a field that submits on Enter loses both. */
.search-go {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.7rem; height: 1.7rem;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--accent-text);
  cursor: pointer;
}
.search-go:hover { background: var(--sky); }
.search-clear { font-size: .8rem; }
/* The hint sits with the field rather than under the whole toolbar, so it reads as a description of the
   box beside it. Flex order keeps it after the pill and before Clear on one line, and it wraps below on a
   narrow screen rather than squeezing the pill. */
.search-hint { flex: 1 1 14rem; margin: 0; font-size: .72rem; }

.message-list { list-style: none; margin: 0; padding: 0; border-right: 1px solid var(--rule); }
.message-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.message-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: .1rem;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--rule);
  border-left: 2px solid transparent;
  padding: .6rem .9rem;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.message-row:hover { background: color-mix(in oklab, var(--ground-2) 70%, transparent); }
.message-row.current { border-left-color: var(--accent); background: color-mix(in oklab, var(--ground-2) 85%, transparent); }
.message-from { font-size: .74rem; color: var(--dim); }
.message-subject { font-size: .98rem; }
.message-when { font-size: .68rem; }

.reading-pane { padding: 0 0 0 clamp(1rem, 2.5vw, 2rem); min-width: 0; }
.reading-pane .message-title { font-size: clamp(1.15rem, 2.2vw, 1.5rem); margin: 0 0 .8rem 0; font-weight: 400; }
.headers { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: .2rem .8rem; margin: 0 0 1.2rem 0; }
.headers dt {
  font-family: var(--mono); font-size: .62rem; letter-spacing: .12em;
  text-transform: uppercase; color: var(--dim);
}
.headers dd { margin: 0; font-size: .85rem; word-break: break-word; }

/* An opaque-origin frame with no scripts and no same-origin access. The sandbox is the boundary, not
   the sanitiser (ADR 37) — so this element carries the security property and the height is the only
   cosmetic decision in it. */
.message-body {
  width: 100%;
  min-height: 24rem;
  border: 1px solid var(--rule);
  background: var(--ground-2);
}
.message-text { white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: .82rem; }

/* ---- ledgers ----------------------------------------------------------------------------- */

.ledger { min-width: 0; }
.ledger-head { display: flex; align-items: baseline; gap: 1rem; margin-bottom: .6rem; }
.ledger-head h1 { font-size: clamp(1.4rem, 2.6vw, 2rem); margin: 0; font-weight: 400; }
.ledger-head p { margin: 0; font-size: .68rem; letter-spacing: .1em; text-transform: uppercase; }
/* Tables scroll inside their own container. A ledger of send outcomes is the last thing that should
   make the whole page scroll sideways. */
.ledger table { width: 100%; }
.ledger { overflow-x: auto; }

.row-toggle {
  background: none; border: 0; padding: 0; margin: 0; font: inherit; color: inherit;
  text-align: left; cursor: pointer; width: 100%;
}
.row-toggle:hover { color: var(--accent); }
/* ---- the docked composer ----------------------------------------------------------------- */

/* Docked rather than a route, so replying does not move the original off screen. For invoice and
   shipment mail a reply exists to quote a reference from the message being replied to, and taking that
   away is a defect rather than a layout preference. */
.composer-dock {
  position: sticky;
  bottom: 0;
  grid-column: 1 / -1;
  border-top: 1px solid var(--rule-strong);
  background: var(--ground-2);
  padding: .9rem clamp(1rem, 2.5vw, 1.6rem) 1.1rem;
  /* Bounded, so a long reply scrolls inside the dock and the message behind it stays visible. */
  max-height: 60vh;
  overflow-y: auto;
}
.dock-head { display: flex; align-items: baseline; gap: .9rem; margin-bottom: .5rem; }
.dock-head h2 { font-size: 1.05rem; margin: 0; font-weight: 400; }


/* Where the bytes are. Amber because it is a caution, not a failure: the draft is real and it is not
   anywhere durable yet. */
.draft-phase {
  font-size: .63rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--accent);
}

.row-actions { margin: .2rem 0 1rem 0; }
.dock-actions { margin-left: auto; display: inline-flex; gap: .9rem; }
/* A failed save has to outweigh the reassurance it replaces: a draft that silently stopped saving is worse
   than one that never saved, because the earlier success taught the person to trust it. */
.draft-phase.failed { color: var(--alarm); }
/* ---- the handover ------------------------------------------------------------------------- */

/* body.shell is set by app.client.js the moment the React application mounts, and it is what retires
   Layer 1's chrome rather than leaving two of everything on the page. Without it the top rack kept its
   wordmark above the rail's, and main's 74rem measure boxed a shell meant to be full-bleed — both
   visible only by looking at the rendered page.

   No backticks anywhere in this stylesheet: it lives inside a TypeScript template literal, so one in a
   comment ends the string. That is the same hazard this file's header describes for JavaScript, and it
   cost a parse error here before it was spotted. */
body.shell .rack { display: none; }
body.shell main#app {
  max-width: none;
  margin: 0;
  padding: 0;
  /* The shell owns the viewport: its grid pins the instrument bar to the bottom, which only works if the
     element it lives in is as tall as the window. */
  min-height: 100vh;
}

/* Addresses are not prose and must not break mid-word: "billing@exam / ple.com" is unreadable and, on a
   ledger of who a message went to, actively misleading. The table gets a floor and its container
   scrolls instead. */
.ledger table { min-width: 52rem; }
/* The queue carries two columns the ledgers do not — a pick control and the response clock — and adding them
   first crushed the subject to a few characters per line. The fix attempted then was a 68rem floor, which
   traded the crushed subject for something worse: at a 1200px window the response clock and the action
   buttons both sat past the right edge, reachable only by a horizontal scroll whose bar macOS hides. The two
   columns a person acts on were the two that disappeared.

   So the queue keeps the ledgers' 52rem floor and earns its width back instead: the holder cell wraps
   between the name and the age (two nowrap spans, not one nowrap string) and the actions stack. Six columns
   then fit without scrolling at 1200px, which is the width the visual check runs at.

   One declared width, on the subject, and it is 100%. Under auto layout that means "give me the surplus": the
   five font-shaped columns settle at the width their content needs and everything left over goes to the one
   column that is prose. A ceiling was tried instead and did nothing useful, because a max-width does not stop
   the surplus going to the address columns, which do not need it — the subject came out at 146px while From
   sat at 226.

   Three wrong answers preceded it, recorded because each looked right: a 68rem floor (pushed the clock and
   the actions off a 1200px window entirely), table-layout: fixed with per-cent shares (clipped every address
   by about 20px, a share of the container being the wrong unit for text whose width the font sets), and a
   min/max pair on the subject (min-width on a table cell did not raise the column at all). */
.queue-table th:nth-child(2), .queue-table td:nth-child(2) { width: 100%; }
.queue-table .case-subject { display: inline-block; }
/* This cell is the exception to td.mono's nowrap: it holds two facts, so it may break between them but never
   inside either. An address split across lines reads as two addresses (the reason nowrap exists at all).
   Scoped under .ledger to outrank the .ledger td.mono rule above — equal specificity would leave this to
   source order, which is how the first version silently kept nowrap and overflowed its cell by 77px.
   (And no backticks in here. This is the third time one in a comment has closed this template literal.) */
.ledger .queue-table td.case-holder { white-space: normal; }
.ledger .queue-table td.case-holder > span { white-space: nowrap; }
/* Stacked, right-aligned. Side by side, release-and-close is the widest cell in the table for the sake of two
   words. Achieved with block buttons rather than a flex cell: display: flex on a td replaces its table-cell
   box, and the visible symptom was the row rule stopping short of the last column. */
.case-actions { text-align: right; }
.case-actions button { display: block; margin-left: auto; }
/* nowrap, not a smarter wrap. overflow-wrap: anywhere still split "billing@example.com" across lines,
   which reads as two addresses. The table has a floor and the ledger scrolls. */
.ledger td.mono { word-break: normal; overflow-wrap: normal; white-space: nowrap; }
/* ---- the shared queue (Layer 3) ----------------------------------------------------------- */

/* Three claim states, and colour is NOT what distinguishes them.

   contrast-tokens.md now proves --dim and both accent tokens. --warn, --alarm and --live are still
   unmeasured, so Blueprint 5C/5D's rule that colour must not be the only channel is doing real work here
   rather than being satisfied incidentally: every row states its state in a word, and the two claimed
   states differ in weight and in a left marker as well as in hue. */
.case-unclaimed { border-color: var(--rule-strong); color: var(--text); }
.case-yours     { border-color: var(--live);   color: var(--live); }
.case-held      { border-color: var(--warn); color: var(--warn); }

.case-row td { vertical-align: baseline; }
/* A marker, not a fill: a tinted row would put the state in colour alone. */
.case-row.mine td:first-child   { box-shadow: inset 2px 0 0 var(--live); }
.case-row.theirs td:first-child { box-shadow: inset 2px 0 0 var(--accent); }
.case-subject { font-size: .95rem; }
.case-count { font-size: .68rem; }
/* The withheld-content placeholder. A word in mono, so it cannot be mistaken for a subject line that happens
   to say "restricted" — and the word is the whole channel, since none of the tinted tokens are measured. No
   strikethrough and no lock glyph: both read as an error state, and this is a correct, ordinary answer. */
.restricted {
  font-family: var(--mono);
  font-size: .72rem;
  letter-spacing: .06em;
  color: var(--dim);
  border-bottom: 1px dotted var(--rule-strong);
  cursor: help;
}
/* The side-by-side spacing these two rules provided is gone with the stacking above, and they were still
   winning on source order: .75rem beat margin-left: auto, so the second button sat a few pixels in from the
   first instead of aligning with it. Kept as a note rather than deleted silently, because a stray rule that
   quietly overrides a later intention is the same class of thing as the swallowed one. */
.case-actions { white-space: nowrap; }

/* The composer's From selector, matched to the bare-underline fields beside it rather than left as browser
   furniture. It first shipped as an unstyled full-width native select among underlined inputs and looked
   like it belonged to a different application. */
.field-row select {
  font: inherit;
  font-family: var(--mono);
  font-size: .95rem;
  background: transparent;
  color: var(--text);
  border: 0;
  border-bottom: 1px solid var(--rule);
  padding: .3rem 0;
  width: auto;
  min-width: 18rem;
}
.field-row select:focus { outline: none; border-bottom-color: var(--accent); }

.queue-picker { display: inline-flex; align-items: baseline; gap: .5rem; margin-left: auto; }
.queue-picker span { font-size: .62rem; letter-spacing: .12em; text-transform: uppercase; }
.queue-picker select {
  font: inherit;
  font-family: var(--mono);
  font-size: .78rem;
  background: var(--ground-2);
  color: var(--text);
  border: 1px solid var(--rule-strong);
  padding: .2rem .4rem;
}

/* Per-mailbox depths under the Queue row. Indented rather than bulleted, so the rail stays a rail. */
.rail-sublist { list-style: none; margin: 0; padding: 0 0 .3rem 0; }
.rail-subrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: .5rem;
  padding: .16rem 1rem .16rem 1.9rem;
  font-size: .8rem;
}
.rail-mine { color: var(--rail-live); }
/* ---- the first-response clock ------------------------------------------------------------- */

/* Each carries a word, so none of them depends on colour being measured. --warn and --alarm are still
   unproven (contrast-tokens.md proves --dim and the accent pair), which is the third feature shaped by
   that gap. */
.clock-answered { border-color: var(--live);   color: var(--live); }
.clock-due      { border-color: var(--warn); color: var(--warn); }
.clock-breached { border-color: var(--alarm);  color: var(--alarm); }

.queue-target { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
.queue-breached { margin-left: auto; }

.target-edit { display: inline-flex; align-items: baseline; gap: .4rem; }
.target-edit span { font-size: .62rem; letter-spacing: .12em; text-transform: uppercase; }
.target-edit input {
  font-family: var(--mono);
  font-size: .78rem;
  width: 5rem;
  background: var(--ground-2);
  color: var(--text);
  border: 1px solid var(--rule-strong);
  padding: .18rem .35rem;
}

/* The pick control sits with the state word rather than in a column of its own: a case is picked *as* a
   state, and a bare checkbox column reads as a table that wants bulk actions it does not have. */
.case-pick { display: inline-flex; align-items: baseline; gap: .5rem; cursor: pointer; }
`;

/**
 * The values a browser needs and cannot work out for itself, as an ES module served from this origin (#97).
 *
 * ## Why this is not an inline script any more
 *
 * It shipped as `<script>window.MAILDA_CONFIG = {…}</script>` in the document. That is the one line that
 * decides whether this Node's CSP is real: keeping it needs either `script-src 'unsafe-inline'`, which
 * permits every injected script the directive exists to stop, or a per-response nonce shared between the
 * header and the document. A nonce is a correspondence to maintain — and one whose failure mode is a nonce
 * repeated across a cached document, which is worse than not having tried.
 *
 * ## Why a module rather than the JSON endpoint the ticket also offered
 *
 * `session.client.js` reads these at **module evaluation** to size the refresh margin and find the expiry
 * cookie. A `fetch` for JSON makes that asynchronous, which means the token lifecycle either waits on a
 * request or starts with the wrong numbers — in the file whose entire job is that a signed-in person never
 * sees a 401. An `import` keeps it synchronous, and a same-origin module *is* a same-origin endpoint:
 * `script-src 'self'` covers it with no nonce and nothing per-response to get wrong.
 *
 * ## What is in it, and what left
 *
 * Every receipt-derived figure the browser reads, and nothing else. `accessTtlSeconds` left because nothing
 * read it — a config field with no reader is a claim that something is configurable when it is not.
 *
 * `holdWindowSeconds` stayed, and it is the interesting one, because the composer *is* bundled by esbuild
 * from this repository and could import `@mailda/budgets` directly. Measured, that costs **+7,960 bytes raw
 * / +2,783 gzip** in the shell bundle to deliver one integer, because the whole 218-entry table comes with
 * it — against `docs/receipts/react-shell-bundle.md`, whose subject is what that bundle costs somebody
 * waiting for it. It would also give the browser two channels for the same kind of number, one baked in at
 * build and one served at runtime, so a figure in the interface disagreeing with the Node would have two
 * places to look. One channel, therefore, for bundled and unbundled readers alike.
 *
 * The defaults left with the global. `config.refreshMarginSeconds ?? 120` was two unreceipted literals
 * standing in for a `window` property that might not be there; a static import cannot be absent, so the
 * fallbacks are gone rather than merely unused.
 */
function configModule(): string {
  const config = {
    refreshMarginSeconds: BUDGETS["auth.access_token_refresh_margin_seconds"],
    expiryCookie: EXPIRY_COOKIE,
    // The composer tells a person how long they have to stop a send. That is the hold window, and it comes
    // from the receipt-generated budget rather than being typed into the interface — exactly the drift
    // `pnpm receipts` exists to prevent, and the prototype already showed it happening: its mock said 18
    // seconds against a measured 15.
    holdWindowSeconds: BUDGETS["send.hold_window_default_seconds"],
  };
  // `<` escaped as \\u003c: valid JSON, valid JavaScript, and inert if this string is ever interpolated
  // into markup by something that does not know it was not meant to be. Nothing in here is
  // attacker-controlled — a generated budget and a constant cookie name — so this is not a live
  // vulnerability, and it stays because the *shape* becomes one the first time the config holds
  // something dynamic.
  return `export const CONFIG = ${JSON.stringify(config).replace(/</g, "\\u003c")};\n`;
}

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<!--
  Inline, as a data: URI, for the same reason there is no webfont: a page whose premise is custody must not
  fetch anything from anywhere. It is also the cheapest fix for a real defect — with no icon declared, every
  browser asked for /favicon.ico and every load logged a 404, so the console of a working Node had an error
  in it permanently and anybody debugging had one false lead before they started.

  The Mailda symbol on a rounded ink tile (src/brand.ts). At 16px the stroke detail is past what the
  reconstruction in that file can honestly carry, which its header says plainly — a real vector should
  replace it before anybody treats this icon as final.
-->
<link rel="icon" type="image/svg+xml" href="${faviconDataUri()}">
<title>Mailda</title>
<link rel="stylesheet" href="/app/app.css">
</head>
<body>
<div class="rack">
  <div class="rack-inner">
    <p class="wordmark">${MARK_IS_AUTHORED ? markSvg({ size: 26 }) : ""}<span>Mailda</span></p>
    <div id="status"></div>
  </div>
</div>
<main id="app"></main>
<!--
  What an operator sees when the bundle does not run (#92, found by driving the browser).
  Without this the page rendered the wordmark and nothing else: no form, no error, no hint — and the first
  screen a Node ever shows is the claim, so the failure landed on the one page whose whole job is to be
  reachable. A blank page is the worst available diagnostic because it looks like a network problem.
-->
<noscript>
  <div class="rack"><div class="rack-inner">
    <p><strong>This page needs JavaScript.</strong></p>
    <p>Claiming a Node, signing in and reading the diagnostic all run in the browser. Nothing here is
    rendered on the server, so with scripting disabled this page can show you only this notice.</p>
    <p>The diagnostic is available as plain text and needs no scripting:
    <a href="/api/doctor?format=text">/api/doctor?format=text</a>.</p>
  </div></div>
</noscript>

<script type="module" src="/app/app.js"></script>
</body>
</html>`;
}

/**
 * Browser assets, served as real files rather than inlined.
 *
 * Two practical reasons for the scripts: the module graph works (`app.js` imports `./session.js` and the
 * browser resolves it against the same directory), and the sources stay lintable `.js` on disk instead of
 * becoming strings inside a template literal.
 *
 * The stylesheet and the config module are here for a third: **the document must contain no inline script
 * and no inline style**, or the CSP in `security-headers.ts` has to permit inline ones and stops meaning
 * anything.
 *
 * `content-type` per entry rather than one for all of them, simply because they are three different types
 * and a shared value would be wrong for at least one. It is **not** `nosniff` that makes this matter, which
 * is what this comment said first: a standards-mode document already refuses a `<link rel=stylesheet>` whose
 * MIME type is not CSS, and has for years, with or without the header. What `nosniff` adds is elsewhere —
 * it stops a *response* being reinterpreted as a type it did not declare, which is why it ships on the
 * download routes rather than why it ships on these.
 */
const CLIENT_ASSETS: Record<string, { readonly source: string | (() => string); readonly type: string }> = {
  "/app/app.js": { source: appScript, type: "text/javascript; charset=utf-8" },
  "/app/session.js": { source: sessionScript, type: "text/javascript; charset=utf-8" },
  // The delivery vocabulary and the rule about which outcomes a reader is shown. A separate module so a
  // test can evaluate it — `app.client.js` touches `document` at load, so nothing could reach it there,
  // and the one rule that decides whether a bounce is visible was the one rule with no coverage.
  "/app/delivery.js": { source: deliveryScript, type: "text/javascript; charset=utf-8" },
  // The React application (ADR 30). Imported dynamically by `app.client.js` once somebody is signed in,
  // so the screens an operator needs when the Node is broken never wait on a hundred kilobytes of it.
  "/app/shell.js": { source: shellBundle, type: "text/javascript; charset=utf-8" },
  "/app/app.css": { source: SHELL_CSS, type: "text/css; charset=utf-8" },
  // A function rather than a string, because this one is generated. Held as the generator instead of its
  // result so there is no module-level value to go stale, and no empty string sitting in this record for a
  // special case elsewhere to fill in.
  "/app/config.js": { source: configModule, type: "text/javascript; charset=utf-8" },
};

/**
 * The webfonts, kept apart from `CLIENT_ASSETS` for two reasons that are both about them being bytes.
 *
 * They are `ArrayBuffer`s rather than strings, so they cannot share that record's type. And they want the
 * **opposite cache policy**: the assets above are 60 seconds, so an OTA update (ADR 24) takes effect on the
 * next load rather than appearing to have silently not happened. A font file never changes — the name
 * carries the family and the weight, and a new weight is a new name — so it is immutable for a year, and
 * paying 71 KB on every load to keep a freshness guarantee that cannot apply would be a waste with no
 * upside.
 */
const FONT_FILES: Record<string, ArrayBuffer> = {
  "/app/fonts/inter-400.woff2": interRegular,
  "/app/fonts/inter-500.woff2": interMedium,
  "/app/fonts/jakarta-600.woff2": jakartaSemibold,
  "/app/fonts/jakarta-700.woff2": jakartaBold,
};

export function clientAsset(pathname: string): Response | null {
  const font = FONT_FILES[pathname] ?? null;
  if (font !== null) {
    return new Response(font, {
      headers: {
        "content-type": "font/woff2",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  const asset = CLIENT_ASSETS[pathname] ?? null;
  if (asset === null) return null;

  return new Response(typeof asset.source === "function" ? asset.source() : asset.source, {
    headers: {
      "content-type": asset.type,
      // Short, because these ship inside the Worker: a deploy should take effect on the next load,
      // or an OTA update (ADR 24) appears to have silently not happened.
      "cache-control": "public, max-age=60",
    },
  });
}
