import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { APP_ROUTES } from "../../src/app-routes.ts";
import { answerMailboxes, answerWith, reset } from "./session-stub.ts";

/**
 * The sidebar: which rows exist, which one is current, and the wordmark.
 *
 * Membership is held by a type (`SIDEBAR_HOME: Record<AppRoute, …>`), so these tests read the record rather
 * than a hand-written list of rows: a route added with a home must appear, and every route must be reachable
 * from the sidebar or a section tab. The current-row tests use the shared router mock, which renders what
 * TanStack's `Link` renders, `aria-current="page"` included, so a row that looks current and is not (or the
 * reverse) is visible here.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

/** A switch for the wordmark test: the brand module as shipped, except for this one flag. */
const brand = vi.hoisted(() => ({ authored: true }));
vi.mock("../../src/brand.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/brand.ts")>();
  return { ...actual, get MARK_IS_AUTHORED() { return brand.authored; } };
});

const { Rail, SIDEBAR_HOME, tabsOf } = await import("../../src/client/app/chrome.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");
const { SectionTabs } = await import("../../src/client/app/ui/section-tabs.tsx");

function mount(pathname: string) {
  route.pathname = pathname;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ShellProvider><Rail /></ShellProvider></QueryClientProvider>);
}

/** The row linking to `to`, by its href: the thing a click follows. */
const rowTo = (to: string) => document.querySelector<HTMLAnchorElement>(`nav.rail a.rail-row[href="${to}"]:not(.rail-mailbox)`);

beforeEach(() => {
  reset();
  brand.authored = true;
});

