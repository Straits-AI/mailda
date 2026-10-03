import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { fullTime, monthDay, shortTime } from "../../src/client/app/format.ts";
import { answerWith, reset } from "./session-stub.ts";
import type { MessageRow } from "../../src/client/app/api.ts";

/**
 * The reading pane in English, byte for byte, as it was before its words moved into the catalog (ADR 46,
 * `docs/i18n.md`). The golden files were written from `reader.tsx` as it stood on 1 October 2026, before the
 * change, and rendered green against it: a key whose English differs by a letter, a plural that picks the wrong
 * form, or an element lost from inside a sentence shows as a diff.
 *
 * A time is the viewer's zone, so it is replaced by `[short]` and `[full]` before comparing, from the two
 * formatters as they were (`OLD_SHORT`, `OLD_FULL` below, pasted from the file before the change). What is held is
 * that the pane shows those strings for that instant, and everything else byte for byte.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { ReadingPane, Thread } = await import("../../src/client/app/screens/reader.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

const AT = "2026-09-26T07:09:02.000Z";

/** `fullTime` as it was in `reader.tsx` before the migration. */
const OLD_FULL = (at: string) => new Date(at).toLocaleString(undefined, { hour12: false });
/** `shortTime` as it was, with its month table. */
const OLD_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function OLD_SHORT(at: string, now: Date = new Date()): string {
  const when = new Date(at);
  if (when.toDateString() === now.toDateString()) {
    return `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  }
  const day = `${when.getDate()} ${OLD_MONTHS[when.getMonth()]}`;
  return when.getFullYear() === now.getFullYear() ? day : `${day} ${when.getFullYear()}`;
}

function html(container: HTMLElement): string {
  return container.innerHTML.replaceAll(OLD_FULL(AT), "[full]").replaceAll(`>${OLD_SHORT(AT)}<`, ">[short]<")
    .replaceAll("><", ">\n<") + "\n";
}

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "rcpt_1", message_id: "msg_1", subject: "Invoice 1",
    from_addr: "accounts@northwind.example", envelope_from: "bounce@relay.example",
    envelope_to: "hello@example.test", mailbox_id: "mbx_test", raw_bytes: 14090,
    accepted_at: AT, parse_error: null, conversation_id: null, case_id: "case_1",
    auth_spf: "pass", auth_dkim: "fail", auth_dmarc: "pass", auth_dmarc_policy: null, auth_from_domain: "northwind.example",
    attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
    place: "inbox", from_name: "Aisha Rahman", preview: null, standing_content: 1, case_mine: 0, case_state: "open",
    ...over,
  };
}

const RECIPIENTS = { to: ["hello@example.test", "bob@example.test"], cc: ["carol@example.test"], replyTo: "ar@northwind.example" };

const FULL_BODY = {
  state: "html", html: "<p>Please find attached.</p>", text: null, blockedRemote: 2, truncated: true, problem: null,
  attachments: [
    { filename: "inv.pdf", declaredType: "application/pdf", bytes: 20480, verdict: "plain" },
    { filename: "all.zip", declaredType: "application/zip", bytes: 100, verdict: "archive" },
    { filename: null, declaredType: "application/octet-stream", bytes: 4096, verdict: "executable" },
    { filename: "bad.zip", declaredType: "application/zip", bytes: 2048, verdict: "archive_dangerous" },
    { filename: "run.js", declaredType: "text/javascript", bytes: 512, verdict: "script" },
    { filename: "invoice.pdf.exe", declaredType: "application/pdf", bytes: 3000, verdict: "disguised" },
  ],
  links: [
    { href: "https://evil.example/pay", text: "northwind.example/pay", verdict: "mismatch" },
    { href: "https://n0rthwind.example/", text: "", verdict: "lookalike" },
    { href: "https://northwind.example@evil.example/", text: "northwind", verdict: "userinfo" },
    { href: "http://192.0.2.1/", text: "portal", verdict: "ip_host" },
    { href: "https://northwind.example/", text: "northwind.example", verdict: "plain" },
  ],
  recipients: RECIPIENTS,
};

let body: () => Response;
let cases: () => Response;
let me: () => Response;
let assign: () => Response;
let steal: () => Response;
let labels: () => Response;
let headers: () => Response;
let thread: { messages: unknown[]; sends: unknown[] };

beforeEach(() => {
  reset();
  body = () => Response.json(FULL_BODY);
  cases = () => Response.json({ cases: [] });
  me = () => Response.json({ userId: "usr_me", email: "me@example.test" });
  assign = () => Response.json({ case: { id: "case_1", state: "claimed" } });
  steal = () => Response.json({ case: { id: "case_1", state: "claimed" } });
  labels = () => Response.json({ labels: [] });
  headers = () => Response.json({ headers: "Received: from mx.northwind.example\nSubject: Invoice", truncated: true, limit_bytes: 65536 });
  thread = { messages: [], sends: [] };
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/messages") return Response.json({ messages: thread.messages, next_cursor: null });
    if (url.pathname === "/api/sends") return Response.json({ sends: thread.sends, daily: {}, capability: {} });
    if (url.pathname.endsWith("/body")) return body();
    if (url.pathname.endsWith("/headers")) return headers();
    if (url.pathname === "/api/mailboxes/mbx_test/cases") return cases();
    if (url.pathname === "/api/me") return me();
    if (url.pathname === "/api/cases/case_1/steal") return steal();
    if (url.pathname === "/api/cases/case_1/assignee") return assign();
    if (url.pathname.endsWith("/labels")) return labels();
    return undefined;
  });
});

afterEach(() => {
  install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
});

const chinese = () =>
  install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });

function mount(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ShellProvider>{element}</ShellProvider></QueryClientProvider>);
}

function pane(message: MessageRow, over: { sendable?: boolean | null; back?: boolean } = {}) {
  return (
    <ReadingPane
      message={message} sendable={over.sendable ?? true} mailboxName="Support"
      onReply={() => undefined} onForward={() => undefined} onMove={() => undefined} onMarkRead={() => undefined}
      onFilterLabel={() => undefined} notice={null} nextSteps={null}
      back={over.back === true ? { label: "Inbox", run: () => undefined } : null}
    />
  );
}

const bodyShown = () => waitFor(() => {
  expect(document.querySelector("iframe.message-body, pre.message-text, [data-body=none], .notice.bad")).not.toBeNull();
});

describe("the reading pane in English", () => {
  it("renders a message with every notice, the details, the labels and the menu as before", async () => {
    const { container } = mount(pane(row({ labels_json: JSON.stringify(["urgent"]), parse_error: "bad Date header" }), { back: true }));
    await bodyShown();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Add label/ }));
    await expect(html(container)).toMatchFileSnapshot("./golden/reader.pane.en.html");
  });

  it("renders the menu for mail in Archive and Trash, unread, as before", async () => {
    for (const place of ["archive", "trash"] as const) {
      const { container, unmount } = mount(pane(row({ place, read: 0 })));
      await bodyShown();
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      await expect(html(container.querySelector("[role=menu]")!)).toMatchFileSnapshot(`./golden/reader.menu-${place}.en.html`);
      unmount();
    }
  });

  it("renders a reader who cannot reply, a spoofed sender, one link of one, one withheld resource", async () => {
    body = () => Response.json({
      ...FULL_BODY, state: "text-only", html: null, text: "hello", blockedRemote: 1, truncated: false, attachments: [],
      links: [{ href: "https://evil.example/", text: "home", verdict: "mismatch" }],
    });
    const { container } = mount(pane(row({
      subject: "  ", from_name: null, auth_dmarc: "fail", auth_dmarc_policy: "reject", auth_spf: null, standing_content: 0,
    }), { sendable: false }));
    await bodyShown();
    await expect(html(container)).toMatchFileSnapshot("./golden/reader.withheld.en.html");
  });

  it("says each authentication result as before", async () => {
    const lines: string[] = [];
    const cases_ = [
      { auth_dmarc: null }, { auth_dmarc: "absent" }, { auth_dmarc: "pass" }, { auth_dmarc: "none" },
      { auth_dmarc: "fail", auth_dmarc_policy: null }, { auth_dmarc: "fail", auth_dmarc_policy: "quarantine", auth_from_domain: null },
      { auth_dmarc: "temperror", auth_dkim: null },
    ] satisfies Array<Partial<MessageRow>>;
    for (const over of cases_) {
      const { container, unmount } = mount(pane(row(over)));
      await bodyShown();
      const dd = Array.from(container.querySelectorAll("dt")).find((dt) => dt.textContent === "Authentication")!.nextElementSibling!;
      lines.push(`${JSON.stringify(over)}\n  details: ${dd.innerHTML}\n  alert: ${container.querySelector(".auth-alert")?.innerHTML ?? "-"}`);
      unmount();
    }
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./golden/reader.auth.en.txt");
  });

  it("says why a body is not shown, as before", async () => {
    const lines: string[] = [];
    const answers: Array<[string, () => Response]> = [
      ["unparsed, the Node's words", () => Response.json({ ...FULL_BODY, state: "unparsed", html: null, problem: "The Node's own words." })],
      ["unparsed, no words", () => Response.json({ ...FULL_BODY, state: "unparsed", html: null, problem: null })],
      ["refused", () => new Response("no", { status: 500 })],
      ["two links, one flagged", () => Response.json({ ...FULL_BODY, blockedRemote: 0, truncated: false, attachments: [], links: FULL_BODY.links.slice(3) })],
      ["no body", () => Response.json({ ...FULL_BODY, state: "no-body", html: null, text: null, blockedRemote: 0, truncated: false, attachments: [], links: [] })],
    ];
    for (const [name, answer] of answers) {
      body = answer;
      const { container, unmount } = mount(pane(row()));
      await bodyShown();
      const at = container.querySelector(".reader-actions")!;
      let shown = "";
      for (let next = at.nextElementSibling; next !== null; next = next.nextElementSibling) shown += next.outerHTML;
      lines.push(`${name}: ${shown}`);
      unmount();
    }
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./golden/reader.body.en.txt");
  });

  it("says a body's problem by its code in the Node's own English, byte for byte", async () => {
    // The Node's sentences (`problemSentence` in `src/render/body.ts`), as the API sends them beside the code.
    const said: Record<string, string> = {
      unreadable: "This message's body could not be read (Unexpected end of input). The original is unchanged and can still be downloaded.",
      sanitised_empty: "Nothing in this message's HTML survived sanitising. The original is unchanged and can still be downloaded.",
      unrenderable: "This message's HTML could not be rendered safely (memory limit exceeded). The original is unchanged and can still be downloaded.",
    };
    const causes: Record<string, string | null> = { unreadable: "Unexpected end of input", sanitised_empty: null, unrenderable: "memory limit exceeded" };
    for (const [code, problem] of Object.entries(said)) {
      body = () => Response.json({ ...FULL_BODY, state: "unparsed", html: null, problem, problemCode: code, problemCause: causes[code] });
      const { container, unmount } = mount(pane(row()));
      await bodyShown();
      expect(container.querySelector(".notice.bad")!.innerHTML).toBe(problem);
      unmount();
    }
    // A text-only body with a problem is the plain-text alternative shown instead (H12): the Node's sentence for that
    // case, above the text, which is still shown.
    const instead: Record<string, string> = {
      sanitised_empty: "Nothing in this message's HTML survived sanitising. Its plain-text alternative is shown instead.",
      unrenderable: "This message's HTML could not be rendered safely (memory limit exceeded). Its plain-text alternative is shown instead.",
    };
    for (const [code, problem] of Object.entries(instead)) {
      body = () => Response.json({
        ...FULL_BODY, state: "text-only", html: null, text: "the real words", blockedRemote: 0, truncated: false,
        attachments: [], links: [], problem, problemCode: code, problemCause: causes[code],
      });
      const { container, unmount } = mount(pane(row()));
      await bodyShown();
      expect([...container.querySelectorAll(".notice")].map((notice) => notice.innerHTML)).toEqual([problem]);
      expect(container.querySelector("pre.message-text")?.textContent).toBe("the real words");
      unmount();
    }
  });

  it("renders the headers dialog, truncated, as before", async () => {
    mount(pane(row()));
    await bodyShown();
    fireEvent.click(screen.getByRole("button", { name: /View headers/ }));
    const dialog = await screen.findByRole("dialog", { name: "Headers" });
    await waitFor(() => { expect(dialog.querySelector("pre")).not.toBeNull(); });
    await expect(html(dialog)).toMatchFileSnapshot("./golden/reader.headers.en.html");
  });

  it("says what a label change did when the Node could not be reached, and names the remove button", async () => {
    labels = () => { throw new Error("offline"); };
    const { container } = mount(pane(row({ labels_json: JSON.stringify(["urgent"]) })));
    await bodyShown();
    fireEvent.click(screen.getByRole("button", { name: "Remove label urgent" }));
    await waitFor(() => { expect(container.querySelector(".reader-labels [role=alert]")).not.toBeNull(); });
    await expect(html(container.querySelector(".reader-labels")!)).toMatchFileSnapshot("./golden/reader.labels.en.html");
  });
});

describe("Assign in English", () => {
  async function openAssign(message: MessageRow = row()) {
    mount(pane(message));
    await bodyShown();
    fireEvent.click(screen.getByRole("button", { name: /Assign/ }));
    return screen.findByRole("dialog", { name: "Assign" });
  }

  it("says each state of the case as before", async () => {
    const lines: string[] = [];
    const states: Array<[string, MessageRow, () => Response]> = [
      ["no case", row({ case_id: null }), () => Response.json({ cases: [] })],
      ["closed", row(), () => Response.json({ cases: [] })],
      ["held", row(), () => Response.json({ cases: [{ id: "case_1", state: "claimed", assignee: "usr_x", assignee_email: "x@example.test", claimed_at: AT }] })],
      ["held, unnamed, unrecorded", row(), () => Response.json({ cases: [{ id: "case_1", state: "claimed", assignee: "usr_x", assignee_email: null, claimed_at: null }] })],
      ["open", row(), () => Response.json({ cases: [{ id: "case_1", state: "open", assignee: null, assignee_email: null, claimed_at: null }] })],
    ];
    for (const [name, message, answer] of states) {
      cases = answer;
      const dialog = await openAssign(message);
      await waitFor(() => { expect(dialog.textContent).not.toMatch(/Reading/); });
      lines.push(`${name}: ${html(dialog)}`);
      document.body.innerHTML = "";
    }
    await expect(lines.join("\n")).toMatchFileSnapshot("./golden/reader.assign.en.txt");
  });

  it("hands over with the toast, and says an unreachable Node, as before", async () => {
    cases = () => Response.json({ cases: [{ id: "case_1", state: "open", assignee: null, assignee_email: null, claimed_at: null }] });
    const dialog = await openAssign();
    const field = await within(dialog).findByLabelText("Colleague's sign-in address");
    fireEvent.change(field, { target: { value: "bob@example.test" } });
    await act(async () => { fireEvent.submit(field.closest("form")!); });
    const toast = await screen.findByText(/Handed to bob@example.test/);
    const lines = [`toast: ${toast.outerHTML}`];

    cases = () => Response.json({ cases: [{ id: "case_1", state: "claimed", assignee: "usr_x", assignee_email: "x@example.test", claimed_at: AT }] });
    steal = () => { throw new Error("offline"); };
    document.body.innerHTML = "";
    const again = await openAssign();
    fireEvent.click(await within(again).findByRole("button", { name: "Take it anyway" }));
    lines.push(`unreachable: ${(await within(again).findByRole("alert")).outerHTML}`);
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./golden/reader.handed.en.txt");
  });
});

describe("the conversation in English", () => {
  const message = (n: number, over: Partial<MessageRow> = {}) =>
    row({ id: `rcpt_${n}`, message_id: `msg_${n}`, accepted_at: AT, subject: `message ${n}`, conversation_id: "cnv_1", ...over });
  const send = (over: Record<string, unknown> = {}) => ({
    id: "snd_1", subject: "Re: message 1", envelope_to: '["a@b.test"]', state: "handed_over", state_at: AT,
    release_at: "", attempts: 1, last_error: null, transport_message_id: null, fidelity: "authored", has_submitted: 1,
    state_reason: null, policy_outcome: null, recipients: [], ...over,
  });

  it("counts, names and opens what came before and after, as before", async () => {
    thread = { messages: [message(1), message(2, { subject: null, from_name: null })], sends: [send(), send({ id: "snd_2", has_submitted: 0, state: "withheld" })] };
    const { container } = mount(<Thread conversationId="cnv_1" current="rcpt_1" />);
    await screen.findByRole("region", { name: "Conversation" });
    for (const button of within(container).getAllByRole("button")) {
      if (button.textContent?.includes("a send from this Node")) fireEvent.click(button);
    }
    await expect(html(container)).toMatchFileSnapshot("./golden/reader.thread.en.html");
  });

  it("says one other message in the singular", async () => {
    thread = { messages: [message(1), message(2)], sends: [] };
    mount(<Thread conversationId="cnv_1" current="rcpt_1" />);
    const region = await screen.findByRole("region", { name: "Conversation" });
    expect(region.querySelector("h3")!.textContent).toBe("1 other message in this conversation");
  });
});

describe("a received time, moved to format.ts", () => {
  it("is in English exactly what the reader's own table made, for every day of two years and every hour", () => {
    const now = new Date(2026, 8, 26, 16, 0);
    for (let day = 0; day < 730; day += 1) {
      const at = new Date(2025, 0, 1 + day, day % 24, (day * 7) % 60).toISOString();
      expect(shortTime(at, now), at).toBe(OLD_SHORT(at, now));
      expect(fullTime(at), at).toBe(OLD_FULL(at));
    }
  });

  it("is in Chinese the locale's own forms: 15:09 today, 9月26日 this year, 2025/9/26 before", () => {
    chinese();
    const now = new Date(2026, 8, 26, 16, 0);
    expect(shortTime(new Date(2026, 8, 26, 15, 9).toISOString(), now)).toBe("15:09");
    expect(shortTime(new Date(2026, 8, 26, 9, 5).toISOString(), now)).toBe("09:05");
    expect(shortTime(new Date(2026, 0, 3, 9, 5).toISOString(), now)).toBe("1月3日");
    expect(shortTime(new Date(2025, 8, 26, 9, 5).toISOString(), now)).toBe("2025/9/26");
    expect(monthDay(new Date(2026, 8, 26))).toBe("9月26日");
    expect(fullTime(new Date(2025, 8, 26, 15, 9, 2).toISOString())).toBe("2025/9/26 15:09:02");
  });
});

describe("the reading pane in Chinese", () => {
  it("says the pane's words from the catalog and keeps the Node's own English marked as English", async () => {
    chinese();
    const { container } = mount(pane(row({ parse_error: "bad Date header" }), { back: true }));
    await bodyShown();
    const partly = Array.from(container.querySelectorAll("p.notice")).find((p) => p.textContent!.startsWith("邮件头"))!;
    expect(partly.innerHTML).toBe('邮件头只能部分读取：<span lang="en">bad Date header</span>。原始邮件未改动。');
    expect(container.querySelector(".links-flagged")!.parentElement!.firstElementChild!.textContent)
      .toBe("此邮件的 5 个链接中，有 4 个与它显示的地址不符：");
    expect(screen.getByRole("button", { name: "返回 Inbox" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    expect(screen.getByRole("menuitem", { name: "移到回收站" })).not.toBeNull();
    expect(container.textContent).not.toMatch(/Reply|Forward|Headers|Download/);
  });

  it("says a body's problem in Chinese by its code, with the parser's own words marked, and an unknown code in the Node's", async () => {
    chinese();
    body = () => Response.json({ ...FULL_BODY, state: "unparsed", html: null, problem: "The Node's own words.", problemCode: "unreadable", problemCause: "Unexpected end of input" });
    const first = mount(pane(row()));
    await bodyShown();
    expect(first.container.querySelector(".notice.bad")!.innerHTML)
      .toBe('无法读取此邮件的正文（<span lang="en">Unexpected end of input</span>）。原始邮件未改动，仍可下载。');
    first.unmount();
    body = () => Response.json({ ...FULL_BODY, state: "unparsed", html: null, problem: "The Node's own words.", problemCode: "a_newer_code", problemCause: null });
    const second = mount(pane(row()));
    await bodyShown();
    expect(second.container.querySelector(".notice.bad")!.innerHTML).toBe('<span lang="en">The Node\'s own words.</span>');
    second.unmount();
    // The plain-text alternative shown instead (H12), and a message with no body (§5C), each said in Chinese.
    body = () => Response.json({
      ...FULL_BODY, state: "text-only", html: null, text: "the real words", blockedRemote: 0, truncated: false, attachments: [],
      links: [], problem: "The Node's own words.", problemCode: "unrenderable", problemCause: "memory limit exceeded",
    });
    const third = mount(pane(row()));
    await bodyShown();
    expect([...third.container.querySelectorAll(".notice")].map((notice) => notice.innerHTML))
      .toEqual(['无法安全地呈现此邮件的 HTML（<span lang="en">memory limit exceeded</span>）。改为显示它的纯文本版本。']);
    third.unmount();
    body = () => Response.json({ ...FULL_BODY, state: "no-body", html: null, text: null, blockedRemote: 0, truncated: false, attachments: [], links: [] });
    const fourth = mount(pane(row()));
    await bodyShown();
    expect(fourth.container.querySelector("[data-body=none]")?.textContent).toBe("此邮件没有正文。");
  });

  it("marks the Node's own words as English wherever the pane shows a refusal or a problem it sent", async () => {
    chinese();
    body = () => Response.json({ ...FULL_BODY, state: "unparsed", html: null, problem: "The Node's own words." });
    labels = () => Response.json({ message: "Labels need mailbox.content.read." }, { status: 403 });
    cases = () => Response.json({ cases: [{ id: "case_1", state: "claimed", assignee: "usr_x", assignee_email: "x@example.test", claimed_at: AT }] });
    steal = () => Response.json({ error: "closed", message: "The case was closed." }, { status: 409 });
    const { container } = mount(pane(row({ labels_json: JSON.stringify(["urgent"]) })));
    await bodyShown();
    expect(container.querySelector(".notice.bad")!.innerHTML).toBe('<span lang="en">The Node\'s own words.</span>');

    fireEvent.click(screen.getByRole("button", { name: "移除标签 urgent" }));
    await waitFor(() => { expect(container.querySelector(".reader-labels [role=alert]")).not.toBeNull(); });
    expect(container.querySelector(".reader-labels [role=alert]")!.innerHTML).toBe(' <span lang="en">Labels need mailbox.content.read.</span>');

    fireEvent.click(screen.getByRole("button", { name: /指派/ }));
    const dialog = await screen.findByRole("dialog", { name: "指派" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "仍然接手" }));
    expect((await within(dialog).findByRole("alert")).innerHTML).toBe('<span lang="en">The case was closed.</span>');
  });
});
