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

/** A local date and time in the locale's own default form: a draft's `title`. */
export function dateTime(at: string | number): string {
  return new Date(at).toLocaleString(current().formatLocale);
}

/** A local date in the locale's own default form, no time: a passkey's Added and Last used. */
export function date(at: string | number): string {
  return new Date(at).toLocaleDateString(current().formatLocale);
}

/** A local date and a short time: `Sep 26, 2026, 5:00 PM` / `2026年9月26日 17:00`. A draft's row. */
export function mediumDateTime(at: string | number): string {
  return new Date(at).toLocaleString(current().formatLocale, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * `fullTime`, then the instant's offset from UTC: `9/26/2026, 15:09:02 GMT+08:00`. For text that leaves this
 * browser, the reply's quote line, where a reader in another zone would otherwise misread the hour (critic L5).
 * The offset is appended rather than asked for inline, because zh-Hans places an inline zone between the date
 * and the time with no space (`2026/9/26 GMT+08:0015:09:02`).
 */
export function zonedTime(at: string): string {
  const zone = new Intl.DateTimeFormat(current().formatLocale, { timeZoneName: "longOffset" })
    .formatToParts(new Date(at)).find((part) => part.type === "timeZoneName")?.value;
  return zone === undefined ? fullTime(at) : `${fullTime(at)} ${zone}`;
}

/**
 * English month names for a date in a list or a chip. Written out rather than asked of `Intl`, whose `en-GB`
 * short month for September changed to "Sept" across ICU versions, and a list is a place a date is scanned for.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The day a provisioning record was written, with its year: `24 Sep 2026` / `2026年9月24日` (Setup's progress).
 * English keeps its table (`MONTHS`), day first whatever the browser's locale, so no ICU can make it "Sept" (D28).
 */
export function recordDay(at: string): string {
  const when = new Date(at);
  return current().locale === "en"
    ? `${when.getDate()} ${MONTHS[when.getMonth()]} ${when.getFullYear()}`
    : when.toLocaleDateString(current().formatLocale, { day: "numeric", month: "short", year: "numeric" });
}

/** A day of the year with no year: `26 Sep` / `9月26日`. English keeps its table (`MONTHS`); others ask `Intl`. */
export function monthDay(when: Date): string {
  return current().locale === "en"
    ? `${when.getDate()} ${MONTHS[when.getMonth()]}`
    : when.toLocaleDateString(current().formatLocale, { month: "short", day: "numeric" });
}

/**
 * When this Node received a message, as short as it can be and still be unambiguous: `15:09` today, `26 Sep` /
 * `9月26日` this year, `26 Sep 2025` / `2025/9/26` before. English keeps the written-out form it always had;
 * another locale takes its own numeric forms from `Intl`, where a month name has no ICU drift to fear.
 */
export function shortTime(at: string, now: Date = new Date()): string {
  const when = new Date(at);
  const en = current().locale === "en";
  if (when.toDateString() === now.toDateString()) {
    return en
      ? `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
      : when.toLocaleTimeString(current().formatLocale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }
  if (when.getFullYear() === now.getFullYear()) return monthDay(when);
  return en
    ? `${monthDay(when)} ${when.getFullYear()}`
    : when.toLocaleDateString(current().formatLocale, { year: "numeric", month: "numeric", day: "numeric" });
}

/** The full local time of an instant, on a 24-hour clock: the `title` behind every short time, and Received. */
export function fullTime(at: string): string {
  return new Date(at).toLocaleString(current().formatLocale, { hour12: false });
}
