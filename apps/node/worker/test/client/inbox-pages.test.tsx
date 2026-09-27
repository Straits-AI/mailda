import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BUDGETS } from "@mailda/budgets";

import { answerMailboxes, answerWith, calls, reset } from "./session-stub.ts";
import { messagesKey, type MessageRow } from "../../src/client/app/api.ts";

/**
 * The list pane's pages, counts and empties, rendered (#91, #101, the lookback).
 *
 * ## Why this one has to mount
 *
 * The defect #91 fixed was *"no control the interface can render would return the fifty-first message"*, so
 * the fix is a control and the thing worth checking is what the screen does with the Node's answer:
 *
 * - **Older exists exactly when `next_cursor` is non-null**, inside the list pane. A disabled button, or one
 *   that leads to an empty page, is the shape this screen refuses — a button that can only fail.
 * - **The cursor goes back verbatim, on the next request.** A client that reformats or forgets it quietly
 *   re-reads page one for ever; the Node cannot tell that from a first visit.
 * - **A page is never printed as a total.** `n` only when the Node says nothing older is visible, `n+` when it
 *   says more is, "Page K" further on, and no figure at all for an empty page — including one the lookback
 *   cut short, which always carries a cursor.
 * - **Each empty says the one thing true of it.** Page four is not "nothing has arrived"; an empty page one is
 *   not "routing is live"; a lookback that found nothing is neither "empty" nor a routing question.
 */

// `Link` because the empty Inbox points at Doctor through `Nothing`'s action; without it the screen throws and
// renders an empty document, which reads in the failure output like the query never resolved.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

/** One row, with every field the list and the reading pane read. */
function row(n: number, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: `rcpt_${n}`, message_id: `msg_${n}`, subject: `message ${n}`,
    from_addr: `sender${n}@outside.example`, envelope_from: `sender${n}@outside.example`,
    envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
    accepted_at: "2026-08-20T09:00:00.000Z", parse_error: null, conversation_id: null, case_id: null,
    auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
    attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
    place: "inbox", from_name: null, preview: null, standing_content: 1, case_mine: 0, case_state: null,
    ...over,
  };
}

type Page = { messages: MessageRow[]; next_cursor: string | null; lookback_exhausted?: boolean; max_lookback?: number | null };

/**
 * Answers `/api/messages` from a map of cursor to page, and records nothing else.
 *
 * Keyed on the cursor the request carried, so the assertion *"the second request asked for the cursor the
 * first page returned"* is made by the fixture being reachable at all — a client that dropped the cursor
 * would get page one again and the test would see page one's rows.
 */
function answerPages(pages: Record<string, Page>) {
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname !== "/api/messages") return undefined;
    const page = pages[url.searchParams.get("cursor") ?? ""];
    return Response.json({ lookback_exhausted: false, max_lookback: null, ...(page ?? { messages: [], next_cursor: null }) });
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
  return client;
}

/**
 * Waits for the query to have answered, by waiting for the screen to stop saying it is reading.
 *
 * `waitFor` rather than a fixed number of microtasks: this waits on a fetch and on react-query's own
 * scheduling, and a fixed count left "Reading…" on screen on some runs and not others.
 */
async function settle() {
  await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
}

async function press(name: RegExp | string) {
  await act(async () => { screen.getByRole("button", { name }).click(); });
}

const listPane = () => screen.getByRole("region", { name: "Message list" });
const count = () => document.querySelector(".list-count")?.textContent ?? null;
/** The list pane's one status region: what a screen reader hears when a filter or a search answers. */
const heard = () => document.querySelector(".list-pane > [role=status]")?.textContent ?? null;
const listings = () => calls.filter((call) => call.path.startsWith("/api/messages"))
  .map((call) => new URL(call.path, "https://node.example").searchParams);

beforeEach(() => {
  reset();
});

