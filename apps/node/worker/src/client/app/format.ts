import { current } from "/app/locale.js";

/**
 * Every date, time and number the interface formats, for the viewer's locale (ADR 46). The one file in
 * `src/client/app` that calls `Intl` or `toLocale*`: `test/node/untranslated.test.ts` flags a call anywhere
 * else, so a formatter cannot quietly pick its own locale.
 *
 * The locale is `current().formatLocale`. For an English viewer that is `undefined`, the browser's own default,
 * which is what every one of these calls passed before the interface had locales, so English output is
 * unchanged. Migrating a screen moves its formatting here, one function per shape, named for what it shows.
 */

/** A count or a size, grouped for the locale: `1,234`. */
export function count(value: number): string {
  return new Intl.NumberFormat(current().formatLocale).format(value);
}

/** Names joined as a sentence would join them: `A, B and C` / `张三、李四和王五`. */
export function list(items: readonly string[]): string {
  return new Intl.ListFormat(current().formatLocale, { type: "conjunction" }).format(items);
}

/** A time of day on a 24-hour clock, with seconds: `15:09:02`. */
export function clock(at: string | number): string {
  return new Date(at).toLocaleTimeString(current().formatLocale, { hour12: false });
}

/** How long ago `at` was, in the coarsest unit that reads naturally: `now`, `5 minutes ago`, `3 hours ago`. */
export function ago(at: string | number, now: number = Date.now()): string {
  const seconds = Math.round((new Date(at).getTime() - now) / 1000);
  const words = new Intl.RelativeTimeFormat(current().formatLocale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return words.format(seconds, "second");
  if (Math.abs(seconds) < 3_600) return words.format(Math.round(seconds / 60), "minute");
  return words.format(Math.round(seconds / 3_600), "hour");
}
