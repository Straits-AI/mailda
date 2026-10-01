import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { install, t } from "/app/locale.js";
import type { MessageRow } from "../../src/client/app/api.ts";
import type { Step } from "../../src/client/app/onboarding.tsx";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { answerWith, reset } from "./session-stub.ts";

/**
 * Matters, Sending limits, the first-run gate, Next steps and the small shared pieces (`ui/menu.tsx`,
 * `ui/popover.tsx`, `ui/section-tabs.tsx`) in English, byte for byte. The golden files were written from the
 * screens as they stood on 1 October 2026, before their words moved into the catalog (layer 2b, ADR 46,
 * `docs/i18n.md`), then regenerated once for the English fixed on purpose (D3: one verb, pause, and the
 * administrators counted as the server counts them; D9: no matter called an investigation; "1 byte"), so a key
 * whose English differs by a letter is an accidental diff here.
 *
 * A time is the viewer's zone and locale, so each fixture instant's `toLocaleString()` is replaced by
 * `[clock]` before comparing, and React's generated ids by `[id]`.
 */

const route = vi.hoisted(() => ({ pathname: "/matters" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Matters } = await import("../../src/client/app/screens/matters.tsx");
const { Limits } = await import("../../src/client/app/screens/limits.tsx");
const { FirstRun, Gate } = await import("../../src/client/app/screens/first-run.tsx");
const { NextSteps, deterministicNextSteps } = await import("../../src/client/app/screens/next-steps.tsx");
const { Menu } = await import("../../src/client/app/ui/menu.tsx");
const { Popover } = await import("../../src/client/app/ui/popover.tsx");
const { SectionTabs } = await import("../../src/client/app/ui/section-tabs.tsx");

const AT = ["2026-09-28T04:36:51.379Z", "2026-09-29T10:00:00.000Z", "2026-09-30T12:00:00.000Z", "2026-10-01T08:00:00.000Z"];
const [A, B, C, D] = AT as [string, string, string, string];

function mount(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

function html(element: Element | string): string {
  let out = typeof element === "string" ? element : element.outerHTML;
  for (const at of AT) out = out.replaceAll(new Date(at).toLocaleString(), "[clock]");
  return out.replace(/_r_[0-9a-z]+_|«r[0-9a-z]+»|:r[0-9a-z]+:/g, "[id]").replaceAll("><", ">\n<") + "\n";
}

/** The blocks a screen owns, joined; every one must be there, or the golden compares less than it says. */
function owned(container: HTMLElement, selectors: readonly string[]): string {
  const blocks = selectors.map((selector) => container.querySelector(selector));
  expect(blocks.every((one) => one !== null), "a block is missing, so this compares less than it says").toBe(true);
  return blocks.map((one) => html(one!)).join("");
}

/** GETs answered from `bodies` by pathname (a number is that status, refused); every other call refused unless `acted` answers. */
function node(bodies: Record<string, unknown>, acted: (path: string) => Response | undefined = () => undefined) {
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (call.method !== "GET") {
      return acted(url.pathname) ?? Response.json({ error: "E_REFUSED_FOR_TEST", message: "Refused, for the test." }, { status: 409 });
    }
    const body = bodies[url.pathname];
    if (typeof body === "number") return Response.json({ error: "E_FORBIDDEN", message: "You do not hold org.admin." }, { status: body });
    return body === undefined ? undefined : Response.json(body);
  });
}

beforeEach(() => {
  reset();
  route.pathname = "/matters";
  try { sessionStorage.clear(); } catch { /* no storage in this runner */ }
});

/* ------------------------------------------------------------------ Matters ------------------------ */

const MAILBOXES = { mailboxes: [{ id: "mbx_test", name: "Support", addresses: "support@example.test" }] };

const MATTERS = {
  "/api/mailboxes": MAILBOXES,
  "/api/matters": {
    matters: [
      { id: "mat_open", type: "security_incident", description: "Phished invoice", openedBy: "usr_me", openedAt: A, closedAt: null, closedBy: null },
      { id: "mat_done", type: "departure_handover", description: "Ana leaves", openedBy: "usr_me", openedAt: B, closedAt: C, closedBy: "usr_me" },
    ],
  },
  "/api/holds": {
    holds: [
      { id: "hld_1", matterId: "mat_open", mailboxId: "mbx_test", fromDate: null, toDate: null, placedBy: "usr_me", placedAt: A, mailboxExists: true, pendingLift: null },
      {
        id: "hld_2", matterId: null, mailboxId: "mbx_gone", fromDate: null, toDate: null, placedBy: "usr_me", placedAt: B, mailboxExists: false,
        pendingLift: { liftId: "lft_1", approvalId: "apr_1", requestedBy: "usr_me", reason: "no longer required" },
      },
    ],
  },
  "/api/supervised": {
    supervised: [
      { id: "sup_1", subjectId: "usr_wang", mailboxId: "mbx_test", scope: "content", matterId: "mat_open", requestedAt: A, expiresAt: D, grantedAt: B, live: true },
      { id: "sup_2", subjectId: "usr_lee", mailboxId: "mbx_test", scope: "metadata", matterId: null, requestedAt: A, expiresAt: D, grantedAt: null, live: false },
      { id: "sup_3", subjectId: "usr_kim", mailboxId: "mbx_test", scope: "metadata", matterId: null, requestedAt: A, expiresAt: B, grantedAt: A, live: false },
    ],
  },
  "/api/exports": {
    exports: [
      { id: "exp_run", matterId: "mat_open", mailboxId: "mbx_test", requestedBy: "usr_me", maxMessages: 100, state: "approved", stateReason: null, messagesEmitted: 0, requestedAt: A, completedAt: null },
      { id: "exp_part", matterId: "mat_open", mailboxId: "mbx_test", requestedBy: "usr_me", maxMessages: 50, state: "running", stateReason: "paused at a page", messagesEmitted: 20, requestedAt: A, completedAt: null },
      { id: "exp_done", matterId: "mat_open", mailboxId: "mbx_test", requestedBy: "usr_me", maxMessages: 10, state: "completed", stateReason: null, messagesEmitted: 2, requestedAt: A, completedAt: C },
    ],
  },
  "/api/exports/exp_done/objects/manifest.json": {
    count: 2,
    messages: [
      { receiptId: "rcp_1", object: "rcp_1.eml", bytes: 1024, sha256: "aa" },
      { receiptId: "rcp_2", object: "rcp_2.eml", bytes: 1, sha256: "bb" },
    ],
  },
};

const MATTERS_EMPTY = {
  "/api/mailboxes": MAILBOXES, "/api/matters": { matters: [] }, "/api/holds": { holds: [] },
  "/api/supervised": { supervised: [] }, "/api/exports": { exports: [] },
};

/** The heading, the lead and the four sections: everything `matters.tsx` renders. */
async function matters(container: HTMLElement): Promise<string> {
  await waitFor(() => { expect(container.querySelectorAll(".matter-block").length).toBe(4); });
  expect(container.textContent).not.toContain("Reading…");
  return html(container.innerHTML);
}

describe("Matters in English", () => {
  it("renders every row shape: open and closed matters, a lift waiting and a mailbox gone, three grant states, three exports", async () => {
    node(MATTERS);
    const { container } = mount(<Matters />);
    await screen.findByText("reading now");
    await screen.findByText("1 open");
    await act(async () => { screen.getByRole("button", { name: "Objects" }).click(); });
    await screen.findByText("rcp_1.eml");
    await expect(await matters(container)).toMatchFileSnapshot("./golden/matters.populated.en.html");
  });

  it("renders the empty state, D9 fixed: no matter is called an investigation", async () => {
    node(MATTERS_EMPTY);
    const { container } = mount(<Matters />);
    await screen.findByText(/No matters have been opened\./);
    await screen.findByText(/No exports have been requested\./);
    await screen.findByText("0 open");
    await expect(await matters(container)).toMatchFileSnapshot("./golden/matters.empty.en.html");
  });

  it("renders a reader without org.admin", async () => {
    node({ ...MATTERS_EMPTY, "/api/matters": 403, "/api/holds": 403 });
    const { container } = mount(<Matters />);
    await screen.findByText(/No holds, or you do not hold org.admin\./);
    await screen.findByText(/No matters, or you do not hold org.admin\./);
    await expect(await matters(container)).toMatchFileSnapshot("./golden/matters.refused-read.en.html");
  });

  it("says what each act asked for, and shows a refusal as the Node wrote it", async () => {
    node(MATTERS, () => Response.json({ ok: true }));
    mount(<Matters />);
    await screen.findByText("reading now");
    const lines: string[] = [];
    const said = async (press: () => void) => {
      await act(async () => { press(); });
      lines.push((await screen.findByRole("status")).textContent ?? "");
    };
    const pick = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });
    fireEvent.change(document.getElementById("matter-description")!, { target: { value: "A new one" } });
    await said(() => screen.getByRole("button", { name: "Open a matter" }).click());
    await said(() => screen.getByRole("button", { name: "Close" }).click());
    pick("hold-mailbox", "mbx_test");
    await said(() => screen.getByRole("button", { name: "Hold this mailbox" }).click());
    await said(() => screen.getByRole("button", { name: "Ask to lift" }).click());
    pick("read-mailbox", "mbx_test");
    await said(() => screen.getByRole("button", { name: "Ask to read" }).click());
    pick("export-mailbox", "mbx_test");
    pick("export-matter", "mat_open");
    await said(() => screen.getByRole("button", { name: "Ask to export" }).click());
    await said(() => screen.getAllByRole("button", { name: "Run" })[0]!.click());
    node(MATTERS);
    await act(async () => { screen.getAllByRole("button", { name: "Run" })[0]!.click(); });
    lines.push((await screen.findByRole("alert")).outerHTML);
    // The two scope choices and the four kinds, which only an open select shows.
    lines.push(...[...document.querySelectorAll("#matter-type option, #read-scope option")].map((one) => one.textContent ?? ""));
    expect(lines).toHaveLength(14);
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./golden/matters.acts.en.txt");
  });
});

