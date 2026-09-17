import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");

/**
 * Reply quotes the message's own text from the body the pane fetched; reply-all addresses the sender and
 * copies everybody else the sender addressed, minus this mailbox's own addresses; opening a message marks
 * it read, once.
 */
const ROW = {
  id: "rcpt_1", message_id: "msg_1", subject: "Invoice", from_addr: "alice@outside.example",
  // The return path differs from the From header, as it does on relayed mail; a reply goes to the person.
  envelope_from: "bounces@relay.example", envelope_to: "support@example.test", mailbox_id: "mbx_test",
  raw_bytes: 1024, accepted_at: "2026-08-21T09:00:00.000Z", parse_error: null, conversation_id: null,
  case_id: "cas_1", auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null,
  auth_from_domain: null, attachments: null, attachments_dangerous: null, labels_json: "[]", read: 0,
};
const BODY = {
  state: "text-only", html: null, text: "Where is my invoice?\nThanks", blockedRemote: 0, truncated: false,
  problem: null, attachments: [], links: [],
  recipients: { to: ["support@example.test", "bob@outside.example"], cc: ["carol@outside.example"], replyTo: null },
};

beforeEach(() => {
  reset();
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") return Response.json({ messages: [ROW], next_cursor: null });
    if (url.pathname === "/api/mailboxes") {
      return Response.json({ mailboxes: [{ id: "mbx_test", name: "Support", unclaimed: 0, claimed: 0, mine: 0, first_response_minutes: null, quarantine_dmarc_fail: 0, quarantine_dangerous_attachments: 0, quarantined: 0, breached: 0, addresses: "support@example.test" }] });
    }
    if (url.pathname.endsWith("/body")) return Response.json(BODY);
    if (url.pathname.endsWith("/read")) return Response.json({ messageId: "msg_1", read: true });
    if (url.pathname.startsWith("/api/cases/")) return Response.json({ ok: true, state: "claimed" });
    if (url.pathname === "/api/drafts") return Response.json({ draft: null });
    return undefined;
  });
});

async function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
  await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
  await act(async () => { screen.getByRole("button", { name: /Invoice/ }).click(); });
  await waitFor(() => { expect(screen.queryByText(/Where is my invoice/)).not.toBeNull(); });
}

describe("replying from the reading pane", () => {
  it("marks the message read once, on open", async () => {
    await open();
    await waitFor(() => { expect(calls.filter((call) => call.path === "/api/messages/msg_1/read")).toHaveLength(1); });
    expect(calls.find((call) => call.path === "/api/messages/msg_1/read")?.body).toEqual({ read: true });
  });

  it("reply quotes the body and addresses the sender; reply all copies the others and not ourselves", async () => {
    await open();
    await act(async () => { screen.getByRole("button", { name: "reply all" }).click(); });
    const dock = await screen.findByRole("region", { name: "Reply" });
    expect((dock.querySelector("#composer-to") as HTMLInputElement).value).toBe("alice@outside.example");
    expect((dock.querySelector("#composer-cc") as HTMLInputElement).value).toBe("bob@outside.example, carol@outside.example");
    const body = (dock.querySelector("#composer-body") as HTMLTextAreaElement).value;
    expect(body).toContain("> Where is my invoice?");
    expect(body).toContain("> Thanks");
  });
});