describe("the sidebar's rows come from SIDEBAR_HOME", () => {
  it("renders every route that has a group as a row, in the record's order within its group", async () => {
    // On /doctor, so the Admin group is expanded and every group's rows are in the DOM.
    mount("/doctor");
    await screen.findByText("Inbox");
    const groups = ["mail", "workspace", "automate", "admin", "foot"] as const;
    for (const group of groups) {
      const expected = APP_ROUTES.filter((one) => SIDEBAR_HOME[one] === group);
      const expectedInOrder = (Object.keys(SIDEBAR_HOME) as Array<keyof typeof SIDEBAR_HOME>)
        .filter((one) => expected.includes(one));
      expect(expectedInOrder.length, `group ${group} has no routes, so this checks nothing`).toBeGreaterThan(0);
      for (const to of expectedInOrder) expect(rowTo(to), `no row for ${to}`).not.toBeNull();
    }
    const mail = [...document.querySelectorAll("ul[aria-labelledby=rail-mail] .rail-name")].map((node) => node.textContent);
    expect(mail).toEqual(["Inbox", "Queue", "Drafts", "Outbox", "Archive", "Trash"]);
  });

  it("reaches every route, by a row or by a section tab over its parent's screen", async () => {
    mount("/doctor");
    await screen.findByText("Inbox");
    for (const to of APP_ROUTES) {
      const home = SIDEBAR_HOME[to];
      if (typeof home === "object") {
        expect(rowTo(home.tabOf), `no row for ${to}'s parent ${home.tabOf}`).not.toBeNull();
        expect(tabsOf(home.tabOf).map((tab) => tab.to), `${to} is not a tab of ${home.tabOf}`).toContain(to);
      } else {
        expect(rowTo(to), `${to} is reachable from nowhere`).not.toBeNull();
      }
    }
  });

  it("gives a route with no tab children a single tab of its own, and Butlers exactly Butlers and Rules", () => {
    expect(tabsOf("/queue").map((tab) => tab.to)).toEqual(["/queue"]);
    expect(tabsOf("/butlers")).toEqual([{ to: "/butlers", label: "Butlers" }, { to: "/rules", label: "Rules" }]);
  });

  it("names Butlers' row Automations, the group word over Butlers and Rules", async () => {
    mount("/");
    expect((await screen.findByText("Automations")).closest("a")?.getAttribute("href")).toBe("/butlers");
  });

  it("hides no group from a reader the directory refuses: navigation is not a second copy of authority", async () => {
    answerWith((call) => (call.path.startsWith("/api/people")
      ? Response.json({ error: "not_found", message: "No directory." }, { status: 404 })
      : undefined));
    mount("/");
    await screen.findByText("Inbox");
    for (const heading of ["Mail", "Workspace", "Automate"]) expect(screen.getByText(heading)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Admin" })).toBeTruthy();
    for (const to of ["/people", "/matters", "/approvals", "/butlers", "/agents", "/settings"]) {
      expect(rowTo(to), `${to} was hidden`).not.toBeNull();
    }
  });
});

describe("which row is current", () => {
  it("marks Automations current, as the page, on /butlers", async () => {
    mount("/butlers");
    const row = (await screen.findByText("Automations")).closest("a")!;
    expect(row.classList.contains("current")).toBe(true);
    expect(row.getAttribute("aria-current")).toBe("page");
  });

  it("marks Automations current in the set, not as the page, on /rules, where its link is not this page", async () => {
    mount("/rules");
    const row = (await screen.findByText("Automations")).closest("a")!;
    expect(row.classList.contains("current")).toBe(true);
    expect(row.getAttribute("aria-current")).toBe("true");
  });

  it("leaves Automations plain elsewhere", async () => {
    mount("/");
    const row = (await screen.findByText("Automations")).closest("a")!;
    expect(row.classList.contains("current")).toBe(false);
    expect(row.getAttribute("aria-current")).toBeNull();
  });

  it("never gives a mailbox row the current fill, even on the Queue it links to", async () => {
    answerMailboxes([{ id: "mbx_a", name: "Support", addresses: "support@example.test", unclaimed: 1 }]);
    mount("/queue");
    const queue = rowTo("/queue")!;
    await waitFor(() => { expect(queue.classList.contains("current")).toBe(true); });
    const mailbox = (await screen.findByText("Support")).closest("a")!;
    expect(mailbox.classList.contains("rail-mailbox")).toBe(true);
    expect(mailbox.classList.contains("current"), "a mailbox row wore the Queue's fill").toBe(false);
  });

  it("marks the current section tab", () => {
    route.pathname = "/rules";
    render(<SectionTabs label="Automations" tabs={tabsOf("/butlers")} />);
    const rules = screen.getByRole("link", { name: "Rules" });
    expect(rules.classList.contains("current")).toBe(true);
    expect(screen.getByRole("link", { name: "Butlers" }).classList.contains("current")).toBe(false);
  });
});

describe("the Admin group", () => {
  it("is collapsed on a mail route, and opens on a click", async () => {
    mount("/");
    const toggle = await screen.findByRole("button", { name: "Admin" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rowTo("/doctor")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rowTo("/doctor")).not.toBeNull();
  });

  it("is expanded on an Admin route, so the current row is never folded away", async () => {
    mount("/doctor");
    const toggle = await screen.findByRole("button", { name: "Admin" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rowTo("/doctor")?.getAttribute("aria-current")).toBe("page");
  });

  it("opens when the route moves into it after mounting", async () => {
    const view = mount("/");
    const toggle = await screen.findByRole("button", { name: "Admin" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    route.pathname = "/limits";
    view.rerender(
      <QueryClientProvider client={new QueryClient()}><ShellProvider><Rail /></ShellProvider></QueryClientProvider>,
    );
    await waitFor(() => { expect(screen.getByRole("button", { name: "Admin" }).getAttribute("aria-expanded")).toBe("true"); });
  });
});

describe("the wordmark", () => {
  it("is the word Mailda beside the mark, while the mark is authored", async () => {
    mount("/");
    const wordmark = await waitFor(() => document.querySelector(".wordmark")!);
    expect(wordmark.textContent).toBe("Mailda");
    expect(wordmark.querySelector("svg")).not.toBeNull();
  });

  it("is the word alone when the mark is not authored, so a placeholder never stands in for the symbol", async () => {
    brand.authored = false;
    mount("/");
    const wordmark = await waitFor(() => document.querySelector(".wordmark")!);
    expect(wordmark.textContent).toBe("Mailda");
    expect(wordmark.querySelector("svg")).toBeNull();
  });
});
