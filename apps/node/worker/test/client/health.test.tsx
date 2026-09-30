import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, reset, seen } from "./session-stub.ts";

/**
 * The status bar and its health popover (D9).
 *
 * What would render plausibly and be wrong: a verdict reworded into something friendlier than the doctor
 * said; an area reading "ok" for a member whose report had the failing check withheld; "ok" for an area
 * nothing checked; a popover whose own `useDoctor` quietly re-runs a ~220-subrequest report every time it
 * opens; and "Connected" printed whatever the Node is doing, which is what the old bar's "listening" was.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { StatusBar } = await import("../../src/client/app/chrome.tsx");
const { healthRows } = await import("../../src/client/app/health.ts");

type Finding = { check: string; severity: "refuse" | "degraded" | "report"; ok: boolean; detail: string };
const finding = (check: string, ok: boolean, severity: Finding["severity"] = "degraded"): Finding =>
  ({ check, severity, ok, detail: "prose" });
const report = (verdict: string, findings: Finding[]) =>
  ({ verdict, claimed: true, at: "2026-09-26T09:00:00.000Z", findings });

function mount(doctor: unknown, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  answerWith((call) => (call.path === "/api/doctor" ? Response.json(doctor) : undefined));
  render(<QueryClientProvider client={client}><StatusBar /></QueryClientProvider>);
  return client;
}

async function openPopover() {
  fireEvent.click(await screen.findByRole("button", { name: /^Health:/ }));
  return screen.getByRole("dialog", { name: "Health" });
}

/** Each row's label and status, as the popover prints them. */
function rows(popover: HTMLElement): Array<[string, string]> {
  return [...popover.querySelectorAll(".health-row")].map((row) => [
    row.querySelector(".health-area")!.textContent!,
    row.querySelector(".state, .health-absent")!.textContent!,
  ]);
}

beforeEach(reset);
afterEach(() => { onlineManager.setOnline(true); });

describe("the verdict", () => {
  it("is the doctor's own word, verbatim", async () => {
    mount(report("degraded", [finding("recovery_escrow", false)]));
    const button = await screen.findByRole("button", { name: "Health: degraded" });
    expect(button.querySelector(".verdict-degraded")?.textContent).toBe("degraded");
  });

  it("says it could not be read, rather than nothing, when the report fails", async () => {
    answerWith((call) => (call.path === "/api/doctor"
      ? Response.json({ error: "E_X", message: "The doctor could not run: the catalog is unreachable." }, { status: 503 })
      : undefined));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StatusBar /></QueryClientProvider>);
    await screen.findByRole("button", { name: "Health: could not be read" });
    const popover = await openPopover();
    expect(within(popover).getByRole("alert").textContent).toBe("The doctor could not run: the catalog is unreachable.");
    expect(within(popover).getByRole("link", { name: "Open Doctor" }).getAttribute("href")).toBe("/doctor");
  });
});

describe("the six areas", () => {
  it("lists the six areas in order, each with the worst failing severity or ok", async () => {
    mount(report("refuse", [
      finding("inbound_routing", true), finding("outbox_draining", false, "report"),
      finding("key_vault", false, "refuse"), finding("evidence_present", false, "degraded"),
      finding("evidence_orphans", false, "report"), finding("butler_execution", true), finding("recovery_escrow", true),
    ]));
    const popover = await openPopover();
    expect(rows(popover)).toEqual([
      ["Inbound routing", "ok"],
      ["Outbound delivery", "report · 1 failing"],
      ["Worker and keys", "refuse · 1 failing"],
      ["Database and storage", "degraded · 2 failing"],
      ["Automation", "ok"],
      ["Access and recovery", "ok"],
    ]);
  });

  it("reads an area an administrator's report has no check in as no checks, never ok", async () => {
    mount(report("ok", [finding("inbound_routing", true)]));
    const popover = await openPopover();
    expect(rows(popover)[1]).toEqual(["Outbound delivery", "no checks"]);
  });

  it("reads a member's reduced report as ok in your checks, and says the verdict counts what was withheld", async () => {
    /*
     * The member's report drops every finding that discloses data but keeps the full report's verdict, so
     * "degraded" here can be a withheld storage failure. An area whose visible checks all pass is therefore
     * "ok in your checks", and plain "ok" would be a claim this reader's report cannot support.
     */
    mount(report("degraded", [
      finding("report_reduced", true, "report"), finding("inbound_routing", true), finding("evidence_bucket_reachable", true),
    ]));
    const popover = await openPopover();
    const printed = rows(popover);
    expect(printed[0]).toEqual(["Inbound routing", "ok in your checks"]);
    expect(printed[3]).toEqual(["Database and storage", "ok in your checks"]);
    expect(printed.every(([, status]) => status !== "ok"), "a reduced report printed plain ok").toBe(true);
    expect(within(popover).getByText(/Some checks describe this organisation's mail and are for administrators/)).toBeTruthy();
  });

  it("colours an ok-in-your-checks row as ok, since nothing it shows failed", async () => {
    mount(report("degraded", [finding("report_reduced", true, "report"), finding("inbound_routing", true)]));
    const popover = await openPopover();
    expect(popover.querySelector(".health-row .state")?.className).toBe("state verdict-ok");
  });

  it("reads an area absent from a reduced report as not in your report", async () => {
    mount(report("ok", [finding("report_reduced", true, "report"), finding("inbound_routing", true)]));
    const popover = await openPopover();
    expect(rows(popover)[4]).toEqual(["Automation", "not in your report"]);
  });

  it("puts a check this client does not know under Other checks, rather than dropping it", async () => {
    mount(report("degraded", [finding("inbound_routing", true), finding("a_check_from_a_newer_node", false)]));
    const popover = await openPopover();
    expect(rows(popover).at(-1)).toEqual(["Other checks", "degraded · 1 failing"]);
  });

  it("shows no Other checks row when every check is known", () => {
    const { rows: printed } = healthRows(report("ok", [finding("inbound_routing", true)]) as never);
    expect(printed.map((row) => row.area)).not.toContain("other");
  });
});

describe("what the popover reads", () => {
  it("marks held and awaiting with + when the sends it counted are a truncated page", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["sends"], {
      sends: [{ state: "held" }, { state: "awaiting" }, { state: "handed_over" }], truncated: true,
      daily: { handedOver: 3 },
    });
    mount(report("ok", [finding("inbound_routing", true)]), client);
    const popover = await openPopover();
    expect(within(popover).getByText(/^Outbound:/).textContent).toBe("Outbound: handed over today 3 · held 1+ · awaiting 1+");
  });

  it("makes no doctor request of its own, even when the report it was handed is stale", async () => {
    /*
     * A second `useDoctor` observer mounting while the report is more than a minute old refetches it, and a
     * doctor run costs up to ~220 subrequests. Aging the cached report past the hook's 60 s staleTime is what
     * makes a mounting observer fetch, so this is the state in which anything the open popover mounts that
     * calls `useDoctor` would show. (A call in the always-mounted popover component itself mounts with the
     * bar, not on open, and costs no request here; the content is what appears on open.)
     */
    const client = mount(report("ok", [finding("inbound_routing", true)]));
    await screen.findByRole("button", { name: "Health: ok" });
    expect(seen("/api/doctor")).toHaveLength(1);
    act(() => {
      client.setQueryData(["doctor"], report("ok", [finding("inbound_routing", true)]), { updatedAt: Date.now() - 120_000 });
    });
    await openPopover();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen("/api/doctor"), "opening the popover ran the doctor again").toHaveLength(1);
  });
});

