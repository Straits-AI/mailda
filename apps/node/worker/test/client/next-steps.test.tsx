import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";
import type { MessageRow } from "../../src/client/app/api.ts";

/**
 * Next steps (U4): deterministic, contextual, and never dressed as AI.
 *
 * The provider is a function of the message and the reader, so most of this calls it directly; the strip and
 * two of its steps are mounted, because what they do (narrow the list, raise the collision notice on the
 * right message) is arrangement. The AI slot is tested only with a fixture: nothing produces a finding today,
 * and the one thing worth holding is that when something does, it cannot appear without its label and
 * provenance.
 */

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { NextSteps, deterministicNextSteps } = await import("../../src/client/app/screens/next-steps.tsx");
const { Inbox } = await import("../../src/client/app/screens/inbox.tsx");
const { ShellProvider } = await import("../../src/client/app/shell-context.tsx");

function row(over: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "rcpt_1", message_id: "msg_1", subject: "Invoice", from_addr: "ar@northwind.example",
    envelope_from: "bounce@relay.example", envelope_to: "support@example.test", mailbox_id: "mbx_test", raw_bytes: 1024,
    accepted_at: "2026-08-21T09:00:00.000Z", parse_error: null, conversation_id: null, case_id: "case_1",
    auth_spf: null, auth_dkim: null, auth_dmarc: null, auth_dmarc_policy: null, auth_from_domain: null,
    attachments: null, attachments_dangerous: null, labels_json: "[]", read: 1,
    place: "inbox", from_name: null, preview: null, standing_content: 1, case_mine: 0, case_state: "open",
    ...over,
  };
}

const ids = (message: MessageRow, canSend: boolean) => deterministicNextSteps({
  message, canSend, claim: () => {}, release: () => {}, showFromSender: () => {},
}).steps.map((step) => step.id);

describe("the deterministic provider offers only what applies to this message and this reader", () => {
  it("offers Claim on an open case to a reader who may send, and not otherwise", () => {
    expect(ids(row(), true)).toContain("claim");
    expect(ids(row(), false), "Claim offered without send.propose").not.toContain("claim");
    expect(ids(row({ case_state: "claimed" }), true)).not.toContain("claim");
    expect(ids(row({ case_state: null, case_id: null }), true)).not.toContain("claim");
  });

  it("offers Release only on a case this reader holds", () => {
    expect(ids(row({ case_state: "claimed", case_mine: 1 }), true)).toContain("release");
    expect(ids(row({ case_state: "claimed", case_mine: 0 }), true)).not.toContain("release");
    expect(ids(row({ case_state: "claimed", case_mine: 1 }), false), "Release offered without send.propose").not.toContain("release");
  });

  it("offers More from this sender by the envelope sender, and returns no finding", () => {
    const shown: string[] = [];
    const result = deterministicNextSteps({
      message: row(), canSend: false, claim: () => {}, release: () => {}, showFromSender: (address) => shown.push(address),
    });
    result.steps.find((step) => step.id === "more-from-sender")!.run();
    // What `from` filters on, not the display name or the From header the sender chose.
    expect(shown).toEqual(["bounce@relay.example"]);
    expect(result.finding).toBeNull();
    expect(ids(row({ envelope_from: "" }), false)).toEqual([]);
  });
});

