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
 * The reading pane shows the rest of the conversation under the message being read, and asks the Node for
 * exactly the two listings it is built from — `?conversation=` on the inbox and on the outbox.
 */
function row(n: number, conversation: string | null) {
  return {
    id: `rcpt_${n}`, message_id: `msg_${n}`, subject: `message ${n}`,
    from_addr: `sender${n}@outside.example`, envelope_from: `sender${n}@outside.example`,
    envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
    accepted_at: `2026-08-2${n}T09:00:00.000Z`, parse_error: null, conversation_id: conversation, case_id: null,
    auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
    attachments: null, attachments_dangerous: null,
  };
}

const BODY = { state: "text-only", html: null, text: "hello", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [] };

beforeEach(() => {
  reset();
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") {
      return url.searchParams.get("conversation") === "cnv_1"
        ? Response.json({ messages: [row(1, "cnv_1"), row(2, "cnv_1")], next_cursor: null })
        : Response.json({ messages: [row(1, "cnv_1"), row(3, null)], next_cursor: null });
    }
    if (url.pathname === "/api/sends") {
      return Response.json({
        sends: url.searchParams.get("conversation") === "cnv_1"
          ? [{ id: "snd_1", subject: "Re: message 1", envelope_to: '["a@b.test"]', state: "sent", state_at: "2026-08-23T09:00:00.000Z",
               release_at: "", attempts: 1, last_error: null, transport_message_id: null, fidelity: "authored", has_submitted: 1,
               state_reason: null, policy_outcome: null, recipients: [] }]
          : [],
        daily: {}, capability: {},
      });
    }
    if (url.pathname.endsWith("/body")) return Response.json(BODY);
    return undefined;
  });
});

async function press(name: RegExp) {
  await act(async () => { screen.getByRole("button", { name }).click(); });
}

describe("the reading pane carries the rest of the conversation", () => {
  it("lists the other messages and the sends of the conversation, from the two filtered listings", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    await press(/message 1/);

    const thread = await screen.findByRole("region", { name: "Conversation" });
    expect(thread.textContent).toContain("2 other messages in this conversation");
    expect(thread.textContent).toContain("message 2");
    expect(thread.textContent).toContain("Re: message 1");
    // The message being read is the pane, not a row of its own thread.
    expect(thread.textContent).not.toContain("sender1@outside.example");
    const asked = calls.map((call) => call.path);
    expect(asked.some((path) => path.startsWith("/api/messages?conversation=cnv_1"))).toBe(true);
    expect(asked.some((path) => path.startsWith("/api/sends?conversation=cnv_1"))).toBe(true);
  });

  it("asks for no thread when the message has no conversation", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    await press(/message 3/);
    await waitFor(() => { expect(screen.queryByText("hello")).not.toBeNull(); });
    expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();
    expect(calls.some((call) => call.path.includes("conversation="))).toBe(false);
  });
});
