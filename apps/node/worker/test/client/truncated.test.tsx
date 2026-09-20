import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, reset } from "./session-stub.ts";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Audit } = await import("../../src/client/app/screens/ledgers.tsx");

/**
 * A capped list says where it stopped, on the screen and not only in the JSON.
 *
 * The Node returns `truncated` on every listing it caps. A flag a screen ignores is the hidden limit
 * AGENTS.md §3 forbids, wearing a new name. One screen is enough to hold the component to its word; the
 * others pass it the same flag.
 */
const ENTRY = {
  id: "aud_1", seq: 1, at: "2026-08-21T09:00:00.000Z", actor_user_id: "usr_me", actor_kind: "user",
  delegator_user_id: null, action: "node.claimed", subject: null, outcome: "ok", detail: "{}", hash: "0".repeat(64),
};

function mount(truncated: boolean) {
  reset();
  answerWith((call) => {
    const url = new URL(call.path, "https://node.example");
    if (url.pathname === "/api/audit") return Response.json({ entries: [ENTRY], truncated });
    if (url.pathname === "/api/me") {
      return Response.json({ signedIn: true, principalId: "usr_me", principalKind: "user", userId: "usr_me", delegatorUserId: null, organizationId: "org_x", email: "me@example.test" });
    }
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Audit /></QueryClientProvider>);
}

beforeEach(() => { reset(); });

describe("a capped list says where it stopped", () => {
  it("names the cap when the Node says older rows exist", async () => {
    mount(true);
    await waitFor(() => { expect(screen.getByText(/Showing the newest 1 entries\. Older ones exist/)).toBeDefined(); });
  });

  it("says nothing when the list is whole", async () => {
    mount(false);
    await waitFor(() => { expect(screen.getByText("node.claimed")).toBeDefined(); });
    expect(screen.queryByText(/Older ones exist/)).toBeNull();
  });
});
