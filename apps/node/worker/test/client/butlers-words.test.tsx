import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { answerWith, reset, type Call } from "./session-stub.ts";

/**
 * Butlers and Rules (`butlers.tsx`, `policies.tsx`) in English, byte for byte. The golden files were written
 * from the screens as they stood on 1 October 2026, before their words moved into the catalog (layer 2b,
 * ADR 46, `docs/i18n.md`), so a key whose English differs by a letter, a sentence split into fragments that no
 * longer read as one, or an element lost from inside a sentence, shows as a diff of the rendered HTML.
 *
 * Both screens print an instant with the browser's `toLocaleString()`, which is the viewer's zone and locale,
 * so it is replaced by `[clock]` before comparing: what is held is the words around it.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/butlers" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Butlers } = await import("../../src/client/app/screens/butlers.tsx");
const { Policies } = await import("../../src/client/app/screens/policies.tsx");

const AT = "2026-09-28T04:36:51.379Z";
/** A read answered 404, which is what a reader who is not an administrator is told (§5C). */
const NOT_ADMIN = Symbol("404");
/** A read that failed for a reason other than who is asking: a 503 with the Node's words. */
const FAILED = Symbol("503");
const REFUSED = { error: "E_REFUSED_FOR_TEST", message: "Refused, for the test: the four-part message the Node writes." };

function mount(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

/** The screen's HTML, its clock replaced, once every block named is there (else it compares less than it says). */
function html(container: HTMLElement, blocks: readonly string[]): string {
  const missing = blocks.filter((selector) => container.querySelector(selector) === null);
  expect(missing, "a block is missing, so this compares less than it says").toEqual([]);
  expect(container.textContent).not.toContain("Reading…");
  return container.innerHTML.replaceAll(new Date(AT).toLocaleString(), "[clock]").replaceAll("><", ">\n<") + "\n";
}

/** GETs from `bodies` by path; every other call answered by `acted`, or refused. */
function node(bodies: Record<string, unknown>, acted: (call: Call) => Response | undefined = () => undefined) {
  answerWith((call) => {
    const path = new URL(call.path, "https://node.example").pathname;
    if (call.method !== "GET") return acted(call) ?? Response.json(REFUSED, { status: 409 });
    const body = bodies[path];
    if (body === NOT_ADMIN) return Response.json({ error: "E_NOT_FOUND", message: "Not found." }, { status: 404 });
    if (body === FAILED) return Response.json({ error: "E_UNAVAILABLE_FOR_TEST", message: "The catalog could not be read, for the test." }, { status: 503 });
    return body === undefined ? undefined : Response.json(body);
  });
}

beforeEach(reset);
afterEach(() => {
  install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
});

/* ------------------------------------------------------------------------------------------ Butlers --- */

const pause = {
  pauseId: "bps_1", butlerId: "btl_paused", butlerName: "triage", reason: "loop_detected",
  detail: "This Butler ran 40 times on one conversation in ten minutes.", trippedBy: "loop-detector", placedAt: AT,
};

const BUTLERS = [
  { id: "btl_paused", name: "triage", created_at: AT, live_version_id: "bv_2", live_version: 2, published_at: AT, draft_version_id: "bv_3", pause },
  { id: "btl_live", name: "auto-ack", created_at: AT, live_version_id: "bv_9", live_version: 3, published_at: AT, draft_version_id: null, pause: null },
  { id: "btl_draft", name: "new butler", created_at: AT, live_version_id: null, live_version: null, published_at: null, draft_version_id: null, pause: null },
];

const run = (id: string, butler: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, butler_id: butler, version_id: "bv_2", trigger_event: "mail.received", trigger_key: `k_${id}`, state,
  outcome_reason: null, started_at: AT, finished_at: AT, nodes_executed: 3, effects: 1, refusals: 0,
  subrequests_spent: 4, replay_of: null, replayed_by: null, ...extra,
});

