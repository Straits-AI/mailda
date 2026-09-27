import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { answer, seen, reset } from "./session-stub.ts";

import { Inbox } from "../../src/client/app/screens/inbox.tsx";
import { ShellProvider, usePendingSearch } from "../../src/client/app/shell-context.tsx";

/**
 * The search field on the inbox (#107).
 *
 * ## What is worth testing here rather than on the Node
 *
 * Three things, and each is a decision that could regress silently:
 *
 * 1. **It submits rather than searching per keystroke.** Every letter reaching the Node would be one
 *    authorization and, for a supervised reader, one `supervised.query` audit entry *per keystroke* —
 *    recording mail nobody looked at. That is a §7 problem, not a performance one, and nothing on the Node
 *    can detect it: from there, ten requests for ten prefixes look like ten legitimate searches.
 * 2. **A search that matches nothing does not read like an empty mailbox.** The two sentences are different
 *    claims and #101 is this repository's history of getting that wrong.
 * 3. **The term reaches the Node as typed.** A client that trimmed, tokenized or "helped" would be a second
 *    opinion about what a search means, and the shell and the SDK would then disagree about the same words.
 *
 * **No router here, on purpose.** The list pane must mount without one: nothing on the path to a listed row
 * may use a `Link` or a router hook, and this file is the one that would throw if something did.
 */

/**
 * Typing, one `change` event per character.
 *
 * `fireEvent.change` sets the whole value at once, which would make "typing sends nothing" a test of a single
 * event. Firing one per prefix is what a real keyboard produces and is exactly the shape the assertion is
 * about — a search-as-you-type implementation issues a request on each of these.
 */
async function type(field: HTMLElement, text: string): Promise<void> {
  for (let at = 1; at <= text.length; at++) {
    await act(async () => {
      fireEvent.change(field, { target: { value: text.slice(0, at) } });
    });
  }
}

/**
 * Submits by **clicking the button**, which is the assertion rather than the mechanism (#128).
 *
 * The brand's field is a pill with a magnifier inside it, and the usual way that is built is a decorative
 * glyph beside an input that submits on Enter — which loses the button, so a keyboard has nothing to land on
 * and a screen reader is told the search cannot be run. Finding the control by its accessible name, and
 * clicking it, is what keeps the icon a button rather than a picture.
 */
async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
  });
}

/** The list's status region: what a screen reader is told a search or a filter came back with. */
const heard = () => document.querySelector(".list-pane > [role=status]")?.textContent ?? null;

async function click(name: RegExp | string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

/** Stands where the palette's "Search mail for …" does: it only asks, and the Inbox runs it. */
function Palette({ term }: { term: string }) {
  const search = usePendingSearch();
  return <button type="button" onClick={() => search.request(term)}>Search mail for {term}</button>;
}

function mounted(palette: string | null = null, inbox = "a") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (key: string) => (
    <QueryClientProvider client={client}>
      <ShellProvider><Inbox key={key} />{palette === null ? null : <Palette term={palette} />}</ShellProvider>
    </QueryClientProvider>
  );
  const result = render(tree(inbox));
  /** A new Inbox under the same shell: what leaving the screen and coming back does. */
  return { ...result, remount: (key: string) => result.rerender(tree(key)) };
}

/** The rows of the Messages list, and only those: tabs, chips and the pager are not rows. */
const listed = () => within(screen.getByRole("list", { name: "Messages" })).getAllByRole("listitem");
const asked = () => new URL(seen("/api/messages").at(-1)!, "https://node.example").searchParams;

/** A page of results, shaped like the Node's response. */
function page(rows: number, cursor: string | null = null) {
  return {
    messages: Array.from({ length: rows }, (_, n) => ({
      id: `rcpt_${String(n).padStart(26, "0")}`,
      envelope_from: `sender-${n}@supplier.example`,
      envelope_to: "in@example.com",
      raw_bytes: 1024,
      accepted_at: "2026-08-20T09:00:00.000Z",
      mailbox_id: "mbx_1",
      message_id: `msg_${String(n).padStart(26, "0")}`,
      subject: `Demurrage claim ${n}`,
      from_addr: `sender-${n}@supplier.example`,
      parse_error: null,
      conversation_id: `cnv_${n}`,
      case_id: `cas_${n}`,
      auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
      attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
      // A search spans places, so one result lives in the Archive and says so.
      place: n === 1 ? "archive" : "inbox",
      from_name: null, preview: null, standing_content: 1, case_mine: 0, case_state: "open",
    })),
    next_cursor: cursor,
    lookback_exhausted: false,
  };
}

beforeEach(() => {
  reset();
  answer("/api/mailboxes", () => ({ mailboxes: [{ id: "mbx_1", name: "Enquiries" }] }));
});

