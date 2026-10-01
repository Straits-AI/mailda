import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootLocale, current, install, t } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { frameHead } from "../../src/client/app/screens/reader.tsx";
import { titleFor } from "../../src/client/app/title.ts";

const { Language } = await import("../../src/client/app/screens/language.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

/**
 * The browser half of the viewer's language (ADR 46, `src/client/locale.ts`): what `bootLocale()` decides from
 * the URL, storage and the browser, and that `<html lang>` and `dir` move with the words, in the same step.
 *
 * The page's own `<html>` here is happy-dom's, so each case resets it and puts the English table back after.
 */

const english = { ...CATALOGS.en.preauth, ...CATALOGS.en.app };
const html = document.documentElement;

/** A browser whose storage accessor itself throws, as it does where site data is blocked. */
function refuseStorage(): () => void {
  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new DOMException("The browser refused site data.", "SecurityError"); },
  });
  return () => Object.defineProperty(globalThis, "localStorage", real);
}

function at(search: string, languages: readonly string[] = ["en-US"]): void {
  history.replaceState(null, "", `/${search}`);
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
}

beforeEach(() => {
  document.body.innerHTML = '<header class="rack"><div class="rack-inner"><p class="wordmark"><span>Mailda</span></p></div></header>';
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
  localStorage.clear();
  install({ locale: "en", formatLocale: undefined, source: "default" }, english);
});

describe("booting the viewer's language", () => {
  it("names the page in English for an English browser", () => {
    at("");
    expect(bootLocale()).toBe("en");
    expect([html.lang, html.dir, document.title]).toEqual(["en", "ltr", "Mailda"]);
  });

  it("does not throw where storage is refused, and still honours the review flag there", () => {
    const restore = refuseStorage();
    try {
      at("");
      expect(() => bootLocale()).not.toThrow();
      expect(current().locale).toBe("en");
      at("?locale=zh-Hans");
      expect(bootLocale()).toBe("zh-Hans");
    } finally {
      restore();
    }
  });

  it("puts the language on <html>, the title and the wordmark in the step that installs its words", () => {
    at("?locale=zh-Hans");
    bootLocale();
    expect([html.lang, html.dir, document.title]).toEqual(["zh-Hans", "ltr", "淼达"]);
    expect(document.querySelector(".wordmark span")?.textContent).toBe("淼达");
    expect(current().source).toBe("flag");
  });

  it("never gives a Chinese browser the preview, nor a preview tag written into storage", () => {
    at("", ["zh-CN", "zh"]);
    expect(bootLocale()).toBe("en");
    localStorage.setItem("mailda.locale", "zh-Hans");
    expect(bootLocale()).toBe("en");
  });

  it("never stores the review flag", () => {
    at("?locale=zh-Hans");
    bootLocale();
    expect(localStorage.getItem("mailda.locale")).toBeNull();
  });
});

describe("what the language reaches, and what it does not", () => {
  it("titles each screen, in the active language", () => {
    expect(titleFor("/outbox")).toBe("Outbox · Mailda");
    expect(titleFor("/")).toBe("Inbox · Mailda");
    expect(titleFor("/not-a-route")).toBe("Mailda");
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
    expect(titleFor("/outbox")).toBe("发件箱 · 淼达");
  });

  it("does not give the message frame the interface's language: the frame is the sender's", () => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
    expect(html.lang).toBe("zh-Hans");
    expect(frameHead("dark", "sc")).not.toMatch(/\blang=/);
  });

  it("fails loudly under test on a key the table lacks, rather than showing the key", () => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, {});
    expect(() => t("brand.name")).toThrow(/E_I18N_KEY_UNKNOWN/);
  });

  it("treats a name every object inherits as a key the table lacks, not as a message", () => {
    const untyped = t as unknown as (key: string) => string;
    for (const key of ["constructor", "toString", "__proto__"]) expect(() => untyped(key)).toThrow(/E_I18N_KEY_UNKNOWN/);
  });
});

describe("Settings > Language", () => {
  function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ShellProvider><Language /></ShellProvider></QueryClientProvider>);
  }

  it("offers no preview: while English is the only offered language it says so, and lists no choice", () => {
    mount();
    expect(screen.getByRole("heading", { name: "Language" })).toBeTruthy();
    expect(screen.getByText("English is the only language offered so far.")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(document.body.textContent).not.toContain("简体中文");
  });

  it("says when the page is in a language only because its address asks for it", () => {
    at("?locale=zh-Hans");
    bootLocale();
    install(current(), CATALOGS["zh-Hans"].app);
    mount();
    expect(screen.getByText(/简体中文/).getAttribute("role")).toBe("status");
  });

  it("says so when this browser will not let it read a saved language", () => {
    const restore = refuseStorage();
    try {
      mount();
      expect(screen.getByText(/would not let Mailda read a saved language/)).toBeTruthy();
    } finally {
      restore();
    }
  });
});
