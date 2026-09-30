import type { Message } from "./format.ts";

/**
 * The catalog's areas, and the key prefixes each one owns.
 *
 * One module per area and per locale (`en/<area>.ts`, `zh-Hans/<area>.ts`), so people migrating different
 * screens never edit the same file. An area's keys must start with one of its prefixes, which the type below
 * enforces, and the prefixes are disjoint, which `test/node/catalog.test.ts` holds: so two areas cannot both
 * define a key, and the spread that joins them in `en/index.ts` cannot silently let one overwrite the other.
 *
 * `preauth` is the one area bundled into `/app/locale.js`, loaded before sign-in; keep it to what the
 * framework-free script and the boot itself render. Every other area is the `app` table, served per locale.
 */
export const AREAS = {
  preauth: ["brand", "preauth"],
  common: ["route", "title"],
  language: ["language"],
  chrome: ["chrome", "health"],
  palette: ["palette"],
  shell: ["shell", "shortcuts"],
  inbox: ["inbox"],
  settings: ["settings"],
  api: ["api"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type AreaName = keyof typeof AREAS;

/** What an area module's source table satisfies: every key under one of the area's prefixes. */
export type Area<A extends AreaName> = Readonly<Record<`${(typeof AREAS)[A][number]}.${string}`, Message>>;