describe("searching from the inbox", () => {
  it("names the field and its button differently, and the button is a submit wearing the magnifier", async () => {
    /*
     * These replace the brand test's reading of the JSX: the pill's magnifier is the submit button's face, not
     * a glyph beside a field that submits on Enter, and the field and the button cannot share one name.
     */
    answer("/api/messages", () => page(1));
    mounted();
    const field = screen.getByLabelText("Search mail");
    const button = screen.getByRole("button", { name: "Search" });
    expect(field.tagName).toBe("INPUT");
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(field.getAttribute("placeholder")).toBe("Search mail");
  });

  it("sends nothing while typing and one request on submit", async () => {
    /*
     * The assertion that matters most, and it is counted rather than observed: typing eight characters must
     * produce **zero** additional listing requests, and pressing the button must produce exactly one.
     *
     * A version of this that only checked the final request would pass against a search-as-you-type
     * implementation, because that one also sends the right thing eventually.
     */
    answer("/api/messages", () => page(2));
    mounted();
    await waitFor(() => expect(seen("/api/messages").length).toBe(1));

    const before = seen("/api/messages").length;
    await type(screen.getByLabelText("Search mail"), "demurrage");
    expect(
      seen("/api/messages").length,
      "typing sent a request — the field is subscribed to the keyboard rather than submitted",
    ).toBe(before);

    await submit();
    await waitFor(() => expect(seen("/api/messages").length).toBe(before + 1));
  });

  it("treats a blank search as no search, rather than asking the Node for nothing", async () => {
    answer("/api/messages", () => page(1));
    mounted();
    await waitFor(() => expect(seen("/api/messages").length).toBe(1));
    await type(screen.getByLabelText("Search mail"), "   ");
    await submit();
    expect(seen("/api/messages").some((url) => url.includes("q=")), "a blank search reached the Node").toBe(false);
    // And the screen did not become a search of nothing: the tabs and the Inbox's own listing are still there.
    expect(screen.getByRole("tab", { name: "All" })).toBeDefined();
    expect(asked().get("place")).toBe("inbox");
  });

  it("puts the term in the query string exactly as typed", async () => {
    /*
     * Including the case and the spacing. `ftsQuery` on the Node decides what a search means; a client that
     * lower-cased or collapsed whitespace here would be making that decision twice, in two places, and the
     * SDK would make it a third way.
     */
    answer("/api/messages", () => page(1));
    mounted();
    await waitFor(() => expect(seen("/api/messages").length).toBe(1));

    await type(screen.getByLabelText("Search mail"), "Demurrage  Hapag");
    await submit();

    await waitFor(() => {
      const url = seen("/api/messages").at(-1)!;
      expect(new URL(url, "https://node.example").searchParams.get("q")).toBe("Demurrage  Hapag");
    });
  });

  it("runs a search the palette asked for once, and shows its words in the field", async () => {
    answer("/api/messages", (url) => (url.includes("q=") ? page(2) : page(3)));
    mounted("Demurrage");
    await waitFor(() => expect(listed().length).toBe(3));
    const before = seen("/api/messages").length;
    await click("Search mail for Demurrage");
    await waitFor(() => expect(asked().get("q")).toBe("Demurrage"));
    expect(seen("/api/messages").length).toBe(before + 1);
    expect((screen.getByLabelText("Search mail") as HTMLInputElement).value).toBe("Demurrage");
  });

  it("clears the palette's request once run, so coming back to the Inbox does not search again", async () => {
    answer("/api/messages", (url) => (url.includes("q=") ? page(2) : page(3)));
    const { remount } = mounted("Demurrage");
    await waitFor(() => expect(listed().length).toBe(3));
    await click("Search mail for Demurrage");
    await waitFor(() => expect(asked().get("q")).toBe("Demurrage"));
    remount("b");
    await waitFor(() => expect(listed().length).toBe(3));
    expect((screen.getByLabelText("Search mail") as HTMLInputElement).value).toBe("");
  });

  it("drops the per-person filters while searching, which the Node refuses beside q, and says the search spans places", async () => {
    answer("/api/messages", (url) => (url.includes("q=") ? page(2) : page(3)));
    mounted();
    await waitFor(() => expect(asked().get("place")).toBe("inbox"));
    // From the Unread tab: a search leaves it, rather than sending `unread` beside `q`.
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "Unread" })); });
    await waitFor(() => expect(asked().get("unread")).toBe("1"));

    await type(screen.getByLabelText("Search mail"), "demurrage");
    await submit();
    await waitFor(() => expect(asked().get("q")).toBe("demurrage"));
    expect(asked().get("place")).toBeNull();
    expect(asked().get("unread")).toBeNull();
    expect(asked().get("mine")).toBeNull();

    await waitFor(() => expect(screen.getByText(/Searched senders, subjects and text in all mail, including Archive and Trash · 2 matches/)).toBeTruthy());
    expect(heard()).toBe("2 matches.");
    // The row from elsewhere says where it is; the tabs, which mean nothing across places, are gone.
    expect(listed()[1]!.querySelector(".chip-place")?.textContent).toBe("Archive");
    expect(screen.queryByRole("tab", { name: "Unread" })).toBeNull();
  });

  it("tells a reader their search matched nothing, not that the mailbox is empty", async () => {
    /*
     * Three empties exist on this screen and they are three different claims: nothing has arrived, nothing is
     * older than here, and nothing matches these words. Saying the first for the third would send somebody to
     * check their DNS because they misspelled a supplier's name — the routing-check action is asserted absent
     * for exactly that reason.
     */
    answer("/api/messages", (url) => (url.includes("q=") ? page(0) : page(3)));
    mounted();
    await waitFor(() => expect(listed().length).toBe(3));
    // With rows, the empty reader says how to move through them ...
    expect(screen.getByText("J and K move through the list")).toBeTruthy();

    await type(screen.getByLabelText("Search mail"), "kumquat");
    await submit();

    await waitFor(() => expect(screen.getByText(/No mail matches those words\. Every word/)).toBeTruthy());
    // And a screen reader is told, in the list's own status region, which the notice alone is not.
    expect(heard()).toBe("No mail matches those words.");
    // ... and with none, it does not point at a list that has nothing in it.
    expect(screen.queryByText("J and K move through the list")).toBeNull();
    expect(
      screen.queryByText(/No messages are visible in your Inbox/),
      "a search with no matches claims the mailbox is empty",
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: /inbound routing/ }),
      "a failed search offers to diagnose inbound routing",
    ).toBeNull();
  });

  it("offers a way out of a search, and taking it restores the unsearched listing", async () => {
    /*
     * A search with no clear affordance is a mailbox that stays empty for ever. Asserted on what the reader
     * sees, and **not** on the request that follows — which is the interesting part.
     *
     * Clearing issues no request at all: `q` is part of the query key, so the unsearched page is already in
     * the cache from mount and react-query serves it. The first version of this test asserted that the last
     * `/api/messages` call carried no `q` and failed, because the last call was still the search. That was the
     * test being wrong rather than the product — a cache hit is the correct behaviour here, and asserting on
     * the network would have forced a refetch of a page the client already had.
     *
     * `AUTHORIZATION_SENSITIVE` is what keeps that cache honest: it applies per page, so a revocation takes
     * effect on the next fetch of any page rather than being papered over by this hit.
     */
    answer("/api/messages", (url) => (url.includes("q=kumquat") ? page(0) : url.includes("q=") ? page(2) : page(3)));
    mounted();
    await waitFor(() => expect(listed().length).toBe(3));

    await type(screen.getByLabelText("Search mail"), "kumquat");
    await submit();
    await waitFor(() => expect(screen.getByText(/No mail matches those words\. Every word/)).toBeTruthy());

    await click("Clear search");
    await waitFor(() => expect(listed().length).toBe(3));
    expect(screen.queryByText(/No mail matches those words\. Every word/)).toBeNull();
    // The region stays, emptied: the unsearched Inbox is not announced.
    expect(heard()).toBe("");

    // And from a search that found something, whose status line is the marker that a search is on.
    await type(screen.getByLabelText("Search mail"), "demurrage");
    await submit();
    await waitFor(() => expect(screen.getByText(/Searched senders/)).toBeTruthy());
    await click("Clear search");
    await waitFor(() => expect(listed().length).toBe(3));
    expect(screen.queryByText(/Searched senders/)).toBeNull();
  });

  it("says a full page of results is capped, and does not say it when the page is short", async () => {
    /*
     * The honest form of "no pagination for a search". A reader seeing exactly a page's worth must know that
     * narrowing the words is how to see different mail, because "50 shown" otherwise reads as "50 matches" —
     * a claim nothing counted. And the notice must **not** appear on a short page, or it would be telling
     * somebody there is more when there is not.
     */
    answer("/api/messages", (url) => (url.includes("q=") ? page(50) : page(3)));
    mounted();
    await waitFor(() => expect(listed().length).toBe(3));

    await type(screen.getByLabelText("Search mail"), "shipment");
    await submit();
    await waitFor(() => expect(screen.getByText(/Best 50 matches — narrow the words to see others/)).toBeTruthy());

    // A short page of results is complete, so it must not claim to be capped.
    await type(screen.getByLabelText("Search mail"), "kumquat");
    answer("/api/messages", (url) => (url.includes("q=") ? page(2) : page(3)));
    await submit();
    await waitFor(() => expect(listed().length).toBe(2));
    expect(screen.getByText(/· 2 matches/)).toBeTruthy();
    expect(screen.queryByText(/best .* matches/i), "a short page of results claims to be capped").toBeNull();
  });

  it("renders no pager on a searched page, because there is nowhere to page to", async () => {
    /*
     * Falls out of `next_cursor` always being null for a search plus the position resetting, rather than being
     * special-cased — but asserted, because "it falls out" is how a control comes back when somebody changes
     * one of the two things it falls out of.
     */
    answer("/api/messages", (url) => (url.includes("q=") ? page(50) : page(50, "cursor-1")));
    mounted();
    await waitFor(() => expect(screen.getByRole("button", { name: "Older" })).toBeTruthy());

    await type(screen.getByLabelText("Search mail"), "shipment");
    await submit();

    await waitFor(() => expect(screen.getByText(/Best 50 matches —/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Older" }), "a searched page offers an older page").toBeNull();
  });
});