/* ------------------------------------------------------------------ Sending limits ----------------- */

const breaker = (name: string, fields: Record<string, unknown>) => ({
  breaker: name, sentence: `The Node's own sentence for ${name}.`, observations: 120, observed: 3, percent: 2.5, limit: 5,
  windowSeconds: 86_400, armed: true, unarmedReason: null, tripped: false, ...fields,
});

const LIMITS = {
  "/api/breakers": {
    breakers: [
      breaker("bounce_rate", { tripped: true, percent: 7.25 }),
      breaker("complaint_rate", { windowSeconds: 172_800 }),
      breaker("sends_per_hour", { percent: null, observed: 40, limit: 200, windowSeconds: 3_600 }),
      breaker("sends_per_day", { percent: null, windowSeconds: 7_200 }),
      breaker("unknown_rate", { armed: false, unarmedReason: "no_observations", observations: 0, windowSeconds: 900 }),
      // One minute: the window's unit is a plural on its count ("1 minute", never "1 minutes").
      breaker("burst", { windowSeconds: 60 }),
    ],
  },
  "/api/domain-pauses": { pauses: [{ id: "dps_1", domain: "customer.example", placedAt: A, reason: "a compromised account" }] },
  "/api/suppressions": {
    suppressed: [
      { address: "gone@example.test", cause: "hard_bounce", detail: "550 no such user", observedAt: A, eventId: "evt_1" },
      { address: "angry@example.test", cause: "complaint", detail: null, observedAt: B, eventId: "evt_2" },
    ],
    truncated: true,
  },
};