const RUNS = [
  run("run_done", "btl_paused", "finished"),
  run("run_stopped", "btl_paused", "stopped", { outcome_reason: "nothing needed doing", effects: 0 }),
  run("run_failed", "btl_live", "failed", { outcome_reason: "budget exhausted", refusals: 2 }),
  run("run_open", "btl_live", "running", { finished_at: null }),
  run("run_waiting", "btl_live", "awaiting_release", { finished_at: null }),
];

const version = (id: string, n: number | null, state: string, extra: Record<string, unknown> = {}) => ({
  id, version: n, state, ast_sha256: "a1b2c3d4e5f6a7b8c9d0", source_sha256: "ff", created_by: "usr_me", created_at: AT,
  published_by: n === null ? null : "usr_me", published_at: n === null ? null : AT, superseded_at: null,
  source_text: null, source_format: "yaml", ...extra,
});

const SIMULATION = {
  butlerId: "btl_paused", butlerName: "triage", versionId: "bv_3", version: null, state: "finished", reason: "reached stop",
  nodesExecuted: 4, wouldSpend: 2, bindings: {},
  effects: [
    { seq: 1, nodeId: "label", nodeType: "label", outcome: "ok", reason: null, subject: null },
    { seq: 2, nodeId: "reply", nodeType: "draft", outcome: "would", reason: null, subject: null, detail: { to: ["a@example.test"] } },
    { seq: 3, nodeId: "assign", nodeType: "assign", outcome: "refused", reason: "no such colleague", subject: null },
    { seq: 4, nodeId: "fetch", nodeType: "http", outcome: "failed", reason: "timed out", subject: null },
  ],
  limits: ["The seal did not run, so no policy, breaker or approval gate was asked."],
};

const BUTLER_DETAIL: Record<string, unknown> = {
  "/api/butlers/btl_paused": {
    butler: { id: "btl_paused", name: "triage" },
    versions: [
      version("bv_3", null, "draft", { source_text: "entry: halt\n" }),
      version("bv_2", 2, "published"),
      version("bv_1", 1, "superseded", { source_format: "json" }),
    ],
  },
  "/api/butlers/btl_live": { butler: { id: "btl_live", name: "auto-ack" }, versions: [version("bv_9", 3, "published", { source_text: "entry: ack\n" })] },
  "/api/butlers/btl_draft": { butler: { id: "btl_draft", name: "new butler" }, versions: [] },
  // The dry run's input: the first run of each Butler, one with facts and one opened before they were recorded.
  "/api/butler-runs/run_done/inspect": { facts: { a: 1 } },
  "/api/butler-runs/run_failed/inspect": { facts: null },
};

function butlers(acted?: (call: Call) => Response | undefined) {
  node({ "/api/butlers": { butlers: BUTLERS }, "/api/butler-runs": { runs: RUNS }, ...BUTLER_DETAIL }, acted);
}

