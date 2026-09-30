import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { t } from "/app/locale.js";
import { answerWith, reset } from "./session-stub.ts";
import type { MessageRow } from "../../src/client/app/api.ts";

/**
 * The list pane's English, as it was before the screen moved its words into the catalog (ADR 46).
 *
 * The migration promised byte-identical English, and the suites around it query most of the sentences already
 * (`inbox-pages.test.tsx`, `places.test.tsx`, `search-field.test.tsx`). These are the ones nothing queried
 * before: each literal below was copied from `inbox.tsx` as it stood on 30 September 2026, before the change,
 * and rendered green against it. A catalog value that drifts from the English it replaced goes red here.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

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

/** Answers `/api/messages` by what the request asked for. */
function answerListing(pick: (params: URLSearchParams) => { messages: MessageRow[]; next_cursor: string | null; lookback_exhausted?: boolean; max_lookback?: number | null }) {
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname !== "/api/messages") return undefined;
    return Response.json({ lookback_exhausted: false, max_lookback: null, ...pick(url.searchParams) });
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
}

async function settle() {
  await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
}

const notice = () => document.querySelector(".list-empty .notice")?.textContent ?? null;
const heard = () => document.querySelector(".list-pane > [role=status]")?.textContent ?? null;

beforeEach(() => {
  reset();
});

