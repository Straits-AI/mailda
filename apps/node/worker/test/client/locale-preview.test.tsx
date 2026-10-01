import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CATALOGS } from "../../src/i18n/catalog.ts";

/**
 * The preview mechanism's browser half (ADR 46, `docs/i18n.md`, The preview flag), in a registry where zh-Hans is
 * still a preview, as it was until 2 October 2026. No real locale is one now, so against the real registry what
 * Settings and the switch before sign-in do for a preview is unreachable; here it is the subject. `OFFERED` is the
 * real `offeredOf()`'s answer. The decision itself is `test/node/locale-preview.test.ts`.
 */

vi.mock("../../src/i18n/locales.ts", async (original) => {
  const real = await original<typeof import("../../src/i18n/locales.ts")>();
  const LOCALES = real.LOCALES.map((entry) => (entry.tag === "zh-Hans" ? { ...entry, preview: true } : entry));
  return { ...real, LOCALES, OFFERED: real.offeredOf(LOCALES) };
});
vi.mock("./session-stub.ts", async (original) => (await import("./preauth-driver.ts")).controlled(await original()));

// `setup.ts` imported the real registry before the mock above was registered, so this file's modules are loaded
// again, under it. The new `/app/locale.js` starts with no table, and is given the English one as `setup.ts` does.
vi.resetModules();
const { current, install, switchable } = await import("/app/locale.js");
const { boot, signInScreen, strip } = await import("./preauth-driver.ts");
const { Language } = await import("../../src/client/app/screens/language.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

const english = { ...CATALOGS.en.preauth, ...CATALOGS.en.app };
const chinese = { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app };
install({ locale: "en", formatLocale: undefined, source: "default" }, english);

beforeAll(async () => {
  await boot();
});

afterEach(() => {
  install({ locale: "en", formatLocale: undefined, source: "default" }, english);
});

function mountLanguage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Language /></ShellProvider></QueryClientProvider>);
}

describe("while a locale is a preview", () => {
  it("draws no switch before sign-in on an English page, since one language is no choice", async () => {
    await signInScreen();
    expect(current().locale).toBe("en");
    expect(strip().querySelector("select")).toBeNull();
    // A strip that never drew would pass the line above; it did draw, with the host in it.
    expect(strip().textContent).toContain(location.host);
  });

  it("lists the preview in the switch only on a page the review flag put in it, so that page can be switched back", () => {
    expect(switchable().map(({ tag }) => tag)).toEqual(["en"]);
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, chinese);
    expect(switchable().map(({ tag }) => tag)).toEqual(["en", "zh-Hans"]);
  });

  it("is not listed in Settings, which says English is the only language offered", () => {
    mountLanguage();
    expect(screen.getByText("English is the only language offered so far.")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(document.body.textContent).not.toContain("简体中文");
  });
});
