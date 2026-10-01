import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootTheme, chooseTheme, currentTheme, storedTheme } from "/app/theme.js";

/**
 * The viewer's theme (R33): Dark unless they chose otherwise, applied before anything renders, and never
 * lost or ignored in silence.
 *
 * What would look right and be wrong: a boot that forgets to apply the stored choice (every page dark for a
 * Light chooser, which a dark-by-default page hides perfectly); a junk stored value reaching `<html>`, or the
 * body frame's `srcdoc`, unchecked; a choice stored before it is applied, so a browser that refuses storage
 * also refuses the change; and a Settings page that looks as if it kept a choice the browser threw away.
 */

const route = vi.hoisted(() => ({ pathname: "/settings" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Settings } = await import("../../src/client/app/screens/settings.tsx");
// Settings asks the shell's composer to save before a sign-out, so it renders inside the shell's provider.
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

/**
 * A browser that refuses site data. `vi.stubGlobal` rather than a spy on `Storage.prototype`: happy-dom's
 * storage stops consulting its prototype once it has been used, so a prototype spy intercepts nothing after
 * the first test and the refusal cases would pass without ever refusing.
 */
function blockStorage(which: { read?: boolean; write?: boolean }) {
  const real = window.localStorage;
  const refuse = (): never => { throw new DOMException("The browser refused site data.", "SecurityError"); };
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => (which.read === true ? refuse() : real.getItem(key)),
    setItem: (key: string, value: string) => (which.write === true ? refuse() : real.setItem(key, value)),
    removeItem: (key: string) => real.removeItem(key),
    clear: () => real.clear(),
  });
}

const theme = () => document.documentElement.dataset.theme;

function mountSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Settings /></ShellProvider></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the boot", () => {
  it("applies the stored choice when the framework-free script loads, before it renders anything", async () => {
    localStorage.setItem("mailda.theme", "light");
    document.body.innerHTML = '<div id="status"></div><main id="app"></main>';
    globalThis.fetch = (async () => Response.json({ claimed: false, outboxPending: 0 })) as unknown as typeof fetch;

    await import("../../src/client/app.client.js");
    expect(theme()).toBe("light");

    // Let the script's own first render land, so it cannot write into a later test's page.
    const app = document.getElementById("app")!;
    for (let attempt = 0; attempt < 400 && app.childElementCount === 0; attempt += 1) {
      await new Promise((settle) => setTimeout(settle, 5));
    }
  });

  it("is dark when nothing is stored, and says so on <html> rather than leaving it unset", () => {
    bootTheme();
    expect(theme()).toBe("dark");
  });

  it("is dark when the stored value is not a choice", () => {
    localStorage.setItem("mailda.theme", "purple");
    bootTheme();
    expect(theme()).toBe("dark");
    expect(storedTheme()).toEqual({ theme: "dark", readable: true });
  });

  it("is dark, and reports the read as refused, when the browser will not let it read storage", () => {
    localStorage.setItem("mailda.theme", "light");
    blockStorage({ read: true });
    bootTheme();
    expect(theme()).toBe("dark");
    expect(storedTheme()).toEqual({ theme: "dark", readable: false });
  });

  it("hands out only one of the three words, whatever <html> was given", () => {
    // What the body frame's srcdoc interpolates: an unchecked value here would be written into the frame.
    document.documentElement.dataset.theme = '"><script>';
    expect(currentTheme()).toBe("dark");
    document.documentElement.dataset.theme = "system";
    expect(currentTheme()).toBe("system");
  });
});

describe("choosing", () => {
  it("applies first and stores second, so a refused store still changes the page", () => {
    blockStorage({ write: true });
    expect(chooseTheme("light")).toEqual({ saved: false });
    expect(theme()).toBe("light");
  });
});

describe("Settings > Appearance", () => {
  /** The Theme group's radios: Settings also has the Language group's. */
  const radios = () => within(screen.getByRole("group", { name: "Theme" })).getAllByRole("radio") as HTMLInputElement[];

  it("offers Dark, Light and System, in that order, with Dark checked by default", async () => {
    bootTheme();
    mountSettings();
    const group = await screen.findByRole("group", { name: "Theme" });
    expect(radios().map((radio) => radio.closest("label")!.textContent)).toEqual([
      "Dark", "Light", "SystemFollows your device's light or dark setting.",
    ]);
    expect(group.querySelector<HTMLInputElement>("input:checked")?.value).toBe("dark");
  });

  it("applies and stores Light when it is chosen, and says nothing about saving", async () => {
    bootTheme();
    mountSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Light" }));
    expect(theme()).toBe("light");
    expect(localStorage.getItem("mailda.theme")).toBe("light");
    expect((screen.getByRole("radio", { name: "Light" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/Not saved in this browser/)).toBeNull();
  });

  it("applies System as system, which the stylesheet resolves by the device's setting", async () => {
    bootTheme();
    mountSettings();
    fireEvent.click(await screen.findByRole("radio", { name: /^System/ }));
    expect(theme()).toBe("system");
    expect(localStorage.getItem("mailda.theme")).toBe("system");
  });

  it("still applies a choice the browser will not store, and says it lasts until a reload", async () => {
    bootTheme();
    blockStorage({ write: true });
    mountSettings();
    fireEvent.click(await screen.findByRole("radio", { name: "Light" }));
    expect(theme()).toBe("light");
    // By its words: the shell around Settings keeps its own (empty) toast status region.
    expect((await screen.findByText("Not saved in this browser; this applies until you reload.")).getAttribute("role")).toBe("status");
  });

  it("says when the browser would not let it read a saved theme, with Dark checked", async () => {
    blockStorage({ read: true });
    bootTheme();
    mountSettings();
    expect((await screen.findByText(/would not let Mailda read a saved theme/)).textContent)
      .toBe("This browser would not let Mailda read a saved theme, so each page starts in Dark.");
    expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
  });
});
