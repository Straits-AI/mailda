import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "/app/locale.js";
import { fullTime } from "../../src/client/app/format.ts";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { answerWith, reset } from "./session-stub.ts";

/**
 * The Queue's words (ADR 46), English character for character and Chinese where it must differ.
 *
 * The English half was written against the screen before its words moved to the catalog and passed there, so a
 * clock that lost its "just now", a reason sentence that lost its domain, or a count that lost its noun fails here.
 * The durations are the part with logic: the old screen decided "just now" by comparing its own English
 * ("under a minute"), which a translation would have silently broken.
 */

const route = vi.hoisted(() => ({ pathname: "/queue" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Queue } = await import("../../src/client/app/screens/queue.tsx");

const MINUTE = 60_000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();

function row(id: string, fields: Record<string, unknown>) {
  return {
    id, conversation_id: `cnv_${id}`, mailbox_id: "mbx_test", state: "open", state_at: at(-10 * MINUTE), assignee: null,
    assignee_email: null, claimed_at: null, subject: `Case ${id}`, from_addr: "a@b.test", message_count: 1,
    response_due_at: null, first_response_at: null, response_breached_at: null, latest_at: at(-10 * MINUTE),
    content_restricted: false, ...fields,
  };
}

function held(id: string, reason: string, fields: Record<string, unknown> = {}) {
  return {
    messageId: id, receiptId: `rcp_${id}`, mailboxId: "mbx_test", mailboxAddress: "support@example.test", subject: `Held ${id}`,
    fromAddr: "x@evil.test", fromDomain: "evil.test", dmarcPolicy: null, acceptedAt: "2026-09-30T08:00:00.000Z",
    quarantinedAt: "2026-09-30T08:01:30.000Z", reason, note: null, ...fields,
  };
}

/** The Node: GETs answered from the fixtures; every other call refused, unless `acted` answers it. */
function node(acted: (path: string) => Response | undefined = () => undefined, target = 30) {
  const mailbox = {
    id: "mbx_test", name: "Support", unclaimed: 1, claimed: 0, mine: 1, first_response_minutes: target,
    quarantine_dmarc_fail: 1, quarantine_dangerous_attachments: 0, quarantined: 7, breached: 2,
    addresses: "support@example.test", attachment_max_bytes: null, attachment_allowed_types: null,
  };
  const cases = [
    row("1", { message_count: 3 }),
    row("2", { assignee: "usr_me", claimed_at: at(-5.5 * MINUTE), response_due_at: at(125.5 * MINUTE) }),
    row("3", {
      assignee: "usr_wang", assignee_email: "wang@example.test", claimed_at: at(-0.5 * MINUTE),
      response_due_at: "2026-09-26T09:00:00.000Z", response_breached_at: "2026-09-26T09:01:00.000Z",
    }),
    row("4", { assignee: "usr_gone", claimed_at: at(-(3 * 24 * 60 + 4 * 60 + 1) * MINUTE), response_due_at: at(-(3 * 24 * 60 + 4 * 60) * MINUTE - 1000), response_breached_at: at(-MINUTE) }),
    row("5", { response_due_at: at(-20_000), response_breached_at: at(-10_000) }),
    row("6", { response_due_at: at(-5_000) }),
    row("7", { response_due_at: at(-MINUTE), first_response_at: at(-2 * MINUTE) }),
    row("8", { content_restricted: true, subject: null, from_addr: null }),
    row("9", { subject: null, response_due_at: at(30_000) }),
  ];
  const quarantined = [
    held("m1", "held", { note: "looks like phishing" }),
    held("m2", "held"),
    held("m3", "attachment_too_large"),
    held("m4", "attachment_type_refused"),
    held("m5", "attachment_dangerous"),
    held("m6", "dmarc_fail_reject"),
    held("m7", "dmarc_fail_quarantine", { fromDomain: null }),
  ];
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (call.method !== "GET") {
      return acted(url.pathname) ?? Response.json({ error: "E_REFUSED_FOR_TEST", message: "Refused, for the test." }, { status: 409 });
    }
    const bodies: Record<string, unknown> = {
      "/api/mailboxes": { mailboxes: [mailbox, { ...mailbox, id: "mbx_other", name: "Sales", unclaimed: 12 }] },
      "/api/mailboxes/mbx_test/cases": { cases },
      "/api/me": { signedIn: true, principalId: "usr_me", principalKind: "user", userId: "usr_me", delegatorUserId: null, organizationId: "org_x", email: "me@example.test" },
      "/api/quarantine": { quarantined, truncated: true },
    };
    const body = bodies[url.pathname];
    return body === undefined ? undefined : Response.json(body);
  });
}

