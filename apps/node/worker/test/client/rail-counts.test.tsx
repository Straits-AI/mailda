import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answer, answerMailboxes, answerWith, reset, seen } from "./session-stub.ts";

/**
 * The sidebar's counts say what they are (#91).
 *
 * ## The number was always a page size
 *
 * `messages.data.messages.length` is the length of **one page**. That was true before paging too — the
 * listing was capped at fifty from the day it shipped — so the rail printed a page size in the position a
 * reader reads as a total, and nothing said so. `next_cursor` already answers whether more exists, so `+`
 * costs nothing. A real total would need a second authorization-scoped `COUNT`, and it is not worth a query to
 * turn `50+` into `4,213`.
 *
 * The lookback (ADR 45) adds one more way a page is not a total: a page it cut short always carries a cursor,
 * so it reads `n+`, and an **empty** one prints no figure at all, because "0" and "0+" would both say
 * something about the Inbox that nobody has looked far enough to know.
 *
 * ## Why the rail had no test at all before this
 *
 * Nothing rendered it. A component nobody mounts is where the page-size-as-total went unnoticed, in the same
 * way #90, #94, #100 and #101 all sat in the one layer with no tests.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Rail } = await import("../../src/client/app/chrome.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");
const { messagesKey, nextSendsRead } = await import("../../src/client/app/api.ts");

function mount(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Rail /></ShellProvider></QueryClientProvider>);
  return client;
}

/** One row's figure, whatever it currently says. */
async function countOf(name: string): Promise<string> {
  await screen.findByText(name);
  /*
   * Scoped to the named row, not to the first `.num` in the rail: the first version selected
   * `.rail-list .num`, which picked up whichever other row happened to render a figure first and read `0`
   * off it. A selector that can match a different row is a test that can pass for the wrong reason.
   */
  const row = [...document.querySelectorAll(".rail-list > li")]
    .find((item) => item.querySelector(".rail-name")?.textContent === name);
  return row?.querySelector(".num")?.textContent?.trim() ?? "";
}

const CURSOR = "2026-08-20T09:00:00.000Z rcpt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ";

function page(count: number, more: boolean, extra: { lookback_exhausted?: boolean; parse_error?: string | null } = {}) {
  answerWith((call) => {
    if (!call.path.startsWith("/api/messages")) return undefined;
    return Response.json({
      messages: Array.from({ length: count }, (_unused, n) => ({ id: `rcpt_${n}`, parse_error: extra.parse_error ?? null })),
      next_cursor: more ? CURSOR : null,
      lookback_exhausted: extra.lookback_exhausted ?? false,
    });
  });
}

beforeEach(() => {
  reset();
  answerMailboxes([]);
  route.pathname = "/";
});

describe("the Inbox count does not present a page as a total", () => {
  it("marks it with + when older mail exists", async () => {
    page(50, true);
    mount();
    await waitFor(async () => { expect(await countOf("Inbox")).toBe("50+"); });
  });

  it("prints the plain figure when nothing older is visible", async () => {
    /*
     * The other side, and it is what stops the `+` becoming decoration: when `next_cursor` is null the
     * number *is* everything this reader may see, and appending `+` would then be its own small lie.
     */
    page(3, false);
    mount();
    await waitFor(async () => { expect(await countOf("Inbox")).toBe("3"); });
  });

  it("renders no figure at all while the answer is unknown", async () => {
    // A zero rendered during loading is a claim about an empty inbox: §5C's "empty" against "not yet answered".
    answerWith((call) => (call.path.startsWith("/api/messages") ? new Promise(() => {}) : undefined));
    mount();
    await screen.findByText("Inbox");
    expect(await countOf("Inbox")).toBe("");
  });

  it("prints no figure for an empty page the lookback cut short, and n+ for one with rows", async () => {
    page(0, true, { lookback_exhausted: true });
    const client = mount();
    // The positive first: the listing was answered, so the blank below is the lookback rule and not a query
    // still pending (which is also blank, and would pass this for the wrong reason).
    await waitFor(() => { expect(client.getQueryState(messagesKey({ place: "inbox" }))?.status).toBe("success"); });
    expect(await countOf("Inbox")).toBe("");
  });

  it("reads three rows the lookback returned as 3+, never 3", async () => {
    page(3, true, { lookback_exhausted: true });
    mount();
    await waitFor(async () => { expect(await countOf("Inbox")).toBe("3+"); });
  });
});

