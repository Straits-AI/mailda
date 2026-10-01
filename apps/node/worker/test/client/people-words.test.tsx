import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import { answerWith, reset, type Call } from "./session-stub.ts";

/**
 * People, Agents and Approvals in English, byte for byte (ADR 46, `docs/i18n.md`, layer 2b). The golden files
 * were written from `people.tsx`, `agents.tsx` and `approvals.tsx` as they stood on 1 October 2026, before
 * their words moved into the catalog, so a key whose English differs by a letter, a sentence split into
 * fragments that no longer read as one, or an element lost from inside a sentence, shows as a diff. An
 * English fix owed in this layer (the D rows) is a deliberate golden diff, made with it.
 *
 * A date or time is the viewer's zone and locale, so each instant the fixtures carry is replaced by `[clock]`
 * (`toLocaleString`) or `[date]` (`toLocaleDateString`) before comparing; the rest is byte for byte.
 *
 * The English fixed with the migration (docs/i18n.md, the D table): the Agents review and its pinned routes said
 * "(s)" and are plurals on their counts, held here at one and at many; an approval for a send says a rule, not a
 * policy, asked for it (D1); and a domain pause is a pause, never a stop (D3). The Chinese half holds that the
 * Node's own words stay English and marked `lang="en"` inside the translated sentences around them.
 */

