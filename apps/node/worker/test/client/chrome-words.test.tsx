import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answer, answerMailboxes, answerWith, reset } from "./session-stub.ts";

/**
 * The chrome's English, character for character (ADR 46).
 *
 * Moving the chrome's words into the catalog must not change one of them for an English reader: the sentences
 * the Node's notices are assembled into, the sidebar, the health popover, the chooser, the palette and the shared
 * empty states. Written against the code before the move and kept after it, so a key that lost a space, a middle
 * dot or a fallback is a failure here rather than a difference nobody reads until it ships.
 */

type HappyDom = { happyDOM: { setViewport(size: { width: number; height: number }): void } };

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Copyable, Nothing, Notices, Rail, Shell, StatusBar, Truncated } = await import("../../src/client/app/chrome.tsx");
const { ShellProvider, useCompose } = await import("../../src/client/app/shell-context.tsx");
const { CommandPalette } = await import("../../src/client/app/ui/palette.tsx");

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  reset();
  route.pathname = "/";
});

describe("the notices band", () => {
  it("assembles each notice's sentence from its recorded facts, and says so where a fact is absent", async () => {
    answer("/api/notifications", () => ({
      truncated: true,
      notifications: [
        {
          id: "ntf_1", kind: "supervised_read", subjectId: "sgr_1", mailboxId: "mbx_1", matterId: "mat_1", dueAt: null,
          deliveredAt: null,
          body: {
            readerEmail: "legal@example.test", mailboxName: "Support", scope: "content", grantedAt: "2026-09-26T09:00:00Z",
            expiresAt: "2026-09-27T09:00:00Z", matterId: "mat_1", matterType: "legal_hold", grantId: "sgr_1",
            acts: { queries: 1, listed: 1, opened: 3, attachments: 1 },
          },
        },
        {
          id: "ntf_2", kind: "supervised_read", subjectId: "sgr_2", mailboxId: null, matterId: null, dueAt: null,
          deliveredAt: null, body: { acts: { queries: 4 } },
        },
        {
          id: "ntf_3", kind: "approval_request", subjectId: "apr_1", mailboxId: null, matterId: null, dueAt: null,
          deliveredAt: null,
          body: { subjectKind: "send_manifest", approvalId: "apr_1", requestedBy: "ops@example.test", requestedAt: "2026-09-26T10:00:00Z" },
        },
        {
          id: "ntf_4", kind: "approval_request", subjectId: "apr_2", mailboxId: null, matterId: null, dueAt: null,
          deliveredAt: null, body: null,
        },
      ],
    }));
    render(<QueryClientProvider client={client()}><Notices /></QueryClientProvider>);
    const band = await screen.findByRole("region", { name: "Notifications" });
    // Each instant in the viewer's zone and locale (D37), the approval's subject in words, the matter's type in its
    // words (`matters.type.*`), and the grant's scope as the Node's token, in <code>.
    const local = (at: string) => new Date(at).toLocaleString();
    expect([...band.querySelectorAll(".notice.told")].map((notice) => notice.textContent)).toEqual([
      `legal@example.test was granted a supervised content of Support, ${local("2026-09-26T09:00:00Z")} to ${local("2026-09-27T09:00:00Z")}. `
        + "1 query listing 1 message · 3 opened · 1 raw message read · matter mat_1 (legal hold) · grant sgr_1",
      "somebody was granted a supervised read of a mailbox, at an unrecorded instant to an unrecorded instant. "
        + "4 queries listing 0 messages · 0 opened · 0 raw messages read · matter none cited · grant sgr_2",
      `You were asked to decide an approval (a send). request apr_1 · asked by ops@example.test · ${local("2026-09-26T10:00:00Z")}`,
      "You were asked to decide an approval (an act). request apr_2 · asked by somebody · an unrecorded instant",
    ]);
    expect(band.querySelector(".notice.told code")?.textContent).toBe("content");
    expect(band.querySelector(".notice.dim")?.textContent).toBe("Showing the newest 4 notices. Older ones exist and are not listed.");
  });
});

describe("the sidebar", () => {
  it("names every group and row, the mailbox's work, and what was accepted and not parsed", async () => {
    answerMailboxes([{ id: "mbx_1", name: "Support", addresses: "support@example.test", unclaimed: 2, claimed: 1, mine: 1 }]);
    answerWith((call) => (call.path.startsWith("/api/messages")
      ? Response.json({ messages: [{ id: "rcpt_1", parse_error: "bad" }], next_cursor: null, lookback_exhausted: false })
      : undefined));
    render(<QueryClientProvider client={client()}><ShellProvider><Rail /></ShellProvider></QueryClientProvider>);
    const mailbox = await screen.findByTitle("2 unclaimed, 1 in progress, 1 mine");
    expect(mailbox.textContent).toBe("Support2 · 1 mine");
    await screen.findByText("1 unparsed");
    const nav = screen.getByRole("navigation", { name: "Navigation" });
    expect([...nav.querySelectorAll(".rail-heading, .rail-group-toggle")].map((one) => one.textContent))
      .toEqual(["Mail", "Workspace", "Automate", "Admin"]);
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect([...nav.querySelectorAll(".rail-name")].map((one) => one.textContent)).toEqual([
      "Inbox", "Queue", "Drafts", "Outbox", "Archive", "Trash", "Support", "People", "Matters", "Approvals", "Automations",
      "Agents", "Doctor", "Limits", "Audit", "Log", "Setup", "Settings",
    ]);
    expect(nav.querySelector(".wordmark")?.textContent).toBe("Mailda");
    expect(screen.getByRole("button", { name: "Compose" }).getAttribute("title")).toBe("Compose (C)");
  });

  it("titles the narrow layout's bar with the screen, and the product where no screen matches", async () => {
    (window as unknown as HappyDom).happyDOM.setViewport({ width: 390, height: 800 });
    route.pathname = "/queue";
    const { unmount } = render(<QueryClientProvider client={client()}><ShellProvider><Shell /></ShellProvider></QueryClientProvider>);
    expect(document.querySelector(".mobile-title")?.textContent).toBe("Queue");
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeTruthy();
    unmount();
    route.pathname = "/nowhere";
    render(<QueryClientProvider client={client()}><ShellProvider><Shell /></ShellProvider></QueryClientProvider>);
    expect(document.querySelector(".mobile-title")?.textContent).toBe("Mailda");
    expect(screen.getByRole("contentinfo", { name: "Node status" })).toBeTruthy();
  });
});

