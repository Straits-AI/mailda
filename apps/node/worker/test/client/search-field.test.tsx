import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { answer, seen, reset } from "./session-stub.ts";

import { Inbox } from "../../src/client/app/screens/inbox.tsx";

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

async function click(name: RegExp | string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

function mounted() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><Inbox /></QueryClientProvider>,
  );
}

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
    })),
    next_cursor: cursor,
  };
}

beforeEach(() => {
  reset();
  answer("/api/mailboxes", () => ({ mailboxes: [{ id: "mbx_1", name: "Enquiries" }] }));
});

describe("searching from the inbox", () => {
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

  it("tells a reader their search matched nothing, not that the mailbox is empty", async () => {
    /*
     * Three empties exist on this screen and they are three different claims: nothing has arrived, nothing is
     * older than here, and nothing matches these words. Saying the first for the third would send somebody to
     * check their DNS because they misspelled a supplier's name — the routing-check action is asserted absent
     * for exactly that reason.
     */
    answer("/api/messages", (url) => (url.includes("q=") ? page(0) : page(3)));
    mounted();
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(3));

    await type(screen.getByLabelText("Search mail"), "kumquat");
    await submit();

    await waitFor(() => expect(screen.getByText(/No mail matches those words/)).toBeTruthy());
    expect(
      screen.queryByText(/No messages are visible to you yet/),
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
    answer("/api/messages", (url) => (url.includes("q=") ? page(0) : page(3)));
    mounted();
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(3));

    await type(screen.getByLabelText("Search mail"), "kumquat");
    await submit();
    await waitFor(() => expect(screen.getByText(/No mail matches those words/)).toBeTruthy());

    await click(/clear the search/);
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(3));
    // The searched-empty screen is gone, and so is the marker that said a filter was on.
    expect(screen.queryByText(/No mail matches those words/)).toBeNull();
    expect(screen.queryByText(/· searched/)).toBeNull();
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
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(3));

    await type(screen.getByLabelText("Search mail"), "shipment");
    await submit();
    await waitFor(() => expect(screen.getByText(/best matches/)).toBeTruthy());

    // A short page of results is complete, so it must not claim to be capped.
    await type(screen.getByLabelText("Search mail"), "kumquat");
    answer("/api/messages", (url) => (url.includes("q=") ? page(2) : page(3)));
    await submit();
    await waitFor(() => expect(screen.getAllByRole("listitem").length).toBe(2));
    expect(screen.queryByText(/best matches/), "a short page of results claims to be capped").toBeNull();
  });

  it("renders no pager on a searched page, because there is nowhere to page to", async () => {
    /*
     * Falls out of `next_cursor` always being null for a search plus the position resetting, rather than being
     * special-cased — but asserted, because "it falls out" is how a control comes back when somebody changes
     * one of the two things it falls out of.
     */
    answer("/api/messages", (url) => (url.includes("q=") ? page(50) : page(50, "cursor-1")));
    mounted();
    await waitFor(() => expect(screen.getByRole("button", { name: "older" })).toBeTruthy());

    await type(screen.getByLabelText("Search mail"), "shipment");
    await submit();

    await waitFor(() => expect(screen.getByText(/best matches/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: "older" }), "a searched page offers an older page").toBeNull();
  });
});
