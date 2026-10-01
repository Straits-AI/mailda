/**
 * The locales this Node ships a catalog for (ADR 46), as data: the tag, the writing direction, the language's
 * own name for itself, and whether it is still a preview.
 *
 * **The endonym is data, not `Intl.DisplayNames`.** Two fixed strings for a closed list do not need the
 * runtime's ICU data to be asked, and an answer that could differ between browsers is a worse label than the
 * one written here.
 *
 * **`preview` keeps a locale out of every path a real viewer takes.** Browser negotiation never picks it, a
 * stored choice naming it is ignored, and Settings does not list it. It is reachable only through the
 * `?locale=` review flag (`docs/i18n.md`), which applies to one page load and is never stored. So a locale
 * whose screens are still partly English is never shown to anybody who did not ask for exactly that, and no
 * real viewer meets a screen in two languages. zh-Hans left preview on 2 October 2026 (`docs/i18n.md`, The
 * preview flag); the mechanism stays for the next locale, and `test/node/locale-preview.test.ts` holds it with a
 * test-only one. The review flag stays too: the sweeps and the switch before sign-in use it.
 */
export const LOCALES = [
  { tag: "en", dir: "ltr", endonym: "English", preview: false },
  { tag: "zh-Hans", dir: "ltr", endonym: "简体中文", preview: false },
] as const satisfies ReadonlyArray<{ tag: string; dir: "ltr" | "rtl"; endonym: string; preview: boolean }>;

export type Locale = (typeof LOCALES)[number]["tag"];

/** The source locale: its catalog is the type every other locale must match, and it is the last resort. */
export const SOURCE_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((entry) => entry.tag === value);
}

export function localeEntry(tag: Locale): (typeof LOCALES)[number] {
  return LOCALES.find((entry) => entry.tag === tag)!;
}

/**
 * The locales of `locales` a viewer can reach without the review flag: the ones that are not a preview. A function so
 * a test can hand it a registry that still has a preview in it (`test/node/locale-preview.test.ts`).
 */
export function offeredOf<L extends string>(locales: ReadonlyArray<{ tag: L; preview: boolean }>): L[] {
  return locales.filter((entry) => !entry.preview).map((entry) => entry.tag);
}

/** The locales a viewer can reach without the review flag: negotiation, a stored choice, Settings. */
export const OFFERED: readonly Locale[] = offeredOf(LOCALES);
