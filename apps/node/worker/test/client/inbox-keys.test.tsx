import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";
import type { MessageRow } from "../../src/client/app/api.ts";

/**
 * The Inbox's keys (D8), and what each one costs the Node.
 *
 * A key is the cheapest gesture there is, so it is where an extra request hides best: J that fetches the next
 * body ahead, an open that refetches the list, R that opens a composer before the claim. Each of those is, for
 * a supervised reader, one more audit entry recording mail they did not look at. So these count requests, not
 * only outcomes:
 *
 * - R4: R claims **before** a composer exists, and claims the message selected **now**; and it waits for the
 *   body, whose Reply-To and Cc decide whom the reply is to.
 * - R11: J and K within a page cost one body per newly opened message and no page listing. A message in a
 *   conversation also lists that conversation, once while it is fresh, for the thread under the reader; that is
 *   counted by its own test, since it is one more `supervised.query` for a supervised reader.
 * - R19: Shift+I marks unread and it stays unread; the open that marked it read does not run again.
 * - R21: after R, focus is in the reply, so the next "a" is text and not a second claim.
 * - E files from the row's own place, with an Undo that puts it back; Z runs that Undo.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { ShellProvider, useCommands, useToastAction } = await import("../../src/client/app/shell-context.tsx");
const { useShortcuts } = await import("../../src/client/app/ui/shortcuts.ts");

function row(n: number, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: `rcpt_${n}`, message_id: `msg_${n}`, subject: `message ${n}`,
    from_addr: `sender${n}@outside.example`, envelope_from: `sender${n}@outside.example`,
    envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
    // No conversation unless a test gives one: the thread's own listing is counted where it is the subject.
    accepted_at: `2026-08-2${n}T09:00:00.000Z`, parse_error: null, conversation_id: null, case_id: `case_${n}`,
    auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
    attachments: null, attachments_dangerous: null, labels_json: "[]", read: 0,
    place: "inbox", from_name: null, preview: null, standing_content: 1, case_mine: 0, case_state: "open",
    ...over,
  };
}

const BODY = {
  state: "text-only", html: null, text: "hello", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [],
  recipients: { to: [] as string[], cc: [] as string[], replyTo: null as string | null },
};

let pages: Record<string, { messages: MessageRow[]; next_cursor: string | null }>;
let claimGate: Promise<void>;
let placeAnswer: (place: string) => Response;
let readAnswer: (read: boolean) => Response;
let mailboxGate: Promise<void>;
let body: typeof BODY;
let bodyAnswer: () => Promise<Response>;

beforeEach(() => {
  reset();
  pages = { "": { messages: [row(1), row(2), row(3)], next_cursor: null } };
  claimGate = Promise.resolve();
  placeAnswer = (place) => Response.json({ messageId: "msg_1", place });
  readAnswer = (read) => Response.json({ read });
  mailboxGate = Promise.resolve();
  body = BODY;
  bodyAnswer = async () => Response.json(body);
  answerWith(async (call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") {
      return Response.json({ lookback_exhausted: false, ...(pages[url.searchParams.get("cursor") ?? ""] ?? { messages: [], next_cursor: null }) });
    }
    if (url.pathname === "/api/mailboxes") {
      await mailboxGate;
      return undefined;
    }
    if (url.pathname.endsWith("/body")) return bodyAnswer();
    if (url.pathname.endsWith("/read")) return readAnswer((call.body as { read: boolean }).read);
    if (url.pathname.endsWith("/place")) return placeAnswer((call.body as { place: string }).place);
    if (/^\/api\/cases\/[^/]+\/claim$/.test(url.pathname)) {
      await claimGate;
      return Response.json({ case: { state: "claimed" } });
    }
    return undefined;
  });
});

/** The Shell's Z, as the Shell registers it: the visible toast's action. */
function UndoKey() {
  const action = useToastAction();
  useShortcuts([{ key: "z", description: "Undo", run: () => action?.() }]);
  return null;
}

/** What the palette would list, as the palette reads it. */
function Commands() {
  return (
    <ul aria-label="Commands">
      {useCommands().map((command) => <li key={command.id}><button type="button" onClick={command.run}>{command.label}</button></li>)}
    </ul>
  );
}