describe("the Inbox count is the Inbox's own request (R11)", () => {
  it("asks for place=inbox under exactly the key the Inbox's default view uses", async () => {
    /*
     * One key, so on `/` the count and the list are one request, and for a supervised reader one audit
     * entry rather than two. INBOX asserts its default key is this same `messagesKey({ place: "inbox" })`;
     * this is the sidebar's half.
     */
    page(2, false);
    const client = mount();
    await waitFor(async () => { expect(await countOf("Inbox")).toBe("2"); });
    expect(seen("/api/messages")).toEqual(["/api/messages?place=inbox"]);
    const listings = client.getQueryCache().findAll({ queryKey: ["messages"] });
    expect(listings.map((query) => query.queryKey)).toEqual([messagesKey({ place: "inbox" })]);
  });
});

describe("the other counts", () => {
  it("counts held and awaiting sends on Outbox, not handed-over ones", async () => {
    // Two handed over against one of each waiting state, so counting the wrong state cannot land on 2 by luck.
    answer("/api/sends", () => ({
      sends: [{ state: "handed_over" }, { state: "handed_over" }, { state: "held" }, { state: "awaiting" }],
      truncated: false, daily: { handedOver: 2 },
    }));
    mount();
    await waitFor(async () => { expect(await countOf("Outbox")).toBe("2"); });
  });

  it("marks the Outbox figure with + when the sends it counted are a truncated page", async () => {
    answer("/api/sends", () => ({
      sends: [{ state: "handed_over" }, { state: "held" }, { state: "awaiting" }], truncated: true, daily: { handedOver: 1 },
    }));
    mount();
    await waitFor(async () => { expect(await countOf("Outbox")).toBe("2+"); });
  });

  it("marks the Drafts figure with + when the list was truncated", async () => {
    answer("/api/drafts", () => ({
      drafts: [{ id: "d1", mailboxId: "mbx_test", inReplyToMessageId: null, to: [], subject: "", updatedAt: "", caseId: null }],
      truncated: true,
    }));
    mount();
    await waitFor(async () => { expect(await countOf("Drafts")).toBe("1+"); });
  });

  it("notes unparsed messages under the Inbox rather than dropping them (R1)", async () => {
    page(2, false, { parse_error: "headers unreadable" });
    mount();
    expect((await screen.findByText("2 unparsed")).closest("li")?.className).toBe("rail-note");
  });

  it("adds no unparsed note when every message parsed", async () => {
    page(2, false);
    mount();
    await waitFor(async () => { expect(await countOf("Inbox")).toBe("2"); });
    expect(document.querySelector(".rail-note")).toBeNull();
  });

  it("sums unclaimed work across mailboxes on Queue, and prints no figure with no mailbox", async () => {
    answerMailboxes([
      { id: "mbx_a", name: "Support", addresses: "support@example.test", unclaimed: 2 },
      { id: "mbx_b", name: "Billing", addresses: "billing@example.test", unclaimed: 3 },
    ]);
    mount();
    await waitFor(async () => { expect(await countOf("Queue")).toBe("5"); });
  });

  it("prints no Queue figure when this person works no mailbox", async () => {
    const client = mount();
    await waitFor(() => { expect(client.getQueryState(["mailboxes"])?.status).toBe("success"); });
    expect(await countOf("Queue")).toBe("");
  });

  it("counts approvals waiting on this person, and prints nothing when none are", async () => {
    answer("/api/approvals", () => ({ approvals: [{ id: "apr_1" }, { id: "apr_2" }] }));
    mount();
    await waitFor(async () => { expect(await countOf("Approvals")).toBe("2"); });
  });

  it("prints no Approvals figure when nothing waits", async () => {
    const client = mount();
    await waitFor(() => { expect(client.getQueryState(["approvals"])?.status).toBe("success"); });
    expect(await countOf("Approvals")).toBe("");
  });

  it("names the cases you hold on a mailbox row as mine, one word for one idea", async () => {
    answerMailboxes([
      { id: "mbx_a", name: "Support", addresses: "support@example.test", unclaimed: 4, claimed: 2, mine: 1 },
    ]);
    mount();
    const link = (await screen.findByText("Support")).closest("a")!;
    // Hair spaces about the dot (chrome.tsx says why); the words are the same.
    expect(link.querySelector(".rail-mine")?.textContent?.replace(/\u200A/g, " ")).toBe(" · 1 mine");
    expect(link.getAttribute("title")).toBe("4 unclaimed, 2 in progress, 1 mine");
  });

  it("says nothing about mine on a mailbox where this person holds no case", async () => {
    answerMailboxes([{ id: "mbx_a", name: "Support", addresses: "support@example.test", unclaimed: 4, mine: 0 }]);
    mount();
    const link = (await screen.findByText("Support")).closest("a")!;
    expect(link.querySelector(".num")?.textContent).toBe("4");
    expect(link.querySelector(".rail-mine")).toBeNull();
  });
});

