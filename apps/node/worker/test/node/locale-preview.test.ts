import { describe, expect, it, vi } from "vitest";

import { resolveLocale } from "../../src/i18n/format.ts";
import { LOCALES, OFFERED, isLocale } from "../../src/i18n/locales.ts";

/**
 * The preview mechanism (ADR 46, `docs/i18n.md`, The preview flag), held with a test-only preview locale.
 *
 * Since zh-Hans left preview on 2 October 2026 no real locale is one, so against the real registry every line that
 * keeps a preview out of reach is dead, and a test of it would pass whether or not it worked. Here the registry
 * gains `de`, marked preview, with no catalog: `OFFERED` is computed by the real `offeredOf()`, and `isLocale()`
 * knows `de`, so a stored `de` is refused for being a preview and not for naming no locale (which `klingon` is).
 * The live behaviour is `locale-format.test.ts`.
 */

vi.mock("../../src/i18n/locales.ts", async (original) => {
  const real = await original<typeof import("../../src/i18n/locales.ts")>();
  const LOCALES = [...real.LOCALES, { tag: "de", dir: "ltr", endonym: "Deutsch", preview: true }] as const;
  return {
    ...real,
    LOCALES,
    OFFERED: real.offeredOf(LOCALES),
    isLocale: (value: unknown) => LOCALES.some((entry) => entry.tag === value),
  };
});

describe("a preview locale", () => {
  it("is listed but not offered", () => {
    // The anti-vacuity control: the registry here has a preview, and it is a locale.
    expect(LOCALES.filter(({ preview }) => preview).map(({ tag }) => tag)).toEqual(["de"]);
    expect(isLocale("de")).toBe(true);
    expect(OFFERED).toEqual(["en", "zh-Hans"]);
  });

  it("is never picked by a browser that asks for it, which continues down its own list", () => {
    expect(resolveLocale({ flag: null, stored: null, languages: ["de-DE", "zh-CN"] }))
      .toEqual({ locale: "zh-Hans", formatLocale: "zh-CN", source: "browser" });
    expect(resolveLocale({ flag: null, stored: null, languages: ["de"] }).source).toBe("default");
  });

  it("is not honoured from storage: the flag cannot become a choice by writing storage by hand", () => {
    expect(resolveLocale({ flag: null, stored: "de", languages: [] }))
      .toEqual({ locale: "en", formatLocale: undefined, source: "default" });
  });

  it("is reached through the review flag, formatted for the viewer's own tag for it", () => {
    expect(resolveLocale({ flag: "de", stored: "en", languages: ["de-AT"] }))
      .toEqual({ locale: "de", formatLocale: "de-AT", source: "flag" });
  });
});
