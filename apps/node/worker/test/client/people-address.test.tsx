import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * Adding an address on People writes its routing in the same act (25 September 2026), and the screen must
 * render the half a person cannot see: whether Cloudflare routes it. `not_written` arrives whole, because
 * its detail names the command that finishes the job, and so do `routed_elsewhere` and `unconfirmed`.
 *
 * The address is typed as its local part, with the domain fixed beside it (28 September 2026): shown when the
 * Node receives for one domain, picked when several, from the provisioned receiving domain and the domains of
 * the mailboxes' addresses; a whole address with its own `@` is taken as typed.
 */

const route = vi.hoisted(() => ({ pathname: "/people" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { People } = await import("../../src/client/app/screens/people.tsx");

const BOX = { id: "mbx_test", name: "Support", unclaimed: 0, claimed: 0, mine: 0, first_response_minutes: null, quarantine_dmarc_fail: 0, quarantine_dangerous_attachments: 0, quarantined: 0, breached: 0, addresses: "support@example.test" as string | null };

function mount(routing: { state: string; detail: string }, boxes = [BOX], receiving: string | null = null) {
  answerWith((call) => {
    if (call.path === "/api/provider") {
      return Response.json({
        provider: { state: "no_token" }, permissions: [], note: "",
        provisioned: {
          receiving: receiving === null ? null : { domain: receiving, at: "2026-09-28T00:00:00.000Z", authority: "operator", address: `hello@${receiving}`, observed: false, routing: null },
          sending: null, deliveryEvents: null,
        },
      });
    }
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
  await screen.findByText("Add the address");
  return document.querySelector("#new-address") as HTMLInputElement;
}
async function add(address: string) {
  fireEvent.change(await field(), { target: { value: address } });
  fireEvent.click(screen.getByText("Add the address"));
}
const status = async () => (await screen.findByRole("status")).textContent ?? "";

describe("adding an address on People", () => {
  beforeEach(reset);

  it("posts the local part on the one domain, with the one mailbox's id, and says the catch-all routes it", async () => {
    mount({ state: "catch_all", detail: "" });
    await add("hello");
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "POST" && call.path === "/api/addresses");
      expect(sent, "the address was never sent").toBeDefined();
      expect(sent!.body).toEqual({ address: "hello@example.test", mailboxId: "mbx_test" });
    });
    expect(await status()).toContain("hello@example.test: routed by the domain's catch-all; nothing to do in Cloudflare");
    // Added, so the field is ready for the next one rather than holding the one just added.
    expect((await field()).value).toBe("");
  });

  it("trims and lower-cases the local part, so the address sent carries no space the field showed", async () => {
    mount({ state: "catch_all", detail: "" });
    await add("  Ops  ");
    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.path === "/api/addresses")?.body).toEqual({ address: "ops@example.test", mailboxId: "mbx_test" });
    });
  });

  it("says a rule was written when it was", async () => {
    mount({ state: "rule_written", detail: "" });
    await add("sales");
    expect(await status()).toContain("sales@example.test: routing rule written");
  });

  it("renders not_written's detail whole, because it names the command that finishes the job", async () => {
    const detail = "no credential could write the rule. Run: mailda provider --onboard-receiving example.test --address ops@example.test --url https://node";
    mount({ state: "not_written", detail });
    await add("ops");
    expect(await status()).toContain(detail);
  });

  it("renders routed_elsewhere's detail whole, because it names where the address's own rule sends it", async () => {
    const detail = "admin@example.test has an Email Routing rule of its own, named \"info\": worker to info-worker. "
      + "To route the address here, list the rules with `mailda provider --routing-rules example.test`, then "
      + "`mailda provider --take-over rule_admin --domain example.test --confirm <digest>`.";
    mount({ state: "routed_elsewhere", detail });
    await add("admin");
    const said = await status();
    expect(said).toContain(detail);
    expect(said).not.toContain("catch-all; nothing to do");
  });

  it("renders rule_disabled's detail whole, because it names the disabled rule and what would enable it", async () => {
    const detail = "ops@example.test has an Email Routing rule of its own, named \"ops\", which is disabled (enabled, it "
      + "would be worker to mailda). It names this Node: enable it in the Cloudflare dashboard (Email, Email Routing, Routing rules).";
    mount({ state: "rule_disabled", detail });
    await add("ops");
    const said = await status();
    expect(said).toContain(detail);
    expect(said).not.toContain("routing rule written");
  });

  it("renders unconfirmed as the Node's own words, never as the catch-all's all-clear", async () => {
    const detail = "not confirmed: this Node took over the catch-all on example.test, which routes an address here only when "
      + "it has no rule of its own, and could not check whether ops@example.test has an Email Routing rule of its own: no token";
    mount({ state: "unconfirmed", detail });
    await add("ops");
    const said = await status();
    expect(said).toContain(detail);
    expect(said).not.toContain("nothing to do in Cloudflare");
  });

  it("asks which mailbox when there are several, and sends the chosen one", async () => {
    mount({ state: "rule_written", detail: "" }, [BOX, { ...BOX, id: "mbx_two", name: "Invoices" }]);
    fireEvent.change(await field(), { target: { value: "bills" } });
    fireEvent.change(screen.getByLabelText("Mailbox"), { target: { value: "mbx_two" } });
    fireEvent.click(screen.getByText("Add the address"));
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "POST" && call.path === "/api/addresses");
      expect(sent!.body).toEqual({ address: "bills@example.test", mailboxId: "mbx_two" });
    });
  });
});