describe("Butlers in English", () => {
  it("renders every standing, a pause, every run shape and a run started again as before", async () => {
    butlers((call) => (call.path.endsWith("/replay") ? Response.json({ mode: "re-run", runId: "run_again", replayOf: "run_done" }) : undefined));
    const { container } = mount(<Butlers />);
    await screen.findByText("live · v3");
    await act(async () => { screen.getAllByRole("button", { name: "Run again" })[0]!.click(); });
    await screen.findByRole("status");
    await expect(html(container, ["h1", ".butler-pause", "table", ".notice[role=status]"]))
      .toMatchFileSnapshot("./golden/butlers.list.en.html");
  });

  it("renders the editor over a draft, the dry run's every outcome and its limits", async () => {
    butlers((call) => (call.path.endsWith("/simulate") ? Response.json({ simulation: SIMULATION }) : undefined));
    const { container } = mount(<Butlers />);
    await screen.findByText("triage");
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!);
    await screen.findByText("unpublished draft", { exact: false });
    await act(async () => { screen.getAllByRole("button", { name: /^Dry run over / })[0]!.click(); });
    await waitFor(() => { expect(container.querySelector(".butler-dry-result")).not.toBeNull(); });
    await expect(html(container, [".butler-detail", ".butler-dry-result", ".butler-dry-limits", "caption"]))
      .toMatchFileSnapshot("./golden/butlers.editor.en.html");
  });

  it("names who published a version by address when the directory has them, by id when it does not", async () => {
    node({
      "/api/butlers": { butlers: BUTLERS }, "/api/butler-runs": { runs: RUNS }, ...BUTLER_DETAIL,
      "/api/people": { people: [{ id: "usr_me", email: "me@example.test", created_at: AT, relations: [] }] },
    });
    const { container } = mount(<Butlers />);
    await screen.findByText("triage");
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!);
    // The By column said `usr_01M4…` until 9 October 2026, found by looking at it while recording the product.
    await waitFor(() => { expect(container.querySelector(".butler-detail tbody")?.textContent).toContain("me@example.test"); });
    expect(container.querySelector(".butler-detail tbody")?.textContent).not.toContain("usr_me");
  });

  it("renders a live Butler with no draft, and a run that recorded no facts", async () => {
    butlers();
    const { container } = mount(<Butlers />);
    await screen.findByText("auto-ack");
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[1]!);
    await screen.findByText("showing live v3", { exact: false });
    await act(async () => { screen.getAllByRole("button", { name: /^Dry run over / })[0]!.click(); });
    await screen.findByText(/recorded no trigger facts/);
    await expect(html(container, [".butler-detail", ".butler-findings"])).toMatchFileSnapshot("./golden/butlers.editor-live.en.html");
  });

  it("renders a Butler with nothing saved and no runs", async () => {
    butlers();
    const { container } = mount(<Butlers />);
    await screen.findByText("draft only, never published");
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[2]!);
    await screen.findByText("nothing saved yet", { exact: false });
    const detail = container.querySelector<HTMLElement>(".butler-detail")!;
    await expect(html(detail, ["h2", ".butler-dry"])).toMatchFileSnapshot("./golden/butlers.editor-new.en.html");
  });

  it("renders an empty Node, and the Node's refusal of a new Butler", async () => {
    node({ "/api/butlers": { butlers: [] }, "/api/butler-runs": { runs: [] } });
    const { container } = mount(<Butlers />);
    await screen.findByText("Nothing is automated on this Node yet.");
    await screen.findByText(/No Butler has run yet/);
    await act(async () => { screen.getByRole("button", { name: "New butler" }).click(); });
    await screen.findByRole("alert");
    await expect(html(container, ["h1", ".butler-findings"])).toMatchFileSnapshot("./golden/butlers.empty.en.html");
  });

  it("renders a reader who is not an administrator, and runs that could not be read", async () => {
    node({
      "/api/butlers": NOT_ADMIN, "/api/butler-runs": NOT_ADMIN,
    });
    const { container } = mount(<Butlers />);
    await screen.findByText(/you do not hold org.admin/);
    await expect(html(container, ["h1", ".notice"])).toMatchFileSnapshot("./golden/butlers.not-admin.en.html");
  });

  it("shows a read that failed as failed, never as not an administrator (H13)", async () => {
    node({ "/api/butlers": FAILED, "/api/butler-runs": FAILED });
    const { container } = mount(<Butlers />);
    expect((await screen.findByRole("alert")).textContent).toBe("The catalog could not be read, for the test.");
    expect(container.textContent).not.toContain("org.admin");
  });
});

/* ------------------------------------------------------------------------------------------- Rules --- */

const rule = (id: string, outcome: string, state: string, conditions: Record<string, unknown> = {}) => ({
  policy_id: `pol_${id}`, name: `rule ${id}`, version_id: `pv_${id}`, version: state === "published" ? 4 : null, state, outcome,
  when_mailbox_id: null, when_actor_user_id: null, when_recipient_external: null, when_is_reply: null,
  when_org_daily_volume_min: null, when_reply_to_dmarc_fail: null, created_at: AT,
  published_at: state === "published" ? AT : null, superseded_at: null, ...conditions,
});