type HappyDom = { happyDOM: { setViewport(size: { width: number; height: number }): void } };
const viewport = (width: number) => (window as unknown as HappyDom).happyDOM.setViewport({ width, height: 900 });

afterEach(() => { viewport(1024); });

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Inbox /><UndoKey /><Commands /></ShellProvider></QueryClientProvider>);
  await screen.findByRole("button", { name: /message 1/ });
  return client;
}

/** A key as a person presses it: on whatever has focus, which is where the browser dispatches it. */
async function key(name: string, shift = false) {
  await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: name, shiftKey: shift }); });
}

async function click(name: RegExp | string) {
  await act(async () => { screen.getByRole("button", { name }).click(); });
}

const listings = () => calls.filter((call) => call.path === "/api/messages" || call.path.startsWith("/api/messages?"));
const param = (path: string, name: string) => new URL(path, "https://node.example").searchParams.get(name);
/** Pages of a place, as opposed to the conversation listing a thread makes. */
const pageListings = () => listings().filter((call) => param(call.path, "conversation") === null);
const conversations = () => listings().map((call) => param(call.path, "conversation")).filter((one) => one !== null);
const sendListings = () => calls.filter((call) => call.path.startsWith("/api/sends?")).map((call) => param(call.path, "conversation"));
const bodies = () => calls.filter((call) => call.path.endsWith("/body")).map((call) => call.path);
const reads = () => calls.filter((call) => call.path.endsWith("/read")).map((call) => (call.body as { read: boolean }).read);
const subject = () => screen.queryByRole("article", { name: "Message" })?.querySelector(".reader-subject")?.textContent ?? null;

describe("R claims first (R4, R21)", () => {
  it("claims the case before any composer exists, then opens the reply", async () => {
    let release!: () => void;
    claimGate = new Promise((resolve) => { release = resolve; });
    await mount();
    await click(/message 1/);
    await key("r");
    await waitFor(() => { expect(calls.some((call) => call.path === "/api/cases/case_1/claim")).toBe(true); });
    expect(screen.queryByRole("region", { name: "Reply" }), "a composer opened before the claim answered").toBeNull();

    await act(async () => { release(); });
    expect(await screen.findByRole("region", { name: "Reply" })).toBeDefined();
  });

  it("acts on the message selected now, and hands the next letter to the reply", async () => {
    await mount();
    await click(/message 1/);
    await click(/message 2/);
    await key("r");
    await screen.findByRole("region", { name: "Reply" });
    const claims = () => calls.filter((call) => call.path.endsWith("/claim")).map((call) => call.path);
    expect(claims()).toEqual(["/api/cases/case_2/claim"]);

    expect(document.activeElement?.id).toBe("composer-body");
    await key("a");
    expect(claims(), "an 'a' typed into the reply ran reply-all").toEqual(["/api/cases/case_2/claim"]);
  });
});

