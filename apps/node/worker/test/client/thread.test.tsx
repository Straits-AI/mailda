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
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

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
    attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
    place: "inbox", from_name: n === 2 ? "Ben Ortiz" : null, preview: null, standing_content: 1, case_mine: 0, case_state: null,
  };
}

const BODY = { state: "text-only", html: null, text: "hello", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [], recipients: { to: [], cc: [], replyTo: null } };

beforeEach(() => {
  reset();
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") {
      const conversation = url.searchParams.get("conversation");
      if (conversation === "cnv_4") return Response.json({ messages: [row(4, "cnv_4")], next_cursor: null });
      return conversation === "cnv_1"
        ? Response.json({ messages: [row(1, "cnv_1"), row(2, "cnv_1")], next_cursor: null })
        : Response.json({ messages: [row(1, "cnv_1"), row(3, null), row(4, "cnv_4")], next_cursor: null });
    }
    if (url.pathname === "/api/sends") {
      return Response.json({
        sends: url.searchParams.get("conversation") === "cnv_1"
          ? [{ id: "snd_1", subject: "Re: message 1", envelope_to: '["a@b.test","c@d.test"]', state: "sent", state_at: "2026-08-23T09:00:00.000Z",
               release_at: "", attempts: 1, last_error: null, transport_message_id: null, fidelity: "authored", has_submitted: 1, is_copy: 0,
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
    render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
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

  it("opens a message of the thread in place, and a send as a pointer to its bytes", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    await press(/message 1/);
    const thread = await screen.findByRole("region", { name: "Conversation" });
    const [earlier, send] = Array.from(thread.querySelectorAll<HTMLButtonElement>("button.thread-row"));
    // The name is whatever the sender typed, so the address rides with it, as the list's title does (ADR 45).
    const sender = earlier!.querySelector(".row-sender")!;
    expect([sender.textContent, sender.getAttribute("title")]).toEqual(["Ben Ortiz", "sender2@outside.example"]);
    expect(earlier!.getAttribute("aria-expanded")).toBe("false");
    // Folded means not fetched: each body is a recorded open for a supervised reader, so only a click opens it.
    expect(calls.some((call) => call.path === "/api/messages/rcpt_2/body"), "a folded thread row fetched its body").toBe(false);
    await act(async () => { earlier!.click(); });
    expect(earlier!.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => { expect(calls.some((call) => call.path === "/api/messages/rcpt_2/body")).toBe(true); });
    await act(async () => { earlier!.click(); });
    expect(earlier!.getAttribute("aria-expanded")).toBe("false");

    // The recipients as a sentence lists them, never the stored JSON array (`["a@b.test",...]`).
    expect(send!.querySelector(".row-sender")!.textContent).toBe("→ a@b.test and c@d.test");
    await act(async () => { send!.click(); });
    const link = await waitFor(() => {
      const found = thread.querySelector<HTMLAnchorElement>("a[href='/api/sends/snd_1/submitted']");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(link.textContent).toBe(".eml");
  });

  it("asks for no thread when the message has no conversation", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    await press(/message 3/);
    await waitFor(() => { expect(screen.queryByText("hello")).not.toBeNull(); });
    expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();
    expect(calls.some((call) => call.path.includes("conversation="))).toBe(false);
  });

  it("shows no conversation when the message is the whole of it", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    await press(/message 4/);
    await waitFor(() => { expect(calls.some((call) => call.path.includes("conversation=cnv_4"))).toBe(true); });
    await waitFor(() => { expect(screen.queryByText("hello")).not.toBeNull(); });
    // The thread's answer has landed (the sends half is the slower of the two in the stub); still no region.
    await waitFor(() => { expect(calls.some((call) => call.path.startsWith("/api/sends?conversation=cnv_4"))).toBe(true); });
    expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();
  });
});
