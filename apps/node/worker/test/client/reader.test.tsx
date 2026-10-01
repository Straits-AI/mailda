import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";
import type { MessageRow } from "../../src/client/app/api.ts";

/**
 * The reading pane: what it shows without expanding, what it folds, and what it offers to whom.
 *
 * Each block here holds one of the redesign's risks, and each is an arrangement only a mount can show — where
 * an alert sits relative to a disclosure, whether a control exists at all for a reader who could not use it,
 * which case a button steals:
 *
 * - R2: the original is one click away, as a link the route answers, with its export consequence said.
 * - R5: Assign shows who holds the case before anything else, and hands over only what this reader holds.
 * - R6: a lost claim's notice sits in that message's article, after its actions, and nowhere else.
 * - R7: a DMARC `fail` is visible without expanding; a pass puts nothing outside the details.
 * - R24: every notice about the body comes before the body.
 * - R32: an act the Node would refuse is not offered, and the missing authority is named.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");
const { shortTime } = await import("../../src/client/app/format.ts");

function row(n: number, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: `rcpt_${n}`, message_id: `msg_${n}`, subject: `Invoice ${n}`,
    from_addr: `accounts${n}@northwind.example`, envelope_from: `bounce${n}@relay.example`,
    envelope_to: "hello@example.test", mailbox_id: "mbx_test", raw_bytes: 1409,
    accepted_at: "2026-09-26T07:09:02.000Z", parse_error: null, conversation_id: null, case_id: `case_${n}`,
    auth_spf: "pass", auth_dkim: "fail", auth_dmarc: "pass", auth_dmarc_policy: null, auth_from_domain: "northwind.example",
    attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
    place: "inbox", from_name: "Aisha Rahman", preview: null, standing_content: 1, case_mine: 0, case_state: "open",
    ...over,
  };
}

const BODY = {
  state: "html", html: "<p>Please find attached.</p>", text: null, blockedRemote: 2, truncated: true, problem: null,
  attachments: [{ filename: "inv.pdf", declaredType: "application/pdf", bytes: 20480, verdict: "plain" }],
  links: [{ href: "https://evil.example/pay", text: "northwind.example/pay", verdict: "mismatch" }],
  recipients: { to: ["hello@example.test", "bob@example.test"], cc: ["carol@example.test"], replyTo: "ar@northwind.example" },
};

const SUPPORT = { id: "mbx_test", name: "Support", unclaimed: 0, claimed: 0, mine: 0, addresses: "hello@example.test" };

let rows: MessageRow[];
let sendable: Array<typeof SUPPORT>;
let cases: unknown[];
let claim: (caseId: string) => Response;
let assign: () => Response;
let body: () => Response;
let casesAnswer: () => Response;
let meAnswer: () => Response | undefined;
let steal: () => Response;

beforeEach(() => {
  reset();
  rows = [row(1)];
  sendable = [SUPPORT];
  cases = [];
  claim = () => Response.json({ case: { id: "case_1", state: "claimed" } });
  assign = () => Response.json({ case: { id: "case_1", state: "claimed" } });
  body = () => Response.json(BODY);
  casesAnswer = () => Response.json({ cases });
  meAnswer = () => undefined;
  steal = () => Response.json({ case: { state: "claimed" } });
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") return Response.json({ messages: rows, next_cursor: null, lookback_exhausted: false });
    if (url.pathname === "/api/mailboxes") return Response.json({ mailboxes: sendable });
    if (url.pathname === "/api/mailboxes/readable") return Response.json({ mailboxes: [{ id: "mbx_test", name: "Support" }] });
    if (url.pathname === "/api/mailboxes/mbx_test/cases") return casesAnswer();
    if (url.pathname === "/api/me") return meAnswer();
    if (url.pathname.endsWith("/body")) return body();
    if (url.pathname.endsWith("/headers")) {
      return Response.json({ headers: "Received: from mx.northwind.example\nSubject: Invoice", truncated: true, limit_bytes: 65536 });
    }
    if (url.pathname.endsWith("/read")) return Response.json({ read: true });
    const caseAct = /^\/api\/cases\/([^/]+)\/(claim|steal)$/.exec(url.pathname);
    if (caseAct !== null) return caseAct[2] === "claim" ? claim(caseAct[1]!) : steal();
    if (url.pathname === "/api/cases/case_1/assignee") return assign();
    return undefined;
  });
});

async function open(subject = /Invoice 1/, rendered: () => boolean = () => document.querySelector("iframe.message-body") !== null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
  const button = await screen.findByRole("button", { name: subject });
  await act(async () => { button.click(); });
  // The body is the anchor for everything below: every negative that follows is also true of a loading pane.
  await waitFor(() => { expect(rendered()).toBe(true); });
  return screen.getByRole("article", { name: "Message" });
}

/** What the details say, as label to value. */
function facts(pane: HTMLElement): Record<string, string | null | undefined> {
  const details = pane.querySelector("details")!;
  return Object.fromEntries(Array.from(details.querySelectorAll("dt")).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
}

async function press(name: string | RegExp, within_: HTMLElement = document.body) {
  await act(async () => { within(within_).getByRole("button", { name }).click(); });
}

async function menu(): Promise<HTMLElement> {
  await press("More actions");
  return screen.getByRole("menu", { name: "More actions" });
}

describe("a time is when this Node received it, as short as it can be and stay unambiguous", () => {
  it("reads HH:MM today, day and month this year, and adds the year before that", () => {
    const now = new Date(2026, 8, 26, 16, 0);
    expect(shortTime(new Date(2026, 8, 26, 9, 5).toISOString(), now)).toBe("09:05");
    expect(shortTime(new Date(2026, 0, 3, 9, 5).toISOString(), now)).toBe("3 Jan");
    expect(shortTime(new Date(2025, 8, 26, 9, 5).toISOString(), now)).toBe("26 Sep 2025");
  });
});

describe("the original stays one click away, and says what the click records (R2)", () => {
  it("links Download original to the raw route with no download attribute, in the details and the menu", async () => {
    const pane = await open();
    const details = pane.querySelector("details")!;
    const inDetails = within(details).getByRole("link", { name: /Download original/ });
    expect(inDetails.getAttribute("href")).toBe("/api/messages/rcpt_1/raw");
    // Without the attribute, a `message.export` refusal opens as the Node's words instead of a saved error file.
    expect(inDetails.hasAttribute("download")).toBe(false);
    expect(details.textContent).toContain("Downloading is recorded as an export.");

    const items = await menu();
    const item = within(items).getByRole("menuitem", { name: /Download original/ });
    expect(item.getAttribute("href")).toBe("/api/messages/rcpt_1/raw");
    expect(item.hasAttribute("download")).toBe(false);
    expect(item.textContent).toContain("Recorded as an export.");
    expect(screen.queryByText(/View source/)).toBeNull();
  });
});

describe("the details, folded under the address it arrived at", () => {
  it("names the sender with the address, and lists the envelope, the time and what the receiving server found", async () => {
    const pane = await open();
    const sender = pane.querySelector(".reader-sender")!;
    expect(sender.querySelector(".sender-name")?.textContent).toBe("Aisha Rahman");
    expect(sender.querySelector(".sender-addr")?.textContent).toBe("<accounts1@northwind.example>");

    const details = pane.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("to hello@example.test");
    const facts = Object.fromEntries(Array.from(details.querySelectorAll("dt")).map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(facts).toMatchObject({
      From: "Aisha Rahman <accounts1@northwind.example>",
      To: "hello@example.test, bob@example.test",
      Cc: "carol@example.test",
      "Reply-To": "ar@northwind.example",
      "Delivered to": "hello@example.test",
      Size: "1,409 bytes",
    });
    expect(facts.Authentication).toBe("SPF pass · DKIM fail · DMARC pass — northwind.example vouches for this message");
    expect(facts.Received).toBe(new Date("2026-09-26T07:09:02.000Z").toLocaleString(undefined, { hour12: false }));
  });

  it("fetches the header block only when asked, shows it in a dialog that can be closed and reopened", async () => {
    const pane = await open();
    const headers = () => calls.filter((call) => call.path === "/api/messages/rcpt_1/headers");
    expect(headers(), "the headers were fetched before anybody asked").toHaveLength(0);

    await press("View headers", pane.querySelector("details")!);
    const dialog = await screen.findByRole("dialog", { name: "Headers" });
    await within(dialog).findByText(/Received: from mx\.northwind\.example/);
    expect(headers()).toHaveLength(1);
    // A named region in the Tab order: a real header block is taller than the dialog, and WebKit does not focus a
    // scroller by itself, so without it a keyboard could not read past the first screen (R2AXE-1).
    expect(within(dialog).getByRole("region", { name: "Header block" }).tabIndex, "the header block is out of the Tab order").toBe(0);
    expect(dialog.textContent).toContain("Shown: the first 65,536 bytes");

    // The browser's Escape is a `cancel` on the dialog; the owner must hear it, or it can never reopen.
    await act(async () => { fireEvent(dialog, new Event("cancel")); });
    expect(screen.queryByRole("dialog", { name: "Headers" })).toBeNull();
    // Focus goes back to the control that opened it, which Safari would not have focused on the click.
    expect(document.activeElement).toBe(within(pane.querySelector("details")!).getByRole("button", { name: "View headers" }));
    await press("View headers", pane.querySelector("details")!);
    expect(await screen.findByRole("dialog", { name: "Headers" })).toBeDefined();
  });
});

describe("a spoofing warning is visible without expanding anything (R7)", () => {
  it("shows a DMARC fail as an alert outside the closed details", async () => {
    rows = [row(1, { auth_dmarc: "fail", auth_spf: "fail", auth_dkim: "fail", auth_dmarc_policy: "reject" })];
    const pane = await open();
    const alert = pane.querySelector(".auth-alert")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(pane.querySelector("details")!.open).toBe(false);
    expect(pane.querySelector("details")!.contains(alert)).toBe(false);
    expect(alert.textContent).toBe("northwind.example says this message is not theirs (dmarc fail; spf fail, dkim fail; the domain asks receivers to reject)");
  });

  it("puts nothing about authentication outside the details on a pass", async () => {
    const pane = await open();
    expect(pane.querySelector(".auth-alert")).toBeNull();
    const outside = pane.cloneNode(true) as HTMLElement;
    outside.querySelector("details")!.remove();
    expect(outside.textContent).not.toContain("vouches");
    // Positive anchor for the negative above: the sentence exists, folded.
    expect(pane.querySelector("details")!.textContent).toContain("vouches for this message");
  });
});

describe("the body, and what is said about it", () => {
  const PLAIN = { state: "text-only", html: null, text: "Just text.", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [], recipients: { to: [], cc: [], replyTo: null } };
  const plainShown = () => screen.queryByText("Just text.") !== null;

  it("says nothing about a clean body, and falls back to the envelope for To", async () => {
    body = () => Response.json(PLAIN);
    const pane = await open(/Invoice 1/, plainShown);
    expect(pane.querySelector("[role=alert]")).toBeNull();
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    expect(pane.textContent).not.toMatch(/withheld|truncated/);
    expect(facts(pane).To).toBe("hello@example.test");
    expect(facts(pane)).not.toHaveProperty("Cc");
  });

  it("names what each attachment is and what an image link hides, as words to check against the file", async () => {
    body = () => Response.json({
      ...PLAIN,
      attachments: [
        { filename: "setup.exe", declaredType: "application/octet-stream", bytes: 4096, verdict: "executable" },
        { filename: "bundle.zip", declaredType: "application/zip", bytes: 4096, verdict: "archive" },
      ],
      links: [{ href: "https://evil.example", text: "", verdict: "lookalike" }],
    });
    await open(/Invoice 1/, plainShown);
    const parts = within(screen.getByRole("list", { name: "Attachments" })).getAllByRole("listitem");
    expect(parts[0]!.querySelector(".bad")?.textContent).toBe(" — a program");
    expect(parts[1]!.querySelector(".dim:last-child")?.textContent).toBe(" — an archive; what is inside has not been opened");
    expect(screen.getByText("(an image)")).toBeDefined();
  });

  it("says a body that could not be read could not be read, in the Node's words where it has them", async () => {
    body = () => Response.json({ ...PLAIN, state: "unparsed", text: null, problem: "The MIME structure ended early." });
    await open(/Invoice 1/, () => screen.queryByText("The MIME structure ended early.") !== null);
  });

  it("reads a body with no HTML as text, whatever its state says", async () => {
    body = () => Response.json({ ...PLAIN, state: "html", html: null, text: "Only the plain part." });
    await open(/Invoice 1/, () => screen.queryByText("Only the plain part.") !== null);
    expect(document.querySelector("iframe.message-body")).toBeNull();
  });

  it("says a body request the Node refused was refused, with its status", async () => {
    body = () => new Response("{}", { status: 500 });
    await open(/Invoice 1/, () => screen.queryByText("The body could not be read (500).") !== null);
  });

  it("says when authentication was never evaluated, or no header said anything", async () => {
    rows = [row(1, { auth_dmarc: null, auth_spf: null, auth_dkim: null }), row(2, { subject: "Invoice 2", auth_dmarc: "absent" })];
    const pane = await open();
    expect(facts(pane).Authentication).toBe("Not evaluated — arrived before this Node checked senders");
    await act(async () => { screen.getByRole("button", { name: /Invoice 2/ }).click(); });
    await waitFor(() => { expect(facts(screen.getByRole("article", { name: "Message" })).Authentication).toBe("no authentication header from the receiving server"); });
  });
});

describe("every notice about the body comes before it (R24)", () => {
  it("puts withheld, truncated, attachments and link warnings above the frame", async () => {
    const pane = await open();
    const frame = pane.querySelector("iframe.message-body")!;
    const notices = [
      screen.getByText(/2 remote resources withheld/),
      screen.getByText(/Shown truncated/),
      screen.getByRole("list", { name: "Attachments" }),
      screen.getByText(/1 of 1 link in this message is not what it says/),
    ];
    for (const notice of notices) {
      expect(notice.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING, notice.textContent ?? "").toBeTruthy();
    }
  });
});

describe("only what works is offered, and a missing authority is named (R32)", () => {
  it("offers Reply, Reply all, Forward and Assign to a reader holding send.propose", async () => {
    const pane = await open();
    const actions = within(pane).getByRole("group", { name: "Message actions" });
    for (const name of ["Reply", "Reply all", "Forward", "Assign"]) expect(within(actions).getByRole("button", { name })).toBeDefined();
    expect(pane.querySelector(".reader-note")).toBeNull();
  });

  it("offers none of them without it, and says which authority they need", async () => {
    sendable = [];
    const pane = await open();
    const actions = within(pane).getByRole("group", { name: "Message actions" });
    await waitFor(() => { expect(pane.querySelector(".reader-note")?.textContent).toBe("Replying from Support needs send.propose on it, which you do not hold."); });
    for (const name of ["Reply", "Reply all", "Forward", "Assign"]) expect(within(actions).queryByRole("button", { name })).toBeNull();
    // Navigation and reading are not withheld: the menu is still there.
    expect(within(actions).getByRole("button", { name: "More actions" })).toBeDefined();
  });

  it("marks unread from the menu, and it is the Node's answer that changes the row", async () => {
    await open();
    await act(async () => { within(await menu()).getByRole("menuitem", { name: "Mark unread" }).click(); });
    await waitFor(() => { expect(calls.filter((call) => call.path.endsWith("/read")).map((call) => call.body)).toEqual([{ read: false }]); });
    await waitFor(() => { expect(screen.getByRole("button", { name: /Invoice 1/ }).className).toContain("unread"); });
  });

  it("says when the headers were only partly readable, above the body", async () => {
    rows = [row(1, { parse_error: "a header line was longer than the limit" })];
    const pane = await open();
    expect(pane.textContent).toContain("Headers were only partly readable: a header line was longer than the limit. The original is unchanged.");
  });

  it("offers no reply to a message with no case, and says why rather than composing one nobody holds", async () => {
    rows = [row(1, { case_id: null, case_state: null })];
    const pane = await open();
    await press("Reply", within(pane).getByRole("group", { name: "Message actions" }));
    await within(pane).findByText("This message has no case yet, so it cannot be claimed. It predates the queue.");
    expect(calls.some((call) => call.path.endsWith("/claim"))).toBe(false);
    expect(screen.queryByRole("region", { name: "Reply" })).toBeNull();
  });

  it("offers read state and places only to a reader with standing content read, and never Delete", async () => {
    const pane = await open();
    const items = within(await menu()).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(expect.arrayContaining(["Archive", "Move to Trash", "Mark unread", "View headers"]));
    expect(items.some((item) => /delete/i.test(item ?? ""))).toBe(false);
    expect(pane).toBeDefined();
  });

  it("groups the menu: the message's state, where it lives, and the original, with a rule between", async () => {
    await open();
    const list = await menu();
    const order = Array.from(list.children).map((child) => (child.tagName === "HR" ? "—" : child.textContent?.replace("Recorded as an export.", "")));
    expect(order).toEqual(["Mark unread", "Add label…", "—", "Archive", "Move to Trash", "—", "View headers", "Download original"]);
    // The rules are separators, and the arrow keys never land on one.
    expect(within(list).getAllByRole("separator")).toHaveLength(2);
  });

  it("omits them for a supervised or metadata reader, and makes no read request on open", async () => {
    rows = [row(1, { standing_content: 0, read: 0 })];
    await open();
    const items = within(await menu()).getAllByRole("menuitem").map((item) => item.textContent);
    expect(items.some((item) => /Mark|Archive|Move to/.test(item ?? ""))).toBe(false);
    expect(items.some((item) => /Download original/.test(item ?? ""))).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/read")), "a PUT the Node would refuse").toBe(false);
  });
});

describe("Assign never hands over a case somebody else holds by accident (R5)", () => {
  const HELD = {
    id: "case_1", conversation_id: "cnv_1", mailbox_id: "mbx_test", state: "claimed", state_at: "2026-09-26T08:00:00.000Z",
    assignee: "usr_bob", claimed_at: "2026-09-26T08:00:00.000Z", created_at: "2026-09-26T07:09:02.000Z", subject: "Invoice 1",
    from_addr: "accounts1@northwind.example", content_restricted: false, message_count: 1, assignee_email: "bob@example.test",
    response_due_at: null, first_response_at: null, response_breached_at: null,
  };
  const assignments = () => calls.filter((call) => call.path === "/api/cases/case_1/assignee");

  it("shows the holder first, and offers the hand-over only after the audited steal", async () => {
    cases = [HELD];
    const pane = await open();
    await press("Assign", pane);
    const popover = await screen.findByRole("dialog", { name: "Assign" });
    await within(popover).findByText(`Held by bob@example.test since ${new Date(HELD.claimed_at).toLocaleString(undefined, { hour12: false })}.`, { exact: false });
    expect(within(popover).queryByRole("button", { name: "Hand over" })).toBeNull();

    await press("Take it anyway", popover);
    await waitFor(() => { expect(calls.some((call) => call.path === "/api/cases/case_1/steal")).toBe(true); });
    expect(assignments()).toHaveLength(0);
    const field = await within(popover).findByLabelText("Colleague's sign-in address");
    fireEvent.change(field, { target: { value: "carol@example.test" } });
    await press("Hand over", popover);
    await waitFor(() => { expect(assignments()).toHaveLength(1); });
    // The holder this popover saw after the steal is this reader, and the Node compares against it.
    expect(assignments()[0]!.body).toEqual({ email: "carol@example.test", holder: "usr_test" });
  });

  async function assignPopover(): Promise<HTMLElement> {
    const pane = await open();
    await press("Assign", pane);
    return await screen.findByRole("dialog", { name: "Assign" });
  }

  it("says when the case was claimed, or that the time was not recorded", async () => {
    cases = [{ ...HELD, claimed_at: null }];
    const popover = await assignPopover();
    await within(popover).findByText(/Held by bob@example\.test since an unrecorded time\./);
  });

  it("offers the hand-over at once on a case this reader holds, naming themselves as the holder", async () => {
    cases = [{ ...HELD, assignee: "usr_test", assignee_email: "ana@example.test" }];
    const popover = await assignPopover();
    fireEvent.change(await within(popover).findByLabelText("Colleague's sign-in address"), { target: { value: "carol@example.test" } });
    expect(within(popover).queryByText(/Held by/)).toBeNull();
    await press("Hand over", popover);
    await waitFor(() => { expect(assignments()).toHaveLength(1); });
    expect(assignments()[0]!.body).toEqual({ email: "carol@example.test", holder: "usr_test" });
  });

  it("keeps the form away when the steal is refused, and says why", async () => {
    cases = [HELD];
    steal = () => Response.json({ error: "closed", message: "This case was closed a moment ago." }, { status: 409 });
    const popover = await assignPopover();
    await within(popover).findByText(/Held by bob@example\.test since/);
    await press("Take it anyway", popover);
    await within(popover).findByText("This case was closed a moment ago.");
    expect(within(popover).queryByRole("button", { name: "Hand over" })).toBeNull();
  });

  it("says a case that is no longer listed is closed", async () => {
    cases = [];
    const popover = await assignPopover();
    await within(popover).findByText("This case is closed.");
  });

  it("says a message with no case cannot be assigned", async () => {
    rows = [row(1, { case_id: null, case_state: null })];
    const popover = await assignPopover();
    expect(within(popover).getByText("This message has no case yet, so it cannot be assigned. It predates the queue.")).toBeDefined();
    expect(calls.some((call) => call.path.endsWith("/cases")), "asked for cases a message without one cannot be in").toBe(false);
  });

  it("shows the Node's words when the cases cannot be read", async () => {
    casesAnswer = () => Response.json({ message: "The queue is for people who can send from Support." }, { status: 403 });
    const popover = await assignPopover();
    await within(popover).findByText("The queue is for people who can send from Support.");
  });

  it("shows the Node's words when the reader's identity cannot be read", async () => {
    cases = [HELD];
    meAnswer = () => Response.json({ message: "Your session ended." }, { status: 401 });
    const popover = await assignPopover();
    await within(popover).findByText("Your session ended.");
  });

  it("sends null as the holder of an unclaimed case, so a claim landing in between is refused", async () => {
    cases = [{ ...HELD, state: "open", assignee: null, assignee_email: null, claimed_at: null }];
    const pane = await open();
    await press("Assign", pane);
    const popover = await screen.findByRole("dialog", { name: "Assign" });
    fireEvent.change(await within(popover).findByLabelText("Colleague's sign-in address"), { target: { value: "carol@example.test" } });
    await press("Hand over", popover);
    await waitFor(() => { expect(assignments()).toHaveLength(1); });
    expect(assignments()[0]!.body).toEqual({ email: "carol@example.test", holder: null });
    await waitFor(() => { expect(document.querySelector(".toast-region .toast")?.textContent).toBe("Handed to carol@example.test. It is in their queue now, and the trail names you both."); });
    expect(screen.queryByRole("dialog", { name: "Assign" })).toBeNull();
  });

  it("keeps the popover open with the Node's words when the hand-over is refused", async () => {
    cases = [{ ...HELD, state: "open", assignee: null, assignee_email: null, claimed_at: null }];
    assign = () => Response.json({ error: "held", heldBy: "dan@example.test", heldSince: "", message: "dan@example.test took this a moment ago." }, { status: 409 });
    const pane = await open();
    await press("Assign", pane);
    const popover = await screen.findByRole("dialog", { name: "Assign" });
    fireEvent.change(await within(popover).findByLabelText("Colleague's sign-in address"), { target: { value: "carol@example.test" } });
    await press("Hand over", popover);
    const refusal = await within(popover).findByText("dan@example.test took this a moment ago.");
    expect(refusal.getAttribute("role")).toBe("alert");
    expect(document.querySelector(".toast-region .toast")).toBeNull();
  });
});

describe("a lost claim's notice belongs to its message (R6)", () => {
  it("renders in that message's article after its actions, steals the case it names, and leaves with the selection", async () => {
    rows = [row(1, { case_id: "case_A" }), row(2, { case_id: "case_B", subject: "Invoice 2" })];
    claim = () => {
      /*
       * The listing refetched after the lost claim carries a different case for the row (a merge, say). The
       * notice names the case whose claim was lost, and that is the one to take: not the row's by lookup.
       */
      rows = [row(1, { case_id: "case_A2" }), rows[1]!];
      return Response.json({ error: "held", heldBy: "bob@example.test", heldSince: "", message: "bob@example.test holds this." }, { status: 409 });
    };
    const pane = await open();
    await press("Reply", within(pane).getByRole("group", { name: "Message actions" }));

    const notice = await within(pane).findByText(/bob@example\.test holds this\./);
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.previousElementSibling?.classList.contains("reader-actions")).toBe(true);
    await waitFor(() => { expect(calls.filter((call) => call.path.startsWith("/api/messages?")).length).toBeGreaterThan(1); });
    await press("Take it anyway", notice);
    await waitFor(() => { expect(calls.some((call) => call.path.endsWith("/steal"))).toBe(true); });
    expect(calls.filter((call) => call.path.endsWith("/steal")).map((call) => call.path)).toEqual(["/api/cases/case_A/steal"]);
    // Taken from a Reply, so the reply it was for opens.
    await screen.findByRole("region", { name: "Reply" });

    // Lose it again, then look at B: a stale "held by" on the wrong message is worse than asking again.
    await press("Reply", within(pane).getByRole("group", { name: "Message actions" }));
    await within(pane).findByText(/bob@example\.test holds this\./);
    await act(async () => { screen.getByRole("button", { name: /Invoice 2/ }).click(); });
    const other = await screen.findByRole("article", { name: "Message" });
    await waitFor(() => { expect(other.querySelector(".reader-subject")?.textContent).toBe("Invoice 2"); });
    expect(within(other).queryByText(/holds this/)).toBeNull();
  });

  it("raises the notice as an alert toast, with Take it anyway, while a composer covers the reader", async () => {
    /*
     * The dock takes the whole reader column, so with a reply to A open, R on B (held by a colleague) put its
     * notice under the dock: nothing visible happened. The toast region sits above the dock.
     */
    rows = [row(1, { case_id: "case_A" }), row(2, { case_id: "case_B", subject: "Invoice 2" })];
    claim = (caseId) => (caseId === "case_B"
      ? Response.json({ error: "held", heldBy: "bob@example.test", heldSince: "", message: "bob@example.test holds this." }, { status: 409 })
      : Response.json({ case: { id: caseId, state: "claimed" } }));
    const pane = await open();
    await press("Reply", within(pane).getByRole("group", { name: "Message actions" }));
    await screen.findByRole("region", { name: "Reply" });

    await act(async () => { screen.getByRole("button", { name: /Invoice 2/ }).click(); });
    const other = await screen.findByRole("article", { name: "Message" });
    await waitFor(() => { expect(other.querySelector(".reader-subject")?.textContent).toBe("Invoice 2"); });
    await press("Reply", within(other).getByRole("group", { name: "Message actions" }));

    const toast = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(".toast-region [role=alert] .toast");
      expect(found?.textContent).toContain("Invoice 2: bob@example.test holds this.");
      return found!;
    });
    // Said once: the copy in the covered article is no longer an alert of its own.
    expect(within(other).getByText(/bob@example\.test holds this\./).getAttribute("role")).toBeNull();
    await press("Take it anyway", toast);
    await waitFor(() => { expect(calls.filter((call) => call.path.endsWith("/steal")).map((call) => call.path)).toEqual(["/api/cases/case_B/steal"]); });
    // The reply it was for replaces the one to A.
    await waitFor(() => { expect((document.getElementById("composer-subject") as HTMLInputElement | null)?.value).toBe("Re: Invoice 2"); });
  });

  it("does not follow the reader to another message when the answer lands after they moved", async () => {
    rows = [row(1, { case_id: "case_A" }), row(2, { case_id: "case_B", subject: "Invoice 2" })];
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    claim = () => Response.json({ error: "held", heldBy: "bob@example.test", heldSince: "", message: "bob@example.test holds this." }, { status: 409 });
    const gated = claim;
    claim = (caseId) => {
      const response = gated(caseId);
      // The Node answers only once the reader has already moved on to B.
      return answered.then(() => response) as unknown as Response;
    };
    const pane = await open();
    await press("Reply", within(pane).getByRole("group", { name: "Message actions" }));
    await act(async () => { screen.getByRole("button", { name: /Invoice 2/ }).click(); });
    const other = screen.getByRole("article", { name: "Message" });
    await waitFor(() => { expect(other.querySelector(".reader-subject")?.textContent).toBe("Invoice 2"); });
    await act(async () => { answer(); });
    // The answer arrived: the listing refetch it causes is the sign, and B's article still has no A notice.
    await waitFor(() => { expect(calls.filter((call) => call.path.startsWith("/api/messages?")).length).toBeGreaterThan(1); });
    expect(within(other).queryByText(/holds this/)).toBeNull();
  });
});