describe("the inbox can reach the page after the first", () => {
  it("renders Older only when the Node says there is more, inside the list pane, and sends the cursor back verbatim", async () => {
    const cursor = "2026-08-20T09:00:00.000Z rcpt_1";
    answerPages({
      "": { messages: [row(1), row(2)], next_cursor: cursor },
      [cursor]: { messages: [row(3)], next_cursor: null },
    });
    mount();
    await settle();

    expect(screen.getByText("message 1")).toBeDefined();
    // Inside the pane it pages: a pager rendered anywhere else scrolls away from the list it moves.
    await act(async () => { within(listPane()).getByRole("button", { name: "Older" }).click(); });
    await settle();

    // Compared decoded: `encodeURIComponent` turns the space into `%20`, which is the encoding, not a value.
    expect(listings().at(-1)!.get("cursor")).toBe(cursor);
    expect(screen.getByText("message 3")).toBeDefined();
    expect(screen.queryByText("message 1")).toBeNull();
    // Nothing older, so nothing offers to go there. The end of the list is an absent control, not a dead one.
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
    expect(within(listPane()).getByRole("button", { name: "Newer" })).toBeDefined();
  });

  it("goes back to the page it came from without asking the Node for a backwards cursor", async () => {
    const cursor = "2026-08-20T09:00:00.000Z rcpt_2";
    answerPages({
      "": { messages: [row(1), row(2)], next_cursor: cursor },
      [cursor]: { messages: [row(3)], next_cursor: null },
    });
    mount();
    await settle();
    await press("Older");
    await settle();

    await press("Newer");
    await settle();
    expect(screen.getByText("message 1")).toBeDefined();
    // Going back is a `pop` of cursors already used: the only cursors ever sent are ones the Node produced.
    expect(new Set(listings().map((query) => query.get("cursor")))).toEqual(new Set([null, cursor]));
    expect(screen.queryByRole("button", { name: "Newer" })).toBeNull();
  });

  it("does not claim nothing has arrived when a later page is empty", async () => {
    /*
     * Reachable in one gesture: the Node said there was more, and by the time the reader pressed for it the
     * rows it counted had been revoked — which the cursor design deliberately allows, because every page
     * re-runs the authorization. So this screen has to have something true to say about it.
     */
    const cursor = "2026-08-20T09:00:00.000Z rcpt_2";
    answerPages({
      "": { messages: [row(1), row(2)], next_cursor: cursor },
      [cursor]: { messages: [], next_cursor: null },
    });
    mount();
    await settle();
    await press("Older");
    await settle();

    expect(screen.getByText(/Nothing older on this page/)).toBeDefined();
    expect(screen.queryByText(/No messages are visible/)).toBeNull();
    expect(count(), "an empty page printed a figure").toBeNull();
    // And the way back, because the reader got here by pressing a control this screen rendered.
    expect(screen.getByRole("button", { name: "Newest" })).toBeDefined();
  });
});

describe("the count is never a total nothing counted (#91)", () => {
  it("prints n on page one when the Node says nothing older is visible", async () => {
    answerPages({ "": { messages: [row(1), row(2)], next_cursor: null } });
    mount();
    await settle();
    expect(count()).toBe("2 messages");
  });

  it("prints n+ when more is visible, and the page number further on — never a page size as a total", async () => {
    const cursor = "2026-08-20T09:00:00.000Z rcpt_2";
    answerPages({
      "": { messages: [row(1), row(2)], next_cursor: cursor },
      [cursor]: { messages: [row(3)], next_cursor: null },
    });
    mount();
    await settle();
    expect(count()).toBe("2+ messages");
    expect(screen.queryByText(/shown/)).toBeNull();

    await press("Older");
    await settle();
    expect(count()).toBe("Page 2");
  });

  it("reads a page the lookback cut short as n+, an ordinary page with a cursor and no extra words", async () => {
    answerPages({ "": { messages: [row(1), row(2), row(3)], next_cursor: "c-edge", lookback_exhausted: true } });
    mount();
    await settle();
    expect(count()).toBe("3+ messages");
    expect(within(listPane()).getByRole("button", { name: "Older" })).toBeDefined();
    expect(screen.queryByText(/None of the/)).toBeNull();
  });
});