const LIMITS_EMPTY = { "/api/breakers": { breakers: [] }, "/api/domain-pauses": { pauses: [] }, "/api/suppressions": { suppressed: [], truncated: false } };

async function limits(container: HTMLElement): Promise<string> {
  await waitFor(() => { expect(container.textContent).not.toContain("Reading…"); });
  await waitFor(() => { expect(container.querySelectorAll(".limits-pauses").length).toBe(2); });
  return owned(container, ["h1", "[aria-label='Breakers'], .notice.bad", "[aria-label='Paused domains']", "[aria-label='Suppressed recipients']"]);
}

describe("Sending limits in English", () => {
  it("renders every breaker state and window, a paused domain, both suppression causes and the truncated notice", async () => {
    node(LIMITS);
    const { container } = mount(<Limits />);
    await screen.findByText("stopping mail");
    await screen.findByText("customer.example");
    await screen.findByText("gone@example.test");
    await expect(await limits(container)).toMatchFileSnapshot("./golden/limits.populated.en.html");
  });

  it("renders the empty state", async () => {
    node(LIMITS_EMPTY);
    const { container } = mount(<Limits />);
    await screen.findByText(/No address is suppressed on this Node\./);
    await expect(await limits(container)).toMatchFileSnapshot("./golden/limits.empty.en.html");
  });

  it("renders the reads refused", async () => {
    node({ "/api/breakers": 403, "/api/domain-pauses": 403, "/api/suppressions": 403 });
    const { container } = mount(<Limits />);
    await waitFor(() => { expect(container.querySelectorAll(".notice").length).toBeGreaterThanOrEqual(2); });
    await expect(await limits(container)).toMatchFileSnapshot("./golden/limits.refused-read.en.html");
  });

  it("says what asking to pause a domain did, and shows each refusal as the Node wrote it", async () => {
    node(LIMITS, (path) => (path === "/api/domain-pauses" ? Response.json({ ok: true }) : undefined));
    mount(<Limits />);
    await screen.findByText("customer.example");
    fireEvent.change(document.getElementById("pause-domain")!, { target: { value: "other.example" } });
    fireEvent.change(document.getElementById("pause-reason")!, { target: { value: "abuse" } });
    await act(async () => { screen.getByRole("button", { name: "Ask to pause this domain" }).click(); });
    const lines = [(await screen.findByRole("status")).textContent ?? ""];
    await act(async () => { screen.getByRole("button", { name: "Let it send again" }).click(); });
    lines.push((await screen.findByRole("alert")).outerHTML);
    fireEvent.change(screen.getByRole("textbox", { name: "Why gone@example.test is good again" }), { target: { value: "fixed" } });
    await act(async () => { screen.getAllByRole("button", { name: "Vouch" })[0]!.click(); });
    await waitFor(() => { expect(screen.getAllByRole("alert")).toHaveLength(2); });
    lines.push(screen.getAllByRole("alert")[1]!.outerHTML);
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./golden/limits.acts.en.txt");
  });
});

