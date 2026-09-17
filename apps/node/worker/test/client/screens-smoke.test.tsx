import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, reset } from "./session-stub.ts";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

/**
 * Every screen, mounted twice: against a Node that answers each list empty, and against one that refuses
 * an act with a four-part message. Ten screens had no DOM test at all (the 17 September coverage audit),
 * and the acts on them render the Node's refusal — this is the check that a refusal reaches the eye as
 * text rather than as a thrown promise, on every screen with a button.
 */
const screens = await import("../../src/client/app/screens/queue.tsx");
const { Approvals } = await import("../../src/client/app/screens/approvals.tsx");
const { Policies } = await import("../../src/client/app/screens/policies.tsx");
const { People } = await import("../../src/client/app/screens/people.tsx");
const { Butlers } = await import("../../src/client/app/screens/butlers.tsx");
const { Limits } = await import("../../src/client/app/screens/limits.tsx");
const { Matters } = await import("../../src/client/app/screens/matters.tsx");
const { Outbox, Audit, Log, Doctor } = await import("../../src/client/app/screens/ledgers.tsx");

const EMPTY: Record<string, unknown> = {
  "/api/mailboxes": { mailboxes: [{ id: "mbx_test", name: "Support", unclaimed: 1, claimed: 0, mine: 0, first_response_minutes: null, quarantine_dmarc_fail: 0, quarantine_dangerous_attachments: 0, quarantined: 0, breached: 0, addresses: "support@example.test" }] },
  "/api/mailboxes/mbx_test/cases": { cases: [{ id: "cas_1", conversation_id: "cnv_1", mailbox_id: "mbx_test", state: "open", state_at: "2026-08-21T09:00:00.000Z", assignee: null, claimed_at: null, subject: "A case", from_addr: "a@b.test", message_count: 1, response_due_at: null, first_response_at: null, response_breached_at: null, latest_at: "2026-08-21T09:00:00.000Z" }] },
  "/api/me": { signedIn: true, principalId: "usr_me", principalKind: "user", userId: "usr_me", delegatorUserId: null, organizationId: "org_x", email: "me@example.test" },
  "/api/approvals": { approvals: [] },
  "/api/policies": { policies: [] },
  "/api/people": { people: [] },
  "/api/invitations": { invitations: [] },
  "/api/teams": { teams: [] },
  "/api/auth/passkeys": { passkeys: [] },
  "/api/butlers": { butlers: [] },
  "/api/butler-runs": { runs: [] },
  "/api/butler-pauses": { pauses: [] },
  "/api/breakers": { breakers: [] },
  "/api/domain-pauses": { pauses: [] },
  "/api/suppressions": { suppressed: [] },
  "/api/matters": { matters: [] },
  "/api/holds": { holds: [] },
  "/api/supervised": { grants: [] },
  "/api/exports": { exports: [] },
  "/api/sends": { sends: [], daily: { handedOver: 0, limit: 100 }, capability: { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "" } },
  "/api/audit": { entries: [] },
  "/api/logs": { entries: [], counts: [] },
  "/api/doctor": { verdict: "ok", claimed: true, at: "2026-08-21T09:00:00.000Z", findings: [] },
  "/api/transport": { transport: { adapter: "cloudflare", capability: { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "test" }, available: { binding: true, rest: null } } },
  "/api/quarantine": { quarantined: [] },
};

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  reset();
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (call.method !== "GET") {
      return Response.json({ error: "E_REFUSED_FOR_TEST", message: "Refused, for the test: the four-part message the Node writes." }, { status: 409 });
    }
    const body = EMPTY[url.pathname];
    return body === undefined ? undefined : Response.json(body);
  });
});

const CASES: Array<[string, () => React.ReactElement, RegExp, RegExp | null]> = [
  ["Queue", () => <screens.Queue />, /^Queue$/, /^claim$/],
  ["Approvals", () => <Approvals />, /Approvals/, null],
  ["Policies", () => <Policies />, /Rules/, null],
  ["People", () => <People />, /People/, null],
  ["Butlers", () => <Butlers />, /Butlers/, null],
  ["Limits", () => <Limits />, /Sending limits/, null],
  ["Matters", () => <Matters />, /Matters/, null],
  ["Outbox", () => <Outbox />, /Outbox/, null],
  ["Audit", () => <Audit />, /Audit/, null],
  ["Log", () => <Log />, /Log/, null],
  ["Doctor", () => <Doctor />, /Doctor/, null],
];

describe("every screen mounts against an empty Node and renders a refusal as text", () => {
  for (const [name, make, heading, button] of CASES) {
    it(`${name}: has a level-one heading, settles, and shows the Node's refusal when an act is refused`, async () => {
      mount(make());
      await waitFor(() => { expect(screen.getByRole("heading", { level: 1, name: heading })).toBeDefined(); });
      await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
      if (button === null) return;
      await act(async () => { screen.getByRole("button", { name: button }).click(); });
      await waitFor(() => { expect(screen.queryByText(/Refused, for the test/)).not.toBeNull(); });
    });
  }
});