const route = vi.hoisted(() => ({ pathname: "/people" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { People, Passkeys } = await import("../../src/client/app/screens/people.tsx");
const { Agents } = await import("../../src/client/app/screens/agents.tsx");
const { Approvals } = await import("../../src/client/app/screens/approvals.tsx");

const INSTANTS = [
  "2026-10-05T00:00:00.000Z", "2026-09-20T00:00:00.000Z", "2026-09-28T09:15:00.000Z", "2026-10-02T17:00:00.000Z",
  "2026-08-01T00:00:00.000Z", "2026-09-30T08:00:00.000Z",
];

/** The text with every fixture instant the viewer's way replaced by its placeholder. */
function stable(text: string): string {
  let out = text;
  for (const at of INSTANTS) {
    out = out.replaceAll(new Date(at).toLocaleString(), "[clock]").replaceAll(new Date(at).toLocaleDateString(), "[date]");
  }
  return out;
}

function html(container: HTMLElement): string {
  return stable(container.innerHTML).replaceAll("><", ">\n<") + "\n";
}

/** The container, after checking every block the golden is meant to hold is there to compare. */
function owned(container: HTMLElement, selectors: readonly string[]): HTMLElement {
  const missing = selectors.filter((selector) => container.querySelector(selector) === null);
  expect(missing, "a block is missing, so this compares less than it says").toEqual([]);
  expect(container.textContent).not.toContain("Reading…");
  return container;
}

function mount(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

const REFUSED = () => Response.json({ error: "E_REFUSED_FOR_TEST", message: "Refused, for the test." }, { status: 409 });
const ME = { signedIn: true, principalId: "usr_ana", principalKind: "user", userId: "usr_ana", delegatorUserId: null, organizationId: "org_x", email: "ana@example.test" };

/* ------------------------------------------------------------------------------------------- People --- */

const box = (id: string, name: string, addresses: string | null) => ({
  id, name, unclaimed: 0, claimed: 0, mine: 0, first_response_minutes: null, quarantine_dmarc_fail: 0,
  quarantine_dangerous_attachments: 0, quarantined: 0, breached: 0, addresses,
});

const BOXES = [
  box("mbx_support", "Support", "support@example.test,bob@example.test"),
  box("mbx_sales", "Sales", "hello@example.org"),
  box("mbx_invoices", "Invoices", null),
];

const PEOPLE = [
  {
    id: "usr_ana", email: "ana@example.test", created_at: "", relations: [
      { relation: "mailbox.content.read", objectType: "mailbox", objectId: "mbx_support" },
      { relation: "send.propose", objectType: "mailbox", objectId: "mbx_support" },
      { relation: "org.admin", objectType: "organization", objectId: "org_x" },
    ],
  },
  // Holds nothing on Support, whose address is his own: the arrival offer.
  { id: "usr_bob", email: "bob@example.test", created_at: "", relations: [] },
];

const INVITATIONS = [
  { id: "inv_1", email: "cleo@example.test", invitedBy: "usr_ana", createdAt: INSTANTS[4], expiresAt: INSTANTS[0], expired: false },
  { id: "inv_2", email: "dan@example.org", invitedBy: "usr_ana", createdAt: INSTANTS[4], expiresAt: INSTANTS[1], expired: true },
];

interface PeopleNode {
  people?: unknown[] | "refused";
  boxes?: unknown[];
  invitations?: unknown[];
  teams?: unknown[];
  withdrawals?: "truncated" | "refused";
  /** What every act answers; the Node's success shapes when absent. */
  act?: (call: Call) => Response | undefined;
}

function peopleNode(opts: PeopleNode = {}) {
  answerWith((call) => {
    if (call.method !== "GET") {
      const acted = opts.act?.(call);
      if (acted !== undefined) return acted;
      const body = call.body as Record<string, string>;
      if (call.path === "/api/invitations") {
        return Response.json({ invitation: { invitationId: "inv_3", email: body.email, expiresAt: INSTANTS[0], secret: "s3cret-once", replacedId: null } });
      }
      if (call.path === "/api/mailboxes") return Response.json({ mailboxId: "mbx_new", name: body.name });
      if (call.path === "/api/addresses" && call.method === "POST") {
        return Response.json({ address: { id: "addr_1", address: body.address, mailboxId: "mbx_new" }, routing: { state: "rule_written", detail: "" } });
      }
      if (call.path === "/api/addresses" && call.method === "DELETE") {
        return Response.json({ address: { id: "addr_1", address: body.address, mailboxId: "mbx_support" }, routing: { state: "rule_removed", detail: "" } });
      }
      if (call.path.startsWith("/api/mailboxes/")) return Response.json({ mailboxId: "mbx_support", name: body.name });
      return Response.json({ ok: true });
    }
    if (call.path === "/api/provider") {
      const receiving = { domain: "example.test", at: INSTANTS[4], authority: "operator", address: "hello@example.test", observed: false, routing: null };
      return Response.json({ provider: { state: "no_token" }, permissions: [], note: "", provisioned: { receiving, sending: null, deliveryEvents: null } });
    }
    if (call.path.startsWith("/api/mailboxes")) return Response.json({ mailboxes: opts.boxes ?? BOXES });
    if (call.path === "/api/me") return Response.json(ME);
    if (call.path.startsWith("/api/people")) {
      return opts.people === "refused"
        ? Response.json({ error: "E_FORBIDDEN", message: "Not yours." }, { status: 404 })
        : Response.json({ people: opts.people ?? PEOPLE });
    }
    if (call.path === "/api/audit?action=access.revoked") {
      return opts.withdrawals === "refused"
        ? Response.json({ error: "E_REFUSED_FOR_TEST", message: "The trail could not be read." }, { status: 503 })
        : Response.json({ entries: [], truncated: opts.withdrawals === "truncated" });
    }
    if (call.path.startsWith("/api/invitations")) return Response.json({ invitations: opts.invitations ?? INVITATIONS });
    if (call.path.endsWith("/members")) return Response.json({ members: ["usr_ana"] });
    if (call.path.startsWith("/api/teams")) {
      return Response.json({ teams: opts.teams ?? [{ id: "team_fin", name: "Finance", createdAt: INSTANTS[4], memberCount: 1 }] });
    }
    return undefined;
  });
  return mount(<People />);
}

const PEOPLE_BLOCKS = [
  "h1", "[aria-label='Access to Support']", "[aria-label='Access to Invoices']", "[aria-label='Administering the organization']",
  "[aria-label='Invite somebody']", "[aria-label='A new mailbox']", "[aria-label='A new address']", "[aria-label='Teams']",
];

/** Every notice and alert the screen shows, one per line, in document order. */
const notices = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll(".notice")).map((one) => stable(one.textContent ?? ""));

beforeEach(reset);

describe("People in English", () => {
  it("renders the people, every mailbox's grants, the organization, invitations, an arrival and teams as before", async () => {
    const { container } = peopleNode({ withdrawals: "truncated" });
    await screen.findByText(/has an account and holds nothing directly/);
    await screen.findByText("Invited, and not yet arrived.");
    await waitFor(() => { expect(screen.getByRole("checkbox", { name: "ana@example.test" })).toHaveProperty("disabled", false); });
    await expect(html(owned(container, [...PEOPLE_BLOCKS, ".invite-secret, caption", ".grant-list"]))).toMatchFileSnapshot("./golden/people.populated.en.html");
  });

  it("renders an empty Node, and the screen for somebody who is not an administrator", async () => {
    const empty = peopleNode({ people: [], boxes: [], invitations: [], teams: [] });
    await screen.findByText("No teams. Approval stages can name one once it exists.");
    await expect(html(owned(empty.container, ["h1", "[aria-label='Invite somebody']", "[aria-label='Teams']"])))
      .toMatchFileSnapshot("./golden/people.empty.en.html");
    empty.unmount();
    reset();
    const refused = peopleNode({ people: "refused" });
    await screen.findByText(/No directory, or you do not hold org.admin/);
    await expect(html(owned(refused.container, ["h1", ".notice"]))).toMatchFileSnapshot("./golden/people.forbidden.en.html");
  });

  it("says what each act did: an invitation with its mailbox, a mailbox, an address, a rename and a removal", async () => {
    const { container } = peopleNode();
    const invite = await screen.findByRole("region", { name: "Invite somebody" });
    fireEvent.change(within(invite).getByLabelText("Address"), { target: { value: "eve@example.test" } });
    fireEvent.click(within(invite).getByLabelText("Also give them a mailbox at"));
    await act(async () => { within(invite).getByText("Mint an invitation").click(); });
    await screen.findByText(/Give this to/);
    await screen.findByText(/The mailbox eve@example.test was made/);

    const made = screen.getByRole("region", { name: "A new mailbox" });
    fireEvent.change(within(made).getByLabelText("Name"), { target: { value: "Billing" } });
    await act(async () => { within(made).getByText("Create a mailbox").click(); });
    await within(made).findByRole("status");

    const added = screen.getByRole("region", { name: "A new address" });
    fireEvent.change(within(added).getByLabelText("Address"), { target: { value: "billing" } });
    fireEvent.change(within(added).getByRole("combobox", { name: "Mailbox" }), { target: { value: "mbx_sales" } });
    await act(async () => { within(added).getByText("Add the address").click(); });
    await within(added).findByRole("status");

    const support = screen.getByRole("region", { name: "Access to Support" });
    fireEvent.change(within(support).getByLabelText("Name"), { target: { value: "Help desk" } });
    await act(async () => { within(support).getByText("Rename").click(); });
    await within(support).findByText("renamed to Help desk");

    const sales = screen.getByRole("region", { name: "Access to Sales" });
    await act(async () => { within(sales).getByText("Remove").click(); });
    await within(sales).findByRole("status");

    await expect(notices(owned(container, PEOPLE_BLOCKS)).join("\n") + "\n").toMatchFileSnapshot("./golden/people.acts.en.txt");
  });

  it("shows each refusal, with the words it wraps the Node's in", async () => {
    const { container } = peopleNode({
      withdrawals: "refused",
      act: (call) => (call.path === "/api/invitations" ? undefined : REFUSED()),
    });
    await screen.findByText(/People offers nobody the mailbox at their own address/);
    const invite = screen.getByRole("region", { name: "Invite somebody" });
    fireEvent.change(within(invite).getByLabelText("Address"), { target: { value: "eve@example.test" } });
    fireEvent.click(within(invite).getByLabelText("Also give them a mailbox at"));
    await act(async () => { within(invite).getByText("Mint an invitation").click(); });
    await screen.findByText(/No mailbox was made/);

    const teams = screen.getByRole("region", { name: "Teams" });
    fireEvent.change(within(teams).getByLabelText("New team"), { target: { value: "Legal" } });
    await act(async () => { within(teams).getByText("Create").click(); });
    await within(teams).findByRole("alert");

    const org = screen.getByRole("region", { name: "Administering the organization" });
    await act(async () => { within(org).getAllByRole("checkbox")[1]!.click(); });
    await within(org).findByRole("alert");

    await expect(notices(owned(container, PEOPLE_BLOCKS)).join("\n") + "\n").toMatchFileSnapshot("./golden/people.refused.en.txt");
  });

  it("names the arrival grant that was refused, and the mailbox made without its address", async () => {
    const { container } = peopleNode({
      act: (call) => (call.path === "/api/access" || call.path === "/api/addresses" ? REFUSED() : undefined),
    });
    await act(async () => { (await screen.findByText("Grant mailbox.content.read and send.propose on Support")).click(); });
    await screen.findByText(/was not granted to bob@example.test/);
    const invite = screen.getByRole("region", { name: "Invite somebody" });
    fireEvent.change(within(invite).getByLabelText("Address"), { target: { value: "eve@example.test" } });
    fireEvent.click(within(invite).getByLabelText("Also give them a mailbox at"));
    await act(async () => { within(invite).getByText("Mint an invitation").click(); });
    await screen.findByText(/was made, and has no address/);
    await expect(notices(owned(container, PEOPLE_BLOCKS)).join("\n") + "\n").toMatchFileSnapshot("./golden/people.arrival-refused.en.txt");
  });
});

describe("Passkeys (people.tsx) in English", () => {
  it("renders the passkeys held, one never used, and the empty state", async () => {
    answerWith((call) => (call.path === "/api/auth/passkeys"
      ? Response.json({
        passkeys: [
          { id: "pk_1", label: "work laptop", createdAt: INSTANTS[4], lastUsedAt: INSTANTS[5], transports: null },
          { id: "pk_2", label: "phone", createdAt: INSTANTS[4], lastUsedAt: null, transports: null },
        ],
      })
      : undefined));
    const held = mount(<Passkeys />);
    await screen.findByText("phone");
    const first = html(owned(held.container, ["h2", "table", "#passkey-label"]));
    held.unmount();
    reset();
    const none = mount(<Passkeys />);
    await screen.findByText("None yet. This account signs in with a password only.");
    await expect(`${first}${html(owned(none.container, ["h2", "#passkey-label"]))}`).toMatchFileSnapshot("./golden/people.passkeys.en.html");
  });
});

/* ------------------------------------------------------------------------------------------- Agents --- */

const CAPABILITIES = [
  {
    id: "mail.read", says: "Read mail: list it, open a message, and fetch the original bytes.", reachesContent: true,
    requires: ["mailbox.content.read", "message.export"], routes: ["a", "b", "c", "d"],
  },
  { id: "hold.read", says: "Read the legal holds in force.", reachesContent: false, requires: [], routes: ["e"] },
];

function agent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, name: `agent ${id}`, sponsorUserId: "usr_ana", createdBy: "usr_ana", createdAt: INSTANTS[4],
    expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: null, actions: ["a", "b", "c", "d"],
    held: [{ id: "mail.read", says: "Read mail.", reachesContent: true, held: 4, total: 4 }],
    unnamed: [],
    grants: [{ mailboxId: "mbx_support", mailboxName: "Support", relation: "mailbox.content.read", effective: true }],
    ...overrides,
  };
}

const AGENTS = [
  agent("agt_live"),
  agent("agt_partial", {
    held: [{ id: "mail.read", says: "Read mail.", reachesContent: true, held: 3, total: 4 }, { id: "hold.read", says: "", reachesContent: false, held: 1, total: 1 }],
    unnamed: ["GET /api/old", "POST /api/older"],
    grants: [
      { mailboxId: "mbx_support", mailboxName: "Support", relation: "mailbox.content.read", effective: false },
      { mailboxId: "mbx_gone", mailboxName: null, relation: "message.export", effective: true },
    ],
  }),
  agent("agt_expired", { expiresAt: "2020-01-01T00:00:00.000Z", grants: [] }),
  agent("agt_revoked", { revokedAt: INSTANTS[5] }),
];

function agentsNode(agents: unknown[], opts: { mailboxes?: unknown[]; act?: (call: Call) => Response } = {}) {
  answerWith((call) => {
    if (call.method !== "GET") {
      if (opts.act !== undefined) return opts.act(call);
      return call.path === "/api/agents"
        ? Response.json({ agent: agent("agt_new"), token: "tok_secret_once", notice: "Shown once: only its hash is stored." })
        : Response.json({ revoked: true });
    }
    if (call.path.startsWith("/api/agent-capabilities")) return Response.json({ capabilities: CAPABILITIES });
    if (call.path === "/api/me") return Response.json(ME);
    if (call.path.startsWith("/api/agents")) return Response.json({ agents });
    if (call.path.startsWith("/api/people/") && call.path.endsWith("/mailboxes")) {
      return Response.json({
        mailboxes: opts.mailboxes ?? [
          { mailboxId: "mbx_support", mailboxName: "Support", relations: ["mailbox.content.read", "message.export", "send.propose"] },
          { mailboxId: "mbx_billing", mailboxName: "Billing", relations: ["mailbox.content.read"] },
          { mailboxId: "mbx_legal", mailboxName: "Legal", relations: [] },
        ],
      });
    }
    if (call.path.startsWith("/api/people")) {
      return Response.json({ people: [{ id: "usr_ana", email: "ana@example.test", created_at: "", relations: [] }, { id: "usr_bob", email: "bob@example.test", created_at: "", relations: [] }] });
    }
    return undefined;
  });
  return mount(<Agents />);
}

/** Tick one relation under one mailbox, or one capability when `mailbox` is absent. */
function tick(text: string, mailbox?: string) {
  const scope = mailbox === undefined ? document.querySelector("fieldset")! : screen.getByText(mailbox).closest("div")!;
  const label = Array.from(scope.querySelectorAll("label")).find((one) => one.textContent?.includes(text))!;
  fireEvent.click(label.querySelector("input")!);
}

describe("Agents in English", () => {
  it("renders live, partial, expired and revoked agents, and the mint form with every mailbox", async () => {
    const { container } = agentsNode(AGENTS);
    await screen.findByText("Legal");
    await screen.findAllByText("hold.read");
    await expect(html(owned(container, ["h1", "table", "form", "fieldset + fieldset strong"]))).toMatchFileSnapshot("./golden/agents.list.en.html");
  });

  it("reviews a ceiling before minting, names a shortfall, and shows the token once", async () => {
    const { container } = agentsNode([]);
    await screen.findByText("Legal");
    tick("mail.read");
    tick("mailbox.content.read", "Billing");
    const review = container.querySelector("form .notice")!.outerHTML;
    tick("mailbox.content.read", "Billing");
    tick("mailbox.content.read", "Support");
    tick("message.export", "Support");
    tick("hold.read");
    const whole = container.querySelector("form .notice")!.outerHTML;
    fireEvent.change(screen.getByPlaceholderText("what this agent is for"), { target: { value: "nightly triage" } });
    await act(async () => { screen.getByRole("button", { name: "Mint agent" }).click(); });
    await screen.findByText("tok_secret_once");
    const minted = Array.from(container.querySelectorAll("form .notice")).map((one) => one.outerHTML).join("\n");
    owned(container, ["h1", "form"]);
    await expect(`${review}\n${whole}\n${minted}\n`.replaceAll("><", ">\n<")).toMatchFileSnapshot("./golden/agents.mint.en.html");
  });

  it("renders no agents, a sponsor with no mailbox, and a refused withdraw and mint", async () => {
    const empty = agentsNode([], { mailboxes: [] });
    await screen.findByText("No mailbox on this Node yet.");
    await expect(html(owned(empty.container, ["h1", "form"]))).toMatchFileSnapshot("./golden/agents.empty.en.html");
    empty.unmount();
    reset();
    const refused = agentsNode([agent("agt_live")], { act: REFUSED });
    await act(async () => { (await screen.findByRole("button", { name: "Withdraw" })).click(); });
    await screen.findByText("Refused, for the test.");
    tick("hold.read");
    fireEvent.change(screen.getByPlaceholderText("what this agent is for"), { target: { value: "x" } });
    await act(async () => { screen.getByRole("button", { name: "Mint agent" }).click(); });
    await waitFor(() => { expect(screen.getAllByText("Refused, for the test.")).toHaveLength(2); });
    await expect(notices(refused.container).join("\n") + "\n").toMatchFileSnapshot("./golden/agents.refused.en.txt");
  });
});

/* ---------------------------------------------------------------------------------------- Approvals --- */

function approval(id: string, subjectKind: string, overrides: Record<string, unknown> = {}) {
  return {
    id, subjectKind, subjectId: `sub_${id}`, scopeId: "org_x", actorUserId: "usr_bob", state: "pending",
    requestedAt: INSTANTS[2], resolvedAt: null, expiresAt: INSTANTS[3], stages: [], openStage: null, decidedByMe: false,
    reason: null, supervised: null, pause: null, ...overrides,
  };
}

const APPROVALS = [
  approval("apr_send", "send_manifest", { expiresAt: null }),
  approval("apr_hold", "hold_lift", { stages: [{ count: 1, teamId: null }], openStage: 1, reason: "The matter closed on Friday." }),
  approval("apr_read", "supervised_read", {
    stages: [{ count: 1, teamId: "team_fin" }, { count: 2, teamId: "team_legal" }], openStage: 1, reason: "Investigating a complaint.",
    supervised: { grantId: "sgr_1", subjectId: "usr_cleo", scope: "metadata", matterId: null },
  }),
  approval("apr_read2", "supervised_read", {
    stages: [{ count: 1, teamId: null }, { count: 1, teamId: null }], openStage: null,
    supervised: { grantId: "sgr_2", subjectId: "usr_dan", scope: "content", matterId: "mtr_1" },
  }),
  approval("apr_export", "ediscovery_export", { stages: [{ count: 2, teamId: null }], openStage: 1, decidedByMe: true }),
  approval("apr_pause", "domain_pause", { reason: "Bouncing everything.", pause: { pauseId: "dpz_1", domain: "example.org", reason: "Bouncing everything." } }),
];

function approvalsNode(approvals: unknown[]) {
  answerWith((call) => {
    if (call.method !== "GET") return REFUSED();
    return call.path === "/api/approvals" ? Response.json({ approvals }) : undefined;
  });
  return mount(<Approvals />);
}

describe("Approvals in English", () => {
  it("renders each kind with its stages, lapse and detail, one decided, and a refused approval", async () => {
    const { container } = approvalsNode(APPROVALS);
    await act(async () => { (await screen.findAllByRole("button", { name: "Approve" }))[0]!.click(); });
    await screen.findByRole("alert");
    await expect(html(owned(container, ["h1", ".approval-list", "blockquote", "[role=alert]"]))).toMatchFileSnapshot("./golden/approvals.waiting.en.html");
  });

  it("says nothing is waiting on you", async () => {
    const { container } = approvalsNode([]);
    await screen.findByText("Nothing is waiting on you to decide.");
    await expect(html(owned(container, ["h1", ".notice"]))).toMatchFileSnapshot("./golden/approvals.empty.en.html");
  });
});

describe("the English fixed with the migration", () => {
  it("counts an agent's pinned routes at one and at many", async () => {
    agentsNode([agent("agt_one", { unnamed: ["GET /api/old"] }), agent("agt_two", { unnamed: ["GET /api/a", "GET /api/b"] })]);
    expect((await screen.findByText(/^1 pinned route this Node/)).textContent).toBe("1 pinned route this Node no longer names: GET /api/old");
    expect(screen.getByText(/^2 pinned routes this Node/).textContent).toBe("2 pinned routes this Node no longer names: GET /api/a, GET /api/b");
  });
});

describe("People, Agents and Approvals in Chinese", () => {
  beforeAll(() => {
    install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
  });
  afterAll(() => {
    install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
  });

  it("says People's refusals around the Node's words, which stay English", async () => {
    peopleNode({ withdrawals: "refused", act: (call) => (call.path === "/api/invitations" ? undefined : REFUSED()) });
    const unread = await screen.findByText(/无法读取访问权限的收回记录/);
    expect(unread.innerHTML).toMatch(/：<span lang="en">The trail could not be read\.<\/span>$/);
    const invite = screen.getByRole("region", { name: "邀请成员" });
    fireEvent.change(within(invite).getByLabelText("邮件地址"), { target: { value: "eve@example.test" } });
    fireEvent.click(within(invite).getByLabelText("同时为对方建一个邮箱，邮件地址为"));
    await act(async () => { within(invite).getByText("签发邀请码").click(); });
    expect((await within(invite).findByText(/没有建好邮箱/)).innerHTML).toBe('没有建好邮箱：<span lang="en">Refused, for the test.</span>');
    const teams = screen.getByRole("region", { name: "团队" });
    fireEvent.change(within(teams).getByLabelText("新团队"), { target: { value: "Legal" } });
    await act(async () => { within(teams).getByText("创建").click(); });
    expect((await within(teams).findByRole("alert")).innerHTML).toBe('<span lang="en">Refused, for the test.</span>');
  });

  it("says an address's routing in the Node's words when its state has none of its own", async () => {
    peopleNode({
      act: (call) => (call.path === "/api/addresses" && call.method === "POST"
        ? Response.json({ address: { id: "addr_2", address: "x@example.test", mailboxId: "mbx_sales" }, routing: { state: "not_written", detail: "Run mailda route add." } })
        : undefined),
    });
    const added = await screen.findByRole("region", { name: "新建邮件地址" });
    fireEvent.change(within(added).getByLabelText("邮件地址"), { target: { value: "x" } });
    fireEvent.change(within(added).getByRole("combobox", { name: "邮箱" }), { target: { value: "mbx_sales" } });
    await act(async () => { within(added).getByText("添加此邮件地址").click(); });
    expect((await within(added).findByRole("status")).innerHTML).toBe('x@example.test：<span lang="en">Run mailda route add.</span>');
  });

  it("counts an agent's ceiling in its own units, and keeps the Node's descriptions and notice English", async () => {
    const { container } = agentsNode([]);
    await screen.findByText("Legal");
    tick("mail.read");
    tick("mailbox.content.read", "Support");
    tick("message.export", "Support");
    expect(container.querySelector("form .notice p")!.textContent).toBe("这个代理将持有 1 项能力，涉及 2 项邮箱关系，直到过期或被收回。");
    const says = Array.from(container.querySelectorAll("fieldset label .dim")).map((one) => one.innerHTML);
    expect(says[0]).toBe('<span lang="en">Read mail: list it, open a message, and fetch the original bytes.</span>');
    fireEvent.change(screen.getByPlaceholderText("这个代理的用途"), { target: { value: "nightly triage" } });
    await act(async () => { screen.getByRole("button", { name: "签发代理" }).click(); });
    expect((await screen.findByText("Shown once: only its hash is stored.")).outerHTML).toBe('<span lang="en">Shown once: only its hash is stored.</span>');
  });

  it("names each approval in Chinese, counts what waits, and keeps a refusal English", async () => {
    approvalsNode(APPROVALS);
    expect((await screen.findByText(/项等你决定$/)).textContent).toBe("6 项等你决定");
    expect(screen.getByRole("heading", { name: "暂停一个域名的邮件" })).toBeDefined();
    expect(screen.getByText("第 1 阶段，共 2 个阶段 · 总计 3 项审批")).toBeDefined();
    await act(async () => { screen.getAllByRole("button", { name: "否决" })[0]!.click(); });
    expect((await screen.findByRole("alert")).innerHTML).toBe('<span lang="en">Refused, for the test.</span>');
  });
});
