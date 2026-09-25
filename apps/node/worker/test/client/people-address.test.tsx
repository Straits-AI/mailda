import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * Adding an address on People writes its routing in the same act (25 September 2026), and the screen must
 * render the half a person cannot see: whether Cloudflare routes it. `not_written` arrives whole, because
 * its detail names the command that finishes the job.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/people" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { People } = await import("../../src/client/app/screens/people.tsx");

const BOX = { id: "mbx_test", name: "Support", unclaimed: 0, claimed: 0, mine: 0, first_response_minutes: null, quarantine_dmarc_fail: 0, quarantine_dangerous_attachments: 0, quarantined: 0, breached: 0, addresses: "support@example.test" };

function mount(routing: { state: string; detail: string }, boxes = [BOX]) {
  answerWith((call) => {
    if (call.path === "/api/addresses" && call.method === "POST") {
      return Response.json({ address: { id: "addr_1", address: (call.body as { address: string }).address, mailboxId: "mbx_test" }, routing });
    }
    if (call.path.startsWith("/api/mailboxes")) return Response.json({ mailboxes: boxes });
    if (call.path === "/api/me") return Response.json({ signedIn: true, principalId: "usr_me", principalKind: "user", userId: "usr_me", delegatorUserId: null, organizationId: "org_x", email: "me@example.test" });
    if (call.path.startsWith("/api/people")) return Response.json({ people: [] });
    if (call.path.startsWith("/api/invitations")) return Response.json({ invitations: [] });
    if (call.path.startsWith("/api/teams")) return Response.json({ teams: [] });
    if (call.path.startsWith("/api/auth/passkeys")) return Response.json({ passkeys: [] });
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><People /></QueryClientProvider>);
}

// By id: the invite form has an "Address" label too, so the label alone matches twice.
async function field() {
  await screen.findByText("add the address");
  return document.querySelector("#new-address") as HTMLInputElement;
}
async function add(address: string) {
  fireEvent.change(await field(), { target: { value: address } });
  fireEvent.click(screen.getByText("add the address"));
}
const status = async () => (await screen.findByRole("status")).textContent ?? "";

describe("adding an address on People", () => {
  beforeEach(reset);

  it("posts the address and the one mailbox's id, and says the catch-all routes it", async () => {
    mount({ state: "catch_all", detail: "" });
    await add("hello@example.test");
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "POST" && call.path === "/api/addresses");
      expect(sent, "the address was never sent").toBeDefined();
      expect(sent!.body).toEqual({ address: "hello@example.test", mailboxId: "mbx_test" });
    });
    expect(await status()).toContain("hello@example.test: routed by the domain's catch-all; nothing to do in Cloudflare");
  });

  it("says a rule was written when it was", async () => {
    mount({ state: "rule_written", detail: "" });
    await add("sales@example.test");
    expect(await status()).toContain("sales@example.test: routing rule written");
  });

  it("renders not_written's detail whole, because it names the command that finishes the job", async () => {
    const detail = "no credential could write the rule. Run: mailda provider --onboard-receiving example.test --address ops@example.test --url https://node";
    mount({ state: "not_written", detail });
    await add("ops@example.test");
    expect(await status()).toContain(detail);
  });

  it("asks which mailbox when there are several, and sends the chosen one", async () => {
    mount({ state: "rule_written", detail: "" }, [BOX, { ...BOX, id: "mbx_two", name: "Invoices" }]);
    fireEvent.change(await field(), { target: { value: "bills@example.test" } });
    fireEvent.change(screen.getByLabelText("Mailbox"), { target: { value: "mbx_two" } });
    fireEvent.click(screen.getByText("add the address"));
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "POST" && call.path === "/api/addresses");
      expect(sent!.body).toEqual({ address: "bills@example.test", mailboxId: "mbx_two" });
    });
  });
});
