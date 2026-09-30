/**
 * The viewer's language (ADR 46), the twin of `theme.client.js`: chosen per viewer, kept in this browser, never
 * sent to the Node, and applied before anything renders.
 *
 * Built by esbuild into `/app/locale.js` (`scripts/build-client.mjs`, a second entry point) and imported by
 * both the framework-free script and the React shell, which leaves it external, so one module instance holds
 * the one active table. It bundles every locale's `preauth` words (`src/i18n/preauth.ts`), so sign-in costs no
 * extra request; the `app` words are one per-locale table, fetched by `loadApp()` when the shell is handed the
 * page, at a URL written into this file at build (`src/i18n/served.ts`).
 *
 * **The function that installs words is the function that sets `<html lang>` and `dir`**, so the page's
 * declared language and its words cannot disagree.
 *
 * **Every storage access is inside a `try`, and a refusal is returned, never swallowed**, as in the theme
 * module: reading `globalThis.localStorage` itself throws where site data is blocked, and `bootLocale()` runs
 * at the top of the page's one script, where a throw would leave a blank page.
 *
 * ponytail: a module script runs after parsing, so the first frame can show `lang="en"` and "Mailda" before
 * `bootLocale()` corrects them, as the theme can show Dark. A cookie mirrored into a server-rendered `lang` is
 * the upgrade, at the price of `Vary: Cookie` on the document.
 */

import type { Key, Source } from "../i18n/catalog.ts";
import { parts, resolveLocale, text, type ArgsFor, type Message, type Resolved, type Text } from "../i18n/format.ts";
import { isLocale, localeEntry, type Locale } from "../i18n/locales.ts";
import { PREAUTH } from "../i18n/preauth.ts";

/** Written by the build: each locale's content-tagged table URL, and whether a missing key throws. */
declare const __MAILDA_LOCALE_BUILD__: { readonly messages: Readonly<Record<Locale, string>>; readonly strict: boolean };

/** The `localStorage` key. Per viewer, this browser only. */
export const LOCALE_KEY = "mailda.locale";
/** The review flag, `?locale=<tag>`: any listed locale, previews included, for one page load, never stored. */
export const LOCALE_FLAG = "locale";

/**
 * The stored choice, if it names a locale. `resolveLocale()` then ignores a preview tag, which is not a choice
 * anybody could have made in Settings. `readable: false` when reading storage threw.
 */
export function storedLocale(): { locale: Locale | null; readable: boolean } {
  let value: string | null;
  try {
    value = globalThis.localStorage.getItem(LOCALE_KEY);
  } catch {
    // Not swallowed: `readable: false` is the answer, and Settings renders it as a sentence.
    return { locale: null, readable: false };
  }
  return { locale: isLocale(value) ? value : null, readable: true };
}

/** Stores the choice. The caller reloads, because every surface reads its words once. `saved: false` is shown. */
export function chooseLocale(locale: Locale): { saved: boolean } {
  try {
    globalThis.localStorage.setItem(LOCALE_KEY, locale);
  } catch {
    // Not swallowed: `saved: false` is the answer, and Settings renders it as a sentence.
    return { saved: false };
  }
  return { saved: true };
}

let active: Resolved = { locale: "en", formatLocale: undefined, source: "default" };
/** No prototype, so `constructor` or `__proto__` from a JavaScript caller is an unknown key, not a message. */
let table: Record<string, Message> = Object.create(null) as Record<string, Message>;

/**
 * Makes `words` the active table for `resolved`, and puts its language on `<html>` in the same step. A second
 * install for the same locale adds to the table (the `app` words after the `preauth` ones); a different locale
 * replaces it. `test/client/setup.ts` installs the English table this way, so the suite renders English.
 */
export function install(resolved: Resolved, words: Readonly<Record<string, Message>>): void {
  if (resolved.locale !== active.locale) table = Object.create(null) as Record<string, Message>;
  active = resolved;
  Object.assign(table, words);
  document.documentElement.lang = resolved.locale;
  document.documentElement.dir = localeEntry(resolved.locale).dir;
}

/**
 * Decides the language, installs the `preauth` words, and names the page in it: `<html lang>` and `dir`, the
 * `<title>`, and the pre-authentication wordmark. Synchronous, and it does not throw: storage is read inside
 * `storedLocale()`'s `try`, and a malformed browser tag is skipped by `negotiate()`.
 */
export function bootLocale(): Locale {
  const resolved = resolveLocale({
    flag: new URLSearchParams(location.search).get(LOCALE_FLAG),
    stored: storedLocale().locale,
    languages: navigator.languages ?? [],
  });
  install(resolved, PREAUTH[resolved.locale]);
  const brand = t("brand.name");
  document.title = brand;
  const wordmark = document.querySelector(".rack .wordmark span");
  if (wordmark !== null) wordmark.textContent = brand;
  return resolved.locale;
}

/**
 * Fetches and installs the active locale's `app` words. Called by `app.client.js` inside the `try` that loads
 * the shell, so a table that cannot be fetched shows the same "could not be loaded" notice a shell would.
 */
export async function loadApp(): Promise<void> {
  const module = (await import(/* @vite-ignore */ __MAILDA_LOCALE_BUILD__.messages[active.locale])) as {
    default: Readonly<Record<string, Message>>;
  };
  install(active, module.default);
}

/** The active locale, the tag dates and numbers are formatted for, and how it was chosen. */
export function current(): Resolved {
  return active;
}

function lookup(key: string): Message {
  const message = table[key];
  if (message !== undefined) return message;
  // Only a JavaScript caller, or a table from another deploy than the shell's, can get here. Under test it is a
  // defect to fail on; in a browser the key itself is what shows, so the gap is visible rather than blank.
  const said = `E_I18N_KEY_UNKNOWN  ${key} is not in the ${active.locale} table`;
  if (__MAILDA_LOCALE_BUILD__.strict) throw new Error(said);
  console.error(said);
  return key;
}

/** The words for `key`, with its parameters. An unknown key, or a missing or misspelt parameter, does not compile. */
export function t<K extends Key>(key: K, ...args: ArgsFor<Source[K]>): Text {
  return text(lookup(key), (args[0] ?? {}) as Record<string, string | number>, active.locale, active.formatLocale);
}

/**
 * For a sentence with an element inside it: the parameters may be nodes, and the result is the sentence's
 * parts in the translation's order. `src/client/app/words.tsx` wraps it for React.
 */
export function rich<K extends Key, V>(key: K, ...args: ArgsFor<Source[K], string | number | V>): Array<string | V> {
  return parts(lookup(key), (args[0] ?? {}) as Record<string, unknown>, active.locale, active.formatLocale) as Array<string | V>;
}
