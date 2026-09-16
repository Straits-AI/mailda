import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerWith, calls, reset } from "./session-stub.ts";

/**
 * Setting a Node up without opening the Cloudflare dashboard (#210).
 *
 * ## What this screen replaced
 *
 * Nineteen provider routes, and no screen for any of them. Everything past the consent — pointing a
 * subdomain at the Node, onboarding a domain for sending, finding out which account the grant covers — was
 * reachable only through `mailda provider …`. The person those routes exist for is whoever owns the
 * Cloudflare account, and requiring them to install a CLI is requiring them to be somebody else.
 *
 * ## What is asserted here, and why these four
 *
 * The screen is mostly forms, and a test that clicked through them would mostly be testing React. These are
 * the four places where rendering a plausible thing would be **wrong**:
 *
 * 1. **The digest that was shown is the digest confirmed.** The Node re-derives what it would do and refuses
 *    unless the two agree, which is the whole safety of propose-then-confirm. A screen that posted a digest
 *    it had regenerated, or omitted it, would pass every visual check and apply a plan nobody read.
 * 2. **An empty `creates` with `enablesZone` set is the *larger* change, not a smaller one.** Enabling Email
 *    Routing writes MX and SPF at the apex — deciding where the whole domain's mail goes — and the record
 *    list is empty in exactly that case because a zone that is not routing yet lists none. Rendering the
 *    list alone would show the biggest act on this screen as its emptiest.
 * 3. **An empty read-back means no rule was made.** `confirmed` comes from re-reading DNS; the Node
 *    deliberately leaves no routing rule when it is empty, because a rule over absent records claims a
 *    domain receives mail that never reaches Cloudflare. "Done" here would be a success that did nothing.
 * 4. **A refusal arrives whole.** These are four-part and the last part is what to do next — which on this
 *    screen is the difference between finishing setup and going back to the dashboard to guess.
 */

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({ location: { pathname: "/setup" } }),
  Link: ({ children }: { children?: unknown }) => children,
}));

const { Setup } = await import("../../src/client/app/screens/setup.tsx");

const CEREMONY = {
  steps: ["Open Manage Account → OAuth clients.", "Create a client."],
  redirectUri: "https://node.example.test/oauth/cloudflare/callback",
  scopes: [
    { scope: "zone.read", why: "find the zone a domain lives in", readOnlyExists: true },
    { scope: "dns.write", why: "write the MX records receiving needs", readOnlyExists: false },
  ],
  unmeasured: "The scope names are not measured against Cloudflare's own list.",
};

function binding(overrides: Record<string, unknown> = {}) {
  return {
    state: "consent_granted",
    evidence: "observed",
    clientId: "cf-client",
    redirectUri: CEREMONY.redirectUri,
    registeredAt: "2026-09-01T00:00:00.000Z",
    accountId: "acc_one",
    grantedAt: "2026-09-02T00:00:00.000Z",
    scopesGranted: ["zone.read", "dns.write"],
    refusedDetail: null,
    ...overrides,
  };
}

const NO_RECORDS = { routing: [] };

/**
 * One handler for the whole surface.
 *
 * `answer` matches a path **prefix**, and `/api/provider` is a prefix of every route on this screen — so a
 * per-path stub would answer the receiving proposal with the connection state. Method- and path-aware
 * routing is the point here.
 */
