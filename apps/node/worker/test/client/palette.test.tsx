import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { calls, reset, seen } from "./session-stub.ts";

/**
 * The command palette (Cmd/Ctrl+K) finds without asking the Node (R14).
 *
 * The property that matters is the one a demo never shows: typing sends nothing. Each listing a supervised
 * reader fetches is a recorded `supervised.query`, so a palette that searched as you typed would write one
 * audit entry per letter. Searching mail is one explicit item, handed to the Inbox, one request.
 */

const route = vi.hoisted(() => ({ pathname: "/", navigate: undefined as undefined | ((to: unknown) => void) }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { CommandPalette } = await import("../../src/client/app/ui/palette.tsx");
const { ShellProvider, usePendingSearch, useRegisterCommands } = await import("../../src/client/app/shell-context.tsx");

/** What the palette handed the Inbox, read the way the Inbox reads it. */
function Pending() {
  const { pending } = usePendingSearch();
  return <output data-testid="pending">{pending ?? ""}</output>;
}

/** A screen that offers message commands while mounted, as the Inbox does while a message is selected. */
const REPLY = [{ id: "reply", label: "Reply", hint: "R" }] as const;
function Registrant({ run }: { run: () => void }) {
  useRegisterCommands(REPLY.map((command) => ({ ...command, run })));
  return null;
}

let navigate = vi.fn();

function mount(extra: React.ReactNode = null) {
  navigate = vi.fn();
  route.navigate = navigate;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ShellProvider><CommandPalette /><Pending />{extra}</ShellProvider>
    </QueryClientProvider>,
  );
}

const open = () => fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
const palette = () => screen.queryByRole("dialog", { name: "Command palette" });
const input = () => screen.getByRole("combobox", { name: "Go to or do" }) as HTMLInputElement;
const options = () => screen.getAllByRole("option").map((option) => option.textContent);

beforeEach(reset);
afterEach(() => {
  localStorage.removeItem("mailda.shortcuts");
  vi.restoreAllMocks();
});

describe("opening and closing", () => {
  it("opens on Ctrl+K and on Cmd+K, even with focus in a field", () => {
    mount(<input aria-label="elsewhere" />);
    expect(palette()).toBeNull();
    open();
    expect(palette()).not.toBeNull();
    fireEvent(palette()!, new Event("cancel"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "elsewhere" }), { key: "k", metaKey: true });
    expect(palette()).not.toBeNull();
  });

  it("gives focus back to what had it when it closes", () => {
    mount(<button type="button">where I was</button>);
    const before = screen.getByRole("button", { name: "where I was" });
    before.focus();
    open();
    expect(document.activeElement).toBe(input());
    // The dialog is modal: until it is closed the page behind it is inert and refuses focus (setup.ts).
    fireEvent(palette()!, new Event("cancel"));
    expect(palette()).toBeNull();
    expect(document.activeElement, "focus was left on <body>").toBe(before);
  });

  it("toggles once for a held chord: auto-repeat is swallowed, not acted on", () => {
    mount();
    open();
    const repeat = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, repeat: true, bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(repeat); });
    expect(palette(), "a repeat closed it again").not.toBeNull();
    expect(repeat.defaultPrevented, "a repeat reached the browser's own Ctrl+K").toBe(true);
  });

  it("is Cmd+K on Apple platforms, leaving Ctrl+K in a field to the system", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    mount(<input aria-label="elsewhere" />);
    const field = screen.getByRole("textbox", { name: "elsewhere" });
    const ctrl = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { field.dispatchEvent(ctrl); });
    expect(palette(), "Ctrl+K opened it on a Mac").toBeNull();
    expect(ctrl.defaultPrevented, "Ctrl+K's delete-to-end-of-line was taken").toBe(false);
    fireEvent.keyDown(field, { key: "k", metaKey: true });
    expect(palette()).not.toBeNull();
  });

  it("closes on Escape, and Ctrl+K opens it again", () => {
    mount();
    open();
    // happy-dom does not turn Escape into the dialog's `cancel`; a browser does, so the test fires that.
    fireEvent(palette()!, new Event("cancel"));
    expect(palette()).toBeNull();
    open();
    expect(palette()).not.toBeNull();
    expect(document.activeElement).toBe(input());
  });
});

