import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerMailboxes, answerWith, calls, reset } from "./session-stub.ts";
import type { MessageRow, Place } from "../../src/client/app/api.ts";

/**
 * Archive and Trash, the tabs, and the Filter control: every one a server-side listing (0067, R13).
 *
 * A tab or a filter that narrowed the rows of another page in the browser would show fifty rows' worth of
 * "the unread mail" and call it that. So each of these asserts the **request** — the parameter reached the
 * Node, once — and that what the Node answered is what is shown, even a row the tab's name would not predict.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

function row(n: number, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: `rcpt_${n}`, message_id: `msg_${n}`, subject: `message ${n}`,
    from_addr: `sender${n}@outside.example`, envelope_from: `sender${n}@outside.example`,
    envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
    accepted_at: `2026-08-2${n}T09:00:00.000Z`, parse_error: null, conversation_id: null, case_id: null,
    auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
    attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
    place: "inbox", from_name: null, preview: null, standing_content: 1, case_mine: 0, case_state: null,
    ...over,
  };
}

const BODY = { state: "text-only", html: null, text: "hello", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [], recipients: { to: [], cc: [], replyTo: null } };

let answerRows: (query: URLSearchParams) => MessageRow[];
let cursorFor: (query: URLSearchParams) => string | null;

beforeEach(() => {
  reset();
  answerRows = () => [];
  cursorFor = () => null;
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") {
      return Response.json({ messages: answerRows(url.searchParams), next_cursor: cursorFor(url.searchParams), lookback_exhausted: false });
    }
    if (url.pathname.endsWith("/body")) return Response.json(BODY);
    if (url.pathname.endsWith("/place")) {
      return Response.json({ error: "E_NO_SUCH_MESSAGE", message: "E_NO_SUCH_MESSAGE  not a message you can file" }, { status: 404 });
    }
    return undefined;
  });
});

function mount(place?: Place) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Inbox {...(place === undefined ? {} : { place })} /></ShellProvider></QueryClientProvider>);
}

async function settle() {
  await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
}

async function press(name: string | RegExp) {
  await act(async () => { screen.getByRole("button", { name }).click(); });
}

const listings = () => calls.filter((call) => call.path === "/api/messages" || call.path.startsWith("/api/messages?"))
  .map((call) => new URL(call.path, "https://node.example").searchParams);

describe("Archive and Trash are the same list, filtered by the Node", () => {
  it("titles Archive, asks for place=archive, and says so when it is empty", async () => {
    mount("archive");
    await screen.findByText("Nothing archived.");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Archive");
    expect(listings()[0]!.get("place")).toBe("archive");
    // The tabs are the Inbox's: Unread and Mine mean nothing asked of a place that is not it.
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("titles Trash, says it is empty, and says always that Trash deletes nothing", async () => {
    mount("trash");
    await screen.findByText("Your Trash is empty.");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Trash");
    expect(screen.getByText("Trash keeps messages until you move them back. Nothing here is deleted.")).toBeDefined();
  });
});

describe("the menu offers the moves that go somewhere, to a reader who may make them", () => {
  async function items(place: Place, over: Partial<MessageRow> = {}) {
    answerRows = () => [row(1, { place, ...over })];
    mount(place);
    await act(async () => { (await screen.findByRole("button", { name: /message 1/ })).click(); });
    await screen.findByText("hello");
    await press("More actions");
    return within(screen.getByRole("menu", { name: "More actions" })).getAllByRole("menuitem").map((item) => item.textContent);
  }

  it("offers Archive and Move to Trash from the Inbox", async () => {
    const found = await items("inbox");
    expect(found).toEqual(expect.arrayContaining(["Archive", "Move to Trash"]));
    expect(found).not.toContain("Move to Inbox");
  });

  it("offers Move to Inbox and Move to Trash from the Archive", async () => {
    const found = await items("archive");
    expect(found).toEqual(expect.arrayContaining(["Move to Inbox", "Move to Trash"]));
    expect(found).not.toContain("Archive");
  });

  it("offers Archive and Move to Inbox from the Trash", async () => {
    const found = await items("trash");
    expect(found).toEqual(expect.arrayContaining(["Archive", "Move to Inbox"]));
    expect(found).not.toContain("Move to Trash");
  });

  it("offers no move at all without standing content read", async () => {
    const found = await items("inbox", { standing_content: 0 });
    expect(found.some((item) => /Archive|Move to/.test(item ?? ""))).toBe(false);
  });

  it("shows the Node's refusal of a move verbatim, and moves nothing on screen", async () => {
    await items("inbox");
    await act(async () => { screen.getByRole("menuitem", { name: "Archive" }).click(); });
    const alert = await waitFor(() => {
      const found = document.querySelector(".toast-region [role=alert] .toast");
      expect(found?.textContent).toContain("E_NO_SUCH_MESSAGE  not a message you can file");
      return found;
    });
    expect(alert).not.toBeNull();
    expect(screen.getByRole("article", { name: "Message" })).toBeDefined();
  });
});

describe("the tabs are the Node's listings, never a filter over this page (R13)", () => {
  it("sends unread=1 with place=inbox and renders what came back, read rows included", async () => {
    answerRows = (query) => (query.get("unread") === "1" ? [row(7, { read: 1, subject: "already read, says the Node" })] : [row(1)]);
    mount();
    await settle();
    await act(async () => { screen.getByRole("tab", { name: "Unread" }).click(); });
    await screen.findByText("already read, says the Node");
    const asked = listings().at(-1)!;
    expect(asked.get("unread")).toBe("1");
    expect(asked.get("place")).toBe("inbox");
    expect(screen.getByRole("tab", { name: "Unread" }).getAttribute("aria-selected")).toBe("true");
  });

  it("moves along the tabs with the arrow keys and asks the Node nothing until one is opened", async () => {
    answerRows = () => [row(1)];
    mount();
    await settle();
    const all = screen.getByRole("tab", { name: "All" });
    // Roving: only the selected tab is in the tab order, and the arrows move from there.
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    all.focus();
    const before = listings().length;
    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Unread" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(all, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Mine" }));
    // Only the arrows move: any other key leaves focus where it is.
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Mine" }));
    expect(listings().length, "moving along the tabs asked for a listing").toBe(before);
    expect(all.getAttribute("aria-selected")).toBe("true");
  });

  it("sends mine=1 for Mine, and offers no Waiting", async () => {
    answerRows = () => [row(1)];
    mount();
    await settle();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["All", "Unread", "Mine"]);
    await act(async () => { screen.getByRole("tab", { name: "Mine" }).click(); });
    await waitFor(() => { expect(listings().at(-1)!.get("mine")).toBe("1"); });
    expect(screen.queryByRole("tab", { name: /Waiting/ })).toBeNull();
  });
});

describe("the Filter control", () => {
  const TWO = [
    { id: "mbx_support", name: "Support", addresses: "support@example.test" },
    { id: "mbx_billing", name: "Billing", addresses: "billing@example.test" },
  ];

  function readable(rows: typeof TWO) {
    const previous = answerRows;
    answerWith((call) => {
      const url = new URL(call.path, "https://node.example");
      if (url.pathname === "/api/mailboxes/readable") return Response.json({ mailboxes: rows });
      if (url.pathname === "/api/messages") {
        return Response.json({ messages: previous(url.searchParams), next_cursor: cursorFor(url.searchParams), lookback_exhausted: false });
      }
      return undefined;
    });
  }

  it("offers what the reader may read, which is not where they have work, and nothing with one", async () => {
    // One work mailbox, two readable: a supervised reader's shape. The choice must come from the readable list.
    answerMailboxes([TWO[0]!]);
    answerRows = () => [row(1)];
    readable(TWO);
    mount();
    await settle();
    await press("Filter");
    const select = await waitFor(() => {
      const found = document.getElementById("inbox-mailbox") as HTMLSelectElement | null;
      expect(found).not.toBeNull();
      return found!;
    });
    expect(Array.from(select.options).map((one) => one.textContent)).toEqual(["All mailboxes", "Support", "Billing"]);
    // Every mailbox by default: "all" describes an unfiltered list, and no mailbox was asked for.
    expect(select.value).toBe("");
    expect(listings()[0]!.get("mailbox")).toBeNull();
  });

  it("renders no mailbox choice with one readable mailbox", async () => {
    answerRows = () => [row(1)];
    readable([TWO[0]!]);
    mount();
    await settle();
    await press("Filter");
    await screen.findByLabelText("Sender address");
    expect(document.getElementById("inbox-mailbox")).toBeNull();
  });

  it("applies every filter in one request, from the first page, shows each as a chip, and removes one", async () => {
    answerRows = () => [row(1)];
    cursorFor = (query) => (query.get("cursor") === null && query.get("from") === null ? "c-2" : null);
    readable(TWO);
    mount();
    await settle();
    await press("Older");
    await waitFor(() => { expect(listings().at(-1)!.get("cursor")).toBe("c-2"); });

    await press("Filter");
    const select = await waitFor(() => document.getElementById("inbox-mailbox") as HTMLSelectElement);
    fireEvent.change(select, { target: { value: "mbx_billing" } });
    fireEvent.change(screen.getByLabelText("Sender address"), { target: { value: "ar@northwind.example" } });
    fireEvent.change(screen.getByLabelText("Received on or after"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Received on or before"), { target: { value: "2026-09-26" } });
    const before = listings().length;
    await press("Apply");

    await waitFor(() => { expect(listings().length).toBe(before + 1); });
    const asked = listings().at(-1)!;
    expect(Object.fromEntries(asked)).toEqual({
      mailbox: "mbx_billing", from: "ar@northwind.example", since: "2026-09-01", until: "2026-09-26", place: "inbox",
    });
    // No cursor: a position in one listing is nowhere in another.
    expect(asked.get("cursor")).toBeNull();

    const chips = Array.from(document.querySelectorAll(".chip-filter")).map((chip) => chip.firstChild?.textContent);
    expect(chips).toEqual(["Mailbox: Billing", "From: ar@northwind.example", "On or after 1 Sep", "On or before 26 Sep"]);
    expect(document.querySelector(".filter-count")?.textContent).toBe("4");
    // The count is in the button's name, and the result is said where a screen reader hears it.
    expect(screen.getByRole("button", { name: "Filter, 4 active" })).toBeDefined();
    await waitFor(() => { expect(document.querySelector(".list-pane > [role=status]")?.textContent).toBe("1 message matches these filters."); });

    await press("Remove filter: From: ar@northwind.example");
    await waitFor(() => { expect(listings().at(-1)!.get("from")).toBeNull(); });
    expect(listings().at(-1)!.get("mailbox")).toBe("mbx_billing");
    expect(document.querySelectorAll(".chip-filter")).toHaveLength(3);

    await press(/^Filter/);
    await press("Clear");
    await waitFor(() => { expect(document.querySelectorAll(".chip-filter")).toHaveLength(0); });
    expect(document.querySelector(".filter-count")).toBeNull();
    expect(screen.getByRole("button", { name: "Filter" })).toBeDefined();
    // An unnarrowed listing says nothing: opening the Inbox is not news.
    expect(document.querySelector(".list-pane > [role=status]")?.textContent).toBe("");
  });
});
