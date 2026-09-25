import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, reset } from "./session-stub.ts";

/**
 * The first-run gate (25 September 2026): an administrator on a Node with no routed address sees the
 * setup steps and the next one, not an inbox. What would render plausibly and be wrong: an inbox on a Node
 * that cannot receive (the founder's report), a member locked out of an app they cannot set up, and a
 * gate that ignores its own override.
 */

let pathname = "/";
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) => select({ location: { pathname } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Gate } = await import("../../src/client/app/screens/first-run.tsx");

const binding = { state: "no_client", evidence: "observed", clientId: null, redirectUri: null, registeredAt: null, accountId: null, grantedAt: null, scopesGranted: null, scopesMissing: [], refusedDetail: null };
const ceremony = { steps: ["x"], redirectUri: "https://n/cb", scopes: [{ scope: "zone.read", why: "w", readOnlyExists: true }], unmeasured: "u", token: { url: "https://dash.cloudflare.com/", permission: "p", unmeasured: "u" } };
const none = { receiving: null, sending: null, deliveryEvents: null };
const routed = { receiving: { domain: "mail.example.test", at: "2026-09-24T00:00:00.000Z", authority: "operator", address: "hello@mail.example.test" }, sending: null, deliveryEvents: null };

function mount(parts: { addressOk: boolean; provisioned?: unknown; providerStatus?: number }) {
  answerWith((call) => {
    if (call.path === "/api/provider") {
      if (parts.providerStatus !== undefined) return Response.json({ error: "not_found" }, { status: parts.providerStatus });
      return Response.json({ provider: binding, provisioned: parts.provisioned ?? none, ceremony });
    }
    if (call.path === "/api/doctor") {
      return Response.json({ verdict: "ok", claimed: true, at: "2026-09-25T00:00:00.000Z", findings: [
        { check: "inbound_routing", severity: "report", ok: parts.addressOk, detail: "prose" },
      ] });
    }
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Gate><div>THE INBOX</div></Gate></QueryClientProvider>);
}

describe("the first-run gate", () => {
  beforeEach(() => { reset(); pathname = "/"; try { sessionStorage.clear(); } catch { /* no storage in this runner */ } });

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

  it("lets an administrator open the app anyway, for this tab", async () => {
    mount({ addressOk: false });
    fireEvent.click(await screen.findByText("open the app anyway"));
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
  });

  it("renders /setup as itself, since the from-this-screen way happens there", async () => {
    pathname = "/setup";
    mount({ addressOk: false });
    expect(await screen.findByText("THE INBOX")).toBeTruthy();
  });
});