describe("rows show what a person triages by, and lose nothing the Node accepted", () => {
  it("keeps a receipt not yet materialised in the list, with the envelope sender and no subject", async () => {
    // R1: accepted but absent is the worst mail failure; a renderer that needs a parsed subject builds it.
    answerPages({ "": { messages: [row(1, { message_id: null, subject: null, from_addr: null, envelope_from: "early@outside.example", standing_content: 0 })], next_cursor: null } });
    mount();
    await settle();
    const rows = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("(no subject)");
    expect(rows[0]!.textContent).toContain("early@outside.example");
  });

  it("says (no subject) for a blank subject, which a header parse failure stores", async () => {
    answerPages({ "": { messages: [row(1, { subject: "  " })], next_cursor: null } });
    mount();
    await settle();
    expect(screen.getByRole("button", { name: /\(no subject\)/ })).toBeDefined();
  });

  it("marks a DMARC fail on the row, where triage happens, and not on a pass", async () => {
    answerPages({ "": { messages: [row(1, { auth_dmarc: "fail" }), row(2, { auth_dmarc: "pass" })], next_cursor: null } });
    mount();
    await settle();
    const [failing, passing] = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("button");
    expect(failing!.querySelector(".chip-auth-fail")?.textContent).toBe("DMARC fail");
    expect(passing!.querySelector(".chip-auth-fail")).toBeNull();
    // A row with nothing to flag carries no chip strip at all, rather than an empty one taking a grid cell.
    expect(passing!.querySelector(".row-chips")).toBeNull();
  });

  it("shows the sender's name with the address a hover away, the preview, and whose case it is", async () => {
    answerPages({
      "": {
        messages: [
          row(1, { from_name: "Aisha Rahman", preview: "Please find attached", case_state: "claimed", case_mine: 1, read: 0 }),
          row(2, { case_state: "claimed", case_mine: 0 }),
        ],
        next_cursor: null,
      },
    });
    mount();
    await settle();
    const [mine, held] = within(screen.getByRole("list", { name: "Messages" })).getAllByRole("button");
    expect(mine!.querySelector(".row-sender")?.textContent).toBe("Aisha Rahman");
    expect(mine!.querySelector(".row-sender")?.getAttribute("title")).toBe("sender1@outside.example");
    expect(mine!.querySelector(".row-preview")?.textContent).toBe("Please find attached");
    expect(mine!.querySelector(".chip-mine")?.textContent).toBe("Mine");
    expect(mine!.textContent).toContain("Unread, ");
    expect(held!.querySelector(".chip-held")?.textContent).toBe("Held");
    // Held means somebody else: the reader's own claimed case is Mine, never Held as well.
    expect(mine!.querySelector(".chip-held")).toBeNull();
    expect(held!.querySelector(".chip-mine")).toBeNull();
    expect(held!.querySelector(".row-preview")).toBeNull();
  });
});

describe("the default view shares one request with the sidebar (R11, the Inbox half)", () => {
  it("asks under exactly messagesKey({ place: \"inbox\" })", async () => {
    answerPages({ "": { messages: [row(1)], next_cursor: null } });
    const client = mount();
    await settle();
    const keys = client.getQueryCache().findAll({ queryKey: ["messages"] }).map((query) => query.queryKey);
    expect(keys).toEqual([messagesKey({ place: "inbox" })]);
    expect(listings()[0]!.get("place")).toBe("inbox");
  });
});