/* ------------------------------------------------------------------ first run and next steps ------- */

describe("the first-run gate in English", () => {
  it("renders the steps, the next one with its two ways, and the way out", async () => {
    route.pathname = "/";
    answerWith((call) => {
      if (call.path === "/api/provider") {
        return Response.json({
          provider: { state: "no_token", accountId: null, accountName: null, registeredAt: null, verifiedAt: null },
          provisioned: { receiving: null, sending: null, deliveryEvents: null },
          permissions: [{ name: "Zone Read", scope: "zone", why: "w", optional: false }], note: "n",
        });
      }
      if (call.path === "/api/doctor") {
        return Response.json({ verdict: "ok", claimed: true, at: A, findings: [{ check: "inbound_routing", severity: "report", ok: false, detail: "prose" }] });
      }
      return undefined;
    });
    const { container } = mount(<Gate><div>THE INBOX</div></Gate>);
    const gate = await screen.findByRole("region", { name: "Setup needed" });
    expect(container.textContent).not.toContain("Reading…");
    await expect(html(gate)).toMatchFileSnapshot("./golden/ui.first-run.en.html");
  });

  it("renders without a next step", async () => {
    const { container } = render(<FirstRun steps={[]} next={null} onOpenAnyway={() => {}} />);
    await expect(html(container.firstElementChild!)).toMatchFileSnapshot("./golden/ui.first-run-no-next.en.html");
  });
});

function message(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "rcpt_1", message_id: "msg_1", subject: "Invoice", from_addr: "ar@northwind.example",
    envelope_from: "bounce@relay.example", envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
    accepted_at: "2026-08-21T09:00:00.000Z", parse_error: null, conversation_id: null, case_id: "case_1",
    auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
    attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
    place: "inbox", from_name: null, preview: null, standing_content: 1, case_mine: 1, case_state: "open",
    ...over,
  };
}

describe("Next steps in English", () => {
  it("renders every step the provider offers, and a finding with its label and provenance", async () => {
    const { steps } = deterministicNextSteps({ message: message(), canSend: true, claim: () => {}, release: () => {}, showFromSender: () => {} });
    expect(steps.map((step) => step.id)).toEqual(["claim", "release", "more-from-sender"]);
    const finding = { text: "Invoice detected", provenance: { profile: "finance", model: "m-1", runId: "run_9", at: "2026-09-26T09:00:00Z" } };
    const { container } = render(<NextSteps steps={steps} finding={finding} />);
    await expect(html(container.firstElementChild!)).toMatchFileSnapshot("./golden/ui.next-steps.en.html");
  });
});

/* ------------------------------------------------------------------ ui pieces ---------------------- */

/** The menu open, the popover open and the section tabs: what each renders around its caller's words. */
function Pieces() {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Menu
        label="More actions"
        face="•••"
        items={[
          { label: "Mark unread", onSelect: () => {} },
          { label: "Move to Trash", disabled: true },
          { label: "Download original", note: "Recorded as an export.", href: "/raw", startsGroup: true },
        ]}
      />
      <span className="popover-wrap">
        <button ref={anchor} type="button">Filter</button>
        <Popover open onClose={() => {}} label="Filter" anchor={anchor} className="popover-down">
          <input aria-label="Sender" />
        </Popover>
      </span>
      <SectionTabs label="Automations" tabs={[{ to: "/butlers", label: "Butlers" }, { to: "/rules", label: "Rules" }]} />
    </>
  );
}

