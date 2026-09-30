import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, reset } from "./session-stub.ts";

/**
 * The Outbox's per-recipient row with a reason beside the state (28 September 2026). The words are the delivery
 * module's and `test/node/delivery-summary.test.ts` holds them; this holds the wiring: the reason chip sits
 * beside `unobserved`, never in its place, and never beside an outcome that arrived.
 */

const route = vi.hoisted(() => ({ pathname: "/outbox" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Outbox } = await import("../../src/client/app/screens/ledgers.tsx");

const recipient = (address: string, delivery_state: string | null, delivery_reason: string | null) => ({
  manifest_id: "snd_1", kind: "to", address, submission_state: "handed_over", delivery_state, delivery_reason,
  bounce_type: null, last_error: null,
});

const SENDS = {
  sends: [{
    id: "snd_1", subject: "two recipients", envelope_to: JSON.stringify(["friend@gmail.test", "ops@example.test"]),
    state: "handed_over", state_at: "2026-09-28T04:36:51.379Z", release_at: "2026-09-28T04:36:51.379Z",
    attempts: 1, last_error: null, transport_message_id: "<m@example.test>", fidelity: "authored", has_submitted: 1,
    state_reason: null, policy_outcome: "allow", retry: { mode: null, why: "" },
    recipients: [
      recipient("friend@gmail.test", null, "verified_destination"),
      // Served by no Node (an event clears the reason in SQL), and rendered safely anyway: an outcome wins.
      recipient("ops@example.test", "accepted", "verified_destination"),
    ],
  }],
  truncated: false,
  daily: { handedOver: 1, throttledAtCount: null, firstThrottledAt: null },
  capability: { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "" },
};

beforeEach(reset);

describe("a recipient no outcome is reported for", () => {
  it("reads unobserved with verified destination beside it, and an accepted one reads accepted alone", async () => {
    answerWith((call) => (call.path.startsWith("/api/sends") && call.method === "GET" ? Response.json(SENDS) : undefined));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Outbox /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "two recipients" }));

    const rows = [...document.querySelectorAll(".recipient")].map((row) =>
      [...row.querySelectorAll(".state")].map((chip) => chip.textContent));
    expect(rows).toEqual([["unobserved", "verified destination"], ["accepted"]]);
  });
});

/**
 * A newer Node's tokens (docs/i18n.md, "a wire token outside the union renders raw, in mono"): this client has no
 * words for them, so each is drawn as the identifier it is, in `<code>`, and cannot pass for a translated word.
 */
describe("a token this client has no words for", () => {
  it("is drawn in code wherever the Outbox shows a token: state, reason, delivery state and kind", async () => {
    const newer = {
      ...SENDS,
      sends: [{
        ...SENDS.sends[0]!, state: "paused_by_quota", state_reason: "quota_exhausted",
        recipients: [{ ...recipient("friend@gmail.test", "greylisted", null), kind: "resent-to" }],
      }],
    };
    answerWith((call) => (call.path.startsWith("/api/sends") && call.method === "GET" ? Response.json(newer) : undefined));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Outbox /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "two recipients" }));

    const coded = (selector: string) => [...document.querySelectorAll(selector)].map((one) => one.textContent);
    expect(coded("tr.entry .state code")).toEqual(["paused_by_quota", "quota_exhausted", "greylisted"]);
    expect(coded(".recipient code")).toEqual(["resent-to", "greylisted"]);
  });
});
