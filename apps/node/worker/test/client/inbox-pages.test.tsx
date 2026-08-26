import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * The control that reaches older mail, rendered (#91).
 *
 * ## Why this one has to mount
 *
 * The defect #91 fixed was *"no control the interface can render would return the fifty-first message"*, so
 * the fix is a control and the thing worth checking is what the screen does with the Node's answer. Three of
 * those are arrangement rather than logic, which is what `vitest.client.config.ts` exists for:
 *
 * - **`older` exists exactly when `next_cursor` is non-null.** A disabled button, or one that leads to an
 *   empty page, is the shape this screen already refuses elsewhere — *"a button that can only fail is worse
 *   than no button"*.
 * - **The cursor goes back verbatim, on the next request.** A cursor the client reformats, or forgets, is a
 *   client that quietly re-reads page one for ever; the Node cannot tell that apart from a first visit.
 * - **An empty page past the end does not say "nothing has arrived yet".** That sentence is a claim about the
 *   whole Node and is false on page four. It is #101's defect in a new place, and #101 is one of the four the
 *   audit found in this directory.
 *
 * The cursor stack itself is component state, so `newer` cannot be tested by calling a function: there isn't
 * one to call.
 */

// `useNavigate` needs a router around it, and `Composer` — which the inbox imports — is its only caller here.
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");

/** One row, with the fields the list and the reading pane read. */
function row(n: number) {
  return {
    id: `rcpt_${n}`,
    message_id: `msg_${n}`,
    subject: `message ${n}`,
    from_addr: `sender${n}@outside.example`,
    envelope_from: `sender${n}@outside.example`,
    envelope_to: "support@example.test",
    mailbox_id: "mbx_test",
    raw_bytes: 1024,
    accepted_at: "2026-08-20T09:00:00.000Z",
    parse_error: null,
    conversation_id: null,
    case_id: null,
  };
}

/**
 * Answers `/api/messages` from a map of cursor to page, and records nothing else.
 *
 * Keyed on the cursor the request carried, so the assertion *"the second request asked for the cursor the
 * first page returned"* is made by the fixture being reachable at all — a client that dropped the cursor
 * would get page one again and the test would see page one's rows.
 */
function answerPages(pages: Record<string, { messages: unknown[]; next_cursor: string | null }>) {
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname !== "/api/messages") return Response.json({});
    const cursor = url.searchParams.get("cursor") ?? "";
    const page = pages[cursor];
    if (page === undefined) return Response.json({ messages: [], next_cursor: null });
    return Response.json(page);
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
}

/**
 * Waits for the query to have answered, by waiting for the screen to stop saying it is reading.
 *
 * `waitFor` rather than `await Promise.resolve()` twice, which is what `composer-close.test.tsx` uses and is
 * not enough here: that suite drives a timer it controls, this one waits on a fetch and on react-query's own
 * scheduling. Both a fixed number of microtasks and a single macrotask left the screen showing "Reading…" on
 * some runs and not others — a flake in the harness, in a suite whose whole subject is what the screen shows.
 */
async function settle() {
  await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
}

async function press(name: RegExp) {
  await act(async () => { screen.getByRole("button", { name }).click(); });
}

const messageCalls = () => calls.filter((call) => call.path.startsWith("/api/messages"));

beforeEach(() => {
  reset();
});

describe("the inbox can reach the page after the first", () => {
  it("renders older only when the Node says there is more, and sends the cursor back verbatim", async () => {
    const cursor = "2026-08-20T09:00:00.000Z rcpt_1";
    answerPages({
      "": { messages: [row(1), row(2)], next_cursor: cursor },
      [cursor]: { messages: [row(3)], next_cursor: null },
    });
    mount();
    await settle();

    expect(screen.getByText("message 1")).toBeDefined();
    await press(/^older$/);
    await settle();

    // The request the button made, with the cursor exactly as it arrived. `encodeURIComponent` turns the
    // space into `%20`, which is the encoding rather than a different value — so it is compared decoded.
    const asked = messageCalls().at(-1)!.path;
    expect(new URL(asked, "https://node.example").searchParams.get("cursor")).toBe(cursor);

    expect(screen.getByText("message 3")).toBeDefined();
    expect(screen.queryByText("message 1")).toBeNull();
    // Nothing older, so nothing offers to go there. The end of the list is an absent control, not a dead one.
    expect(screen.queryByRole("button", { name: /^older$/ })).toBeNull();
  });

  it("says which page it is on, and does not print a count it does not have", async () => {
    const cursor = "2026-08-20T09:00:00.000Z rcpt_2";
    answerPages({
      "": { messages: [row(1), row(2)], next_cursor: cursor },
      [cursor]: { messages: [row(3)], next_cursor: null },
    });
    mount();
    await settle();

    /*
     * `2 shown`, not `2 messages`. The old wording was true only while the listing returned everything there
     * was; against a page it states a count of the archive and prints the size of a page instead.
     */
    expect(screen.getByText("2 shown")).toBeDefined();
    await press(/^older$/);
    await settle();
    expect(screen.getByText("1 shown · page 2")).toBeDefined();
  });

  it("goes back to the page it came from without asking the Node for a backwards cursor", async () => {
    const cursor = "2026-08-20T09:00:00.000Z rcpt_2";
    answerPages({
      "": { messages: [row(1), row(2)], next_cursor: cursor },
      [cursor]: { messages: [row(3)], next_cursor: null },
    });
    mount();
    await settle();
    await press(/^older$/);
    await settle();

    await press(/^newer$/);
    await settle();
    expect(screen.getByText("message 1")).toBeDefined();
    // Going back is a `pop` of cursors already used, which is why there is no reverse query and no
    // `previous_cursor` on the wire. The only cursors ever sent are ones the Node produced.
    const sent = messageCalls().map((call) => new URL(call.path, "https://node.example").searchParams.get("cursor"));
    expect(new Set(sent)).toEqual(new Set([null, cursor]));
    // And page one offers no way further back, because there is nothing behind it.
    expect(screen.queryByRole("button", { name: /^newer$/ })).toBeNull();
  });

  it("does not claim nothing has arrived when a later page is empty", async () => {
    /*
     * Reachable in one gesture: the Node said there was more, and by the time the reader pressed for it the
     * rows it counted had been revoked — which is the case the cursor design deliberately allows, because
     * every page re-runs the authorization. So this screen has to have something true to say about it.
     */
    const cursor = "2026-08-20T09:00:00.000Z rcpt_2";
    answerPages({
      "": { messages: [row(1), row(2)], next_cursor: cursor },
      [cursor]: { messages: [], next_cursor: null },
    });
    mount();
    await settle();
    await press(/^older$/);
    await settle();

    expect(screen.getByText(/Nothing older on this page/)).toBeDefined();
    expect(screen.queryByText(/Nothing has arrived yet/)).toBeNull();
    // And the way back, because the reader got here by pressing a control this screen rendered.
    expect(screen.getByRole("button", { name: /^newest$/ })).toBeDefined();
  });

  it("still says nothing has arrived on an empty page one, which is the true statement there", async () => {
    // The control for the test above: the sentence is not wrong, it was being said in the wrong place.
    answerPages({ "": { messages: [], next_cursor: null } });
    mount();
    await settle();
    expect(screen.getByText(/Nothing has arrived yet/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /^older$/ })).toBeNull();
  });
});
