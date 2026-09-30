import { CATALOGS } from "./catalog.ts";
import { isLocale, LOCALES, type Locale } from "./locales.ts";

/**
 * How a locale's `app` table is served: the module's text, and the URL it is served at, which carries a tag of
 * that text (critic M5).
 *
 * **Why the URL carries the content.** Every other `/app/*` asset is `max-age=60` at a fixed URL, so for a
 * minute after a deploy a tab could pair a new shell with a cached old table, and a key the new shell asks for
 * would render raw. A table whose URL changes with its content is `immutable`: a browser keeps it for a year,
 * never re-downloads an unchanged one, and can never be handed a different one at the same address.
 *
 * **Why both sides compute it.** `scripts/build-client.mjs` writes each URL into `/app/locale.js` at build, and
 * the Worker answers exactly those URLs, from the same catalogs through this same function, so the two cannot
 * disagree; `test/catalog-served.test.ts` reads the built file and asserts they do not.
 *
 * **Why an old tag is redirected, not refused.** `/app/locale.js` is evaluated once per tab and names the table
 * URL of the deploy it came from; `loadApp()` fetches that URL only at sign-in. A sign-in tab left open across a
 * deploy that changed any word, or a reload inside `/app/locale.js`'s 60 seconds, asks for a tag the Worker no
 * longer has. A 404 there failed the whole shell ("could not be loaded") for as long as the tab stayed open. So
 * an old tag of a known locale is a `307`, marked `no-store`, to the current table (`currentTable()`): the old
 * address is never handed new words, and the new one stays immutable.
 *
 * ponytail: that shell is itself from `max-age=60` at a fixed URL, so for a minute after a deploy it can be the
 * old shell reading the new table. A key the old shell asks for and the new table dropped then renders raw, and
 * `E_I18N_KEY_UNKNOWN` is logged. Content-tagging the shell too is the upgrade.
 */

/** The served module. `<` escaped as `\u003c`, as `configModule()` in `ui.ts` does, so it is inert if ever put in markup. */
export function tableModule(locale: Locale): string {
  return `export default ${JSON.stringify(CATALOGS[locale].app).replace(/</g, "\\u003c")};\n`;
}

/**
 * A 53-bit tag of `text` (cyrb53), in base 36. Not a security property: it only has to change when the text
 * does, and it is computed synchronously in both the build and the Worker, which Web Crypto's digest is not.
 */
export function contentTag(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Every locale's table URL, which the build writes into `/app/locale.js`. */
export function messagePaths(): Readonly<Record<Locale, string>> {
  return Object.fromEntries(LOCALES.map(({ tag }) => [tag, `/app/messages/${tag}.${contentTag(tableModule(tag))}.js`])) as Record<Locale, string>;
}

let served: ReadonlyMap<string, string> | null = null;

/** URL to module text, computed once per isolate, so the Worker does no per-request work for it. */
export function servedTables(): ReadonlyMap<string, string> {
  if (served === null) {
    const paths = messagePaths();
    served = new Map(LOCALES.map(({ tag }) => [paths[tag], tableModule(tag)]));
  }
  return served;
}

/**
 * The current table's URL for an old content tag of a known locale (`/app/messages/<locale>.<tag>.js`), or null
 * for anything else, including the current URL itself, which `servedTables()` answers.
 */
export function currentTable(pathname: string): string | null {
  const locale = /^\/app\/messages\/([A-Za-z-]+)\.[0-9a-z]+\.js$/.exec(pathname)?.[1];
  if (!isLocale(locale)) return null;
  const now = messagePaths()[locale];
  return now === pathname ? null : now;
}