describe("the strip", () => {
  it("renders nothing when there is nothing to do", () => {
    const { container } = render(<NextSteps steps={[]} finding={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("names itself Next steps and carries no AI marking on a deterministic step", () => {
    render(<NextSteps steps={[{ id: "claim", label: "Claim", run: () => {} }]} finding={null} />);
    const strip = screen.getByRole("region", { name: "Next steps" });
    expect(within(strip).getByRole("button", { name: "Claim" })).toBeDefined();
    expect(strip.textContent).not.toMatch(/\bAI\b|suggest/i);
    expect(strip.querySelector(".ai-finding, .ai-label")).toBeNull();
  });

  it("shows a finding only with its AI label and its provenance, before its text", () => {
    render(<NextSteps steps={[]} finding={{ text: "Invoice detected · RM 4,800", provenance: { profile: "finance", model: "m-1", runId: "run_9", at: "2026-09-26T09:00:00Z" } }} />);
    const finding = document.querySelector(".ai-finding")!;
    expect(finding.querySelector(".ai-label")?.textContent).toBe("AI");
    expect(finding.querySelector(".ai-provenance")?.textContent).toBe("finance · m-1 · run run_9 · 2026-09-26T09:00:00Z");
    expect(finding.textContent!.indexOf("finance")).toBeLessThan(finding.textContent!.indexOf("Invoice detected"));
  });
});

describe("in the reader", () => {
  let claim: Response;
  let steal: Response;

  beforeEach(() => {
    reset();
    claim = Response.json({ case: { id: "case_1", state: "claimed" } });
    steal = Response.json({ case: { id: "case_1", state: "claimed" } });
    answerWith((call) => {
      const url = new URL(call.path, "https://node.example");
      if (url.pathname === "/api/messages") {
        return Response.json({ messages: [row({ subject: url.searchParams.has("from") ? "filtered" : "Invoice" })], next_cursor: null, lookback_exhausted: false });
      }
      if (url.pathname.endsWith("/body")) {
        return Response.json({ state: "text-only", html: null, text: "hello", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [], recipients: { to: [], cc: [], replyTo: null } });
      }
      if (url.pathname === "/api/cases/case_1/claim") return claim;
      if (url.pathname === "/api/cases/case_1/steal") return steal;
      if (url.pathname === "/api/cases/case_1/release") return Response.json({ case: { id: "case_1", state: "open" } });
      return undefined;
    });
  });

  async function open() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ShellProvider><Inbox /></ShellProvider></QueryClientProvider>);
    await act(async () => { (await screen.findByRole("button", { name: /Invoice/ })).click(); });
    await screen.findByText("hello");
    return screen.getByRole("region", { name: "Next steps" });
  }

  it("narrows the list to the envelope sender", async () => {
    const strip = await open();
    await act(async () => { within(strip).getByRole("button", { name: "More from this sender" }).click(); });
    await waitFor(() => {
      const last = calls.filter((call) => call.path.startsWith("/api/messages?")).at(-1)!;
      expect(new URL(last.path, "https://node.example").searchParams.get("from")).toBe("bounce@relay.example");
    });
  });

  it("releases a case this reader holds, and says where it went", async () => {
    answerWith((call) => {
      const url = new URL(call.path, "https://node.example");
      if (url.pathname === "/api/messages") return Response.json({ messages: [row({ case_state: "claimed", case_mine: 1 })], next_cursor: null, lookback_exhausted: false });
      if (url.pathname.endsWith("/body")) {
        return Response.json({ state: "text-only", html: null, text: "hello", blockedRemote: 0, truncated: false, problem: null, attachments: [], links: [], recipients: { to: [], cc: [], replyTo: null } });
      }
      if (url.pathname === "/api/cases/case_1/release") return Response.json({ case: { id: "case_1", state: "open" } });
      return undefined;
    });
    const strip = await open();
    await act(async () => { within(strip).getByRole("button", { name: "Release" }).click(); });
    await waitFor(() => { expect(document.querySelector(".toast-region .toast")?.textContent).toBe("Released to the queue."); });
    expect(calls.some((call) => call.path === "/api/cases/case_1/release" && call.method === "POST")).toBe(true);
  });

  it("claims, and says so", async () => {
    const strip = await open();
    await act(async () => { within(strip).getByRole("button", { name: "Claim" }).click(); });
    await waitFor(() => { expect(document.querySelector(".toast-region .toast")?.textContent).toBe("Claimed."); });
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/cases/case_1/claim"]);
  });

  it("takes a lost claim with the audited steal and opens no composer, because nothing is being answered", async () => {
    claim = Response.json({ error: "held", heldBy: "bob@example.test", heldSince: "", message: "bob@example.test holds this." }, { status: 409 });
    const strip = await open();
    await act(async () => { within(strip).getByRole("button", { name: "Claim" }).click(); });
    const notice = await screen.findByText(/bob@example\.test holds this\./);
    await act(async () => { within(notice).getByRole("button", { name: "Take it anyway" }).click(); });
    await waitFor(() => { expect(document.querySelector(".toast-region .toast")?.textContent).toBe("Claimed."); });
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/cases/case_1/claim", "/api/cases/case_1/steal"]);
    expect(screen.queryByRole("region", { name: "Reply" })).toBeNull();
    expect(screen.queryByText(/holds this/)).toBeNull();
  });

  it("keeps the notice, in the Node's newer words, when the steal is refused", async () => {
    claim = Response.json({ error: "held", heldBy: "bob@example.test", heldSince: "", message: "bob@example.test holds this." }, { status: 409 });
    steal = Response.json({ error: "closed", message: "This case was closed a moment ago." }, { status: 409 });
    const strip = await open();
    await act(async () => { within(strip).getByRole("button", { name: "Claim" }).click(); });
    const notice = await screen.findByText(/bob@example\.test holds this\./);
    await act(async () => { within(notice).getByRole("button", { name: "Take it anyway" }).click(); });
    const refused = await screen.findByText(/This case was closed a moment ago\./);
    expect(refused.getAttribute("role")).toBe("alert");
    // A closed case has nobody to take it from.
    expect(within(refused).queryByRole("button", { name: "Take it anyway" })).toBeNull();
  });

  it("raises the collision notice on this message when the claim is lost", async () => {
    claim = Response.json({ error: "held", heldBy: "bob@example.test", heldSince: "", message: "bob@example.test holds this." }, { status: 409 });
    const strip = await open();
    await act(async () => { within(strip).getByRole("button", { name: "Claim" }).click(); });
    const pane = screen.getByRole("article", { name: "Message" });
    const notice = await within(pane).findByText(/bob@example\.test holds this\./);
    expect(notice.getAttribute("role")).toBe("alert");
    expect(within(notice).getByRole("button", { name: "Take it anyway" })).toBeDefined();
  });
});
