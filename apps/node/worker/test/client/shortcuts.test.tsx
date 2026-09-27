import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isEditableTarget, setShortcutsEnabled, shortcutsEnabled, storedShortcuts, useShortcuts, type Shortcut,
} from "../../src/client/app/ui/shortcuts.ts";

const route = vi.hoisted(() => ({ pathname: "/settings" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Settings } = await import("../../src/client/app/screens/settings.tsx");
// Settings asks the shell's composer to save before a sign-out, so it renders inside the shell's provider.
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

/**
 * Single-key shortcuts act only where nobody is typing, once per press, and on the message selected now.
 *
 * Each case is a way a key would act wrongly and still look fine: E archiving from inside the palette's
 * field, J opening a body per auto-repeat (each a recorded open for a supervised reader), R replying to the
 * message selected before the last click, or a switch in Settings that does nothing where storage is blocked.
 */

function Keys({ shortcuts }: { shortcuts: readonly Shortcut[] }) {
  useShortcuts(shortcuts);
  return (
    <div>
      <input aria-label="field" />
      <textarea aria-label="area" />
      <select aria-label="choice"><option>a</option></select>
      <div contentEditable suppressContentEditableWarning data-testid="editable">text</div>
      <section className="composer-dock"><button type="button" data-testid="in-composer">x</button></section>
      <dialog open><button type="button" data-testid="in-dialog">x</button></dialog>
      <div role="dialog"><button type="button" data-testid="in-role-dialog">x</button></div>
      <div role="menu"><button type="button" role="menuitem" data-testid="in-menu">x</button></div>
      <ul role="listbox"><li role="option" aria-selected="false" tabIndex={-1} data-testid="in-listbox">x</li></ul>
      <details><summary data-testid="summary">more</summary></details>
      <div role="tablist"><button type="button" role="tab" aria-selected="true" data-testid="tab">All</button></div>
      <button type="button" data-testid="plain">plain</button>
    </div>
  );
}

let archive = vi.fn();
let unread = vi.fn();

function mount() {
  archive = vi.fn();
  unread = vi.fn();
  return render(<Keys shortcuts={[
    { key: "e", description: "Archive", run: archive },
    { key: "i", shift: true, description: "Mark unread", run: unread },
  ]} />);
}

const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;

/**
 * A browser that refuses site data. `vi.stubGlobal` rather than a spy on `Storage.prototype`: happy-dom's
 * storage stops consulting its prototype once it has been used, so a prototype spy intercepts nothing after
 * the first test and the refusal cases pass without ever refusing.
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

beforeEach(() => {
  try { localStorage.clear(); } catch { /* a runner without storage has nothing to clear */ }
});

afterEach(() => {
  vi.unstubAllGlobals();
  setShortcutsEnabled(true);
  try { localStorage.clear(); } catch { /* as above */ }
});

describe("where a key is a shortcut", () => {
  it("acts on the document and on an ordinary button", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "e" });
    fireEvent.keyDown(byTest("plain"), { key: "e" });
    expect(archive).toHaveBeenCalledTimes(2);
  });

  it("acts on a press aimed at the document itself, which is no field", () => {
    mount();
    fireEvent.keyDown(document, { key: "e" });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(isEditableTarget(document)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("acts on a summary and on a tab, where nothing is typed", () => {
    mount();
    fireEvent.keyDown(byTest("summary"), { key: "e" });
    fireEvent.keyDown(byTest("tab"), { key: "e" });
    expect(archive).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an input", () => document.querySelector("input")!],
    ["a textarea", () => document.querySelector("textarea")!],
    ["a select", () => document.querySelector("select")!],
    ["a contenteditable", () => byTest("editable")],
    ["the composer", () => byTest("in-composer")],
    ["a <dialog>, whose role is implicit", () => byTest("in-dialog")],
    ["a role=dialog", () => byTest("in-role-dialog")],
    ["a menu", () => byTest("in-menu")],
    ["a listbox", () => byTest("in-listbox")],
  ])("is ignored inside %s", (_where, target) => {
    mount();
    // The positive control first, so a listener that never fired cannot pass the negative below.
    fireEvent.keyDown(document.body, { key: "e" });
    expect(archive).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(target(), { key: "e" });
    expect(archive).toHaveBeenCalledTimes(1);
    expect(isEditableTarget(target())).toBe(true);
  });
});

describe("which presses count", () => {
  it("ignores auto-repeat, so holding a key acts once", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "e" });
    fireEvent.keyDown(document.body, { key: "e", repeat: true });
    fireEvent.keyDown(document.body, { key: "e", repeat: true });
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it.each([["ctrlKey"], ["metaKey"], ["altKey"]])("ignores a press with %s, which belongs to the browser", (modifier) => {
    mount();
    fireEvent.keyDown(document.body, { key: "e", [modifier]: true });
    expect(archive).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "e" });
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("ignores a press made while composing text, and one already handled", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "e", isComposing: true });
    const handled = new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(archive).not.toHaveBeenCalled();
  });

  it("tells Shift+I from I, and takes E and Shift+E apart the same way", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "i" });
    expect(unread).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "I", shiftKey: true });
    expect(unread).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "E", shiftKey: true });
    expect(archive).not.toHaveBeenCalled();
  });

  it("claims a matched press, so the browser does not also act on it", () => {
    mount();
    const press = new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true });
    document.body.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });
});

