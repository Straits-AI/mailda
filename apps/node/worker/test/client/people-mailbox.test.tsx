import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * A mailbox's addresses and name on People (26 September 2026), and a team's name beside its roster. Removing
 * an address renders what became of its rule in the same words adding does, and `not_removed` arrives whole.
 */

const route = vi.hoisted(() => ({ pathname: "/people" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { People } = await import("../../src/client/app/screens/people.tsx");

const BOX = { id: "mbx_test", name: "Support", unclaimed: 0, claimed: 0, mine: 0, first_response_minutes: null, quarantine_dmarc_fail: 0, quarantine_dangerous_attachments: 0, quarantined: 0, breached: 0, addresses: "support@example.test,help@example.test" as string | null };

function mount(opts: {
  removal?: { state: string; detail: string }; box?: typeof BOX; teams?: Array<{ id: string; name: string; createdAt: string; memberCount: number }>;
  forwards?: unknown[];
} = {}) {
  answerWith((call) => {
    if (call.path === "/api/forwards" && call.method === "GET") return Response.json({ forwards: opts.forwards ?? [] });
    if (call.path === "/api/forwards" && call.method === "POST") {
      const body = call.body as { address: string; to: string[] };
      return Response.json({ forwards: { address: body.address, to: body.to.map((one) => one.toLowerCase()) } });
    }
    if (call.path === "/api/provider") {
      return Response.json({ provider: { state: "no_token" }, permissions: [], note: "", provisioned: { receiving: null, sending: null, deliveryEvents: null } });
    }
    if (call.path === "/api/addresses" && call.method === "DELETE") {
      return Response.json({ address: { id: "addr_1", address: (call.body as { address: string }).address, mailboxId: "mbx_test" }, routing: opts.removal ?? { state: "catch_all", detail: "" } });
    }
    if (call.path.startsWith("/api/mailboxes/") && call.method === "PATCH") return Response.json({ mailboxId: "mbx_test", name: "Renamed" });
    if (call.path.startsWith("/api/mailboxes")) return Response.json({ mailboxes: [opts.box ?? BOX] });
    if (call.path === "/api/me") return Response.json({ signedIn: true, principalId: "usr_me", principalKind: "user", userId: "usr_me", delegatorUserId: null, organizationId: "org_x", email: "me@example.test" });
    if (call.path.startsWith("/api/people")) return Response.json({ people: [] });
    if (call.path.startsWith("/api/invitations")) return Response.json({ invitations: [] });
    if (call.path.endsWith("/rename") && call.method === "POST") return Response.json({ team: { id: "team_1", name: "Legal", createdAt: "2026-09-26T00:00:00.000Z" } });
    if (call.path.endsWith("/members")) return Response.json({ members: [] });
    if (call.path.startsWith("/api/teams")) return Response.json({ teams: opts.teams ?? [] });
    if (call.path.startsWith("/api/auth/passkeys")) return Response.json({ passkeys: [] });
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><People /></QueryClientProvider>);
}

const status = async () => (await screen.findByRole("status")).textContent ?? "";

describe("a mailbox's addresses on People", () => {
  beforeEach(reset);

  it("lists every address the mailbox carries, with a remove beside each", async () => {
    mount();
    const list = await screen.findByLabelText("Addresses of Support");
    expect(Array.from(list.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "support@example.test Remove Change forwards", "help@example.test Remove Change forwards",
    ]);
  });

  it("says a mailbox with no address routes nothing, rather than listing nothing", async () => {
    mount({ box: { ...BOX, addresses: null } });
    await screen.findByText(/No address yet: nothing is routed here/);
  });

  it("sends DELETE with the address and says the catch-all needed nothing", async () => {
    mount();
    const list = await screen.findByLabelText("Addresses of Support");
    fireEvent.click(Array.from(list.querySelectorAll("button")).filter((one) => one.textContent === "Remove")[1]!);
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "DELETE" && call.path === "/api/addresses");
      expect(sent, "the removal was never sent").toBeDefined();
      expect(sent!.body).toEqual({ address: "help@example.test" });
    });
    expect(await status()).toBe("help@example.test: removed; the domain's catch-all needed nothing");
  });

  it("says the rule went with it, and renders not_removed's detail whole", async () => {
    mount({ removal: { state: "rule_removed", detail: "" } });
    fireEvent.click((await screen.findByLabelText("Addresses of Support")).querySelector("button")!);
    expect(await status()).toBe("support@example.test: removed, and its routing rule deleted");
  });

  it("renders not_removed's detail whole, because it names where the rule still is", async () => {
    const detail = "the rule for support@example.test is forward to x@gmail.test, not this Node, so it was left alone. delete the rule in the Cloudflare dashboard";
    mount({ removal: { state: "not_removed", detail } });
    fireEvent.click((await screen.findByLabelText("Addresses of Support")).querySelector("button")!);
    expect(await status()).toBe(`support@example.test: ${detail}`);
  });

  it("sets where an address forwards through one box, the list as typed, and says what it did (ADR 47 amended)", async () => {
    mount();
    const list = await screen.findByLabelText("Addresses of Support");
    fireEvent.click(Array.from(list.querySelectorAll("button")).filter((one) => one.textContent === "Change forwards")[0]!);
    const field = (await screen.findByLabelText("Forward support@example.test to")) as HTMLInputElement;
    expect(screen.getByText(/separated by commas, up to \d+\. Each message is stored here first/)).toBeDefined();
    fireEvent.change(field, { target: { value: " A@gmail.test, b@gmail.test ," } });
    fireEvent.click(screen.getByRole("button", { name: "Save forwards" }));
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "POST" && call.path === "/api/forwards");
      expect(sent, "the forwards were never sent").toBeDefined();
      expect(sent!.body).toEqual({ address: "support@example.test", to: ["A@gmail.test", "b@gmail.test"] });
    });
    expect(await status()).toBe("support@example.test forwards to a@gmail.test, b@gmail.test.");
  });

  it("draws one line per destination, and the copy setting once", async () => {
    const row = (to: string, last: unknown) => ({
      address: "support@example.test", mailboxId: "mbx_test", to, verified: "verified", checkedAt: null, last, lastHandedOverAt: null, copy: null,
    });
    mount({ forwards: [
      row("a@gmail.test", { state: "handed_over", at: "2026-10-07T00:00:00.000Z", error: null, copy: null }),
      row("b@gmail.test", { state: "refused", at: "2026-10-07T00:00:00.000Z", error: "destination address not verified", copy: null }),
    ] });
    const item = (await screen.findByText("support@example.test")).closest("li")!;
    await waitFor(() => expect(item.textContent).toContain("forwards to a@gmail.test (verified)"));
    expect(item.textContent).toContain("forwards to b@gmail.test (verified)");
    expect(item.textContent).toContain("destination address not verified");
    expect(item.textContent!.match(/Copies off\./g)).toHaveLength(1);
  });

  it("renames the mailbox through PATCH, and offers no rename for the name it already has", async () => {
    mount();
    const field = (await screen.findByLabelText("Name", { selector: "#rename-mbx_test" })) as HTMLInputElement;
    const button = field.parentElement!.querySelector("button")!;
    expect(button.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Renamed" } });
    fireEvent.click(button);
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "PATCH" && call.path === "/api/mailboxes/mbx_test");
      expect(sent, "the rename was never sent").toBeDefined();
      expect(sent!.body).toEqual({ name: "Renamed" });
    });
    expect(await status()).toBe("renamed to Renamed");
  });

  it("renames a team through its rename route", async () => {
    mount({ teams: [{ id: "team_1", name: "Finance", createdAt: "2026-09-26T00:00:00.000Z", memberCount: 0 }] });
    const field = (await screen.findByLabelText("Name of Finance")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Legal" } });
    fireEvent.click(field.parentElement!.querySelector("button")!);
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "POST" && call.path === "/api/teams/team_1/rename");
      expect(sent, "the rename was never sent").toBeDefined();
      expect(sent!.body).toEqual({ name: "Legal" });
    });
  });
});
