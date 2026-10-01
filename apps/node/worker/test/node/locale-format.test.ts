import { describe, expect, it } from "vitest";

import { negotiate, parts, resolveLocale, text } from "../../src/i18n/format.ts";
import { LOCALES, OFFERED } from "../../src/i18n/locales.ts";

/**
 * The pure half of the message runtime (ADR 46): which locale a viewer gets, and how a message is filled. The
 * browser half, which reads storage and the URL and sets `<html lang>`, is `test/client/locale-boot.test.tsx`; the
 * preview mechanism, which no real locale is in now, is `test/node/locale-preview.test.ts`.
 */

describe("negotiation over the browser's list", () => {
  const all = LOCALES.map(({ tag }) => tag);
  it.each([
    [["zh-CN", "en"], "zh-Hans", "zh-CN"],
    [["zh-MY"], "zh-Hans", "zh-MY"],
    [["zh-SG"], "zh-Hans", "zh-SG"],
    [["zh-TW", "en-GB"], "en", "en-GB"],
    [["zh-HK"], null, null],
    [["zh-TW", "zh-CN"], "zh-Hans", "zh-CN"],
    [["en-GB"], "en", "en-GB"],
    [["ja", "fr"], null, null],
    [["not a tag!", "zh"], "zh-Hans", "zh"],
  ])("%j gets %s, formatted as %s", (requested, locale, formatLocale) => {
    const got = negotiate(requested, all);
    expect(got === null ? null : [got.locale, got.formatLocale]).toEqual(locale === null ? null : [locale, formatLocale]);
  });
});

describe("the boot decision", () => {
  it("offers every locale it lists: none is a preview since zh-Hans left preview on 2 October 2026", () => {
    expect(OFFERED).toEqual(LOCALES.map(({ tag }) => tag));
    expect(OFFERED).toContain("zh-Hans");
  });

  it.each([
    [["zh"], "zh"], [["zh-CN"], "zh-CN"], [["zh-SG"], "zh-SG"], [["zh-MY"], "zh-MY"], [["zh-Hans-HK", "en"], "zh-Hans-HK"],
  ])("gives a Simplified Chinese browser %j zh-Hans, formatted as %s", (languages, formatLocale) => {
    expect(resolveLocale({ flag: null, stored: null, languages })).toEqual({ locale: "zh-Hans", formatLocale, source: "browser" });
  });

  it.each([["zh-TW"], ["zh-HK"], ["zh-MO"]])("does not give %s zh-Hans: Traditional continues down the list", (tag) => {
    expect(resolveLocale({ flag: null, stored: null, languages: [tag, "en-GB"] }))
      .toEqual({ locale: "en", formatLocale: undefined, source: "browser" });
    expect(resolveLocale({ flag: null, stored: null, languages: [tag, "zh-CN"] }).locale).toBe("zh-Hans");
    expect(resolveLocale({ flag: null, stored: null, languages: [tag] }).source).toBe("default");
  });

  it("honours a stored choice over the browser, either way", () => {
    expect(resolveLocale({ flag: null, stored: "zh-Hans", languages: ["en-GB"] }))
      .toEqual({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "stored" });
    expect(resolveLocale({ flag: null, stored: "en", languages: ["zh-CN"] }))
      .toEqual({ locale: "en", formatLocale: undefined, source: "stored" });
  });

  it("puts the review flag above a stored choice, and formats for the viewer's own tag for it", () => {
    expect(resolveLocale({ flag: "zh-Hans", stored: null, languages: ["zh-MY", "en"] }))
      .toEqual({ locale: "zh-Hans", formatLocale: "zh-MY", source: "flag" });
    expect(resolveLocale({ flag: "zh-Hans", stored: "en", languages: ["en-GB"] }))
      .toEqual({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" });
    expect(resolveLocale({ flag: "en", stored: "zh-Hans", languages: ["zh-CN"] }).source).toBe("flag");
  });

  it("ignores a flag that names no locale, and a stored value that names none", () => {
    expect(resolveLocale({ flag: "klingon", stored: "klingon", languages: [] }).source).toBe("default");
  });

  it("formats English exactly as before locales existed: the browser's own default", () => {
    expect(resolveLocale({ flag: null, stored: "en", languages: ["de-DE", "en-GB"] }))
      .toEqual({ locale: "en", formatLocale: undefined, source: "stored" });
    expect(resolveLocale({ flag: null, stored: null, languages: ["en-GB"] }))
      .toEqual({ locale: "en", formatLocale: undefined, source: "browser" });
  });
});

describe("filling a message", () => {
  it("fills placeholders, and formats a number for the locale", () => {
    expect(text("{screen} · {brand}", { screen: "Outbox", brand: "Mailda" }, "en", undefined)).toBe("Outbox · Mailda");
    expect(text({ one: "{n} message", other: "{n} messages" }, { n: 1 }, "en", "en-GB")).toBe("1 message");
    expect(text({ one: "{n} message", other: "{n} messages" }, { n: 1234 }, "en", "en-GB")).toBe("1,234 messages");
    expect(text({ other: "{n} 封邮件" }, { n: 3 }, "zh-Hans", "zh-Hans")).toBe("3 封邮件");
  });

  it("picks the plural category by the catalog's locale, not the formatting one", () => {
    // French puts 0 in `one`; English puts it in `other`. An English catalog formatted for French is still English.
    expect(text({ one: "{n} message", other: "{n} messages" }, { n: 0 }, "en", "fr")).toBe("0 messages");
  });

  it("spaces a Latin value from the Han it meets, as the register asks, and leaves English and quotes alone", () => {
    expect(text("前往{route}", { route: "Butler" }, "zh-Hans", "zh-CN")).toBe("前往 Butler");
    expect(text("前往{route}", { route: "收件箱" }, "zh-Hans", "zh-CN")).toBe("前往收件箱");
    expect(text("{n}封", { n: 3 }, "zh-Hans", "zh-CN")).toBe("3 封");
    expect(text("{name}已发布", { name: "Butler" }, "zh-Hans", "zh-CN")).toBe("Butler 已发布");
    expect(text("在邮件中搜索“{term}”", { term: "sjx" }, "zh-Hans", "zh-CN")).toBe("在邮件中搜索“sjx”");
    expect(text("复制 {what}", { what: "ID" }, "zh-Hans", "zh-CN")).toBe("复制 ID");
    expect(text("Go to{route}", { route: "收件箱" }, "en", undefined)).toBe("Go to收件箱");
  });

  it("keeps an element where the translation puts it", () => {
    const who = { element: "strong" };
    expect(parts("把它交给 {who}。", { who }, "zh-Hans", "zh-Hans")).toEqual(["把它交给 ", who, "。"]);
    // At either end, with no empty text beside it.
    expect(parts("{who} 已加入", { who }, "zh-Hans", "zh-Hans")).toEqual([who, " 已加入"]);
    expect(parts("交给 {who}", { who }, "zh-Hans", "zh-Hans")).toEqual(["交给 ", who]);
  });

  it("refuses a missing placeholder and a plural without its count, rather than showing half a sentence", () => {
    expect(() => text("{who} and {until}", { who: "x" }, "en", undefined)).toThrow(/E_I18N_PARAM_MISSING/);
    expect(() => text({ one: "a", other: "b" }, {}, "en", undefined)).toThrow(/E_I18N_PLURAL_WITHOUT_N/);
  });
});