function mount(
  parts: {
    provider?: Record<string, unknown>;
    receiving?: unknown;
    outcome?: unknown;
    refuse?: { status: number; body: unknown };
  } = {},
) {
  answerWith((call) => {
    if (call.path.startsWith("/api/provider/email-routing")) return Response.json(NO_RECORDS);
    if (call.path.startsWith("/api/provider/receiving") && call.method === "GET") {
      return Response.json(parts.receiving);
    }
    if (call.path.startsWith("/api/provider/receiving") && call.method === "POST") {
      if (parts.refuse !== undefined) {
        return Response.json(parts.refuse.body, { status: parts.refuse.status });
      }
      return Response.json(parts.outcome);
    }
    if (call.path === "/api/provider") {
      return Response.json({ provider: binding(parts.provider), ceremony: CEREMONY });
    }
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><Setup /></QueryClientProvider>);
}

/** Fills the two receiving fields and asks for a proposal. */
async function propose(domain: string, address: string) {
  fireEvent.change(await screen.findByLabelText("Subdomain"), { target: { value: domain } });
  fireEvent.change(screen.getByLabelText("Address to route here"), { target: { value: address } });
  fireEvent.click(screen.getByText("see what pointing this here would do"));
}

beforeEach(reset);

describe("setting a Node up without the Cloudflare dashboard", () => {
  it("confirms with the digest it was shown, not one of its own", async () => {
    mount({
      receiving: {
        proposal: {
          domain: "mail.example.com", zone: "example.com", zoneId: "z1", zoneRouting: "ready",
          enablesZone: null,
          creates: [{ type: "MX", name: "mail.example.com", content: "route1.mx.cloudflare.net", priority: 9 }],
          present: [], rule: null, digest: "d".repeat(64), refusal: null,
        },
      },
      outcome: {
        outcome: {
          domain: "mail.example.com", written: ["MX mail.example.com"],
          confirmed: ["MX mail.example.com"], rule: "inbox@mail.example.com", note: null,
        },
      },
    });

    await propose("mail.example.com", "inbox@mail.example.com");
    fireEvent.click(await screen.findByText("do this"));

    await waitFor(() => {
      const posted = calls.find((one) => one.path === "/api/provider/receiving" && one.method === "POST");
      expect(posted, "the confirmation was never sent").toBeDefined();
      expect((posted!.body as { digest: string }).digest).toBe("d".repeat(64));
      expect((posted!.body as { address: string }).address).toBe("inbox@mail.example.com");
    });
  });

  it("says a zone is being turned on, when that is the part with no records to show", async () => {
    mount({
      receiving: {
        proposal: {
          domain: "mail.example.com", zone: "example.com", zoneId: "z1", zoneRouting: null,
          // Empty, and that is what the case looks like: a zone that is not routing yet lists no MX.
          enablesZone: "example.com", creates: [], present: [], rule: null,
          digest: "e".repeat(64), refusal: null,
        },
      },
    });

    await propose("mail.example.com", "inbox@mail.example.com");

    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("example.com");
    expect(warning.textContent).toContain("apex");
    // And the empty list must not be the only thing a reader takes from the screen.
    expect(warning.textContent).toContain("not because little would change");
  });

  it("does not call it done when nothing was confirmed in DNS", async () => {
    mount({
      receiving: {
        proposal: {
          domain: "mail.example.com", zone: "example.com", zoneId: "z1", zoneRouting: "ready",
          enablesZone: null,
          creates: [{ type: "MX", name: "mail.example.com", content: "route1.mx.cloudflare.net", priority: 9 }],
          present: [], rule: null, digest: "f".repeat(64), refusal: null,
        },
      },
      outcome: {
        outcome: {
          domain: "mail.example.com", written: ["MX mail.example.com"],
          // The write answered 200 and the read-back found nothing, so the Node made no rule.
          confirmed: [], rule: null, note: "The records were not visible when read back.",
        },
      },
    });

    await propose("mail.example.com", "inbox@mail.example.com");
    fireEvent.click(await screen.findByText("do this"));

    const said = await screen.findByRole("status");
    expect(said.textContent).toContain("no routing rule was made");
    expect(said.textContent).toContain("The records were not visible when read back.");
  });

  it("renders a refusal whole, including the sentence that says what to do", async () => {
    mount({
      receiving: {
        proposal: {
          domain: "mail.example.com", zone: "example.com", zoneId: "z1", zoneRouting: "ready",
          enablesZone: null,
          creates: [{ type: "MX", name: "mail.example.com", content: "route1.mx.cloudflare.net", priority: 9 }],
          present: [], rule: null, digest: "a".repeat(64), refusal: null,
        },
      },
      refuse: {
        status: 409,
        // The wire shape `CallerError` produces: the four parts are already in `message`, not in a `detail`
        // key. An earlier version of this fixture invented one, and the screen parsed the invention.
        body: {
          error: "E_PROVIDER_STALE_PROPOSAL",
          message: "E_PROVIDER_STALE_PROPOSAL  the zone changed since this plan was read\n"
            + "  why      the digest no longer matches what this Node would do\n"
            + "  fix      read the plan again before confirming it",
        },
      },
    });

    await propose("mail.example.com", "inbox@mail.example.com");
    fireEvent.click(await screen.findByText("do this"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("the zone changed since this plan was read");
    // The fix is the half that gets dropped when a message is summarised, so it is asserted by itself.
    expect(alert.textContent).toContain("read the plan again before confirming it");
  });

  it("offers no authorization until there is a client to authorize", async () => {
    /*
     * A consent needs a registered client. Offering the button first produces a refusal whose only cause is
     * that the operator followed the screen in the order it was printed — which is the specific way a setup
     * screen wastes somebody's afternoon.
     */
    mount({ provider: { state: "no_client", clientId: null, accountId: null, grantedAt: null } });

    expect(await screen.findByLabelText("Client ID")).toBeTruthy();
    expect(screen.queryByText("start the authorization")).toBeNull();
  });
});