/** Every outcome, each condition both ways, a mailbox by name and by an id no mailbox has, and none at all. */
const RULES = [
  rule("every", "allow", "published"),
  rule("outside", "require_approval", "published", { when_mailbox_id: "mbx_test", when_recipient_external: 1, when_is_reply: 0 }),
  rule("inside", "hold", "published", { when_mailbox_id: "mbx_gone", when_recipient_external: 0, when_is_reply: 1, when_actor_user_id: "usr_wang" }),
  rule("dmarc", "deny", "published", { when_reply_to_dmarc_fail: 1, when_org_daily_volume_min: 500 }),
  rule("clean", "deny", "draft", { when_reply_to_dmarc_fail: 0, when_recipient_external: 1 }),
];

describe("Rules in English", () => {
  it("renders every outcome and condition as a sentence, a draft, and the Node's refusal to publish", async () => {
    node({ "/api/policies": { policies: RULES } });
    const { container } = mount(<Policies />);
    await screen.findByText("rule every");
    await act(async () => { screen.getByRole("button", { name: "Publish" }).click(); });
    await screen.findByRole("alert");
    await expect(html(container, ["h1", "caption", "tbody", ".butler-findings"])).toMatchFileSnapshot("./golden/policies.list.en.html");
  });

  it("renders a new rule's editor, the approvals count included", async () => {
    node({ "/api/policies": { policies: RULES } });
    const { container } = mount(<Policies />);
    await screen.findByText("rule every");
    fireEvent.click(screen.getByRole("button", { name: "New rule" }));
    const editor = container.querySelector<HTMLElement>(".policy-editor")!;
    await expect(html(editor, ["#policy-name", "#policy-approvals", "#policy-outcome"])).toMatchFileSnapshot("./golden/policies.new.en.html");
  });

  it("renders a draft's editor, and the Node's refusal of its save", async () => {
    node({ "/api/policies": { policies: RULES } });
    const { container } = mount(<Policies />);
    await screen.findByText("rule clean");
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[4]!);
    await act(async () => { screen.getByRole("button", { name: "Save draft" }).click(); });
    await screen.findByRole("alert");
    const editor = container.querySelector<HTMLElement>(".policy-editor")!;
    await expect(html(editor, ["h2", "#policy-external", ".butler-findings"])).toMatchFileSnapshot("./golden/policies.edit.en.html");
  });

  it("renders an organization with no rules", async () => {
    node({ "/api/policies": { policies: [] } });
    const { container } = mount(<Policies />);
    await screen.findByText(/No rules yet/);
    await expect(html(container, ["h1", ".notice"])).toMatchFileSnapshot("./golden/policies.empty.en.html");
  });

  it("renders a reader who is not an administrator", async () => {
    node({ "/api/policies": NOT_ADMIN });
    const { container } = mount(<Policies />);
    await screen.findByText(/you do not hold org.admin/);
    await expect(html(container, ["h1", ".notice"])).toMatchFileSnapshot("./golden/policies.not-admin.en.html");
  });

  it("shows a read that failed as failed, never as not an administrator (H13)", async () => {
    node({ "/api/policies": FAILED });
    const { container } = mount(<Policies />);
    expect((await screen.findByRole("alert")).textContent).toBe("The catalog could not be read, for the test.");
    expect(container.textContent).not.toContain("org.admin");
  });
});

/* ----------------------------------------------------------------------------------- the words' fixes --- */

