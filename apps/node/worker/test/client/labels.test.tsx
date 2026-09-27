import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
 * A label is a word on the row and in the pane, visible without expanding anything; adding one is a PUT,
 * offered only to a reader the labels route would let make it; clicking one narrows the listing.
 */
let standing: 0 | 1 = 1;
let labelled: () => Response;

function row(n: number, labels: string[]) {
  return {
    id: `rcpt_${n}`, message_id: `msg_${n}`, subject: `message ${n}`,
    from_addr: `sender${n}@outside.example`, envelope_from: `sender${n}@outside.example`,
    envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
    accepted_at: `2026-08-2${n}T09:00:00.000Z`, parse_error: null, conversation_id: null, case_id: null,
    auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
    attachments: null, attachments_dangerous: null, labels_json: JSON.stringify(labels), read: 1,
    place: "inbox", from_name: null, preview: null, standing_content: standing, case_mine: 0, case_state: null,
  };
}

beforeEach(() => {
  reset();
  standing = 1;
  labelled = () => Response.json({ messageId: "msg_1", labels: ["invoice", "urgent"] });
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") {
      const label = url.searchParams.get("label");
      const rows = [row(1, ["invoice"]), row(2, [])].filter((one) => label === null || (JSON.parse(one.labels_json) as string[]).includes(label));
      return Response.json({ messages: rows, next_cursor: null, lookback_exhausted: false });
    }
    if (url.pathname === "/api/messages/msg_1/labels") return labelled();
    if (url.pathname.endsWith("/body")) {
      return Response.json({ state: "text-only", html: null, text: "hello", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [], recipients: { to: [], cc: [], replyTo: null } });
    }
    return undefined;
  });
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
}

const more = () => within(screen.getByRole("article", { name: "Message" })).getByRole("button", { name: "More actions" });

/** "Add label…" is in the ••• menu, not a row of its own under the actions. */
async function addLabel() {
  await act(async () => { more().click(); });
  await act(async () => { screen.getByRole("menuitem", { name: "Add label…" }).click(); });
  return screen.findByLabelText("Add a label");
}

describe("labels in the inbox", () => {
  it("shows the word on the row, adds one with Enter, and narrows the listing on a click", async () => {
    mount();
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    expect(screen.getAllByText("invoice").length).toBeGreaterThan(0);

    await act(async () => { screen.getByRole("button", { name: /message 1/ }).click(); });
    // The pane's word is a chip in the Message region, not folded into the details.
    const pane = await screen.findByRole("article", { name: "Message" });
    expect(pane.querySelector(".reader-labels .chip-label")?.textContent).toContain("invoice");
    expect(pane.querySelector("details .chip-label")).toBeNull();
    // Beside the "to …" line, not a control row of its own between the actions and the body.
    expect(pane.querySelector(".reader-meta > .reader-labels")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Add label" })).toBeNull();
    const field = await addLabel();
    // Revealed and focused, so the next key typed is the label and not a shortcut.
    expect(document.activeElement).toBe(field);
    // It says what to type and how to finish: the menu that gave it context has closed (WCAG 3.3.2).
    expect(field.getAttribute("placeholder")).toBe("Label, then Enter");
    // Enter on nothing sends nothing: an empty label is not a word.
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); });
    expect(calls.some((call) => call.path === "/api/messages/msg_1/labels")).toBe(false);
    fireEvent.change(field, { target: { value: "Urgent" } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); });
    const put = calls.find((call) => call.path === "/api/messages/msg_1/labels");
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ add: ["Urgent"] });
    await screen.findByRole("button", { name: "urgent" });
    // The field is gone; focus is back on the menu it came from, not on <body>.
    expect(document.activeElement).toBe(more());

    // Removing one is the × on it, and focus again lands on the menu rather than on a chip that is gone.
    labelled = () => Response.json({ messageId: "msg_1", labels: ["urgent"] });
    await act(async () => { screen.getByRole("button", { name: "Remove label invoice" }).click(); });
    await waitFor(() => { expect(screen.queryByRole("button", { name: "invoice" })).toBeNull(); });
    expect(document.activeElement).toBe(more());

    await act(async () => { screen.getByRole("button", { name: "urgent" }).click(); });
    await waitFor(() => {
      expect(calls.some((call) => call.path.startsWith("/api/messages?") && call.path.includes("label=urgent"))).toBe(true);
    });
    expect(screen.getByText(/Showing mail labelled/)).toBeDefined();
  });

  it("offers no way to change the words to a reader without standing content read, and still shows them", async () => {
    // The labels route takes `mailbox.content.read`; a metadata or supervised reader would only be refused.
    standing = 0;
    mount();
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    await act(async () => { screen.getByRole("button", { name: /message 1/ }).click(); });
    const pane = await screen.findByRole("article", { name: "Message" });
    expect(pane.querySelector(".reader-labels .chip-label")?.textContent).toContain("invoice");
    await act(async () => { more().click(); });
    expect(screen.queryByRole("menuitem", { name: "Add label…" })).toBeNull();
    await act(async () => { fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" }); });
    expect(screen.queryByRole("button", { name: "Remove label invoice" })).toBeNull();

    // And a message with no words has no labels row at all for this reader: nothing to show, nothing to do.
    await act(async () => { screen.getByRole("button", { name: /message 2/ }).click(); });
    await waitFor(() => { expect(screen.getByRole("article", { name: "Message" }).querySelector(".reader-subject")?.textContent).toBe("message 2"); });
    expect(document.querySelector(".reader-labels")).toBeNull();
  });

  it("puts the field away on Escape, and shows a refused change in the Node's words", async () => {
    labelled = () => Response.json({ message: "E_LEGAL_HOLD  this mailbox is under a hold" }, { status: 409 });
    mount();
    await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
    await act(async () => { screen.getByRole("button", { name: /message 1/ }).click(); });
    await screen.findByRole("article", { name: "Message" });
    await act(async () => { fireEvent.keyDown(await addLabel(), { key: "Escape" }); });
    expect(screen.queryByLabelText("Add a label")).toBeNull();
    expect(document.activeElement, "Escape left focus on <body>").toBe(more());

    const field = await addLabel();
    fireEvent.change(field, { target: { value: "urgent" } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); });
    const refusal = await screen.findByText(/E_LEGAL_HOLD\s+this mailbox is under a hold/);
    expect(refusal.getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("button", { name: "urgent" })).toBeNull();
  });
});