describe("the list pane's English is what it was before the catalog", () => {
  it("names the tabs, the list, the pager and the empty reader", async () => {
    answerListing(() => ({ messages: [row(1, { read: 0 }), row(2)], next_cursor: "2026-08-20T09:00:00.000Z rcpt_2" }));
    mount();
    await settle();
    expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Inbox views");
    expect(screen.getAllByRole("tab").map((tab) => [tab.textContent, tab.getAttribute("title")])).toEqual([
      ["All", null], ["Unread", null], ["Mine", "Cases you hold"],
    ]);
    expect(screen.getByRole("list").getAttribute("aria-label")).toBe("Messages");
    expect(screen.getByRole("navigation").getAttribute("aria-label")).toBe("Pages");
    expect(document.querySelector(".message-row.unread .visually-hidden")?.textContent).toBe("Unread, ");
    expect(document.querySelector(".list-count")?.textContent).toBe("2+ messages");
    expect(screen.getByRole("button", { name: "Filter" })).toBeDefined();
    expect(document.querySelector(".reader-empty p")?.textContent).toBe("No message selected");
  });

  it("says what an empty Unread and an empty Mine hold", async () => {
    answerListing((params) => (params.has("unread") || params.has("mine") ? { messages: [], next_cursor: null } : { messages: [row(1)], next_cursor: null }));
    mount();
    await settle();
    expect(document.querySelector(".list-count")?.textContent).toBe("1 message");
    await act(async () => { screen.getByRole("tab", { name: "Unread" }).click(); });
    await waitFor(() => { expect(notice()).toBe("Nothing unread in your Inbox."); });
    await act(async () => { screen.getByRole("tab", { name: "Mine" }).click(); });
    await waitFor(() => { expect(notice()).toBe("You hold no cases in your Inbox."); });
  });

  it("says nothing matches the filters, the chip's words, and the count a screen reader hears", async () => {
    answerListing((params) => (params.has("from") ? { messages: [], next_cursor: null } : { messages: [row(1)], next_cursor: null }));
    mount();
    await settle();
    await act(async () => { screen.getByRole("button", { name: "Filter" }).click(); });
    fireEvent.change(document.getElementById("inbox-from")!, { target: { value: "a@b.example" } });
    await act(async () => { screen.getByRole("button", { name: "Apply" }).click(); });
    await waitFor(() => { expect(notice()).toBe("Nothing matches these filters."); });
    expect(heard()).toBe("Nothing matches these filters.");
    expect(screen.getByRole("button", { name: "Filter, 1 active" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Remove filter: From: a@b.example" })).toBeDefined();
  });

  it("says the whole empty-Inbox sentence and names the routing check", async () => {
    answerListing(() => ({ messages: [], next_cursor: null }));
    mount();
    await settle();
    expect(notice()).toBe(
      "No messages are visible in your Inbox. Whether mail can reach this Node is a separate question — Doctor's inbound routing check answers it. Check inbound routing",
    );
  });

  it("says a lookback without a figure when the Node sent none", async () => {
    answerListing(() => ({ messages: [], next_cursor: "2026-08-01T09:00:00.000Z rcpt_edge", lookback_exhausted: true, max_lookback: null }));
    mount();
    await settle();
    expect(notice()).toBe("None of the newest messages you can see is in your Inbox.");
  });
});

describe("each whole sentence says what the glued one said", () => {
  /*
   * The oracle is the generator `inbox.tsx` used before the catalog, pasted here unchanged: the lookback's
   * sentence was glued from four parts, and its catalog replacement is one whole sentence per case (24).
   * Every case is compared, including the ones no rendered test reaches.
   */
  const tabs = ["all", "unread", "mine"] as const;
  function glued(page: number, maxLookback: number | null, narrowed: boolean, tab: (typeof tabs)[number]): string {
    const scope = page === 1 ? "newest" : "next";
    const looked = maxLookback === null ? "" : ` ${maxLookback.toLocaleString()}`;
    const older = page === 1 ? "" : " older";
    const tail = tab === "unread" ? "is unread" : tab === "mine" ? "is in a case you hold" : "is in your Inbox";
    return `None of the ${scope}${looked}${older} messages you can see${narrowed ? " that match these filters" : ""} ${tail}.`;
  }

  it("the lookback, in every case", () => {
    let compared = 0;
    for (const from of ["newest", "older"] as const) {
      for (const among of ["any", "filtered"] as const) {
        for (const tab of tabs) {
          const page = from === "newest" ? 1 : 2;
          expect(t(`inbox.lookback.${from}.uncounted.${among}.${tab}`)).toBe(glued(page, null, among === "filtered", tab));
          expect(t(`inbox.lookback.${from}.counted.${among}.${tab}`, { n: 12_345 })).toBe(glued(page, 12_345, among === "filtered", tab));
          compared += 2;
        }
      }
    }
    expect(compared).toBe(24);
  });

  it("the search's counts, the heard counts and the filter count", () => {
    for (const found of [1, 2, 49]) {
      expect(t("inbox.search.found", { n: found }))
        .toBe(`Searched senders, subjects and text in all mail, including Archive and Trash · ${found} match${found === 1 ? "" : "es"}`);
      expect(t("inbox.heard.found", { n: found })).toBe(`${found} match${found === 1 ? "" : "es"}.`);
    }
    expect(t("inbox.search.capped", { n: 50 })).toBe("Best 50 matches — narrow the words to see others");
    expect(t("inbox.heard.capped", { n: 50 })).toBe("Best 50 matches.");
    expect(t("inbox.heard.exact", { n: 1 })).toBe("1 message matches these filters.");
    expect(t("inbox.heard.exact", { n: 7 })).toBe("7 messages match these filters.");
    expect(t("inbox.count.noun", { n: 1 })).toBe("message");
    expect(t("inbox.count.nounMore")).toBe("messages");
  });

  it("the moves and the acts no rendered test reaches", () => {
    expect([t("inbox.moved.inbox"), t("inbox.moved.archive"), t("inbox.moved.trash")]).toEqual(["Moved to Inbox.", "Archived.", "Moved to Trash."]);
    expect([t("inbox.movedBack.inbox"), t("inbox.movedBack.archive"), t("inbox.movedBack.trash")])
      .toEqual(["Moved back to Inbox.", "Moved back to Archive.", "Moved back to Trash."]);
    expect([t("inbox.act.next"), t("inbox.act.previous"), t("inbox.act.trash")]).toEqual(["Next message", "Previous message", "Move to Trash"]);
  });
});