describe("the English the migration fixed", () => {
  it("counts the dry run's nodes as a plural, one and many (it said \"4 node(s)\")", async () => {
    butlers((call) => (call.path.endsWith("/simulate")
      ? Response.json({ simulation: { ...SIMULATION, version: 2, nodesExecuted: 1, wouldSpend: 1 } })
      : undefined));
    const { container } = mount(<Butlers />);
    await screen.findByText("triage");
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!);
    await act(async () => { screen.getAllByRole("button", { name: /^Dry run over / })[0]!.click(); });
    await waitFor(() => { expect(container.querySelector(".butler-dry-result")).not.toBeNull(); });
    expect(container.querySelector(".butler-dry-result .dim")!.textContent).toBe("v2 · 1 node · would spend 1");
  });

  it("says a run's state in words, an underscore read as a space, and a token outside the list as the Node sent it (H7)", async () => {
    node({ "/api/butlers": { butlers: BUTLERS }, "/api/butler-runs": { runs: [...RUNS, run("run_odd", "btl_live", "parked_for_test")] } });
    mount(<Butlers />);
    await screen.findByText("live · v3");
    const states = [...screen.getByRole("region", { name: "Runs" }).querySelectorAll("tbody td:nth-child(2)")];
    expect(states.map((cell) => cell.innerHTML)).toEqual([
      "finished", "stopped", "failed", "running", "awaiting release", "parked_for_test",
    ]);
  });

  /**
   * D1 (`docs/i18n.md`): the send notes said "a policy", and the interface calls one a rule (the Rules screen). Read
   * from the catalog, so a note the Outbox golden does not render (approval required, denied, stricter, impossible)
   * is held too; since D30 (the owner's decision, 1 October 2026) the labels say rule as well.
   */
  it("calls a rule a rule in every send note (D1)", () => {
    const notes = Object.entries(CATALOGS.en.app).filter(([key]) => key.startsWith("send.") && key.endsWith(".note"));
    expect(notes.length).toBeGreaterThan(20);
    expect(notes.filter(([, note]) => /\bpolic(y|ies)\b/i.test(String(note))).map(([key]) => key)).toEqual([]);
    expect(notes.filter(([, note]) => /\brules?\b/.test(String(note))).map(([key]) => key)).toEqual(expect.arrayContaining([
      "send.state.awaiting.note", "send.state.withheld.note", "send.reason.policy_hold.note",
      "send.reason.policy_approval_required.note", "send.reason.policy_denied.note", "send.reason.policy_stricter.note",
      "send.reason.approval_unsatisfiable.note",
    ]));
  });

  it("says rule, not policy, in every send-reason label (D30)", () => {
    const labels = Object.entries(CATALOGS.en.app)
      .filter(([key]) => key.startsWith("send.reason.") && !key.endsWith(".note"));
    expect(labels.length).toBeGreaterThan(10);
    expect(labels.filter(([, label]) => /\bpolic(y|ies)\b/i.test(String(label))).map(([key]) => key)).toEqual([]);
    expect(CATALOGS.en.app["send.reason.policy_hold"]).toBe("rule hold");
  });
});

/* ------------------------------------------------------------------------------------------ zh-Hans --- */

