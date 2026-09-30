/**
 * The whole message runtime, pure: no DOM, no storage, no fetch (ADR 46). The Worker imports it, node tests
 * import it, and esbuild bundles it into `/app/locale.js` for both browser surfaces, so there is one copy.
 *
 * A message is a string with `{name}` placeholders, or a plural object keyed by CLDR category. There is no ICU
 * syntax and no markup: a sentence with an element inside it takes the element as a parameter (`parts()`), so a
 * translation can move it but never add one.
 */

import { OFFERED, isLocale, type Locale } from "./locales.ts";

/** One string per CLDR plural category, chosen by the `n` parameter. `other` is the only one every locale has. */
export type Plural = { readonly other: string } & { readonly [C in Exclude<Intl.LDMLPluralRule, "other">]?: string };
/** A string with `{name}` placeholders, or a plural. Nothing else. */
export type Message = string | Plural;

type Names<S> = S extends `${string}{${infer N}}${infer Rest}` ? N | Names<Rest> : never;
type NamesOf<M> = M extends string ? Names<M> : Names<M[keyof M]> | "n";
/** The parameters a message takes, read from its source-locale literal. `n` is always the count, and a number. */
export type Params<M, V = string | number> = { readonly [K in NamesOf<M>]: K extends "n" ? number : V };
/** No argument for a message without placeholders; exactly its parameters otherwise. */
export type ArgsFor<M, V = string | number> = [NamesOf<M>] extends [never] ? [] : [params: Params<M, V>];

declare const TEXT: unique symbol;
/**
 * A string that came out of a catalog. A sink that shows the interface's own words takes this, so a literal
 * (`label="Save"`) and a glued string (`t(a) + " anyway"`) do not compile there. Data (a subject, a sender, a
 * name someone typed) stays `string`, so the type records which is which.
 */
export type Text = string & { readonly [TEXT]: true };

const plurals = new Map<string, Intl.PluralRules>();
const numbers = new Map<string, Intl.NumberFormat>();
function cached<T>(map: Map<string, T>, locale: string | undefined, make: () => T): T {
  const key = locale ?? "";
  let value = map.get(key);
  if (value === undefined) map.set(key, (value = make()));
  return value;
}

const HAN = /\p{Script=Han}/u;
const LATIN = /[A-Za-z0-9]/;
const meets = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && ((HAN.test(a) && LATIN.test(b)) || (LATIN.test(a) && HAN.test(b)));

/**
 * The Chinese register's one space between Han and a Latin letter or digit (`docs/i18n.md`), where a filled value
 * meets its template: `{name}已发布` with `lead-response` is `lead-response 已发布`. The catalog check can see only the template, so
 * the join is made here. Only a template with Han in it is touched, so English output is byte-identical, and never
 * inside the value, which may be somebody's words.
 */
function spaced(before: string | undefined, value: string, after: string | undefined): string {
  return `${meets(before, value[0]) ? " " : ""}${value}${meets(value.at(-1), after) ? " " : ""}`;
}

/**
 * The message with its placeholders filled, as parts: a parameter may be any value (a React node, a DOM node),
 * and numbers are formatted for `formatLocale`. `pluralLocale` picks the category, and is the catalog's locale
 * rather than the formatting one, because the categories are the catalog's: an `en` catalog read on a `de-DE`
 * browser still has `one` and `other`.
 *
 * Throws on a plural given no numeric `n` and on a missing placeholder. The types make both unreachable from
 * TypeScript; a JavaScript caller or a table from another deploy is who can reach them.
 */
export function parts(
  message: Message, params: Readonly<Record<string, unknown>>, pluralLocale: string, formatLocale: string | undefined,
): unknown[] {
  let template: string;
  if (typeof message === "string") template = message;
  else {
    const n = params["n"];
    if (typeof n !== "number") throw new TypeError(`E_I18N_PLURAL_WITHOUT_N  a plural message was given n=${String(n)}`);
    const category = cached(plurals, pluralLocale, () => new Intl.PluralRules(pluralLocale)).select(n);
    template = message[category] ?? message.other;
  }
  const out: unknown[] = [];
  const han = HAN.test(template);
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const name = match[1]!;
    if (!(name in params)) throw new TypeError(`E_I18N_PARAM_MISSING  {${name}} has no value`);
    if (match.index > last) out.push(template.slice(last, match.index));
    const raw = params[name];
    const value = typeof raw === "number" ? cached(numbers, formatLocale, () => new Intl.NumberFormat(formatLocale)).format(raw) : raw;
    const end = match.index + match[0].length;
    out.push(han && typeof value === "string" ? spaced(template[match.index - 1], value, template[end]) : value);
    last = end;
  }
  if (last < template.length) out.push(template.slice(last));
  return out;
}

export function text(
  message: Message, params: Readonly<Record<string, string | number>>, pluralLocale: string, formatLocale: string | undefined,
): Text {
  return parts(message, params, pluralLocale, formatLocale).join("") as Text;
}

/**
 * The first requested tag whose language and script a catalog serves, and the tag itself for formatting, so
 * `en-GB` keeps day-month order and `zh-MY` keeps its region. `zh-TW` maximizes to Hant and matches nothing, so
 * negotiation continues down the viewer's own list.
 */
export function negotiate<L extends string>(
  requested: readonly string[], available: readonly L[],
): { locale: L; formatLocale: string } | null {
  const key = (tag: string): string | null => {
    try {
      const full = new Intl.Locale(tag).maximize();
      return `${full.language}-${full.script}`;
    } catch {
      // A malformed tag in navigator.languages is not a preference; skipping it is the answer, not a lost error.
      return null;
    }
  };
  for (const tag of requested) {
    const wanted = key(tag);
    const hit = available.find((locale) => key(locale) === wanted);
    if (wanted !== null && hit !== undefined) return { locale: hit, formatLocale: tag };
  }
  return null;
}

/** Why the locale is what it is. Settings says it in words. */
export type LocaleSource = "flag" | "stored" | "browser" | "default";

export interface Resolved {
  readonly locale: Locale;
  /**
   * The tag dates and numbers are formatted for. `undefined` means the browser's own default, which is what
   * the interface used before it had locales, so English formats exactly as it did. Another locale takes the
   * viewer's own tag for it when their list has one (`zh-MY` keeps its region), and the catalog tag otherwise.
   */
  readonly formatLocale: string | undefined;
  readonly source: LocaleSource;
}

/**
 * The boot decision, pure so a node test can hold it:
 *
 * 1. `?locale=<tag>`, any listed locale, previews included. The review flag: one page load, never stored.
 * 2. The stored choice, only if it is offered. A stored preview tag is ignored, so the flag cannot become a
 *    choice by somebody writing storage by hand.
 * 3. `navigator.languages`, negotiated over the offered locales only.
 * 4. The source locale.
 */
export function resolveLocale(input: {
  readonly flag: string | null; readonly stored: string | null; readonly languages: readonly string[];
}): Resolved {
  const formatFor = (locale: Locale): string | undefined =>
    locale === "en" ? undefined : negotiate(input.languages, [locale])?.formatLocale ?? locale;
  const at = (locale: Locale, source: LocaleSource): Resolved => ({ locale, formatLocale: formatFor(locale), source });
  if (input.flag !== null && isLocale(input.flag)) return at(input.flag, "flag");
  if (input.stored !== null && isLocale(input.stored) && OFFERED.includes(input.stored)) return at(input.stored, "stored");
  const browser = negotiate(input.languages, OFFERED);
  if (browser !== null) return at(browser.locale, "browser");
  return at("en", "default");
}