describe("the health popover", () => {
  it("says when the doctor last looked, where, and what is waiting to go out", async () => {
    answerWith((call) => (call.path === "/api/doctor"
      ? Response.json({ verdict: "ok", claimed: true, at: new Date(Date.now() - 120_000).toISOString(), findings: [] })
      : undefined));
    const cache = client();
    cache.setQueryData(["sends"], {
      truncated: true, daily: { handedOver: 7 },
      sends: [{ state: "held" }, { state: "awaiting" }, { state: "awaiting" }, { state: "handed_over" }],
    });
    render(<QueryClientProvider client={cache}><StatusBar /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Health: ok" }));
    const popover = screen.getByRole("dialog", { name: "Health" });
    const meta = [...popover.querySelectorAll(".health-meta")].map((one) => one.textContent);
    expect(meta[0]).toBe("Outbound: handed over today 7 · held 1+ · awaiting 2+");
    expect(meta[1]).toMatch(new RegExp(`^Last health check \\d{2}:\\d{2}:\\d{2} · 2 minutes agoThis Node ${location.host}$`));
    expect(popover.querySelector(".health-title")?.textContent).toBe("Health ok");
    expect(within(popover).getByRole("link", { name: "Open Doctor" })).toBeTruthy();
  });
});

describe("the mailbox chooser", () => {
  function Start() {
    const compose = useCompose();
    return (
      <button type="button" onClick={() => compose.start([
        { id: "mbx_1", name: "Support", addresses: "support@example.test,help@example.test", unclaimed: 0, claimed: 0, mine: 0 },
        { id: "mbx_2", name: "Sales", addresses: null, unclaimed: 0, claimed: 0, mine: 0 },
      ] as never)}>start</button>
    );
  }

  it("names each mailbox by its first address, or says it has none", () => {
    render(<QueryClientProvider client={client()}><ShellProvider><Start /></ShellProvider></QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a mailbox" });
    expect([...dialog.querySelectorAll("option")].map((one) => one.textContent))
      .toEqual(["Choose a mailbox…", "Support · support@example.test", "Sales (no address)"]);
    expect(dialog.querySelector("label")?.textContent).toBe("Send from");
    expect(within(dialog).getByRole("button", { name: "Start message" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});

describe("the palette", () => {
  it("lists Compose and one Go to per route, each with its group, and offers the search as typed", () => {
    render(<QueryClientProvider client={client()}><ShellProvider><CommandPalette /></ShellProvider></QueryClientProvider>);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "ComposeCMail", "Go to InboxGo to", "Go to QueueGo to", "Go to ApprovalsGo to", "Go to RulesGo to",
      "Go to PeopleGo to", "Go to MattersGo to", "Go to ButlersGo to", "Go to AgentsGo to", "Go to LimitsGo to",
      "Go to OutboxGo to", "Go to AuditGo to", "Go to LogGo to", "Go to DoctorGo to", "Go to SetupGo to",
      "Go to DraftsGo to", "Go to ArchiveGo to", "Go to TrashGo to", "Go to SettingsGo to",
    ]);
    const input = screen.getByRole("combobox", { name: "Go to or do" }) as HTMLInputElement;
    expect(input.placeholder).toBe("Go to or do…");
    fireEvent.change(input, { target: { value: "invoice" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Search mail for “invoice”Mail"]);
  });
});

describe("the shared states", () => {
  it("says loading, unreadable, empty and capped in the same words", () => {
    render(
      <QueryClientProvider client={client()}>
        <div data-testid="states">
          <Nothing kind="loading" />
          <Nothing kind="failed" />
          <Nothing kind="empty" />
          <Nothing kind="empty" unfiltered />
          <Truncated when shown={50} noun="drafts" />
          <Truncated when shown={1} noun="drafts" />
          <Copyable text="mailda upgrade" label="command" />
        </div>
      </QueryClientProvider>,
    );
    expect([...screen.getByTestId("states").children].map((one) => one.textContent)).toEqual([
      "Reading…",
      "This could not be read. That is different from it being empty.",
      "Nothing here yet.",
      "Nothing here yet. An empty ledger. Not a filtered one: nothing has been hidden from you.",
      "Showing the newest 50 drafts. Older ones exist and are not listed.",
      "Showing the newest one. Older ones exist and are not listed.",
      "mailda upgradeCopy command",
    ]);
  });
});