describe("the handler that runs is the current one", () => {
  it("calls the shortcut of the latest render, not the one the listener was attached with", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Keys shortcuts={[{ key: "r", description: "Reply", run: first }]} />);
    view.rerender(<Keys shortcuts={[{ key: "r", description: "Reply", run: second }]} />);
    fireEvent.keyDown(document.body, { key: "r" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("the switch in Settings (WCAG 2.1.4)", () => {
  it("turns every single-key shortcut off at once, and back on", () => {
    mount();
    expect(setShortcutsEnabled(false)).toEqual({ saved: true });
    expect(localStorage.getItem("mailda.shortcuts")).toBe("off");
    fireEvent.keyDown(document.body, { key: "e" });
    expect(archive).not.toHaveBeenCalled();
    setShortcutsEnabled(true);
    fireEvent.keyDown(document.body, { key: "e" });
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it("reads a choice stored earlier, at the moment of the press", () => {
    mount();
    localStorage.setItem("mailda.shortcuts", "off");
    fireEvent.keyDown(document.body, { key: "e" });
    expect(archive).not.toHaveBeenCalled();
    expect(shortcutsEnabled()).toBe(false);
  });

  it("still switches them off for this tab where the browser refuses to store it, and says it was not saved", () => {
    blockStorage({ write: true });
    mount();
    expect(setShortcutsEnabled(false)).toEqual({ saved: false });
    fireEvent.keyDown(document.body, { key: "e" });
    expect(archive).not.toHaveBeenCalled();
  });

  it("stays on where the browser refuses even to read storage, and says the read was refused", () => {
    // Stored "off" first, so a reader that ignored the refusal and read storage anyway would say off.
    localStorage.setItem("mailda.shortcuts", "off");
    expect(storedShortcuts()).toEqual({ enabled: false, readable: true });
    blockStorage({ read: true });
    mount();
    expect(storedShortcuts()).toEqual({ enabled: true, readable: false });
    expect(shortcutsEnabled()).toBe(true);
    fireEvent.keyDown(document.body, { key: "e" });
    expect(archive).toHaveBeenCalledTimes(1);
  });
});

describe("Settings > Keyboard", () => {
  function mountSettings() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ShellProvider><Settings /></ShellProvider></QueryClientProvider>);
  }
  const box = async () => (await screen.findByRole("checkbox", { name: "Single-key shortcuts" })) as HTMLInputElement;

  /**
   * The case the switch exists for (WCAG 2.1.4): somebody saved "off", and the browser now refuses to read site
   * data. The shortcuts are back on; the page must say why rather than show a checked box as if nothing happened.
   */
  it("says when the browser would not let it read a saved choice, with the box checked because keys are on", async () => {
    localStorage.setItem("mailda.shortcuts", "off");
    blockStorage({ read: true });
    mountSettings();
    expect((await box()).checked).toBe(true);
    expect(screen.getByText(/saved shortcut choice/).textContent)
      .toBe("This browser would not let Mailda read a saved shortcut choice, so single-key shortcuts start on.");
  });

  it("says nothing about reading where storage reads, and shows the saved choice", async () => {
    localStorage.setItem("mailda.shortcuts", "off");
    mountSettings();
    expect((await box()).checked).toBe(false);
    expect(screen.queryByText(/saved shortcut choice/)).toBeNull();
  });
});
