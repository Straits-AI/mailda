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

const PERMISSIONS = [
  { name: "Zone Read", scope: "zone", why: "find the zone a domain lives in", optional: false },
  { name: "Registrar Domains Read", scope: "account", why: "price a domain before buying it", optional: true },
];
const NOTE = "The permission names come from Cloudflare's token form and are not measured against it.";

function binding(overrides: Record<string, unknown> = {}) {
  return {
    state: "token_held",
    accountId: "acc_one",
    accountName: "Example Ltd",
    registeredAt: "2026-09-26T00:00:00.000Z",
    verifiedAt: "2026-09-26T00:00:00.000Z",
    ...overrides,
  };
}

const NO_RECORDS = { routing: [] };
const NOTHING_PROVISIONED = { receiving: null, sending: null, deliveryEvents: null };

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
    subscription?: unknown;
    subscribed?: unknown;
    outcome?: unknown;
    refuse?: { status: number; body: unknown };
    /** What `PUT /api/provider/token` answers, per call, in order; a 4xx body carries `message`. */
    tokenAnswers?: Array<{ status: number; body: unknown }>;
  } = {},
) {
  let tokenCall = 0;
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
    if (call.path.startsWith("/api/provider/subscription") && call.method === "GET") {
      return Response.json(parts.subscription);
    }
    if (call.path.startsWith("/api/provider/subscription") && call.method === "POST") {
      return Response.json(parts.subscribed);
    }
    if (call.path === "/api/provider" && call.method === "GET") {
      return Response.json({ provider: binding(parts.provider), provisioned: NOTHING_PROVISIONED, permissions: PERMISSIONS, note: NOTE });
    }
    if (call.path === "/api/provider/token" && call.method === "PUT") {
      const answer = parts.tokenAnswers?.[tokenCall] ?? { status: 200, body: { provider: binding() } };
      tokenCall += 1;
      return Response.json(answer.body, { status: answer.status });
    }
    if (call.path === "/api/provider/token" && call.method === "DELETE") {
      return Response.json({ provider: binding({ state: "no_token", accountId: null, accountName: null, registeredAt: null, verifiedAt: null }) });
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
          present: [], rule: null, digest: "d".repeat(64), refusal: null, apex: false, catchAll: null,
        },
      },
      outcome: {
        outcome: {
          domain: "mail.example.com", written: ["MX mail.example.com"],
          confirmed: ["MX mail.example.com"], rule: "inbox@mail.example.com", note: null, catchAll: null,
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
          confirmed: [], rule: null, note: "The records were not visible when read back.", catchAll: null,
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

  it("subscribes a sending domain's delivery events with the digest it was shown (#222)", async () => {
    const proposal = {
      domain: "mail.example.com", zone: "example.com", zoneId: "z1", sendingDomain: "mail.example.com",
      subscribed: null, queueId: "q1", queueName: "mailda-sending-events", consumerAttached: true,
      events: ["message.delivered", "message.bounced"], digest: "b".repeat(64), error: null,
    };
    mount({
      subscription: { proposal },
      subscribed: { proposal: { ...proposal, subscribed: "mailda-sending-events-mail.example.com" } },
    });

    fireEvent.change(await screen.findByLabelText("Domain", { selector: "#setup-subscribe-domain" }), {
      target: { value: "mail.example.com" },
    });
    fireEvent.click(screen.getByText("see what subscribing this would do"));
    expect(await screen.findByText(/Would publish 2 event types/)).toBeTruthy();

    fireEvent.click(screen.getByText("subscribe this domain"));
    // Two statuses once applied: the outcome, and the plan's own "already subscribed" from the re-read.
    expect(await screen.findByText(/delivery events now reach this Node/)).toBeTruthy();

    const posted = calls.find((call) => call.path === "/api/provider/subscription" && call.method === "POST");
    expect(posted?.body).toEqual({ domain: "mail.example.com", digest: "b".repeat(64) });
  });

  it("keeps the subscribe button off while the proposal names why it cannot be applied", async () => {
    mount({
      subscription: {
        proposal: {
          domain: "mail.example.com", zone: "example.com", zoneId: "z1", sendingDomain: null,
          subscribed: null, queueId: null, queueName: null, consumerAttached: null, events: [], digest: "c".repeat(64),
          error: "mail.example.com is not onboarded for sending — onboard it first: POST /api/provider/sending",
        },
      },
    });

    fireEvent.change(await screen.findByLabelText("Domain", { selector: "#setup-subscribe-domain" }), {
      target: { value: "mail.example.com" },
    });
    fireEvent.click(screen.getByText("see what subscribing this would do"));
    expect((await screen.findByRole("alert")).textContent).toContain("onboard it first");
    expect((screen.getByText("subscribe this domain") as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * The connection is one API token (26 September 2026), held by the Node and never shown again. What would
 * render plausibly and be wrong: a permission list written in this file rather than the Node's; a token
 * kept in the field after a refusal; the account-id field offered before the Node said it was needed; a
 * "forget" that did not reach the route.
 */
describe("the connection, one API token", () => {
  beforeEach(reset);
  const unconnected = { state: "no_token", accountId: null, accountName: null, registeredAt: null, verifiedAt: null };

  it("renders the Node's permission list, marks the optional one, and shows the note", async () => {
    mount({ provider: unconnected });
    expect(await screen.findByText("Zone Read")).toBeTruthy();
    expect(screen.getByText("Registrar Domains Read")).toBeTruthy();
    expect(screen.getByText("Optional.")).toBeTruthy();
    expect(screen.getByText(NOTE)).toBeTruthy();
    expect(screen.getByText("open the token page").getAttribute("href")).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(screen.queryByLabelText("Account id")).toBeNull();
  });

  it("sends the token to PUT /api/provider/token and clears the field, whatever the answer", async () => {
    mount({ provider: unconnected, tokenAnswers: [{ status: 422, body: { error: "E_PROVIDER_TOKEN_REFUSED", message: "E_PROVIDER_TOKEN_REFUSED  the token is not active\n  fix      make a new one" } }] });
    fireEvent.change(await screen.findByLabelText("API token"), { target: { value: "tok-once" } });
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => {
      const sent = calls.find((call) => call.method === "PUT" && call.path === "/api/provider/token");
      expect(sent, "the token was never sent").toBeDefined();
      expect(sent!.body).toEqual({ token: "tok-once" });
    });
    expect((await screen.findByRole("alert")).textContent).toContain("make a new one");
    expect((screen.getByLabelText("API token") as HTMLInputElement).value).toBe("");
  });

  it("asks for the account only after the Node said the token sees several, and resends with it", async () => {
    mount({
      provider: unconnected,
      tokenAnswers: [
        { status: 422, body: { error: "E_PROVIDER_ACCOUNT_AMBIGUOUS", message: "E_PROVIDER_ACCOUNT_AMBIGUOUS  the token can see 2 accounts\n  fix      pass accountId" } },
        { status: 200, body: { provider: binding() } },
      ],
    });
    fireEvent.change(await screen.findByLabelText("API token"), { target: { value: "tok-two" } });
    fireEvent.click(screen.getByText("connect"));
    const account = await screen.findByLabelText("Account id");
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-two" } });
    fireEvent.change(account, { target: { value: "1e0170aaabc90ecf5f466128d1f0466a" } });
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => {
      const puts = calls.filter((call) => call.method === "PUT" && call.path === "/api/provider/token");
      expect(puts).toHaveLength(2);
      expect(puts[1]!.body).toEqual({ token: "tok-two", accountId: "1e0170aaabc90ecf5f466128d1f0466a" });
    });
  });

  it("shows the held token's account and forgets it through DELETE", async () => {
    mount();
    const held = await screen.findByText(/Connected to account/);
    expect(held.textContent).toContain("Connected to account Example Ltd (acc_one) since");
    fireEvent.click(screen.getByText("forget this token"));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.path === "/api/provider/token")).toBe(true);
    });
  });
});

