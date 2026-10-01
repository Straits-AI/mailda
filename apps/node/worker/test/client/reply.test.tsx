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
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");
const { fullTime } = await import("../../src/client/app/format.ts");

/**
 * This machine's zone as the quote line names it, `GMT+08:00`, worked out without `Intl`: what the quote line must end
 * its date with. At a zero offset some ICU builds print a bare `GMT`, so either form is accepted there.
 */
function zone(at: string): RegExp {
  const minutes = -new Date(at).getTimezoneOffset();
  const abs = Math.abs(minutes);
  const offset = `${minutes < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  const time = fullTime(at).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`\\n\\nOn ${time} ${minutes === 0 ? "GMT(?:\\+00:00)?" : `GMT\\${offset}`}, alice@outside\\.example wrote:\\n> Where`);
}

/**
 * Reply quotes the message's own text from the body the pane fetched; reply-all addresses the sender and
 * copies everybody else the sender addressed, minus this mailbox's own addresses; opening a message marks
 * it read, once, and patches the listed row rather than asking for the list again.
 */
const ROW = {
  id: "rcpt_1", message_id: "msg_1", subject: "Invoice", from_addr: "alice@outside.example",
  // The return path differs from the From header, as it does on relayed mail; a reply goes to the person.
  envelope_from: "bounces@relay.example", envelope_to: "support@example.test", mailbox_id: "mbx_test",
  raw_bytes: 1024, accepted_at: "2026-08-21T09:00:00.000Z", parse_error: null, conversation_id: null,
  case_id: "cas_1", auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null,
  auth_from_domain: null, attachments: null, attachments_dangerous: null, labels_json: "[]", read: 0,
  place: "inbox", from_name: null, preview: null, standing_content: 1, case_mine: 0, case_state: "open",
};
const BODY = {
  state: "text-only", html: null, text: "Where is my invoice?\nThanks", blockedRemote: 0, truncated: false,
  problem: null, attachments: [], links: [],
  recipients: { to: ["support@example.test", "bob@outside.example"], cc: ["carol@outside.example"], replyTo: null },
};

let answered: unknown;
let listed: Array<typeof ROW>;
let sealed: () => Promise<Response> | undefined;
/** When set, the second message's body waits for it: a body still on its way. */
let held: Promise<void> | null;

beforeEach(() => {
  reset();
  answered = BODY;
  listed = [ROW];
  sealed = () => undefined;
  held = null;
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") return Response.json({ messages: listed, next_cursor: null, lookback_exhausted: false });
    if (url.pathname === "/api/sends" && call.method === "POST") return sealed();
    if (url.pathname === "/api/mailboxes") {
      return Response.json({ mailboxes: [{ id: "mbx_test", name: "Support", unclaimed: 0, claimed: 0, mine: 0, first_response_minutes: null, quarantine_dmarc_fail: 0, quarantine_dangerous_attachments: 0, quarantined: 0, breached: 0, addresses: "support@example.test" }] });
    }
    if (url.pathname === "/api/messages/rcpt_2/body" && held !== null) return held.then(() => Response.json(answered));
    if (url.pathname.endsWith("/body")) return Response.json(answered);
    if (url.pathname.endsWith("/read")) return Response.json({ messageId: "msg_1", read: true });
    if (url.pathname.startsWith("/api/cases/")) return Response.json({ ok: true, state: "claimed" });
    if (url.pathname === "/api/drafts") return Response.json({ draft: null });
    return undefined;
  });
});

async function open(ready: () => boolean = () => screen.queryByText(/Where is my invoice/) !== null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
  await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
  await act(async () => { screen.getByRole("button", { name: /Invoice/ }).click(); });
  await waitFor(() => { expect(ready()).toBe(true); });
}

describe("replying from the reading pane", () => {
  it("marks the message read once, on open, and does not ask for the list again", async () => {
    await open();
    await waitFor(() => { expect(calls.filter((call) => call.path === "/api/messages/msg_1/read")).toHaveLength(1); });
    expect(calls.find((call) => call.path === "/api/messages/msg_1/read")?.body).toEqual({ read: true });
    // The row is patched in the cache: a refetch after every open is one more listing, and for a supervised
    // reader one more `supervised.query` entry. The row's weight changing is the proof the patch landed.
    await waitFor(() => { expect(screen.getByRole("button", { name: /Invoice/ }).className).not.toContain("unread"); });
    expect(calls.filter((call) => call.path.startsWith("/api/messages?") || call.path === "/api/messages")).toHaveLength(1);
  });

  it("reply quotes the body and addresses the sender; reply all copies the others and not ourselves", async () => {
    await open();
    await act(async () => { screen.getByRole("button", { name: "Reply all" }).click(); });
    const dock = await screen.findByRole("region", { name: "Reply" });
    expect((dock.querySelector("#composer-to") as HTMLInputElement).value).toBe("alice@outside.example");
    expect((dock.querySelector("#composer-cc") as HTMLInputElement).value).toBe("bob@outside.example, carol@outside.example");
    const body = (dock.querySelector("#composer-body") as HTMLTextAreaElement).value;
    expect(body).toContain("> Where is my invoice?");
    expect(body).toContain("> Thanks");
  });

  it("quotes an HTML-only message as its text, tags and entities gone", async () => {
    answered = { ...BODY, state: "html", text: null, html: "<style>p{}</style><p>Where is it?</p><p>Tom &amp; Ann</p>" };
    await open(() => document.querySelector("iframe.message-body") !== null);
    await act(async () => { screen.getByRole("button", { name: "Reply" }).click(); });
    const dock = await screen.findByRole("region", { name: "Reply" });
    const quoted = (dock.querySelector("#composer-body") as HTMLTextAreaElement).value;
    expect(quoted).toContain("> Where is it?\n> Tom & Ann");
    expect(quoted).not.toContain("<p>");
  });

  it("names the message it answers in the dock's head, and dates the quote on the reader's 24-hour clock with its offset", async () => {
    await open();
    await act(async () => { screen.getByRole("button", { name: "Reply" }).click(); });
    const dock = await screen.findByRole("region", { name: "Reply" });
    // The dock covers the reader, so it says what the reply is about.
    expect(dock.querySelector(".dock-context")?.textContent).toBe("Replying to: Invoice");
    const body = (dock.querySelector("#composer-body") as HTMLTextAreaElement).value;
    // The same instant as the details' Received, in the same form; 09:00 UTC is never "AM" or "PM" here. Then the
    // offset, because the line leaves for a correspondent whose clock may be another zone's (critic L5).
    expect(body).toMatch(zone(ROW.accepted_at));
    expect(body).not.toMatch(/\b[AP]M\b/);
  });

  it("says every fact of the send beside the button, and keeps the long form one click down", async () => {
    await open();
    await act(async () => { screen.getByRole("button", { name: "Forward" }).click(); });
    const dock = await screen.findByRole("region", { name: "Forward" });
    expect(dock.querySelector(".dock-context")?.textContent).toBe("Forwarding: Invoice");
    const note = dock.querySelector(".dock-send .send-note")?.textContent?.replace(/\s+/g, " ").trim();
    expect(note).toMatch(/^Sent as the mailbox; who wrote it is recorded here\. Held \d+ s so you can stop it; no recall\.$/);
    const how = dock.querySelector("details.send-how");
    expect(how?.querySelector("summary")?.textContent).toBe("How sending works");
    expect(how?.textContent).toContain("a recall would not be honest");
  });
});

describe("a reply while the open one is sealing", () => {
  /*
   * The dock keeps its seal's answer, so a reply cannot open over it; the refusal used to come after the reply had
   * claimed its case, and the person held a case they never saw announced (R2-R-WHILE-SEALING).
   */
  it("claims nothing on another message, and says why", async () => {
    listed = [ROW, { ...ROW, id: "rcpt_2", message_id: "msg_2", subject: "Contract renewal", case_id: "cas_2" }];
    sealed = () => new Promise<Response>(() => {});
    await open();
    await act(async () => { screen.getByRole("button", { name: "Reply" }).click(); });
    await screen.findByRole("region", { name: "Reply" });
    const seal = screen.getByRole("button", { name: "Seal and send" }) as HTMLButtonElement;
    await waitFor(() => { expect(seal.disabled).toBe(false); });
    await act(async () => { seal.click(); });
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/sends"), "the seal is not in the air, so this proves nothing").toHaveLength(1);
    });

    // Focused as a click in a browser focuses it: a key pressed inside the dock is the dock's own.
    const other = screen.getByRole("button", { name: /Contract renewal/ });
    await act(async () => { other.focus(); other.click(); });
    await act(async () => { fireEvent.keyDown(other, { key: "r" }); });
    expect(await screen.findByText("Still sealing the open message. Open this again once the Node has answered it.")).toBeTruthy();
    expect(calls.filter((call) => call.path === "/api/cases/cas_2/claim"), "R claimed a case whose reply could not open").toHaveLength(0);
  });

  /* R pressed before the seal, whose body arrives after it: the check before the body fetch saw no seal (R3C-REPLY-SEAL-WINDOW). */
  it("claims nothing when the seal starts while the other message's body is on its way", async () => {
    listed = [ROW, { ...ROW, id: "rcpt_2", message_id: "msg_2", subject: "Contract renewal", case_id: "cas_2" }];
    sealed = () => new Promise<Response>(() => {});
    let arrive = () => {};
    held = new Promise<void>((resolve) => { arrive = resolve; });
    await open();
    await act(async () => { screen.getByRole("button", { name: "Reply" }).click(); });
    await screen.findByRole("region", { name: "Reply" });
    const seal = screen.getByRole("button", { name: "Seal and send" }) as HTMLButtonElement;
    await waitFor(() => { expect(seal.disabled).toBe(false); });

    const other = screen.getByRole("button", { name: /Contract renewal/ });
    await act(async () => { other.focus(); other.click(); });
    await act(async () => { fireEvent.keyDown(other, { key: "r" }); });
    await act(async () => { seal.click(); });
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/sends"), "the seal is not in the air, so this proves nothing").toHaveLength(1);
    });

    await act(async () => { arrive(); });
    expect(await screen.findByText("Still sealing the open message. Open this again once the Node has answered it.")).toBeTruthy();
    expect(calls.filter((call) => call.path === "/api/cases/cas_2/claim"), "R claimed a case once the body came in under a seal").toHaveLength(0);
  });
});