describe("the Outbox figure follows a held send out of its hold, with no reload", () => {
  /*
   * `held` is the one state a send leaves on its own clock. Before this, nothing read the sends again while
   * somebody watched, so the badge (and the Outbox row, and the health popover) said "held" until a reload.
   * The read is timed to the hold's end rather than polled through it: a hold window can be an hour.
   */
  const NOW = Date.parse("2026-09-26T10:00:00.000Z");
  afterEach(() => { vi.useRealTimers(); });

  function sendsNow(row: () => { state: string; release_at: string }) {
    answer("/api/sends", () => ({ sends: [row()], truncated: false, daily: { handedOver: 0 } }));
  }

  it("reads the sends again once the earliest hold has ended, not before, and the figure drops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    let state = "held";
    sendsNow(() => ({ state, release_at: new Date(NOW + 30_000).toISOString() }));
    mount();
    await waitFor(async () => { expect(await countOf("Outbox")).toBe("1"); });
    const reads = seen("/api/sends").length;

    state = "handed_over";
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(seen("/api/sends").length, "it polled through the hold window").toBe(reads);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(seen("/api/sends").length).toBe(reads + 1);
    await waitFor(async () => { expect(await countOf("Outbox"), "the badge still said held").toBe(""); });
  });

  it("never asks a timer for longer than one holds (it would wrap to a busy loop), nor gives up on an unparseable time", () => {
    const held = (release: number) => ({ sends: [{ state: "held", release_at: new Date(release).toISOString() }] });
    const inAMonth = NOW + 31 * 24 * 3_600_000;
    expect(nextSendsRead(held(inAMonth) as never, NOW)).toBe(2_147_483_647);
    expect(nextSendsRead(held(NOW + 60_000) as never, NOW)).toBe(65_000);
    // A release time that does not parse is still a held send: asked about on the recheck cadence, not never.
    expect(nextSendsRead({ sends: [{ state: "held", release_at: "not a time" }] } as never, NOW)).toBe(5_000);
  });

  it("schedules nothing for a send that waits on a person", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    sendsNow(() => ({ state: "awaiting", release_at: new Date(NOW).toISOString() }));
    mount();
    await waitFor(async () => { expect(await countOf("Outbox")).toBe("1"); });
    const reads = seen("/api/sends").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(seen("/api/sends").length, "an approval nobody has decided was polled").toBe(reads);
  });
});