describe("finding", () => {
  it("filters a static list as you type, and sends nothing while you do", async () => {
    mount();
    open();
    // Whatever mounting asked for has settled before the typing starts, so the count below is typing's alone.
    await waitFor(() => { expect(seen("/api/mailboxes").length).toBeGreaterThan(0); });
    const before = calls.length;
    for (const typed of ["q", "qu", "que", "queu", "queue"]) fireEvent.change(input(), { target: { value: typed } });
    expect(options()).toEqual(["Go to QueueGo to", "Search mail for “queue”Mail"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.slice(before).map((call) => call.path), "typing in the palette made a request").toEqual([]);
    expect(seen("/api/messages")).toEqual([]);
  });

  it("goes to a screen on Enter", () => {
    mount();
    open();
    fireEvent.change(input(), { target: { value: "queue" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith({ to: "/queue" });
    expect(palette()).toBeNull();
  });

  // An IME's Enter commits a candidate (发票), not the highlighted command. Chrome marks it `isComposing`; Safari
  // sends it after compositionend with only `keyCode` 229. Each must leave the palette open and go nowhere.
  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("does not run a command on an input method's Enter (%s)", (_, composing) => {
    mount();
    open();
    fireEvent.change(input(), { target: { value: "queue" } });
    fireEvent.keyDown(input(), { key: "Enter", ...composing });
    expect(navigate).not.toHaveBeenCalled();
    expect(palette()).not.toBeNull();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith({ to: "/queue" });
  });

  it("moves with the arrow keys, and says which option is active", () => {
    mount();
    open();
    fireEvent.change(input(), { target: { value: "go to" } });
    const first = input().getAttribute("aria-activedescendant");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    const second = input().getAttribute("aria-activedescendant");
    expect(second).not.toBe(first);
    expect(document.getElementById(second!)?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith({ to: "/queue" });
  });

  it("hands a mail search to the Inbox as one explicit act", () => {
    mount();
    open();
    fireEvent.change(input(), { target: { value: "invoice 2041" } });
    expect(options()).toEqual(["Search mail for “invoice 2041”Mail"]);
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(screen.getByTestId("pending").textContent).toBe("invoice 2041");
    expect(navigate).toHaveBeenCalledWith({ to: "/" });
    expect(seen("/api/messages"), "the palette searched on its own").toEqual([]);
  });

  it("keeps the active option in view as the arrows move", () => {
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    mount();
    open();
    for (let press = 0; press < 12; press += 1) fireEvent.keyDown(input(), { key: "ArrowDown" });
    const last = scrolled.mock.contexts.at(-1) as HTMLElement | undefined;
    expect(last?.id).toBe("palette-option-12");
    expect(last?.getAttribute("aria-selected")).toBe("true");
    expect(scrolled.mock.calls.at(-1)).toEqual([{ block: "nearest" }]);
  });

  it("says what it is for before anything is typed", () => {
    mount();
    open();
    expect(input().placeholder).toBe("Go to or do…");
  });

  it("offers no search item until something is typed", () => {
    mount();
    open();
    expect(options().some((text) => text?.startsWith("Search mail"))).toBe(false);
    expect(options()[0]).toBe("ComposeCMail");
  });
});

describe("what the mounted screen offers", () => {
  it("lists a registered command first, under Message, and runs it", () => {
    const reply = vi.fn();
    mount(<Registrant run={reply} />);
    open();
    const option = screen.getAllByRole("option")[0]!;
    expect(option.textContent).toBe("ReplyRMessage");
    fireEvent.click(within(option).getByText("Reply"));
    expect(reply).toHaveBeenCalledTimes(1);
    expect(palette()).toBeNull();
  });

  it("shows the single key a command has, as a key, and none once single keys are switched off", () => {
    mount(<Registrant run={vi.fn()} />);
    open();
    expect(screen.getAllByRole("option")[0]!.querySelector("kbd")?.textContent).toBe("R");
    fireEvent(palette()!, new Event("cancel"));

    localStorage.setItem("mailda.shortcuts", "off");
    open();
    expect(screen.getAllByRole("option")[0]!.querySelector("kbd"), "a hint named a key that does nothing").toBeNull();
    expect(screen.getAllByRole("option")[0]!.textContent).toBe("ReplyMessage");
  });
});