describe("the shared pieces in English", () => {
  it("render the menu, the popover and the section tabs as before", async () => {
    route.pathname = "/rules";
    const { container } = render(<Pieces />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menu", { name: "More actions" })).toBeDefined();
    await expect(html(container.innerHTML)).toMatchFileSnapshot("./golden/ui.pieces.en.html");
  });
});

/* ------------------------------------------------------------------ zh-Hans ------------------------ */

describe("the same screens in Chinese", () => {
  beforeAll(() => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
  });
  afterAll(() => {
    install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
  });

  it("calls a matter 事项, never an investigation, and marks the Node's refusal as English", async () => {
    node(MATTERS_EMPTY, () => Response.json({ error: "E_REFUSED_FOR_TEST", message: "Refused, for the test." }, { status: 409 }));
    const { container } = mount(<Matters />);
    await screen.findByText("尚未开立任何事项。");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("事项");
    // Every word the screen writes about a matter, less the kinds' own descriptions (a security incident is
    // investigated, `api.matter.security_incident`), which are the one place an investigation is meant.
    const kinds = container.querySelector("#matter-type")!.textContent!;
    expect(container.textContent!.replace(kinds, "")).not.toContain("调查");
    fireEvent.change(document.getElementById("matter-description")!, { target: { value: "x" } });
    await act(async () => { screen.getByRole("button", { name: "开立事项" }).click(); });
    expect((await screen.findByRole("alert")).innerHTML).toBe('<span lang="en">Refused, for the test.</span>');
  });

  it("counts a byte and a window in its own units, and keeps each measure word in its noun", async () => {
    node(MATTERS);
    mount(<Matters />);
    await act(async () => { (await screen.findByRole("button", { name: "对象" })).click(); });
    expect((await screen.findByText("1,024 字节")).className).toBe("dim mono");
    node(LIMITS);
    const { container } = mount(<Limits />);
    await screen.findByText("customer.example");
    expect([...container.querySelectorAll<HTMLTableRowElement>("[aria-label='熔断器'] tbody tr")].map((row) => row.cells[2]!.textContent))
      .toEqual(["1 天", "2 天", "1 小时", "2 小时", "15 分钟", "1 分钟"]);
    expect(screen.getByText(/^仅显示最新的/).textContent).toBe("仅显示最新的 2 个邮件地址。更早的仍然存在，但未列出。");
    expect(screen.getByRole("heading", { name: "已暂停的域名" })).toBeDefined();
    // The breaker's sentence is the Node's own, so it stays English and says so.
    expect(container.querySelector("[aria-label='熔断器'] tbody td .dim")!.innerHTML)
      .toBe('<span lang="en">The Node\'s own sentence for bounce_rate.</span>');
  });

  it("names the next step in the step's own words, with its link inside the sentence", async () => {
    const step: Step = { id: "address", label: t("onboarding.step.address"), phrase: t("onboarding.step.address.phrase"), state: "todo", detail: "d" };
    const { container } = render(<FirstRun steps={[]} next={step} onOpenAnyway={() => {}} />);
    expect(container.querySelector("h2")!.textContent).toBe(`下一步：${t("onboarding.step.address.phrase")}`);
    expect(screen.getByRole("link", { name: "用一个 API 令牌连接本节点，然后在那里配置接收" }).parentElement!.textContent)
      .toBe("浏览器中没有 wrangler，所以这种方式需要本节点自己的凭据：用一个 API 令牌连接本节点，然后在那里配置接收。在根域名上，Catch-all 地址只需一步，之后邮件地址都在本节点上管理。");
  });

  it("marks the Node's own tokens and words as English: a matter's kind, a read's scope, an export's state, a bounce", async () => {
    const marked = (root: HTMLElement) => [...root.querySelectorAll("td [lang='en']")].map((one) => one.textContent);
    node(MATTERS);
    const { container } = mount(<Matters />);
    await screen.findByText("paused at a page");
    expect(marked(container)).toEqual(expect.arrayContaining(
      ["security incident", "departure handover", "content", "metadata", "running", "paused at a page", "completed"],
    ));
    node(LIMITS);
    const limits = mount(<Limits />);
    await screen.findByText("gone@example.test");
    expect(marked(limits.container)).toContain("550 no such user");
  });

  it("offers the Queue's own words for a case's acts", () => {
    const { steps } = deterministicNextSteps({ message: message(), canSend: true, claim: () => {}, release: () => {}, showFromSender: () => {} });
    expect(steps.map((step) => step.label)).toEqual(["认领", "放回队列", "此发件人的更多邮件"]);
  });
});