async function mounted(
  acted?: (path: string) => Response | undefined, target?: number,
): Promise<{ cases: HTMLTableElement; held: HTMLTableElement }> {
  node(acted, target);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Queue /></QueryClientProvider>);
  const held = await screen.findByRole<HTMLTableElement>("table", { name: /Held back|已隔离/ });
  await waitFor(() => { expect(document.querySelectorAll(".queue-table").length).toBe(2); });
  return { cases: document.querySelectorAll<HTMLTableElement>(".queue-table")[1]!, held };
}

const cells = (table: HTMLTableElement): string[][] =>
  Array.from(table.rows).map((tr) => Array.from(tr.cells).map((cell) => cell.textContent ?? ""));

beforeEach(reset);

describe("the Queue in English, unchanged by the catalog", () => {
  it("words each case's state, holder and clock as before", async () => {
    const { cases } = await mounted();
    expect(cells(cases)).toEqual([
      ["State", "Subject", "From", "Held by", "Response", "Action"],
      ["unclaimed", "Case 1 · 3 messages", "a@b.test", "—", "—", "Claim"],
      ["mine", "Case 2", "a@b.test", "you · 5m", "in 2h 5m", "ReleaseCloseHand to…"],
      ["held", "Case 3", "a@b.test", "wang@example.test · just now", expect.stringMatching(/^overdue \d+d \d+h$/), "Take"],
      ["held", "Case 4", "a@b.test", "usr_gone · 3d 4h", "overdue 3d 4h", "Take"],
      ["unclaimed", "Case 5", "a@b.test", "—", "overdue just now", "Claim"],
      ["unclaimed", "Case 6", "a@b.test", "—", "due now", "Claim"],
      ["unclaimed", "Case 7", "a@b.test", "—", "answered", "Claim"],
      ["unclaimed", "restricted", "restricted", "—", "—", "Claim"],
      ["unclaimed", "(no subject)", "a@b.test", "—", "in under a minute", "Claim"],
    ]);
    // Local time, as every other time on the screen, never the wire's UTC instant.
    expect(cases.rows[3]!.cells[4]!.querySelector("span")!.title).toBe(`Target passed at ${fullTime("2026-09-26T09:00:00.000Z")}`);
    expect(within(cases).getAllByText("restricted").map((one) => one.title)).toEqual([
      "You hold send.propose on this mailbox but neither read relation, so the subject is withheld. An administrator grants mailbox.metadata.read.",
      "You hold send.propose on this mailbox but neither read relation, so the sender is withheld. An administrator grants mailbox.metadata.read.",
    ]);
    expect(within(cases).getAllByRole("checkbox").map((box) => box.getAttribute("aria-label"))).toEqual([
      "Pick Case 1 for merging", "Pick Case 2 for merging", "Pick Case 3 for merging", "Pick Case 4 for merging",
      "Pick Case 5 for merging", "Pick Case 6 for merging", "Pick Case 7 for merging", "Pick this case for merging",
      "Pick this case for merging",
    ]);
  });

  it("says why each delivery is held, one sentence per reason", async () => {
    const { held } = await mounted();
    expect(cells(held).map((one) => one.slice(0, 4).concat(one[4]!))).toEqual([
      ["Held", "Subject", "From", "Why", "Action"],
      [fullTime("2026-09-30T08:01:30.000Z"), "Held m1", "x@evil.test", "Held on request: looks like phishing", "Release"],
      [fullTime("2026-09-30T08:01:30.000Z"), "Held m2", "x@evil.test", "Held on request: no reason given", "Release"],
      [fullTime("2026-09-30T08:01:30.000Z"), "Held m3", "x@evil.test", "Carries an attachment over this mailbox's size limit.", "Release"],
      [fullTime("2026-09-30T08:01:30.000Z"), "Held m4", "x@evil.test", "Carries an attachment of a type this mailbox does not accept.", "Release"],
      [fullTime("2026-09-30T08:01:30.000Z"), "Held m5", "x@evil.test", "Carries an executable, a script, a program under a document's name, or an archive listing one.", "Release"],
      [fullTime("2026-09-30T08:01:30.000Z"), "Held m6", "x@evil.test", "evil.test says this is not theirs and asks receivers to reject it.", "Release"],
      [fullTime("2026-09-30T08:01:30.000Z"), "Held m7", "x@evil.test", "The From domain says this is not theirs and asks receivers to quarantine it.", "Release"],
    ]);
    // The local time a reader sees everywhere else, with the instant kept for the machine.
    expect(held.querySelector("time")!.getAttribute("datetime")).toBe("2026-09-30T08:01:30.000Z");
  });

  it("keeps the mailbox's target, counts, switches and limits", async () => {
    await mounted();
    expect(screen.getByRole("option", { name: "Support (1 unclaimed)" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Sales (12 unclaimed)" })).toBeDefined();
    expect(document.querySelector(".queue-target")!.textContent).toBe("First response promised within 30 minutes. Minutes");
    // The overdue count stays on the line the settings fold under (design audit, 7 October 2026).
    expect(document.querySelector(".queue-settings > summary")!.textContent).toBe("Mailbox settings2 overdue7 held");
    expect(screen.getByRole("spinbutton", { name: "First response target in minutes; empty promises nothing" })).toBeDefined();
    expect(document.querySelector(".queue-switches")!.textContent).toBe(
      "Hold back a delivery its sender's domain disowns (DMARC fail, p=reject or p=quarantine)."
      + "Hold back a delivery carrying an executable, a script, or a program under a document's name."
      + "Largest attachment, in KBAllowed attachment types",
    );
    expect(screen.getByRole("checkbox", { name: "Hold back deliveries whose sender's domain disowns them" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Hold back deliveries carrying a dangerous attachment" })).toBeDefined();
    expect(screen.getByPlaceholderText("no limit")).toBeDefined();
    expect(screen.getByPlaceholderText("any — or pdf, docx, png")).toBeDefined();
    expect(screen.getByText("Showing the newest 7 held deliveries across this Node. Older ones exist and are not listed.")).toBeDefined();
  });

  it("offers a merge for two picked cases, and shows the Node's refusal as it came", async () => {
    await mounted();
    const boxes = screen.getAllByRole("checkbox", { name: /^Pick / });
    await act(async () => { boxes[0]!.click(); boxes[1]!.click(); });
    expect(document.querySelector("p.notice:not(.dim)")!.textContent).toBe(
      "Two cases picked. Merge them — most merges are refused, and the refusal names the pair to resolve first. Clear",
    );
    await act(async () => { screen.getAllByRole("button", { name: "Claim" })[0]!.click(); });
    const alert = await screen.findByRole("alert");
    expect(alert.innerHTML).toBe("Refused, for the test.");
  });
});

describe("the Queue's counts in English, one and many (D11)", () => {
  it("says one minute and one message in the singular", async () => {
    await mounted((path) => (path === "/api/conversations/merge" ? Response.json({ merged: true, messagesMoved: 1 }) : undefined), 1);
    expect(document.querySelector(".queue-target")!.textContent).toBe("First response promised within 1 minute. Minutes");
    const boxes = screen.getAllByRole("checkbox", { name: /^Pick / });
    await act(async () => { boxes[0]!.click(); boxes[1]!.click(); });
    await act(async () => { screen.getByRole("button", { name: "Merge them" }).click(); });
    await waitFor(() => { expect(screen.getByRole("status").textContent).toBe("Merged. 1 message moved."); });
  });
});

describe("the Queue's confirmations in English, unchanged by the catalog", () => {
  it("says what each act did", async () => {
    const { held } = await mounted((path) => path === "/api/conversations/merge" ? Response.json({ merged: true, messagesMoved: 3 })
      : path === "/api/cases/2/assignee" ? Response.json({ case: {} })
        : Response.json({ ok: true }));
    // Each act replaces the one notice, so the wait is for this act's words, not for any notice.
    const said = async (act_: () => void, words: string): Promise<void> => {
      await act(async () => { act_(); });
      await waitFor(() => { expect(screen.getByRole("status").textContent).toBe(words); });
    };
    const minutes = screen.getByRole("spinbutton", { name: "First response target in minutes; empty promises nothing" });
    await said(() => { fireEvent.change(minutes, { target: { value: "45" } }); fireEvent.blur(minutes); }, "First response promised within 45 minutes. Clocks start on the next message.");
    await said(() => { fireEvent.change(minutes, { target: { value: "1" } }); fireEvent.blur(minutes); }, "First response promised within 1 minute. Clocks start on the next message.");
    await said(() => { fireEvent.change(minutes, { target: { value: "" } }); fireEvent.blur(minutes); }, "This mailbox now promises nothing, so its cases carry no clock.");
    await said(() => screen.getByRole("checkbox", { name: "Hold back deliveries carrying a dangerous attachment" }).click(), "From now on, a delivery carrying an executable, a script, or a program under a document's name is held back here for an administrator.");
    await said(() => screen.getByRole("checkbox", { name: "Hold back deliveries whose sender's domain disowns them" }).click(), "That is off. Deliveries already held stay held until released.");
    const size = screen.getByPlaceholderText("no limit");
    await said(() => { fireEvent.change(size, { target: { value: "100" } }); fireEvent.blur(size); }, "Attachment limits saved. They apply to the next message in and the next send out.");
    await said(() => within(held).getAllByRole("button", { name: "Release" })[0]!.click(), "Released. It is in the queue now, with the case it would have had.");
    const boxes = screen.getAllByRole("checkbox", { name: /^Pick / });
    await act(async () => { boxes[0]!.click(); boxes[1]!.click(); });
    await said(() => screen.getByRole("button", { name: "Merge them" }).click(), "Merged. 3 messages moved.");
    await act(async () => { screen.getByRole("button", { name: "Hand to…" }).click(); });
    fireEvent.change(screen.getByRole("textbox", { name: "Colleague's sign-in address" }), { target: { value: "wang@example.test" } });
    await said(() => screen.getByRole("button", { name: "Hand over" }).click(), "Handed to wang@example.test. It is in their queue now, and the trail names you both.");
  });
});

describe("the Queue in Chinese", () => {
  beforeAll(() => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
  });
  afterAll(() => {
    install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
  });

  it("counts in its own units, and says just now and under a minute as sentences of their own", async () => {
    const { cases } = await mounted();
    const rows = cells(cases);
    expect(rows[2]!.slice(3, 5)).toEqual(["你 · 5 分钟", "2 小时 5 分钟后到期"]);
    expect(rows[3]![3]).toBe("wang@example.test · 刚刚");
    expect(rows[4]!.slice(3, 5)).toEqual(["usr_gone · 3 天 4 小时", "已逾期 3 天 4 小时"]);
    expect(rows.slice(5).map((one) => one[4])).toEqual(["刚刚逾期", "现在到期", "已回复", "—", "不到 1 分钟后到期"]);
    expect(rows.slice(1).map((one) => one[0])).toEqual(["未认领", "由你处理", "他人处理中", "他人处理中", "未认领", "未认领", "未认领", "未认领", "未认领"]);
    // A time in a Chinese sentence is the reader's local time in Chinese form, not the wire's ISO instant.
    const passed = cases.rows[3]!.cells[4]!.querySelector("span")!.title;
    expect(passed).toContain(fullTime("2026-09-26T09:00:00.000Z"));
    expect(passed).not.toContain("2026-09-26T");
  });

  it("keeps a case's Release and a delivery's Release apart", async () => {
    const { cases, held } = await mounted();
    expect(within(cases).getByRole("button", { name: "放回队列" })).toBeDefined();
    expect(within(held).getAllByRole("button", { name: "放行" })).toHaveLength(7);
    expect(cells(held).slice(6).map((one) => one[3])).toEqual([
      "evil.test 声明这封邮件不属于它，并要求收件方拒收。",
      "发件人域名声明这封邮件不属于它，并要求收件方隔离。",
    ]);
  });

  it("marks the Node's refusal as English", async () => {
    await mounted();
    await act(async () => { screen.getAllByRole("button", { name: "认领" })[0]!.click(); });
    const alert = await screen.findByRole("alert");
    expect(alert.innerHTML).toBe('<span lang="en">Refused, for the test.</span>');
  });
});
