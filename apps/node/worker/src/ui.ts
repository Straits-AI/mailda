import { BUDGETS } from "@mailda/budgets";

import appScript from "./client/app.client.js";
import sessionScript from "./client/session.client.js";
import { EXPIRY_COOKIE } from "./auth/session.ts";

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
 * JSON safe to embed in a `<script>` element.
 *
 * `</script>` inside a JSON string ends the element early, whatever the JSON says. Nothing in this
 * config is attacker-controlled — it is generated budgets and a constant cookie name — so this is not
 * a live vulnerability. It is here because the *shape* is the one that becomes one the first time
 * something dynamic is added, and the fix costs a line. `<` is escaped as a unicode sequence, which is
 * valid JSON and inert in HTML.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function page(): string {
  const config = {
    refreshMarginSeconds: BUDGETS["auth.access_token_refresh_margin_seconds"],
    accessTtlSeconds: BUDGETS["auth.access_token_ttl_seconds"],
    expiryCookie: EXPIRY_COOKIE,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Mailda</title>
<style>
:root {
  --ground: #0a0e13;
  --ground-2: #10161e;
  --rule: rgba(226, 215, 195, .13);
  --rule-strong: rgba(226, 215, 195, .30);
  --text: #e6dfd2;
  --dim: rgba(230, 223, 210, .52);
  --signal: #e9a35c;
  --alarm: #e8695c;
  --live: #86c9a4;

  /* Editorial serif for prose, monospace for every figure. Two families, used with discipline —
     labels are the monospace at small size with wide tracking, which is what gives the panel its
     instrument character without introducing a third face. */
  --display: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Charter, Georgia, serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}

@media (prefers-color-scheme: light) {
  :root {
    --ground: #f1ece0;
    --ground-2: #fbf8f1;
    --rule: rgba(26, 22, 16, .16);
    --rule-strong: rgba(26, 22, 16, .34);
    --text: #1b1712;
    --dim: rgba(27, 23, 18, .58);
    --signal: #9a5410;
    --alarm: #a5342a;
    --live: #2f6f4e;
  }
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--ground);
  color: var(--text);
  font: 400 16px/1.6 var(--display);
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

.wordmark {
  font-family: var(--display);
  font-size: 1.15rem;
  letter-spacing: .22em;
  text-transform: uppercase;
  margin: 0;
  padding-right: clamp(.9rem, 3vw, 2rem);
  border-right: 1px solid var(--rule);
  white-space: nowrap;
}
.wordmark span { color: var(--signal); }

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
#status .session { color: var(--signal); font-variant-numeric: tabular-nums; }

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
  font-weight: 400;
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
  border-top: 1px solid var(--signal);
  border-right: 1px solid var(--signal);
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
  border-bottom-color: var(--signal);
  background: color-mix(in oklab, var(--signal) 5%, transparent);
}

button.primary {
  font: 400 .72rem/1 var(--mono);
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ground);
  background: var(--signal);
  border: 1px solid var(--signal);
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
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
td.dim { color: var(--dim); }

tr.entry { cursor: pointer; transition: background-color .14s; }
tr.entry:hover, tr.entry:focus-visible { background: color-mix(in oklab, var(--signal) 6%, transparent); outline: 0; }
tr.entry:focus-visible td:first-child { box-shadow: inset 2px 0 0 var(--signal); }
tr.entry.open { background: color-mix(in oklab, var(--signal) 7%, transparent); }
tr.entry.open td { border-bottom-color: transparent; }

tr.detail td { padding: .2rem .7rem 1.1rem; background: color-mix(in oklab, var(--signal) 4%, transparent); }
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

a { color: var(--signal); text-decoration: none; border-bottom: 1px solid color-mix(in oklab, var(--signal) 40%, transparent); }
a:hover { border-bottom-color: var(--signal); }
tbody a { font-size: .8rem; }
</style>
</head>
<body>
<div class="rack">
  <div class="rack-inner">
    <p class="wordmark">Mail<span>da</span></p>
    <div id="status"></div>
  </div>
</div>
<main id="app"></main>

<script>window.MAILDA_CONFIG = ${safeJson(config)};</script>
<script type="module" src="/app/app.js"></script>
</body>
</html>`;
}

/**
 * Browser scripts, served as real files rather than inlined.
 *
 * Two practical reasons: the module graph works (`app.js` imports `./session.js` and the browser
 * resolves it against the same directory), and the sources stay lintable `.js` on disk instead of
 * becoming strings inside a template literal.
 */
export function clientScript(pathname: string): Response | null {
  const source =
    pathname === "/app/app.js" ? appScript : pathname === "/app/session.js" ? sessionScript : null;
  if (source === null) return null;

  return new Response(source, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Short, because these ship inside the Worker: a deploy should take effect on the next load,
      // or an OTA update (ADR 24) appears to have silently not happened.
      "cache-control": "public, max-age=60",
    },
  });
}
