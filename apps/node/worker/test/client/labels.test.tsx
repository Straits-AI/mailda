import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");

/** A label is a word on the row and in the pane; adding one is a PUT; clicking one narrows the listing. */
function row(n: number, labels: string[]) {
  return {
    id: `rcpt_${n}`, message_id: `msg_${n}`, subject: `message ${n}`,
    from_addr: `sender${n}@outside.example`, envelope_from: `sender${n}@outside.example`,
    envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
    accepted_at: `2026-08-2${n}T09:00:00.000Z`, parse_error: null, conversation_id: null, case_id: null,
    auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
    attachments: null, attachments_dangerous: null, labels_json: JSON.stringify(labels),
  };
}

beforeEach(() => {
  reset();
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") {
      const label = url.searchParams.get("label");
      const rows = [row(1, ["invoice"]), row(2, [])].filter((one) => label === null || (JSON.parse(one.labels_json) as string[]).includes(label));
      return Response.json({ messages: rows, next_cursor: null });
    }
    if (url.pathname === "/api/messages/msg_1/labels") return Response.json({ messageId: "msg_1", labels: ["invoice", "urgent"] });
    if (url.pathname.endsWith("/body")) {
      return Response.json({ state: "text-only", html: null, text: "hello", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [] });
    }
    return undefined;
  });
});

describe("labels in the inbox", () => {
  it("shows the word on the row, adds one with Enter, and narrows the listing on a click", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    expect(screen.getAllByText("invoice").length).toBeGreaterThan(0);

    await act(async () => { screen.getByRole("button", { name: /message 1/ }).click(); });
    const field = await screen.findByLabelText("Add a label");
    fireEvent.change(field, { target: { value: "Urgent" } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); });
    const put = calls.find((call) => call.path === "/api/messages/msg_1/labels");
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ add: ["Urgent"] });
    await screen.findByRole("button", { name: "urgent" });

    await act(async () => { screen.getByRole("button", { name: "urgent" }).click(); });
    await waitFor(() => {
      expect(calls.some((call) => call.path.startsWith("/api/messages?") && call.path.includes("label=urgent"))).toBe(true);
    });
    expect(screen.getByText(/Showing mail labelled/)).toBeDefined();
  });
});