/** The two screens read in Chinese: the catalog's words, and the Node's own English marked as English. */
describe("Butlers and Rules in zh-Hans", () => {
  const zh = () => install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
  /**
   * The words a viewer reads that are the interface's own: not the Node's (`[lang=en]`), not an identifier (`.mono`),
   * not the program's source, and not a Butler's name (its `h2`).
   */
  const own = (root: Element): string => {
    const copy = root.cloneNode(true) as Element;
    copy.querySelectorAll("[lang=en], .mono, textarea, h2").forEach((node) => node.remove());
    return copy.textContent ?? "";
  };

  it("says Butlers in Chinese, with a pause's reason and a version's state in its words, the dry run's outcomes in the Node's English", async () => {
    zh();
    butlers((call) => (call.path.endsWith("/simulate") ? Response.json({ simulation: SIMULATION }) : undefined));
    const { container } = mount(<Butlers />);
    await screen.findByText("triage");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("管家");
    expect(screen.getByText(pause.detail).closest("[lang]")?.getAttribute("lang")).toBe("en");
    // A pause's reason is the contract's token (`BUTLER_PAUSE_REASONS`), keyed in the catalog since round three (G12).
    expect(screen.getByText("已暂停：检测到循环").closest("[lang='en']")).toBeNull();
    expect(screen.getByText("生效中 · v3")).toBeTruthy();
    // A run's state is the contract's token (`BUTLER_RUN_STATES`), keyed since round four (H7): stopped is 已终止, never
    // 已停止, and none of them is the Node's English.
    const states = [...screen.getByRole("region", { name: "运行记录" }).querySelectorAll("tbody td:nth-child(2)")];
    expect(states.map((cell) => cell.textContent)).toEqual(["已完成", "已终止", "失败", "运行中", "等待放行"]);
    expect(states.filter((cell) => cell.querySelector("[lang=en]") !== null)).toEqual([]);
    fireEvent.click(screen.getAllByRole("button", { name: "打开" })[0]!);
    await waitFor(() => { expect(container.querySelector(".butler-detail table tbody td:nth-child(2)")).not.toBeNull(); });
    expect([...container.querySelectorAll(".butler-detail table tbody td:nth-child(2)")].map((cell) => cell.innerHTML))
      .toEqual(expect.arrayContaining(["已发布"]));
    await act(async () => { screen.getAllByRole("button", { name: /^试运行：.+ 的那次运行$/ })[0]!.click(); });
    // The run a dry run reads names its event as an identifier and its state in the viewer's words.
    expect(container.querySelector(".butler-dry-runs li .dim")!.innerHTML).toBe("<code>mail.received</code> · 已完成");
    await waitFor(() => { expect(container.querySelector(".butler-dry-result")).not.toBeNull(); });
    expect(container.querySelector(".butler-dry-result strong")!.innerHTML).toBe("已完成");
    expect(container.querySelector(".butler-dry-result .dim")!.textContent).toBe("草稿 · 4 个步骤 · 将消耗 2");
    expect([...container.querySelectorAll(".butler-dry-result tbody td:nth-child(3) [lang=en]")].map((one) => one.textContent))
      .toEqual(["ok", "would", "refused", "no such colleague", "failed", "timed out"]);
    expect(container.querySelector(".butler-dry-limits li [lang=en]")!.textContent).toBe(SIMULATION.limits[0]);
    expect(container.querySelector(".butler-detail")!.getAttribute("aria-label")).toBe("管家 triage");
    // Butler is 管家 in Chinese: the Latin word is left only in the Node's words and in identifiers.
    expect(own(container)).toContain("管家");
    expect(own(container)).not.toMatch(/Butler/);
    expect(container.querySelector(".butler-runs-heading")!.textContent).toBe("运行记录");
  });

  it("marks the Node's refusal of a new Butler as English", async () => {
    zh();
    node({ "/api/butlers": { butlers: [] }, "/api/butler-runs": { runs: [] } });
    mount(<Butlers />);
    await screen.findByText("本节点上还没有任何自动化。");
    await act(async () => { screen.getByRole("button", { name: "新建管家" }).click(); });
    expect((await screen.findByRole("alert")).querySelector("[lang=en]")?.textContent).toBe(REFUSED.message);
  });

  it("says a rule as one Chinese sentence, its clauses joined with 、", async () => {
    zh();
    node({ "/api/policies": { policies: RULES } });
    const { container } = mount(<Policies />);
    await screen.findByText("rule every");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("规则");
    expect([...container.querySelectorAll("tbody tr td:nth-child(2)")].map((cell) => cell.firstChild?.textContent)).toEqual([
      "每封邮件都照常发出。",
      "来自 Support、发给组织外部的人、作为新邮件的邮件需要先经审批才能发出。",
      "来自 mbx_gone、由 usr_wang 撰写、只发给同事、作为回复的邮件会被暂扣，等人放行。",
      "回复发件人域名不予认可的来信、在本节点今天已移交 500 封之后的邮件会被此规则否决。",
      "发给组织外部的人、不是回复不予认可的来信的邮件会被此规则否决。",
    ]);
    // A rule is 规则 in every word the screen writes, its caption and New rule included, which say "rule" and so are
    // not bound to the rules row (G20); DMARC's own policy is not on this screen.
    expect(container.querySelector("caption")!.textContent).toContain("规则");
    expect(container.textContent).not.toContain("策略");
    await act(async () => { screen.getByRole("button", { name: "发布" }).click(); });
    expect((await screen.findByRole("alert")).querySelector("[lang=en]")?.textContent).toBe(REFUSED.message);
  });
});
