import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answer, answerMailboxes, answerWith, reset, seen } from "./session-stub.ts";

/** happy-dom's own control of the window it simulates; its default 1024px viewport is the narrow layout. */
type HappyDom = { happyDOM: { setViewport(size: { width: number; height: number }): void } };

/**
 * The layout around every screen (R10, R17, and the narrow drawer).
 *
 * What would render plausibly and be wrong: §7's notices folded into a popover or given a close button (the
 * investigator could make the person stop being told); a composer rendered by a screen, so a visit to the
 * Outbox loses the reply being written; a closed drawer whose links still sit in the tab order off screen;
 * and two Compose buttons at one width, one of which is a stale copy.
 */

const route = vi.hoisted(() => ({ pathname: "/", outlet: null as React.ReactNode }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Shell } = await import("../../src/client/app/chrome.tsx");
const { ShellProvider, useCompose, useToast } = await import("../../src/client/app/shell-context.tsx");

/** Shows a toast carrying an Undo, as the Inbox does after archiving. */
function Archived({ undo }: { undo: () => void }) {
  const toast = useToast();
  return <button type="button" onClick={() => toast({ text: "Archived.", action: { label: "Undo", run: undo } })}>archive</button>;
}

/** Opens a new-message composer on mount, as Compose would, so the tests can move the route under it. */
function OpenComposer() {
  const compose = useCompose();
  return (
    <>
      <button type="button" onClick={() => compose.open({ mailboxId: "mbx_test" })}>open composer</button>
      {/* What R, Reply and the palette's Reply do, and what Drafts does for a draft by id. */}
      <button type="button" onClick={() => compose.open({ mailboxId: "mbx_test", inReplyToMessageId: "msg_1" })}>reply to one</button>
      <button type="button" onClick={() => compose.open({ mailboxId: "mbx_test", draftId: "drf_1" })}>open draft</button>
    </>
  );
}

/** Opens a composer and is gone by the time it closes, as a sent reply's row is after the move to the Outbox. */
function Vanishing() {
  const compose = useCompose();
  const [here, setHere] = useState(true);
  if (!here) return null;
  return (
    <button type="button" onClick={() => { compose.open({ mailboxId: "mbx_test" }); setHere(false); }}>open and go</button>
  );
}

/** Shows the same words twice, as archiving two messages in a row does. */
function SameTwice() {
  const toast = useToast();
  return <button type="button" onClick={() => toast({ text: "Archived." })}>say archived</button>;
}

const NOTICE = {
  id: "ntf_1", kind: "supervised_read", subjectId: "sgr_1", mailboxId: "mbx_test", matterId: "mat_1",
  dueAt: null, deliveredAt: "2026-09-26T09:00:00.000Z",
  body: { readerEmail: "legal@example.test", mailboxName: "Support", scope: "read", acts: { queries: 1 } },
};

let client: QueryClient;

function tree() {
  return (
    <QueryClientProvider client={client}>
      <ShellProvider><Shell /><OpenComposer /></ShellProvider>
    </QueryClientProvider>
  );
}

function mount(width: number) {
  (window as unknown as HappyDom).happyDOM.setViewport({ width, height: 900 });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(tree());
}

afterEach(() => { localStorage.removeItem("mailda.shortcuts"); });

beforeEach(() => {
  reset();
  route.pathname = "/";
  route.outlet = <p data-testid="outlet">the screen</p>;
  answerMailboxes([{ id: "mbx_test", name: "Support", addresses: "support@example.test" }]);
  // A member's answer to the setup read, so the setup band has nothing to say.
  answerWith((call) => (call.path === "/api/provider"
    ? Response.json({ error: "not_found", message: "not yours" }, { status: 404 })
    : undefined));
});

describe("the bands above every screen (R10)", () => {
  it("puts §7's notices before the screen, focusable, with nothing that could dismiss them", async () => {
    answer("/api/notifications", () => ({ notifications: [NOTICE], truncated: false }));
    mount(1440);
    const band = await screen.findByRole("region", { name: "Notifications" });
    expect(band.textContent).toContain("legal@example.test was granted a supervised read of Support");
    expect(band.getAttribute("tabindex")).toBe("0");
    expect(within(band).queryAllByRole("button"), "a notice gained a control that could clear it").toEqual([]);
    const outlet = screen.getByTestId("outlet");
    expect(band.compareDocumentPosition(outlet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the composer survives navigation (R17)", () => {
  it("stays open when the route changes under it", async () => {
    const view = mount(1440);
    fireEvent.click(await screen.findByRole("button", { name: "open composer" }));
    expect(await screen.findByRole("region", { name: "New message" })).toBeTruthy();

    route.pathname = "/outbox";
    route.outlet = <p data-testid="outlet">the outbox</p>;
    view.rerender(tree());
    expect(await screen.findByText("the outbox")).toBeTruthy();
    expect(screen.getByRole("region", { name: "New message" }), "navigating closed the composer").toBeTruthy();
  });
});

describe("narrow: below 1120px the sidebar is a drawer", () => {
  it("has no sidebar in the DOM and exactly one Compose, in the bar", async () => {
    mount(1024);
    await screen.findByRole("button", { name: "Open navigation" });
    expect(document.querySelector(".app-shell")?.getAttribute("data-layout")).toBe("narrow");
    expect(document.querySelector("nav.rail"), "a closed drawer left its links in the DOM").toBeNull();
    await waitFor(() => { expect(screen.getAllByRole("button", { name: "Compose" })).toHaveLength(1); });
    expect(screen.getByRole("button", { name: "Compose" }).closest(".mobile-bar")).not.toBeNull();
  });

  it("opens the drawer as a dialog with focus on its first link, and closing returns focus to the button", async () => {
    mount(1024);
    const menu = await screen.findByRole("button", { name: "Open navigation" });
    fireEvent.click(menu);

    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(drawer.querySelector("nav.rail")).not.toBeNull();
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(drawer.querySelector("a"));
    expect(within(drawer).queryByRole("button", { name: "Compose" }), "a second Compose inside the drawer").toBeNull();

    // happy-dom does not turn Escape into the dialog's `cancel`; a browser does, so the test fires that.
    act(() => { fireEvent(drawer, new Event("cancel")); });
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(document.activeElement).toBe(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the drawer on a click on its backdrop, and not on a click inside it", async () => {
    mount(1024);
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    fireEvent.click(drawer.querySelector("nav.rail")!);
    expect(screen.queryByRole("dialog", { name: "Navigation" }), "a click inside the rail closed it").not.toBeNull();
    // A click on the backdrop lands on the dialog element itself.
    fireEvent.click(drawer);
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });

  it("has a Close control a touch screen reader can find, after the links, that gives focus back", async () => {
    mount(1024);
    const menu = await screen.findByRole("button", { name: "Open navigation" });
    menu.focus();
    fireEvent.click(menu);
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    const close = within(drawer).getByRole("button", { name: "Close navigation" });
    // After the rail in the DOM, so opening still lands on the first link rather than on the way out.
    expect(drawer.querySelector("nav.rail")!.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(close);
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
    expect(document.activeElement).toBe(menu);
  });

  it("closes the drawer when a link in it is followed", async () => {
    mount(1024);
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Navigation" })).getByText("Outbox"));
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();
  });
});

describe("wide: at 1120px and above", () => {
  it("shows the sidebar, no bar, and exactly one Compose, in the sidebar", async () => {
    mount(1440);
    await waitFor(() => { expect(screen.getAllByRole("button", { name: "Compose" })).toHaveLength(1); });
    expect(document.querySelector(".app-shell")?.getAttribute("data-layout")).toBe("wide");
    expect(screen.getByRole("button", { name: "Compose" }).closest("nav.rail")).not.toBeNull();
    expect(document.querySelector(".mobile-bar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
  });

  it("names Compose's key only while single keys are on", async () => {
    mount(1440);
    await waitFor(() => { expect(screen.getByRole("button", { name: "Compose" }).title).toBe("Compose (C)"); });
    cleanup();
    localStorage.setItem("mailda.shortcuts", "off");
    mount(1440);
    await waitFor(() => { expect(screen.getByRole("button", { name: "Compose" }).title, "it named a key that does nothing").toBe("Compose"); });
  });

  it("gives the mail views the mail layout and every other screen the ledger one", async () => {
    const view = mount(1440);
    await screen.findByTestId("outlet");
    expect(document.querySelector(".app-main")?.className).toBe("app-main mail");
    route.pathname = "/outbox";
    view.rerender(tree());
    expect(document.querySelector(".app-main")?.className).toBe("app-main");
  });
});

describe("Z undoes what the visible notice offers", () => {
  it("runs the toast's action, and only while a toast offers one", async () => {
    const undo = vi.fn();
    (window as unknown as HappyDom).happyDOM.setViewport({ width: 1440, height: 900 });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ShellProvider><Shell /><Archived undo={undo} /></ShellProvider>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(document.body, { key: "z" });
    expect(undo).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "archive" }));
    fireEvent.keyDown(document.body, { key: "z" });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".toast-region")?.textContent, "the undone notice stayed").toBe("");
  });
});

describe("the composer and focus", () => {
  it("gives focus back to what opened it when it closes", async () => {
    mount(1440);
    const opener = await screen.findByRole("button", { name: "open composer" });
    opener.focus();
    fireEvent.click(opener);
    const dock = await screen.findByRole("region", { name: "New message" });
    await waitFor(() => { expect(dock.contains(document.activeElement), "the dock did not take focus").toBe(true); });
    await act(async () => { fireEvent.click(within(dock).getByRole("button", { name: "Close" })); });
    expect(screen.queryByRole("region", { name: "New message" })).toBeNull();
    expect(document.activeElement, "focus fell to <body>").toBe(opener);
  });

  it("gives focus to Compose when what opened it is gone", async () => {
    (window as unknown as HappyDom).happyDOM.setViewport({ width: 1440, height: 900 });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ShellProvider><Shell /><Vanishing /></ShellProvider>
      </QueryClientProvider>,
    );
    const opener = await screen.findByRole("button", { name: "open and go" });
    opener.focus();
    fireEvent.click(opener);
    const dock = await screen.findByRole("region", { name: "New message" });
    expect(opener.isConnected).toBe(false);
    await act(async () => { fireEvent.click(within(dock).getByRole("button", { name: "Close" })); });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Compose" }));
  });

  it("keeps the open reply, and what was typed, when the same reply is asked for again", async () => {
    mount(1440);
    fireEvent.click(await screen.findByRole("button", { name: "reply to one" }));
    await screen.findByRole("region", { name: "Reply" });
    await waitFor(() => { expect(seen("/api/drafts?inReplyTo=")).toHaveLength(1); });
    const body = document.getElementById("composer-body") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "typed in the last pause" } });

    // Pressed from outside the dock, as Reply is: focus is on the button, and must go back to the words.
    const again = screen.getByRole("button", { name: "reply to one" });
    again.focus();
    fireEvent.click(again);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.getElementById("composer-body"), "the dock was remounted").toBe(body);
    expect(body.value).toBe("typed in the last pause");
    expect(seen("/api/drafts?inReplyTo="), "a second dock read the draft again").toHaveLength(1);
    expect(document.activeElement).toBe(body);
  });

  it("keeps an open draft opened again by id", async () => {
    mount(1440);
    fireEvent.click(await screen.findByRole("button", { name: "open draft" }));
    await waitFor(() => { expect(seen("/api/drafts/drf_1")).toHaveLength(1); });
    fireEvent.click(screen.getByRole("button", { name: "open draft" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen("/api/drafts/drf_1"), "the same draft was mounted twice").toHaveLength(1);
  });
});

describe("toasts", () => {
  it("announces the same words twice: a repeat is a new node in the live region, not no change", async () => {
    (window as unknown as HappyDom).happyDOM.setViewport({ width: 1440, height: 900 });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ShellProvider><SameTwice /></ShellProvider>
      </QueryClientProvider>,
    );
    const region = screen.getByRole("status");
    fireEvent.click(screen.getByRole("button", { name: "say archived" }));
    const first = region.querySelector(".toast");
    expect(first?.textContent).toBe("Archived.");
    fireEvent.click(screen.getByRole("button", { name: "say archived" }));
    const second = region.querySelector(".toast");
    expect(second?.textContent).toBe("Archived.");
    expect(second, "the second toast changed nothing a screen reader could hear").not.toBe(first);
    expect(screen.getByRole("status"), "the live region itself was replaced").toBe(region);
  });
});
