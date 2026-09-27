import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerMessages, reset, seen } from "./session-stub.ts";

/**
 * The sidebar's Inbox count and the default Inbox view are one listing request, not two (R11).
 *
 * ## Why this is a governance test and not a cache nicety
 *
 * A listing a supervised reader fetches writes one `supervised.query` (`docs/supervised-access.md`). If the
 * sidebar asked for its count under any key but the Inbox's own, opening `/` would record two queries for one
 * look, and every refetch would do it again. SHELL's `rail-counts.test.tsx` holds the Rail's half (its key is
 * `messagesKey({ place: "inbox" })`) and INBOX's `inbox-pages.test.tsx` the Inbox's half; this mounts both in
 * one `QueryClient`, the way the shell does, and counts the requests that actually leave.
 *
 * The second test is the control: a view the sidebar does not share (the Unread tab) is its own request, so a
 * counter that could only ever say "one" would fail there.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Rail } = await import("../../src/client/app/chrome.tsx");
const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ShellProvider>
        <Rail />
        <Inbox />
      </ShellProvider>
    </QueryClientProvider>,
  );
}

const ROW = {
  id: "rcpt_1", message_id: "msg_1", subject: "Invoice INV-2041",
  from_addr: "billing@outside.example", envelope_from: "billing@outside.example",
  envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
  accepted_at: "2026-09-26T09:00:00.000Z", parse_error: null, conversation_id: null, case_id: null,
  auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
  attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
  place: "inbox", from_name: null, preview: null, standing_content: 1, case_mine: 0, case_state: null,
};

/** The Inbox row of the sidebar has printed its figure, and the list has printed its row: both have their answer. */
async function bothAnswered(): Promise<void> {
  await screen.findByText("Invoice INV-2041");
  await waitFor(() => {
    const inboxRow = [...document.querySelectorAll(".rail-list > li")]
      .find((item) => item.querySelector(".rail-name")?.textContent === "Inbox");
    expect(inboxRow?.querySelector(".num")?.textContent?.trim()).toBe("1");
  });
}

beforeEach(() => {
  reset();
  route.pathname = "/";
  answerMessages([ROW]);
});

describe("the sidebar's Inbox count shares the default Inbox view's request", () => {
  it("makes exactly one listing request on / with no tab, filter or search", async () => {
    mount();
    await bothAnswered();
    expect(seen("/api/messages")).toEqual(["/api/messages?place=inbox"]);
  });

  it("makes a request of its own for a view the sidebar does not share", async () => {
    mount();
    await bothAnswered();
    fireEvent.click(screen.getByRole("tab", { name: "Unread" }));
    await waitFor(() => { expect(seen("/api/messages")).toHaveLength(2); });
    expect(seen("/api/messages")[1]).toContain("unread=1");
  });
});