describe("the domain beside the local part", () => {
  beforeEach(reset);

  const section = () => screen.getByRole("region", { name: "A new address" });
  const posted = async () => {
    let body: unknown;
    await waitFor(() => {
      body = calls.find((call) => call.method === "POST" && call.path === "/api/addresses")?.body;
      expect(body, "the address was never sent").toBeDefined();
    });
    return body;
  };

  it("shows the one domain as a fixed suffix the field is described by, and offers no picker", async () => {
    mount({ state: "rule_written", detail: "" });
    const input = await field();
    const suffix = document.getElementById(input.getAttribute("aria-describedby") ?? "");
    expect(suffix?.textContent).toBe("@example.test");
    expect(within(section()).queryByLabelText("Domain")).toBeNull();
  });

  it("takes the domain from the provisioned receiving domain when no mailbox has an address", async () => {
    mount({ state: "rule_written", detail: "" }, [{ ...BOX, addresses: null }], "whymelabs.com");
    await add("admin");
    expect(await posted()).toEqual({ address: "admin@whymelabs.com", mailboxId: "mbx_test" });
  });

  it("offers a picker when the Node receives for several, the provisioned domain first, and sends the one picked", async () => {
    mount({ state: "rule_written", detail: "" }, [BOX], "whymelabs.com");
    const input = await field();
    const picker = within(section()).getByLabelText("Domain") as HTMLSelectElement;
    expect(Array.from(picker.options).map((one) => one.value)).toEqual(["whymelabs.com", "example.test"]);
    fireEvent.change(input, { target: { value: "admin" } });
    fireEvent.change(picker, { target: { value: "example.test" } });
    fireEvent.click(screen.getByText("Add the address"));
    expect(await posted()).toEqual({ address: "admin@example.test", mailboxId: "mbx_test" });
  });

  it("takes a whole address as typed, and drops the suffix so what is shown is what is sent", async () => {
    mount({ state: "rule_written", detail: "" });
    await add("Ops@Mail.Example.Test");
    expect(section().querySelector(".address-domain")).toBeNull();
    expect(await posted()).toEqual({ address: "ops@mail.example.test", mailboxId: "mbx_test" });
  });

  it("is a whole-address field when the Node knows no domain", async () => {
    mount({ state: "rule_written", detail: "" }, [{ ...BOX, addresses: null }]);
    const input = await field();
    expect(input.placeholder).toBe("hello@example.com");
    expect(section().querySelector(".address-domain")).toBeNull();
  });
});