describe("when the report was taken", () => {
  it.each([
    [30, "30 seconds ago"],
    [60, "1 minute ago"],
    [170, "3 minutes ago"],
    [3_600, "1 hour ago"],
  ])("says a report %i s old was taken %s", async (secondsAgo, words) => {
    const at = new Date(Date.now() - secondsAgo * 1000).toISOString();
    mount({ ...report("ok", [finding("inbound_routing", true)]), at });
    const popover = await openPopover();
    expect(within(popover).getByText(/^Last health check/).textContent).toContain(` · ${words}`);
  });
});

describe("the connection word is derived, never a literal", () => {
  it("starts from what the cache already holds when the bar mounts: no answer", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery({ queryKey: ["earlier"], queryFn: () => Promise.reject(new TypeError("Failed to fetch")) })
      .catch(() => undefined);
    answerWith((call) => (call.path === "/api/doctor" ? new Promise(() => {}) : undefined));
    render(<QueryClientProvider client={client}><StatusBar /></QueryClientProvider>);
    expect(screen.getByText("Unreachable")).toBeTruthy();
  });

  it("starts from what the cache already holds: an answer, even a refusal after an earlier success", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery({ queryKey: ["earlier"], queryFn: () => Promise.resolve(1) });
    await client.fetchQuery({ queryKey: ["earlier"], queryFn: () => Promise.reject(new SyntaxError("not JSON")), staleTime: 0 })
      .catch(() => undefined);
    answerWith((call) => (call.path === "/api/doctor" ? new Promise(() => {}) : undefined));
    render(<QueryClientProvider client={client}><StatusBar /></QueryClientProvider>);
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("says Offline when the browser is offline, in the same live region that said Connected", async () => {
    mount(report("ok", []));
    await screen.findByText("Connected");
    // One always-mounted status region, so a screen reader hears the change rather than nothing.
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("Connected");
    act(() => { onlineManager.setOnline(false); });
    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(screen.getByRole("status"), "the live region was replaced rather than changed").toBe(region);
    expect(region.textContent).toBe("Offline");
  });

  it("says Unreachable when a request got no answer at all", async () => {
    answerWith((call) => {
      if (call.path === "/api/doctor") throw new TypeError("Failed to fetch");
      return undefined;
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StatusBar /></QueryClientProvider>);
    expect(await screen.findByText("Unreachable")).toBeTruthy();
  });

  it("says Connected when the Node answered with a refusal", async () => {
    answerWith((call) => (call.path === "/api/doctor"
      ? Response.json({ error: "E_X", message: "no" }, { status: 500 })
      : undefined));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StatusBar /></QueryClientProvider>);
    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("says Connected when something answered with a page that is not JSON", async () => {
    answerWith((call) => (call.path === "/api/doctor" ? new Response("<html>a proxy</html>", { status: 200 }) : undefined));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><StatusBar /></QueryClientProvider>);
    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("says Checking… before any request has settled", () => {
    answerWith((call) => (call.path === "/api/doctor" ? new Promise(() => {}) : undefined));
    render(<QueryClientProvider client={new QueryClient()}><StatusBar /></QueryClientProvider>);
    expect(screen.getByText("Checking…")).toBeTruthy();
  });
});