/**
 * The apex catch-all (25 September 2026). Cloudflare's catch-all exists for apex zones only, so the box
 * exists only when the proposal says apex; the current catch-all is shown in the proposal's words, because
 * taking it over replaces somebody's rule; and `catchAll: true` travels only when ticked, since the Node
 * refuses it off an apex and an absent key is the plain per-address rule.
 */
describe("the apex catch-all", () => {
  beforeEach(reset);
  const apex = {
    proposal: {
      domain: "example.com", zone: "example.com", zoneId: "z1", zoneRouting: "ready", enablesZone: null,
      creates: [], present: ["route1.mx.cloudflare.net"], rule: null, digest: "e".repeat(64), refusal: null,
      apex: true, catchAll: { action: "worker", destinations: ["butler"], enabled: true },
    },
  };
  const takenOver = {
    outcome: {
      domain: "example.com", written: [], confirmed: ["route1.mx.cloudflare.net"], rule: "catch-all", note: null,
      catchAll: { before: { action: "worker", destinations: ["butler"], enabled: true }, after: { action: "worker", destinations: ["mailda"], enabled: true } },
    },
  };

  it("offers the box on an apex, names the current catch-all, and sends catchAll only when ticked", async () => {
    mount({ receiving: apex, outcome: takenOver });
    await propose("example.com", "hello@example.com");
    const box = await screen.findByLabelText("Route every address at example.com to this Node (catch-all)");
    expect(screen.getByText(/Currently: worker → butler, enabled\./)).toBeTruthy();
    fireEvent.click(box);
    fireEvent.click(screen.getByText("do this"));
    await waitFor(() => {
      const posted = calls.find((one) => one.path === "/api/provider/receiving" && one.method === "POST");
      expect(posted, "the confirmation was never sent").toBeDefined();
      expect((posted!.body as { catchAll?: boolean }).catchAll).toBe(true);
    });
    // The outcome names what was replaced, so the operator can put it back knowingly.
    expect(await screen.findByText(/The catch-all on example.com now routes to this Node \(before: worker → butler\)/)).toBeTruthy();
  });

  it("sends no catchAll key when the box is left alone", async () => {
    mount({ receiving: apex, outcome: takenOver });
    await propose("example.com", "hello@example.com");
    await screen.findByLabelText("Route every address at example.com to this Node (catch-all)");
    fireEvent.click(screen.getByText("do this"));
    await waitFor(() => {
      const posted = calls.find((one) => one.path === "/api/provider/receiving" && one.method === "POST");
      expect(posted).toBeDefined();
      expect("catchAll" in (posted!.body as object)).toBe(false);
    });
  });

  it("says a subdomain gets one rule per address, and offers no box", async () => {
    mount({
      receiving: { proposal: { ...apex.proposal, domain: "mail.example.com", apex: false, catchAll: null } },
      outcome: takenOver,
    });
    await propose("mail.example.com", "hello@mail.example.com");
    expect(await screen.findByText(/mail.example.com is a subdomain, so each address gets its own rule/)).toBeTruthy();
    expect(screen.queryByLabelText(/catch-all/)).toBeNull();
  });
});
