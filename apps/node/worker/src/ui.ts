import { BUDGETS } from "@mailda/budgets";

import appScript from "./client/app.client.js";
import shellBundle from "../generated/app.bundle.client.js";
import localeModule from "../generated/locale.bundle.client.js";
// The webfonts, as ArrayBuffers via wrangler's `Data` rule. Served from this origin and never fetched from
// anywhere else — `fonts/README.md` records why that is a product rule, and why the brand's Satoshi was never
// shipped.
import interRegular from "../fonts/inter-400.woff2";
import interMedium from "../fonts/inter-500.woff2";
import interSemibold from "../fonts/inter-600.woff2";
import interBold from "../fonts/inter-700.woff2";
import deliveryScript from "./client/delivery.client.js";
import sessionScript from "./client/session.client.js";
import themeScript from "./client/theme.client.js";
import { EXPIRY_COOKIE } from "./auth/session.ts";
import { ATTACHMENT_BUDGET, MAX_ATTACHMENTS, MAX_OUTBOUND_BYTES } from "./outbound/attachment-budget.ts";
import { MARK_IS_AUTHORED, faviconDataUri, markSvg } from "./brand.ts";
import { parts } from "./i18n/format.ts";
import { LOCALES } from "./i18n/locales.ts";
import { PREAUTH } from "./i18n/preauth.ts";
import { currentTable, servedTables } from "./i18n/served.ts";
import { SHELL_CSS } from "./shell-css.ts";
import { frameStylesheet } from "./theme.ts";

/**
 * The Node's interface shell: its document, and the assets the document loads.
 *
 * `page()` is the document every screen starts from. It carries no inline script and no inline style, so the
 * Content-Security-Policy in `security-headers.ts` can refuse both; everything it needs is a file from this
 * origin in `CLIENT_ASSETS` below. The framework-free script (`client/app.client.js`) renders the claim,
 * sign-in and recovery pages into it, and loads the React application once somebody is signed in.
 *
 * ## The look is the redesign's, and it lives in two modules
 *
 * `theme.ts` holds the colour tokens for both themes and the blocks that apply them; `shell-css.ts` holds the
 * stylesheet built on them, served here as `/app/app.css`. Dark is the default, and Light and System are the
 * viewer's choice, applied as `data-theme` on `<html>` by `bootTheme()` from `/app/theme.js`, the first call the
 * page's one script (`client/app.client.js`, served as `/app/app.js`) makes. That is a module script, which runs
 * after parsing, so the first paint can come before it; the `ponytail:` note beside the call says what the
 * upgrade is. Neither module imports anything that needs a browser, so a node test reads the served CSS itself.
 *
 * ## Fonts are local, and that is a product decision
 *
 * Inter is served from this origin in four weights (`fonts/README.md`), and no font, script, stylesheet or
 * image is ever fetched from anywhere else. Mailda's premise is custody — your account, your data, your keys —
 * and a page that fetches a font from a third party hands that third party every viewer's IP address on every
 * load. `font-src 'self'` holds it.
 */

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
 * Every receipt-derived figure the browser reads, and nothing else, plus the seal's attachment limits from
 * `src/outbound/attachment-budget.ts`: a receipt's ceiling times a provisional margin, and a provisional count,
 * served here so the composer shows what the seal enforces. `accessTtlSeconds` left because nothing
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
    // What a send may attach, shown by the composer as files are added rather than discovered at the seal.
    // From the module the seal itself reads (`src/outbound/attachment-budget.ts`), so the two cannot disagree.
    attachmentBudgetBytes: ATTACHMENT_BUDGET,
    maxAttachments: MAX_ATTACHMENTS,
    // The most a copy (ADR 47) may be, which People and Setup state where copies are turned on: the same figure the
    // seal refuses past, `email.outbound.max_bytes`.
    outboundMaxBytes: MAX_OUTBOUND_BYTES,
    // How many destinations an address may forward to (ADR 47, amended 7 October 2026), stated where they are set.
    forwardMaxDestinations: BUDGETS["forward.max_destinations"],
  };
  // `<` escaped as \\u003c: valid JSON, valid JavaScript, and inert if this string is ever interpolated
  // into markup by something that does not know it was not meant to be. Nothing in here is
  // attacker-controlled — a generated budget and a constant cookie name — so this is not a live
  // vulnerability, and it stays because the *shape* becomes one the first time the config holds
  // something dynamic.
  return `export const CONFIG = ${JSON.stringify(config).replace(/</g, "\\u003c")};\n`;
}

