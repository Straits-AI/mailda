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

function mount(routing: { state: string; detail: string }, boxes = [BOX], receiving: string | null = null, forwards: unknown[] = []) {
  answerWith((call) => {
    if (call.path === "/api/forwards") return Response.json({ forwards });
    if (call.path === "/api/forwards/copy") {
      const asked = call.body as { address: string; copy: boolean };
      return Response.json({ copy: { address: asked.address, to: "me@gmail.test", by: asked.copy ? "usr_me" : null, at: asked.copy ? "2026-10-03T00:00:00.000Z" : null } });
    }
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

describe("an address that keeps a forward (ADR 47)", () => {
  beforeEach(reset);
  const forward = (last: unknown, verified: string | null = "verified", copy: unknown = null) => ({
    address: "support@example.test", mailboxId: "mbx_test", to: "me@gmail.test", verified, checkedAt: "2026-10-03T00:00:00.000Z",
    last, lastHandedOverAt: null, copy,
  });

  it("says where it forwards, what the last read said, and when it last forwarded", async () => {
    mount({ state: "catch_all", detail: "" }, [BOX], null, [forward({ state: "handed_over", at: "2026-10-03T01:00:00.000Z", error: null })]);
    const line = (await screen.findByText(/forwards to/)).closest("li")!;
    expect(line.textContent).toMatch(/forwards to me@gmail\.test \(verified\) · last forwarded /);
  });

  it("says a refused forward was not forwarded, in Cloudflare's words, and a never-read destination as not checked", async () => {
    mount({ state: "catch_all", detail: "" }, [BOX], null, [forward({ state: "refused", at: "2026-10-03T01:00:00.000Z", error: "destination address not verified" }, null)]);
    const line = (await screen.findByText(/forwards to/)).closest("li")!;
    expect(line.textContent).toContain("forwards to me@gmail.test (not checked)");
    expect(line.textContent).toMatch(/not forwarded at .*: destination address not verified/);
  });
});

describe("copies, under an address that keeps a forward (ADR 47, amended 3 October 2026)", () => {
  beforeEach(reset);
  const refusedWith = (copy: unknown) => ({ state: "refused", at: "2026-10-03T01:00:00.000Z", error: "destination address not verified", copy });
  const forward = (last: unknown, copy: unknown = null) => ({
    address: "support@example.test", mailboxId: "mbx_test", to: "me@gmail.test", verified: "absent", checkedAt: null,
    last, lastHandedOverAt: null, copy,
  });

  it("says copies are off, offers to send them, and states what a copy is, with the limit", async () => {
    mount({ state: "catch_all", detail: "" }, [BOX], null, [forward(null)]);
    const line = (await screen.findByText(/forwards to/)).closest("li")!;
    expect(line.textContent).toContain("Copies off.");
    expect(line.textContent).toContain("Send copies");
    expect(line.textContent).toContain('a copy from support@example.test: the recipient sees it from "<sender> via Support", and replies go to the sender. Up to 5.0 MB.');
    expect(line.textContent).toContain("Each copy counts towards today's sending");
  });

  it("names the sealed copy's send and its state, and who turned copies on", async () => {
    mount({ state: "catch_all", detail: "" }, [BOX], null, [forward(
      refusedWith({ state: "sealed", at: "2026-10-03T01:00:01.000Z", error: null, sendId: "snd_COPY", sendState: "handed_over" }),
      { by: "usr_nobody", at: "2026-10-02T00:00:00.000Z" },
    )]);
    const line = (await screen.findByText(/forwards to/)).closest("li")!;
    expect(line.textContent).toContain("a copy was sealed as snd_COPY (handed over)");
    expect(line.textContent).toMatch(/Copies on, turned on by usr_nobody on /);
    expect(line.textContent).toContain("Stop copies");
  });

  it("turns copies on for that address when asked, and says so", async () => {
    mount({ state: "catch_all", detail: "" }, [BOX], null, [forward(null)]);
    fireEvent.click(await screen.findByText("Send copies"));
    expect(await status()).toBe("Copies on for support@example.test.");
    expect(calls.find((call) => call.path === "/api/forwards/copy")?.body).toEqual({ address: "support@example.test", copy: true });
  });

  it("says why no copy was sealed, in the Node's words", async () => {
    mount({ state: "catch_all", detail: "" }, [BOX], null, [forward(refusedWith({
      state: "refused", at: "2026-10-03T01:00:01.000Z", error: "the message failed DMARC for its sender's domain", sendId: null, sendState: null,
    }))]);
    const line = (await screen.findByText(/forwards to/)).closest("li")!;
    expect(line.textContent).toContain("no copy: the message failed DMARC for its sender's domain");
  });
});
