import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * The first-run gate (25 September 2026): an administrator on a Node with no routed address sees the
 * setup steps and the next one, not an inbox. What would render plausibly and be wrong: an inbox on a Node
 * that cannot receive (the founder's report), a member locked out of an app they cannot set up, and a
 * gate that ignores its own override.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Gate } = await import("../../src/client/app/screens/first-run.tsx");
const { SetupUnfinished } = await import("../../src/client/app/onboarding.tsx");

const binding = { state: "no_token", accountId: null, accountName: null, registeredAt: null, verifiedAt: null };
const permissions = [{ name: "Zone Read", scope: "zone", why: "w", optional: false }];
const none = { receiving: null, sending: null, deliveryEvents: null };
const routed = { receiving: { domain: "mail.example.test", at: "2026-09-24T00:00:00.000Z", authority: "operator", address: "hello@mail.example.test" }, sending: null, deliveryEvents: null };

function mount(parts: { addressOk: boolean; provisioned?: unknown; providerStatus?: number }, child = <div>THE INBOX</div>) {
  answerWith((call) => {
    if (call.path === "/api/provider") {
      if (parts.providerStatus !== undefined) return Response.json({ error: "not_found" }, { status: parts.providerStatus });
      return Response.json({ provider: binding, provisioned: parts.provisioned ?? none, permissions, note: "n" });
    }
    if (call.path === "/api/doctor") {
      return Response.json({ verdict: "ok", claimed: true, at: "2026-09-25T00:00:00.000Z", findings: [
        { check: "inbound_routing", severity: "report", ok: parts.addressOk, detail: "prose" },
      ] });
    }
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Gate>{child}</Gate></QueryClientProvider>);
}

describe("the first-run gate", () => {
  beforeEach(() => { reset(); route.pathname = "/"; try { sessionStorage.clear(); } catch { /* no storage in this runner */ } });

  it("shows the steps and the terminal command, and not the inbox, on a Node with no routed address", async () => {
    mount({ addressOk: false });
    expect(await screen.findByRole("heading", { name: "This Node is not ready to use yet" })).toBeTruthy();
    expect(screen.getByText("curl -fsSL https://mailda.site/update.sh | bash")).toBeTruthy();
    expect(screen.getByText(/Next: an address to receive at/)).toBeTruthy();
    expect(screen.queryByText("THE INBOX")).toBeNull();
  });

  it("shows the inbox once an address exists and the audit trail records mail routed here", async () => {
    mount({ addressOk: true, provisioned: routed });
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This Node is not ready to use yet" })).toBeNull();
  });

  it("does not gate a member, who is refused the provider read and cannot set anything up", async () => {
    mount({ addressOk: false, providerStatus: 404 });
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
  });

  /*
   * Found by the pseudo-locale (T4, 2 October 2026). The shell under the gate reads the provider too (the setup
   * notice). A second reader mounting on a failed read refetches it, the read goes back to pending, and a gate that
   * showed loading then unmounted the shell, whose reader mounted again when the read failed: about one read a second,
   * and a screen flipping between loading and the shell, for every member.
   */
  it("keeps the shell for a member once it has decided, rather than re-reading the provider in a loop", async () => {
    mount({ addressOk: false, providerStatus: 404 }, <><SetupUnfinished /><div>THE INBOX</div></>);
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
    for (let tick = 0; tick < 20; tick += 1) await act(async () => { await new Promise((done) => setTimeout(done, 25)); });
    expect(calls.filter((call) => call.path === "/api/provider").length).toBeLessThanOrEqual(2);
    expect(screen.getByText("THE INBOX")).toBeTruthy();
  });

  it("lets an administrator open the app anyway, for this tab", async () => {
    mount({ addressOk: false });
    fireEvent.click(await screen.findByText("Open the app anyway"));
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
  });

  it("renders /setup as itself, since the from-this-screen way happens there", async () => {
    route.pathname = "/setup";
    mount({ addressOk: false });
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
  });

  it("renders /doctor as itself, since it is the diagnostic a Node that is not working needs", async () => {
    route.pathname = "/doctor";
    mount({ addressOk: false });
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
  });

  it("renders /settings as itself, so a gated administrator can always sign out", async () => {
    // The sign-outs moved from the bottom bar to Settings; a gate over Settings would leave no way out.
    route.pathname = "/settings";
    mount({ addressOk: false });
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
  });
});