/**
 * The `<noscript>` notice, once per locale, each block marked with its language. Without scripting nothing can
 * choose a language for the reader, so every locale's words are here and the reader finds their own; English
 * first, as the source. The words are the catalog's `preauth` ones (`src/i18n/en/preauth.ts`), escaped, and the
 * link is filled into its sentence, so a translation moves it and cannot add one.
 */
function noscript(): string {
  const link = { html: '<a href="/api/doctor?format=text">/api/doctor?format=text</a>' };
  return LOCALES.map(({ tag }) => {
    const words = PREAUTH[tag];
    const doctor = parts(words["preauth.noscript.doctor"], { link }, tag, undefined)
      .map((part) => (part === link ? link.html : escapeHtml(String(part)))).join("");
    return `  <div class="rack" lang="${tag}"><div class="rack-inner">
    <p><strong>${escapeHtml(words["preauth.noscript.title"])}</strong></p>
    <p>${escapeHtml(words["preauth.noscript.body"])}</p>
    <p>${doctor}</p>
  </div></div>`;
  }).join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
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
<!-- A <header>, so the wordmark sits in a landmark (axe's region rule); the shell hides it, so no second banner. -->
<header class="rack">
  <div class="rack-inner">
    <p class="wordmark">${MARK_IS_AUTHORED ? markSvg({ size: 26 }) : ""}<span>Mailda</span></p>
    <div id="status"></div>
  </div>
</header>
<main id="app"></main>
<!--
  What an operator sees when the bundle does not run (#92, found by driving the browser).
  Without this the page rendered the wordmark and nothing else: no form, no error, no hint — and the first
  screen a Node ever shows is the claim, so the failure landed on the one page whose whole job is to be
  reachable. A blank page is the worst available diagnostic because it looks like a network problem.
-->
<noscript>
${noscript()}
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
  // The rules about which state, reason and outcome a reader is shown; the words are the catalog's. A separate
  // module so a test can evaluate it — `app.client.js` touches `document` at load, so nothing could reach it there,
  // and the one rule that decides whether a bounce is visible was the one rule with no coverage.
  "/app/delivery.js": { source: deliveryScript, type: "text/javascript; charset=utf-8" },
  // The React application (ADR 30). Imported dynamically by `app.client.js` once somebody is signed in,
  // so the screens an operator needs when the Node is broken never wait on a hundred kilobytes of it.
  "/app/shell.js": { source: shellBundle, type: "text/javascript; charset=utf-8" },
  "/app/app.css": { source: SHELL_CSS, type: "text/css; charset=utf-8" },
  // The sandboxed message body's own sheet. The frame is opaque-origin and cannot see the shell's theme or
  // its stylesheet, so it is given the same theme blocks and colours only in tokens (`theme.ts`). The frame
  // loads it under the policy it inherits, `style-src 'self'`.
  "/app/frame.css": { source: frameStylesheet, type: "text/css; charset=utf-8" },
  // The viewer's theme choice. `app.js` imports it statically and applies it before rendering anything, so
  // without this entry no page boots at all; the React shell imports the same module to read and change it.
  "/app/theme.js": { source: themeScript, type: "text/javascript; charset=utf-8" },
  // The viewer's language (ADR 46): built from `client/locale.ts` beside the shell, and imported by `app.js`
  // before it renders anything and by the shell, so it holds the one active table. It carries every locale's
  // pre-sign-in words; each locale's `app` words are served below `clientAsset()`, at content-tagged URLs.
  "/app/locale.js": { source: localeModule, type: "text/javascript; charset=utf-8" },
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
 * paying 97 KB on every load to keep a freshness guarantee that cannot apply would be a waste with no
 * upside.
 */
const FONT_FILES: Record<string, ArrayBuffer> = {
  "/app/fonts/inter-400.woff2": interRegular,
  "/app/fonts/inter-500.woff2": interMedium,
  "/app/fonts/inter-600.woff2": interSemibold,
  "/app/fonts/inter-700.woff2": interBold,
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

  // A locale's `app` words, at the URL that names their content (`src/i18n/served.ts`), so a year's cache can
  // never hand a browser a different table at the same address. An old tag of a known locale is redirected,
  // uncached, to the current one: a tab open across a deploy still names it, and a 404 failed its whole shell.
  const table = servedTables().get(pathname) ?? null;
  if (table !== null) {
    return new Response(table, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
  const now = currentTable(pathname);
  if (now !== null) return new Response(null, { status: 307, headers: { location: now, "cache-control": "no-store" } });

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