describe("A and F", () => {
  it("A claims and opens a reply to everyone; F opens a forward and claims nothing", async () => {
    body = { ...BODY, recipients: { to: ["support@example.test", "bob@outside.example"], cc: [], replyTo: null } };
    await mount();
    await click(/message 1/);
    await screen.findByText("hello");
    await key("a");
    const reply = await screen.findByRole("region", { name: "Reply" });
    // Everybody else the sender wrote to, minus this mailbox's own address: that is what makes it reply-all.
    expect((reply.querySelector("#composer-cc") as HTMLInputElement).value).toBe("bob@outside.example");
    expect(calls.filter((call) => call.path.endsWith("/claim")).map((call) => call.path)).toEqual(["/api/cases/case_1/claim"]);

    await click(/message 2/);
    // A click focuses the row in a browser (happy-dom does not); from inside the reply, F would be text.
    screen.getByRole("button", { name: /message 2/ }).focus();
    await key("f");
    const dock = await screen.findByRole("region", { name: "Forward" });
    expect((dock.querySelector("#composer-subject") as HTMLInputElement).value).toBe("Fwd: message 2");
    expect(calls.filter((call) => call.path.endsWith("/claim"))).toHaveLength(1);
  });

  // What a Chinese mail client writes (critic L5); the prefix this screen adds is the mail's own `Re:`/`Fwd:`.
  it.each([
    ["回复：发票", "r", "Reply", "回复：发票"],
    ["回复:发票", "r", "Reply", "回复:发票"],
    ["转发：报价", "f", "Forward", "转发：报价"],
    ["转发:报价", "f", "Forward", "转发:报价"],
    ["发票", "r", "Reply", "Re: 发票"],
    ["报价", "f", "Forward", "Fwd: 报价"],
  ])("keeps %j as the subject's prefix on %s, so it is not doubled", async (subject, letter, dock, expected) => {
    pages = { "": { messages: [row(1, { subject })], next_cursor: null } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
    const button = await screen.findByRole("button", { name: new RegExp(subject) });
    await act(async () => { button.click(); });
    button.focus();
    await key(letter);
    expect(((await screen.findByRole("region", { name: dock })).querySelector("#composer-subject") as HTMLInputElement).value).toBe(expected);
  });
});

describe("J and K cost nothing but the bodies they open (R11)", () => {
  it("moves through the page with no listing request and one body per newly opened message", async () => {
    await mount();
    const before = listings().length;

    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 1"); });
    // Focus follows the selection, so the next key and a screen reader are both on the row being read.
    expect(document.activeElement?.getAttribute("aria-current")).toBe("true");
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 2"); });
    await key("k");
    await waitFor(() => { expect(subject()).toBe("message 1"); });
    await waitFor(() => { expect(bodies()).toEqual(["/api/messages/rcpt_1/body", "/api/messages/rcpt_2/body"]); });

    expect(listings().length, "J or K fetched a listing").toBe(before);
    // And no body was fetched ahead of a key: message 3 was never opened.
    expect(bodies()).not.toContain("/api/messages/rcpt_3/body");
  });

  it("opens a supervised reader's message with one body, its conversation's one listing, and nothing else", async () => {
    pages = { "": { messages: [row(1, { standing_content: 0, conversation_id: "cnv_a" })], next_cursor: null } };
    await mount();
    const before = pageListings().length;
    await click(/message 1/);
    await waitFor(() => { expect(screen.getByText("hello")).toBeDefined(); });
    expect(bodies()).toEqual(["/api/messages/rcpt_1/body"]);
    expect(reads(), "a read mark the Node refuses to a reader without standing content read").toEqual([]);
    expect(pageListings().length).toBe(before);
    // The thread under the reader: one conversation listing (one supervised.query) and its sends, once.
    await waitFor(() => { expect(conversations()).toEqual(["cnv_a"]); });
    expect(sendListings()).toEqual(["cnv_a"]);
  });

  it("lists an opened message's conversation once while it is fresh, and never the page, as J and K move", async () => {
    pages = {
      "": { messages: [row(1, { conversation_id: "cnv_a" }), row(2, { conversation_id: "cnv_a" }), row(3, { conversation_id: "cnv_b" })], next_cursor: null },
    };
    await mount();
    const before = pageListings().length;
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 1"); });
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 2"); });
    await key("k");
    await waitFor(() => { expect(subject()).toBe("message 1"); });
    await waitFor(() => { expect(bodies()).toEqual(["/api/messages/rcpt_1/body", "/api/messages/rcpt_2/body"]); });

    expect(pageListings().length, "J or K fetched a page").toBe(before);
    // Two messages of one conversation share one listing; message 3's conversation was never opened.
    expect(conversations()).toEqual(["cnv_a"]);
    expect(sendListings()).toEqual(["cnv_a"]);
  });

  it("takes J past the last row to the next page, exactly as Older would, and lands on its first row", async () => {
    pages = {
      "": { messages: [row(1), row(2)], next_cursor: "c-2" },
      "c-2": { messages: [row(3), row(4)], next_cursor: null },
    };
    await mount();
    await key("j");
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 2"); });
    const before = listings().length;
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 3"); });
    expect(listings().length).toBe(before + 1);
    expect(new URL(listings().at(-1)!.path, "https://node.example").searchParams.get("cursor")).toBe("c-2");

    // And back: K on the first row of page two is Newer, landing on that page's last row.
    await key("k");
    await waitFor(() => { expect(subject()).toBe("message 2"); });
  });

  it("stays put on K at the top of the first page, where nothing is newer", async () => {
    pages = { "": { messages: [row(1), row(2)], next_cursor: "c-2" }, "c-2": { messages: [row(3)], next_cursor: null } };
    await mount();
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 1"); });
    const before = listings().length;
    await key("k");
    await act(async () => { await Promise.resolve(); });
    expect(subject()).toBe("message 1");
    expect(listings().length).toBe(before);
  });

  it("lands nowhere when the page J reached is empty, and says nothing is older", async () => {
    pages = { "": { messages: [row(1)], next_cursor: "c-2" }, "c-2": { messages: [], next_cursor: null } };
    await mount();
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 1"); });
    await key("j");
    await screen.findByText("Nothing older on this page.");
  });
});

describe("Shift+I marks unread, and it stays unread (R19)", () => {
  it("marks read once on open, unread on the key, and never read again behind the reader's back", async () => {
    await mount();
    await click(/message 1/);
    await waitFor(() => { expect(reads()).toEqual([true]); });
    await waitFor(() => { expect(screen.getByRole("button", { name: /message 1/ }).className).not.toContain("unread"); });

    await key("I", true);
    await waitFor(() => { expect(reads()).toEqual([true, false]); });
    await waitFor(() => { expect(screen.getByRole("button", { name: /message 1/ }).className).toContain("unread"); });
    // A tick for any effect that would re-mark it: the row changed, and the open must not run again.
    await act(async () => { await Promise.resolve(); });
    expect(reads()).toEqual([true, false]);
  });
});

describe("the selection outlives the list it came from", () => {
  it("keeps the reader on a message the next refetch no longer lists", async () => {
    /*
     * Opening a row in the Unread tab marks it read, and the next natural refetch leaves it out. The reader
     * stays on what the person is reading; the list shows what the Node returned.
     */
    const client = await mount();
    await click(/message 1/);
    await waitFor(() => { expect(reads()).toEqual([true]); });
    pages = { "": { messages: [row(2), row(3)], next_cursor: null } };
    const selectedRow = () => screen.getByRole("article", { name: "Message" });
    await act(async () => { await client.invalidateQueries({ queryKey: ["messages"] }); });
    await waitFor(() => { expect(screen.queryByRole("button", { name: /message 1/ })).toBeNull(); });
    expect(subject()).toBe("message 1");

    // And the reader's own copy keeps up with what this screen changed. It was listed unread and opening marked
    // it read, so it offers Mark unread; marked unread by the key, it offers Mark read.
    await act(async () => { within(selectedRow()).getByRole("button", { name: "More actions" }).click(); });
    expect(screen.getByRole("menuitem", { name: "Mark unread" })).toBeDefined();
    await key("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    await key("I", true);
    await waitFor(() => { expect(reads()).toEqual([true, false]); });
    await act(async () => { within(selectedRow()).getByRole("button", { name: "More actions" }).click(); });
    expect(screen.getByRole("menuitem", { name: "Mark read" })).toBeDefined();
  });

  it("offers a way back to the list below 768px, and returns focus to the row it left", async () => {
    viewport(390);
    await mount();
    await click(/message 2/);
    expect(document.querySelector(".mail-panes")?.getAttribute("data-view")).toBe("reader");
    await click("Back to Inbox");
    expect(document.querySelector(".mail-panes")?.getAttribute("data-view")).toBe("list");
    expect(subject()).toBeNull();
    await waitFor(() => { expect((document.activeElement as HTMLElement | null)?.dataset.id).toBe("rcpt_2"); });
  });

  it("moves focus into the reader below 768px, where the list and the row that had focus are hidden", async () => {
    viewport(390);
    await mount();
    const focusedSubject = () => (document.activeElement?.classList.contains("reader-subject") ? document.activeElement.textContent : null);
    await click(/message 2/);
    await waitFor(() => { expect(focusedSubject()).toBe("message 2"); });
    // The list's h1 hides with the list; the screen keeps its name inside the reader.
    const article = screen.getByRole("article", { name: "Message" });
    expect(within(article).getByRole("heading", { level: 1 }).textContent).toBe("Inbox");

    // J opens the next one the same way, and never focuses a row the list is hiding.
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 3"); });
    await waitFor(() => { expect(focusedSubject()).toBe("message 3"); });
  });

  it("offers no Back where the list and the reader are side by side, and leaves focus on the row", async () => {
    viewport(1024);
    await mount();
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 1"); });
    expect(screen.queryByRole("button", { name: "Back to Inbox" })).toBeNull();
    expect(within(screen.getByRole("article", { name: "Message" })).queryByRole("heading", { level: 1 })).toBeNull();
    expect((document.activeElement as HTMLElement | null)?.dataset.id).toBe("rcpt_1");
  });
});

describe("the palette offers a selected message's commands, gated as its buttons are", () => {
  const offered = () => within(screen.getByRole("list", { name: "Commands" })).queryAllByRole("listitem").map((item) => item.textContent);

  it("lists reply, filing and read state for a reader who may do each, and nothing with no selection", async () => {
    await mount();
    expect(offered()).toEqual([]);
    await click(/message 1/);
    await waitFor(() => { expect(offered()).toEqual(["Reply", "Reply all", "Forward", "Archive", "Move to Trash", "Mark unread"]); });
  });

  it("runs the same act as the button, on the message selected now", async () => {
    await mount();
    await click(/message 1/);
    await click(/message 2/);
    await waitFor(() => { expect(offered()).toContain("Archive"); });
    await act(async () => { within(screen.getByRole("list", { name: "Commands" })).getByRole("button", { name: "Archive" }).click(); });
    await waitFor(() => { expect(calls.filter((call) => call.path.endsWith("/place")).map((call) => call.path)).toEqual(["/api/messages/msg_2/place"]); });
  });

  it("offers neither to a reader without the authority", async () => {
    pages = { "": { messages: [row(1, { standing_content: 0, mailbox_id: "mbx_elsewhere" })], next_cursor: null } };
    await mount();
    await click(/message 1/);
    await screen.findByText("hello");
    expect(offered()).toEqual([]);
  });
});

describe("a key that cannot apply says why, and a refusal is the Node's words", () => {
  const toast = () => document.querySelector(".toast-region .toast")?.textContent ?? null;

  it("says it is still reading the mailboxes when R comes before they arrive, and claims nothing", async () => {
    mailboxGate = new Promise(() => {});
    await mount();
    await click(/message 1/);
    await key("r");
    await waitFor(() => { expect(toast()).toBe("Still reading which mailboxes you can send from."); });
    expect(calls.some((call) => call.path.endsWith("/claim"))).toBe(false);
  });

  it("says a message not yet filed cannot be filed or forwarded", async () => {
    pages = { "": { messages: [row(1, { message_id: null, standing_content: 0, case_id: null, case_state: null })], next_cursor: null } };
    await mount();
    await click(/\(no subject\)|message 1/);
    await screen.findByText("hello");
    await key("e");
    await waitFor(() => { expect(toast()).toBe("This message has not been filed yet. Try again in a minute."); });
    await key("f");
    await within(screen.getByRole("article", { name: "Message" })).findByText(/not been filed yet, so there is nothing to forward/);
    expect(screen.queryByRole("region", { name: "Forward" })).toBeNull();
  });

  it("names send.propose when R, A or F meet a mailbox this reader cannot send from", async () => {
    pages = { "": { messages: [row(1, { mailbox_id: "mbx_elsewhere" })], next_cursor: null } };
    await mount();
    await click(/message 1/);
    await screen.findByText("hello");
    for (const letter of ["r", "a", "f"]) {
      await key(letter);
      await waitFor(() => { expect(toast()).toBe("Replying from this mailbox needs send.propose on it, which you do not hold."); });
    }
    expect(calls.some((call) => call.path.endsWith("/claim"))).toBe(false);
    expect(screen.queryByRole("region", { name: /Reply|Forward/ })).toBeNull();
  });

  it("names content read when E or Shift+I meet a message this reader may only open", async () => {
    pages = { "": { messages: [row(1, { standing_content: 0 })], next_cursor: null } };
    await mount();
    await click(/message 1/);
    await screen.findByText("hello");
    await key("e");
    await waitFor(() => { expect(toast()).toBe("Filing and read state need mailbox.content.read on Support, which you do not hold."); });
    await key("I", true);
    expect(calls.some((call) => call.path.endsWith("/place") || call.path.endsWith("/read"))).toBe(false);
  });

  it("shows a refused Mark unread in the Node's words, and leaves the row as it was", async () => {
    readAnswer = (read) => (read
      ? Response.json({ read: true })
      : Response.json({ error: "E_NO_SUCH_MESSAGE", message: "E_NO_SUCH_MESSAGE  not a message you can mark" }, { status: 404 }));
    await mount();
    await click(/message 1/);
    await waitFor(() => { expect(reads()).toEqual([true]); });
    await key("I", true);
    await waitFor(() => { expect(document.querySelector(".toast-region [role=alert] .toast")?.textContent).toBe("E_NO_SUCH_MESSAGE  not a message you can mark"); });
    expect(screen.getByRole("button", { name: /message 1/ }).className).not.toContain("unread");
  });
});

describe("E files the message, from where it is, and can be undone", () => {
  const places = () => calls.filter((call) => call.path.endsWith("/place")).map((call) => (call.body as { place: string }).place);
  const toast = () => document.querySelector(".toast-region .toast");

  it("archives from the Inbox with an Undo that puts it back where it was, and Z runs it", async () => {
    pages = { "": { messages: [row(1, { read: 1 }), row(2, { read: 1 })], next_cursor: null } };
    await mount();
    await click(/message 1/);
    await key("e");
    await waitFor(() => { expect(toast()?.textContent).toContain("Archived."); });
    expect(places()).toEqual(["archive"]);
    // The next row of the list as it stood, where somebody working down a queue expects to be.
    await waitFor(() => { expect(subject()).toBe("message 2"); });
    // And focus with it, as J would: the archived row is leaving the list, and <body> is nowhere.
    await waitFor(() => { expect((document.activeElement as HTMLElement | null)?.dataset.id).toBe("rcpt_2"); });

    await key("z");
    await waitFor(() => { expect(places()).toEqual(["archive", "inbox"]); });
    await waitFor(() => { expect(toast()?.textContent).toContain("Moved back to Inbox."); });
  });

  it("puts a message back in the Trash it came from when a filed row is undone", async () => {
    pages = { "": { messages: [row(1, { place: "trash", read: 1 })], next_cursor: null } };
    await mount();
    await click(/message 1/);
    await key("e");
    await waitFor(() => { expect(toast()).not.toBeNull(); });
    await act(async () => { within(toast() as HTMLElement).getByRole("button", { name: "Undo" }).click(); });
    await waitFor(() => { expect(places()).toEqual(["archive", "trash"]); });
  });

  it("says so, in the Node's words, when the Undo is refused", async () => {
    pages = { "": { messages: [row(1, { read: 1 })], next_cursor: null } };
    placeAnswer = (place) => (place === "inbox"
      ? Response.json({ error: "E_NO_SUCH_MESSAGE", message: "E_NO_SUCH_MESSAGE  not a message you can file" }, { status: 404 })
      : Response.json({ messageId: "msg_1", place }));
    await mount();
    await click(/message 1/);
    await key("e");
    await waitFor(() => { expect(toast()?.textContent).toContain("Archived."); });
    await key("z");
    const alert = await waitFor(() => {
      const found = document.querySelector(".toast-region [role=alert] .toast");
      expect(found?.textContent).toContain("E_NO_SUCH_MESSAGE  not a message you can file");
      return found;
    });
    expect(alert).not.toBeNull();
  });

  it("keeps a searched message selected when it is filed, because a search spans places", async () => {
    pages = { "": { messages: [row(1, { read: 1 }), row(2, { read: 1 })], next_cursor: null } };
    await mount();
    fireEvent.change(screen.getByLabelText("Search mail"), { target: { value: "message" } });
    await act(async () => { screen.getByRole("button", { name: "Search" }).click(); });
    await waitFor(() => { expect(calls.some((call) => call.path.includes("q=message"))).toBe(true); });
    await click(/message 1/);
    await key("e");
    await waitFor(() => { expect(toast()?.textContent).toContain("Archived."); });
    expect(subject()).toBe("message 1");
  });

  it("says a message already in the Archive is there, and asks the Node nothing", async () => {
    pages = { "": { messages: [row(1, { place: "archive", read: 1 })], next_cursor: null } };
    await mount();
    await click(/message 1/);
    await key("e");
    await waitFor(() => { expect(toast()?.textContent).toContain("Already in Archive."); });
    expect(places()).toEqual([]);
  });
});

describe("a reply waits for the body that says whom it answers", () => {
  const claims = () => calls.filter((call) => call.path.endsWith("/claim")).map((call) => call.path);

  async function heldBody() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    body = {
      ...BODY, text: "the question",
      recipients: { to: ["support@example.test", "bob@outside.example"], cc: ["carol@outside.example"], replyTo: "billing@outside.example" },
    };
    bodyAnswer = async () => { await gate; return Response.json(body); };
    await mount();
    // J opens message 1 with its body still in the air, then the letter comes before the body does.
    await key("j");
    await waitFor(() => { expect(subject()).toBe("message 1"); });
    return () => act(async () => { release(); });
  }

  it("sends R to Reply-To with the real quote, not to From with an ellipsis, when R beats the body", async () => {
    const release = await heldBody();
    await key("r");
    // Nothing is claimed or opened on a guess.
    expect(claims()).toEqual([]);
    expect(screen.queryByRole("region", { name: "Reply" })).toBeNull();

    await release();
    const reply = await screen.findByRole("region", { name: "Reply" });
    expect((reply.querySelector("#composer-to") as HTMLInputElement).value).toBe("billing@outside.example");
    expect((reply.querySelector("#composer-body") as HTMLTextAreaElement).value).toContain("> the question");
    expect(claims()).toEqual(["/api/cases/case_1/claim"]);
    // The reader's request, joined: one read of the body, so one recorded open.
    expect(bodies()).toEqual(["/api/messages/rcpt_1/body"]);
  });

  it("copies everybody else on A when A beats the body", async () => {
    const release = await heldBody();
    await key("a");
    await release();
    const reply = await screen.findByRole("region", { name: "Reply" });
    expect((reply.querySelector("#composer-to") as HTMLInputElement).value).toBe("billing@outside.example");
    expect((reply.querySelector("#composer-cc") as HTMLInputElement).value).toBe("bob@outside.example, carol@outside.example");
  });

  it("opens and claims nothing when the body cannot be read, and says why in the message", async () => {
    bodyAnswer = async () => Response.json({ error: "E_UNHANDLED" }, { status: 500 });
    await mount();
    await click(/message 1/);
    await key("r");
    const article = screen.getByRole("article", { name: "Message" });
    await within(article).findByText(/The body could not be read \(500\)\. Without it, who a reply goes to and whom it copies are unknown/);
    expect(claims()).toEqual([]);
    expect(screen.queryByRole("region", { name: "Reply" })).toBeNull();
  });
});

describe("the list is one Tab stop, and the arrow keys move focus inside it", () => {
  const stops = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button.message-row"))
    .filter((button) => button.tabIndex === 0).map((button) => button.dataset.id);
  const focusedRow = () => (document.activeElement as HTMLElement | null)?.dataset.id ?? null;
  const arrow = (name: string) => act(async () => { fireEvent.keyDown(document.activeElement!, { key: name }); });

  it("keeps exactly one stop, moves focus without opening anything, and falls back to a page's first row", async () => {
    pages = {
      "": { messages: [row(1), row(2), row(3)], next_cursor: "c-2" },
      "c-2": { messages: [row(4), row(5)], next_cursor: null },
    };
    await mount();
    expect(stops()).toEqual(["rcpt_1"]);
    // Focus on row 1, then row 2 opened by a click that does not focus it (Safari; happy-dom): the stop is
    // the message being read, not the row focus last passed through.
    screen.getByRole("button", { name: /message 1/ }).focus();
    await click(/message 2/);
    expect(stops()).toEqual(["rcpt_2"]);

    screen.getByRole("button", { name: /message 2/ }).focus();
    const opened = bodies().length;
    await arrow("ArrowDown");
    expect(focusedRow()).toBe("rcpt_3");
    expect(stops()).toEqual(["rcpt_3"]);
    await arrow("ArrowDown");
    expect(focusedRow(), "ArrowDown wrapped or left the list").toBe("rcpt_3");
    await arrow("Home");
    expect(focusedRow()).toBe("rcpt_1");
    await arrow("End");
    expect(focusedRow()).toBe("rcpt_3");
    await arrow("ArrowUp");
    expect(focusedRow()).toBe("rcpt_2");
    // Focus only: the message being read is still message 2, and no body was fetched for a row passed over.
    expect(subject()).toBe("message 2");
    expect(bodies().length).toBe(opened);

    // A page holding neither the focused row nor the one being read: its first row is the stop.
    await click("Older");
    await waitFor(() => { expect(stops()).toEqual(["rcpt_4"]); });
  });
});
