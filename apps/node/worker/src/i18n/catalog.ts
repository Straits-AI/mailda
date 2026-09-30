import * as en from "./en/index.ts";
import * as zhHans from "./zh-Hans/index.ts";
import type { Message } from "./format.ts";
import type { Locale } from "./locales.ts";

/**
 * What a translation of a source table must be: exactly its keys, each a string where the source has a string
 * and any message where the source has a plural (Chinese has only `other`, so a plural may be one string). An
 * object literal typed this way makes a missing key and an extra key both compile errors.
 */
export type Twin<T> = { readonly [K in keyof T]: T[K] extends string ? string : Message };

/** What every locale provides. */
export interface Catalog {
  readonly preauth: Twin<typeof en.preauth>;
  readonly app: Twin<typeof en.app>;
}

/** The source literals, which is where a message's parameter names come from. */
export type Source = typeof en.preauth & typeof en.app;
export type Key = keyof Source;

/** Every locale's catalog. A locale in `LOCALES` without one is a compile error here. */
export const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  en: { preauth: en.preauth, app: en.app },
  "zh-Hans": { preauth: zhHans.preauth, app: zhHans.app },
};
