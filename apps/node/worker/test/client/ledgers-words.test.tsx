import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { clock, fullTime } from "../../src/client/app/format.ts";
import { answerWith, reset } from "./session-stub.ts";

/**
 * The four ledgers (Outbox, Audit, Log, Doctor) in English, byte for byte, as they were before their words moved
 * into the catalog (ADR 46, `docs/i18n.md`). The golden files were written from the screens as they stood
 * before the migration, with D5 and D8 already applied, so a key whose English differs by a letter, a sentence
 * split into fragments that no longer read as one, or an element lost from inside a sentence, shows as a diff.
 *
 * A time of day is the viewer's zone and locale, so it is replaced by `[clock]` before comparing: what is held
 * is that the cell shows `format.ts`'s clock for that instant, and the rest byte for byte.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/outbox" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Outbox, Audit, Log, Doctor } = await import("../../src/client/app/screens/ledgers.tsx");

const AT = "2026-09-28T04:36:51.379Z";

function mount(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function html(container: HTMLElement): string {
  return container.innerHTML.replaceAll(clock(AT), "[clock]").replaceAll("><", ">\n<") + "\n";
}

const recipient = (kind: string, address: string, delivery_state: string | null, extra: Record<string, unknown> = {}) => ({
  manifest_id: "snd_x", kind, address, submission_state: "handed_over", delivery_state, delivery_reason: null,
  bounce_type: null, last_error: null, ...extra,
});

function send(id: string, extra: Record<string, unknown>) {
  return {
    id, subject: `subject ${id}`, envelope_to: JSON.stringify(["a@example.test"]), state: "handed_over", state_at: AT,
    release_at: AT, attempts: 1, last_error: null, transport_message_id: null, fidelity: "authored", has_submitted: 0,
    state_reason: null, policy_outcome: "allow", retry: { mode: null, why: "" }, recipients: [], ...extra,
  };
}

const SENDS = [
  send("snd_held", { state: "held", state_reason: "policy_hold" }),
  send("snd_gate", { state: "awaiting", state_reason: "butler_release_required", subject: "" }),
  send("snd_over", {
    has_submitted: 1, envelope_to: JSON.stringify(["a@example.test", "b@example.test", "c@example.test", "d@example.test"]),
    recipients: [
      recipient("to", "a@example.test", "accepted"),
      recipient("cc", "b@example.test", "bounced", { bounce_type: "hard", last_error: "550 no such user" }),
      recipient("bcc", "c@example.test", null, { delivery_reason: "verified_destination" }),
      recipient("to", "d@example.test", "accepted"),
    ],
  }),
  send("snd_unknown", { state: "outcome_unknown", retry: { mode: "resend-may-duplicate", why: "" }, last_error: "the transport timed out" }),
  send("snd_refused", { state: "refused", retry: { mode: "retry-effect", why: "" }, fidelity: "reconstructed" }),
  send("snd_withheld", { state: "withheld", state_reason: "approval_expired", recipients: [recipient("to", "a@example.test", "deferred")] }),
];

function answerSends(body: Record<string, unknown>, act: (path: string) => Response | undefined = () => undefined) {
  answerWith((call) => {
    if (call.path === "/api/sends" && call.method === "GET") return Response.json(body);
    return call.method === "POST" ? act(call.path) : undefined;
  });
}

const DAILY = { day: "2026-09-28", handedOver: 7, throttledAtCount: null, firstThrottledAt: null };
const CAN = { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "" };

beforeEach(reset);
afterEach(() => {
  install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
});

describe("the Outbox in English", () => {
  it("renders every row shape, a send opened, the resend question, and the notices as before", async () => {
    answerSends({
      sends: SENDS, truncated: true, daily: DAILY,
      capability: { ...CAN, canSend: false, detail: "This Node has no sending adapter." },
    });
    const { container } = mount(<Outbox />);
    fireEvent.click(await screen.findByRole("button", { name: "subject snd_over" }));
    fireEvent.click(screen.getByRole("button", { name: "Resend…" }));
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.outbox.en.html");
  });

  it("renders the empty Outbox and the rate-limited notice as before", async () => {
    answerSends({ sends: [], truncated: false, daily: { ...DAILY, handedOver: 0, throttledAtCount: 3 }, capability: CAN });
    const { container } = mount(<Outbox />);
    await screen.findByText("The Outbox is empty.");
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.outbox-empty.en.html");
  });

  it("counts one send as one send; the goldens hold 0 and 6 (D10)", async () => {
    answerSends({ sends: SENDS.slice(0, 1), truncated: false, daily: DAILY, capability: CAN });
    mount(<Outbox />);
    expect((await screen.findByText(/^1 send/)).textContent).toBe("1 send");
  });

  it("says why a stop, a release, a gate release or a retry did not happen, in its own words when the Node gave none", async () => {
    answerSends({ sends: SENDS, truncated: false, daily: DAILY, capability: CAN }, (path) => {
      if (path.endsWith("/cancel")) return Response.json({ cancelled: false });
      if (path.endsWith("/release-hold")) return Response.json({ released: false });
      if (path.endsWith("/release")) return Response.json({ released: false });
      if (path.endsWith("/retry")) return new Response("", { status: 503 });
      return undefined;
    });
    mount(<Outbox />);
    const said = async (name: string) => {
      fireEvent.click((await screen.findAllByRole("button", { name }))[0]!);
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
      const text = screen.getByRole("alert").textContent;
      return text;
    };
    expect(await said("Stop")).toBe("It could not be stopped.");
    expect(await said("Let it go")).toBe("It could not be released.");
    expect(await said("Release")).toBe("refused: this send is no longer waiting on a Butler's gate, or you may not send "
      + "as its mailbox. The outbox has been refreshed; if it is still listed, ask for send.propose on that mailbox.");
    expect(await said("Retry")).toBe("This Node answered 503.");
  });

  it("shows the Node's reason as the Node said it", async () => {
    answerSends({ sends: SENDS, truncated: false, daily: DAILY, capability: CAN }, (path) => {
      if (path.endsWith("/cancel")) return Response.json({ cancelled: false, reason: "It already left." });
      if (path.endsWith("/release")) return Response.json({ released: false, reason: "not_found" });
      return undefined;
    });
    mount(<Outbox />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Stop" }))[0]!);
    expect((await screen.findByRole("alert")).textContent).toBe("It already left.");
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/^not_found: this send is no longer/));
  });
});

const AUDIT = [
  { actor_user_id: "usr_ana", actor_kind: "user", delegator_user_id: null, subject: "rcpt_1", outcome: "ok" },
  { actor_user_id: "agt_bot", actor_kind: "agent", delegator_user_id: "usr_ana", subject: null, outcome: "refused" },
  { actor_user_id: null, actor_kind: "node", delegator_user_id: null, subject: "snd_1", outcome: "failed" },
].map((entry, index) => ({
  id: `aud_${index}`, seq: index + 1, at: AT, action: "send.sealed", detail: "{}", hash: "0".repeat(64), ...entry,
}));

describe("the Audit trail in English", () => {
  it("renders its entries and a verified chain as before", async () => {
    answerWith((call) => {
      if (call.path === "/api/audit") return Response.json({ entries: AUDIT, truncated: true });
      if (call.path === "/api/audit/verify") return Response.json({ intact: true, checked: 3 });
      return undefined;
    });
    const { container } = mount(<Audit />);
    fireEvent.click(await screen.findByRole("button", { name: "Verify chain" }));
    await screen.findByText("3 entries checked, chain intact.");
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.audit.en.html");
  });

  it("says where a chain broke, and renders an empty trail as before", async () => {
    answerWith((call) => {
      if (call.path === "/api/audit") return Response.json({ entries: [], truncated: false });
      if (call.path === "/api/audit/verify") return Response.json({ intact: false, checked: 12, brokenAt: 9 });
      return undefined;
    });
    const { container } = mount(<Audit />);
    fireEvent.click(await screen.findByRole("button", { name: "Verify chain" }));
    await screen.findByText("Chain broken at entry 9. 12 entries checked.");
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.audit-empty.en.html");
  });
});

const LOGS = [
  { id: "log_1", at: AT, level: "error", event: "send.failed", message: "The transport timed out.", detail: null, request_id: null },
  { id: "log_2", at: AT, level: "warn", event: "breaker.opened", message: "Too many bounces.", detail: null, request_id: null },
  { id: "log_3", at: AT, level: "trace", event: "future.level", message: "A level this interface has no words for.", detail: null, request_id: null },
];

describe("the Log in English", () => {
  it("renders its counts and entries as before", async () => {
    answerWith((call) => (call.path === "/api/logs"
      ? Response.json({ entries: LOGS, truncated: true, counts: [{ level: "error", n: 1 }, { level: "warn", n: 1 }, { level: "trace", n: 1 }] })
      : undefined));
    const { container } = mount(<Log />);
    await screen.findByText("Too many bounces.");
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.log.en.html");
  });

  it("renders an empty log as before", async () => {
    answerWith((call) => (call.path === "/api/logs" ? Response.json({ entries: [], truncated: false, counts: [] }) : undefined));
    const { container } = mount(<Log />);
    await screen.findByText("Nothing has been logged. This Node trims its log by design.");
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.log-empty.en.html");
  });
});

const FINDINGS = [
  { check: "d1_reachable", severity: "refuse", ok: true, detail: "D1 answered." },
  { check: "transport_adapters", severity: "refuse", ok: false, detail: "No adapter can send.", fix: "Supply credentials below." },
  { check: "queue_backlog", severity: "degraded", ok: false, detail: "12 messages waiting." },
  { check: "domain_verified", severity: "report", ok: false, detail: "Nothing is verified yet." },
];

function answerDoctor(claimed: boolean, available: Record<string, unknown>) {
  answerWith((call) => {
    if (call.path === "/api/doctor") return Response.json({ verdict: "refuse", claimed, at: AT, findings: FINDINGS });
    if (call.path === "/api/transport") {
      return Response.json({ transport: { adapter: "cloudflare-rest", capability: CAN, available } });
    }
    return undefined;
  });
}

describe("the Doctor in English", () => {
  it("renders a claimed report with every state and a fix, and REST credentials, as before", async () => {
    answerDoctor(true, { binding: false, rest: { accountId: "acc_123" } });
    const { container } = mount(<Doctor />);
    await screen.findByText(/over the REST API for account acc_123/);
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.doctor.en.html");
  });

  it("says what the binding and its absence mean, and an unclaimed Node, as before", async () => {
    answerDoctor(false, { binding: true, rest: null });
    mount(<Doctor />);
    expect((await screen.findByText(/The EMAIL binding is present/)).textContent).toBe("Sends go through cloudflare-rest. "
      + "The EMAIL binding is present and is preferred: it holds no credential, and it is the only adapter that can submit the exact bytes an authored send records.");
    expect(document.querySelector(".notice.dim.mono")!.textContent).toBe(`unclaimed · read ${clock(AT)}`);
  });

  it("says a Node with neither adapter cannot send", async () => {
    answerDoctor(true, { binding: false, rest: null });
    mount(<Doctor />);
    expect((await screen.findByText(/There is no EMAIL binding and no API token/)).textContent)
      .toBe("Sends go through cloudflare-rest. There is no EMAIL binding and no API token, so this Node cannot send at all.");
  });
});

describe("the Doctor's remedies in English", () => {
  it("renders a minted sheet, the armed collector, the assessment fields, the failed index and a verdict as before", async () => {
    const failing = (check: string) => ({ check, severity: "degraded", ok: false, detail: `${check} detail` });
    answerWith((call) => {
      if (call.path === "/api/doctor") {
        return Response.json({ verdict: "degraded", claimed: true, at: AT, findings: [
          failing("recovery_escrow"), { ...failing("evidence_present"), ok: true }, failing("evidence_orphans"),
          failing("recovery_key_conflicts"), failing("body_index_failed"),
        ] });
      }
      if (call.path === "/api/transport") return Response.json({ transport: { adapter: "cloudflare", capability: CAN, available: { binding: true, rest: null } } });
      if (call.path === "/api/search/failed") {
        return Response.json({ failed: [
          { messageId: "msg_a", state: "retryable", attempts: 2, error: "R2 timed out" },
          { messageId: "msg_b", state: "unindexable", attempts: 5, error: null },
        ] });
      }
      if (call.path === "/api/recovery-codes/rotate") {
        return Response.json({ codes: ["aaaa-bbbb-cccc", "dddd-eeee-ffff"], escrowed: { content: 2, credential: 3 }, set: "rcs_1", notice: "Store them, then confirm one." });
      }
      if (call.path.startsWith("/api/evidence/verify")) {
        return Response.json({ checked: 50, table: "receipts", intact: false, resumeAfter: "rcpt_50", bytesRead: 1024, faults: [
          { rowId: "rcpt_7", table: "receipts", column: "blob_key", blobKey: "k", kind: "missing", detail: "no object" },
          { rowId: "rcpt_9", table: "receipts", column: "blob_key", blobKey: "k", kind: "altered", detail: "hash differs" },
        ] });
      }
      return undefined;
    });
    const { container } = mount(<Doctor />);
    fireEvent.click(await screen.findByRole("button", { name: "Mint a new set" }));
    fireEvent.click(await screen.findByRole("button", { name: "Collect them…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Verify a batch" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Repair msg_a" }));
    await screen.findByRole("list", { name: "Recovery codes" });
    await screen.findByText(/More remains\./);
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.doctor-remedies.en.html");
  });

  it("says a batch in no table that was the last, intact, and an empty failed list, as before", async () => {
    answerWith((call) => {
      if (call.path === "/api/doctor") {
        return Response.json({ verdict: "ok", claimed: true, at: AT, findings: [
          { check: "evidence_present", severity: "report", ok: true, detail: "d" },
          { check: "body_index_failed", severity: "report", ok: false, detail: "d" },
        ] });
      }
      if (call.path === "/api/transport") return Response.json({ transport: { adapter: "cloudflare", capability: CAN, available: { binding: true, rest: null } } });
      if (call.path === "/api/search/failed") return Response.json({ failed: [] });
      if (call.path.startsWith("/api/evidence/verify")) {
        return Response.json({ checked: 0, table: null, intact: true, resumeAfter: null, bytesRead: 0, faults: [] });
      }
      return undefined;
    });
    mount(<Doctor />);
    expect((await screen.findByText("The failed list is empty now.")).textContent).toBe("The failed list is empty now.");
    fireEvent.click(await screen.findByRole("button", { name: "Verify a batch" }));
    expect((await screen.findByRole("status")).textContent).toBe("0 objects checked, 0 bytes read: intact. That was the last batch.");
  });
});

/** The ledgers read in Chinese: the catalog's words, and the Node's own English marked as English. */
describe("the ledgers in zh-Hans", () => {
  const zh = () => install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });

  it("says the Outbox in Chinese and marks the Node's words as English", async () => {
    zh();
    answerSends({ sends: SENDS, truncated: true, daily: { ...DAILY, throttledAtCount: 5 }, capability: { ...CAN, canSend: false, detail: "No adapter." } });
    const { container } = mount(<Outbox />);
    fireEvent.click(await screen.findByRole("button", { name: "subject snd_over" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("发件箱");
    expect(container.querySelector("section")!.getAttribute("aria-label")).toBe("发件箱");
    expect(screen.getByText("No adapter.").closest("[lang]")?.getAttribute("lang")).toBe("en");
    expect(screen.getByText("今天已移交 7 封。本节点第一次被限流是在第 5 封。")).toBeTruthy();
    const detail = container.querySelector("#detail-snd_over")!;
    expect([...detail.querySelectorAll(".recipient .label")].map((one) => one.textContent)).toEqual(["收件人", "收件人", "抄送", "密送"]);
    expect([...container.querySelectorAll(".delivery-chip")].map((one) => one.textContent)).toContain("已受理 2");
    expect(detail.querySelector(".delivery-bounced")!.getAttribute("title")).toMatch(/（hard）$/);
    // A Butler's send offers 放行, as a rule-held one does; neither is 放回队列, which is a case given back.
    expect(screen.getAllByRole("button", { name: "放行" })).toHaveLength(2);
    await expect(html(container)).toMatchFileSnapshot("./golden/ledgers.outbox.zh-Hans.html");
  });

  it("names a log level it knows and shows one it does not as the Node sent it", async () => {
    zh();
    answerWith((call) => (call.path === "/api/logs"
      ? Response.json({ entries: LOGS, truncated: false, counts: [{ level: "error", n: 1 }, { level: "warn", n: 2 }, { level: "trace", n: 1 }] })
      : undefined));
    const { container } = mount(<Log />);
    expect((await screen.findByText("Too many bounces.")).closest("[lang]")?.getAttribute("lang")).toBe("en");
    expect(container.querySelector(".ledger-head p")!.textContent).toBe("错误 1 · 警告 2 · trace 1");
    expect([...container.querySelectorAll("tbody .state")].map((one) => one.textContent)).toEqual(["错误", "警告", "trace"]);
  });

  it("says who acted for whom in Chinese", async () => {
    zh();
    answerWith((call) => (call.path === "/api/audit" ? Response.json({ entries: AUDIT, truncated: false }) : undefined));
    mount(<Audit />);
    expect((await screen.findByText("agt_bot（代表 usr_ana）")).textContent).toBe("agt_bot（代表 usr_ana）");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("审计");
  });

  it("says the Doctor's states and remedies in Chinese, with each finding's detail and fix in the Node's English", async () => {
    zh();
    answerDoctor(true, { binding: false, rest: { accountId: "acc_123" } });
    const { container } = mount(<Doctor />);
    const detail = await screen.findByText("No adapter can send.");
    expect(detail.closest("[lang]")?.getAttribute("lang")).toBe("en");
    expect(screen.getByText("Supply credentials below.").closest("[lang]")?.getAttribute("lang")).toBe("en");
    expect(screen.getByText("Supply credentials below.").closest(".dim")!.textContent).toBe("修复：Supply credentials below.");
    expect(container.querySelector(".ledger-head .state")!.textContent).toBe("未通过");
    expect([...container.querySelectorAll("tbody .state")].map((one) => one.textContent)).toEqual(["ok", "未通过", "降级", "提示"]
      .map((word) => (word === "ok" ? CATALOGS["zh-Hans"].app["health.status.ok"] : word)));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("诊断");
  });

  it("joins a batch's two sentences as Chinese joins them, and marks each fault's words as the Node's", async () => {
    zh();
    answerWith((call) => {
      if (call.path === "/api/doctor") {
        return Response.json({ verdict: "ok", claimed: true, at: AT, findings: [{ check: "evidence_present", severity: "report", ok: true, detail: "d" }] });
      }
      if (call.path === "/api/transport") return Response.json({ transport: { adapter: "cloudflare", capability: CAN, available: { binding: true, rest: null } } });
      if (call.path.startsWith("/api/evidence/verify")) {
        return Response.json({ checked: 50, table: "receipts", intact: false, resumeAfter: "rcpt_50", bytesRead: 1024, faults: [
          { rowId: "rcpt_7", table: "receipts", column: "blob_key", blobKey: "k", kind: "missing", detail: "no object" },
        ] });
      }
      return undefined;
    });
    mount(<Doctor />);
    fireEvent.click(await screen.findByRole("button", { name: "校验一批" }));
    const status = await screen.findByRole("status");
    expect(status.firstChild!.textContent).toBe("已检查 receipts 中的 50 个对象，读取 1024 字节：1 处问题。还有剩余。");
    expect(status.querySelector("span")!.textContent).toBe("缺失 receipts.blob_key rcpt_7：no object");
    expect(screen.getByText("no object").getAttribute("lang")).toBe("en");
  });
});

/** The sentences the goldens above do not reach, each pinned whole, in English as it was. */
describe("the rest of the ledgers' English", () => {
  it("names an info line", async () => {
    answerWith((call) => (call.path === "/api/logs"
      ? Response.json({ entries: [{ ...LOGS[0]!, level: "info" }], truncated: false, counts: [{ level: "info", n: 1 }] })
      : undefined));
    const { container } = mount(<Log />);
    await screen.findByText("The transport timed out.");
    expect(container.querySelector(".ledger-head p")!.textContent).toBe("1 info");
    expect(container.querySelector("tbody .state")!.textContent).toBe("info");
  });

  it("says what minting does, what an assessment recorded, and every batch verdict", async () => {
    let batch = 0;
    answerWith((call) => {
      if (call.path === "/api/doctor") {
        return Response.json({ verdict: "ok", claimed: true, at: AT, findings: [
          { check: "recovery_escrow", severity: "degraded", ok: false, detail: "d" },
          { check: "recovery_key_conflicts", severity: "degraded", ok: false, detail: "d" },
          { check: "evidence_present", severity: "report", ok: true, detail: "d" },
        ] });
      }
      if (call.path === "/api/transport") return Response.json({ transport: { adapter: "cloudflare", capability: CAN, available: { binding: true, rest: null } } });
      if (call.path.startsWith("/api/recovery/conflicts/")) {
        return Response.json({ acknowledged: { restoreId: "rst_9", generations: "3,4", acknowledgedAt: "2026-09-28T04:36:51.379Z" } });
      }
      if (call.path.startsWith("/api/evidence/verify")) {
        batch += 1;
        return Response.json(batch === 1
          ? { checked: 1, table: null, intact: false, resumeAfter: "x", bytesRead: 9, faults: [
            { rowId: "r_1", table: "drafts", column: "body_key", blobKey: "k", kind: "unreadable", detail: "cannot open" },
          ] }
          : { checked: 1, table: "drafts", intact: true, resumeAfter: null, bytesRead: 7, faults: [] });
      }
      return undefined;
    });
    mount(<Doctor />);
    expect((await screen.findByText(/^Ten codes/)).textContent).toBe("Ten codes, shown once. Confirming one retires any previous sheet.");
    fireEvent.change(screen.getByLabelText("Restore id"), { target: { value: "rst_9" } });
    fireEvent.click(screen.getByRole("button", { name: "Record the assessment" }));
    expect((await screen.findByText(/^Recorded against/)).textContent)
      .toBe(`Recorded against rst_9 (generations 3,4) at ${fullTime("2026-09-28T04:36:51.379Z")}. The collision is not repaired; the alarm is discharged.`);
    fireEvent.click(screen.getByRole("button", { name: "Verify a batch" }));
    // One object and one fault, in a batch with no table and in one with a table; the goldens hold the many (D12).
    const first = await screen.findByText(/^1 object checked,/);
    expect(first.textContent).toBe("1 object checked, 9 bytes read: 1 fault. More remains.unreadable drafts.body_key r_1: cannot open");
    fireEvent.click(screen.getByRole("button", { name: "Continue from where it stopped" }));
    expect((await screen.findByText(/^1 object checked in/)).textContent).toBe("1 object checked in drafts, 7 bytes read: intact. That was the last batch.");
  });
});

describe("a remedy's answer in zh-Hans", () => {
  it("marks the Node's refusal and the Node's sentence after a count as English, and says the count in Chinese", async () => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
    answerWith((call) => {
      if (call.path === "/api/doctor") {
        return Response.json({ verdict: "degraded", claimed: true, at: AT, findings: [
          { check: "migrations_applied", severity: "refuse", ok: false, detail: "d" },
          { check: "preview_backlog", severity: "degraded", ok: false, detail: "d" },
        ] });
      }
      if (call.path === "/api/transport") return Response.json({ transport: { adapter: "cloudflare", capability: CAN, available: { binding: true, rest: null } } });
      if (call.path === "/api/prepare") return Response.json({ error: "E_BUSY", message: "Another migration is running." }, { status: 409 });
      if (call.path === "/api/maintenance/requeue-previews") return Response.json({ requeued: 2, message: "Queued for the preview backfill." });
      return undefined;
    });
    mount(<Doctor />);
    fireEvent.click(await screen.findByRole("button", { name: "应用迁移" }));
    expect((await screen.findByText("Another migration is running.")).getAttribute("lang")).toBe("en");
    fireEvent.click(screen.getByRole("button", { name: "重新排队失败的预览" }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("已重新排队 2 项。Queued for the preview backfill.");
    expect(screen.getByText("Queued for the preview backfill.").getAttribute("lang")).toBe("en");
  });
});