describe("an empty Inbox makes no claim about routing (#101)", () => {
  it("says what an empty list means, and points at what can answer the rest", async () => {
    /*
     * The old copy read "This Node is claimed and routing is live", concluded from an empty result set.
     * Routing never enabled, MX pointing elsewhere, a catch-all aimed at another Worker and no address at
     * all produce this same screen — so the sentence told a reader with broken routing that it worked.
     */
    answerMailboxes([{ id: "mbx_only", name: "Support", addresses: "support@example.test" }]);
    answerPages({ "": { messages: [], next_cursor: null } });
    mount();
    // The empty state itself is the anchor: the negatives below are true of a loading screen too.
    await screen.findByText(/No messages are visible in your Inbox/);
    expect(screen.queryByText(/routing is live/i), "the unverified claim is still here").toBeNull();
    expect(screen.getByText(/inbound routing/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing older on this page/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Older" })).toBeNull();
  });

  it("does not tell the reader nothing has been hidden from them", async () => {
    /*
     * Authorization happens inside the SQL (ADR 11, §5), so an empty Inbox routinely means "nothing you may
     * see" — and this is the one screen where that reassurance is most likely to be read and most certainly false.
     */
    answerPages({ "": { messages: [], next_cursor: null } });
    mount();
    await screen.findByText(/No messages are visible in your Inbox/);
    expect(screen.queryByText(/nothing has been hidden from you/i)).toBeNull();
  });
});

describe("a lookback that found nothing says what it looked at (R26)", () => {
  /**
   * The answering Node's figure, `max_lookback`, formatted as the screen formats it. Deliberately not this
   * build's budget: a Node running another bound must be described by its own number, not the bundle's.
   */
  const LOOKED = BUDGETS["messages.max_lookback"] + 7;
  const N = LOOKED.toLocaleString();
  const CURSOR = "2026-08-01T09:00:00.000Z rcpt_edge";

  it("names the newest N it looked through, prints no figure, and looks further back in one request", async () => {
    answerPages({
      "": { messages: [], next_cursor: CURSOR, lookback_exhausted: true, max_lookback: LOOKED },
      [CURSOR]: { messages: [row(9)], next_cursor: null },
    });
    mount();
    await screen.findByText(`None of the newest ${N} messages you can see is in your Inbox.`);
    expect(count(), "an empty exhausted page printed a figure").toBeNull();
    // Neither of the sentences for a listing that ended: nothing here is known to be empty.
    expect(screen.queryByText(/No messages are visible/)).toBeNull();

    const before = listings().length;
    await press("Look further back");
    await screen.findByText("message 9");
    expect(listings().length).toBe(before + 1);
    expect(listings().at(-1)!.get("cursor")).toBe(CURSOR);
  });

  it("says unread on the Unread tab and a case you hold on Mine", async () => {
    answerWith((call) => {
      const url = new URL(call.path, "https://node.example");
      if (url.pathname !== "/api/messages") return undefined;
      const exhausted = url.searchParams.has("unread") || url.searchParams.has("mine");
      return Response.json({ messages: exhausted ? [] : [row(1)], next_cursor: exhausted ? CURSOR : null, lookback_exhausted: exhausted, max_lookback: exhausted ? LOOKED : null });
    });
    mount();
    await settle();
    await act(async () => { screen.getByRole("tab", { name: "Unread" }).click(); });
    await screen.findByText(`None of the newest ${N} messages you can see is unread.`);
    await act(async () => { screen.getByRole("tab", { name: "Mine" }).click(); });
    await screen.findByText(`None of the newest ${N} messages you can see is in a case you hold.`);
  });

  it("names the filters when they are on, and offers to clear them", async () => {
    answerWith((call) => {
      const url = new URL(call.path, "https://node.example");
      if (url.pathname !== "/api/messages") return undefined;
      const filtered = url.searchParams.has("from");
      return Response.json({ messages: filtered ? [] : [row(1)], next_cursor: filtered ? CURSOR : null, lookback_exhausted: filtered, max_lookback: filtered ? LOOKED : null });
    });
    mount();
    await settle();
    await press("Filter");
    fireEvent.change(document.getElementById("inbox-from")!, { target: { value: "a@b.example" } });
    await press("Apply");
    // The notice itself: the status region says the same sentence (`heard`), which is the point of it.
    await screen.findByText(`None of the newest ${N} messages you can see that match these filters is in your Inbox.`, { selector: ".notice" });
    await press("Clear filters");
    // The unfiltered page is already cached, so clearing is a cache hit: asserted on the screen, not the wire.
    await screen.findByText("message 1");
    expect(document.querySelector(".filter-count")).toBeNull();
  });

  it("says next N older on a later page, and offers the way back", async () => {
    const first = "2026-08-20T09:00:00.000Z rcpt_1";
    answerPages({
      "": { messages: [row(1)], next_cursor: first },
      [first]: { messages: [], next_cursor: CURSOR, lookback_exhausted: true, max_lookback: LOOKED },
    });
    mount();
    await settle();
    await press("Older");
    await screen.findByText(`None of the next ${N} older messages you can see is in your Inbox.`);
    expect(screen.getByRole("button", { name: "Newest" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Look further back" })).toBeDefined();
  });
});

describe("the status region speaks the count's words, never a total (#91)", () => {
  /*
   * What a screen reader hears when a filter answers. The visible count and the empty states are careful never
   * to print a page as a total or an unfinished lookback as a zero; a live region built from the row count
   * alone said both, out loud, to exactly the reader who cannot see the page it contradicts.
   */
  const FIRST = "2026-08-20T09:00:00.000Z rcpt_1";
  const EDGE = "2026-08-01T09:00:00.000Z rcpt_edge";

  /** Answers the filtered listing from `pages` by cursor, and the unfiltered one with a single row. */
  function answerFiltered(pages: Record<string, Page>) {
    answerWith((call) => {
      const url = new URL(call.path, "https://node.example");
      if (url.pathname !== "/api/messages") return undefined;
      if (!url.searchParams.has("from")) return Response.json({ messages: [row(1)], next_cursor: null, lookback_exhausted: false, max_lookback: null });
      const page = pages[url.searchParams.get("cursor") ?? ""] ?? { messages: [], next_cursor: null };
      return Response.json({ lookback_exhausted: false, max_lookback: null, ...page });
    });
  }

  async function filterBySender() {
    mount();
    await settle();
    await press("Filter");
    fireEvent.change(document.getElementById("inbox-from")!, { target: { value: "a@b.example" } });
    await press("Apply");
  }

  it("says the page, not its rows as a total, on a later page of a filtered list", async () => {
    const twelve = Array.from({ length: 12 }, (_, at) => row(20 + at));
    answerFiltered({ "": { messages: [row(2), row(3)], next_cursor: FIRST }, [FIRST]: { messages: twelve, next_cursor: null } });
    await filterBySender();
    await waitFor(() => { expect(heard()).toBe("2+ messages match these filters."); });

    await press("Older");
    await screen.findByText("message 31");
    expect(count()).toBe("Page 2");
    expect(heard()).toBe("Page 2 of the mail that matches these filters.");
    expect(heard(), "a later page was announced as a total").not.toContain("12");
  });

  it("says what the lookback looked through, not a zero, on an empty filtered page it cut short", async () => {
    const LOOKED = BUDGETS["messages.max_lookback"] + 7;
    answerFiltered({ "": { messages: [], next_cursor: EDGE, lookback_exhausted: true, max_lookback: LOOKED } });
    await filterBySender();
    await waitFor(() => {
      expect(heard()).toBe(`None of the newest ${LOOKED.toLocaleString()} messages you can see that match these filters is in your Inbox.`);
    });
  });

  it("says nothing older is on an empty later page, not that nothing matches", async () => {
    answerFiltered({ "": { messages: [row(2)], next_cursor: FIRST }, [FIRST]: { messages: [], next_cursor: null } });
    await filterBySender();
    await waitFor(() => { expect(heard()).toBe("1+ messages match these filters."); });

    await press("Older");
    await screen.findByText(/Nothing older on this page/, { selector: ".notice" });
    expect(heard()).toBe("Nothing older on this page.");
  });
});
