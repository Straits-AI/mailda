import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerMailboxes, answerWith, calls, reset } from "./session-stub.ts";

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
    /** What `POST /api/provider/verified-destinations` answers. */
    verified?: { status: number; body: unknown };
    /** What `GET /api/provider/routing-rules` and its take-over answer. */
    rules?: unknown;
    takenOver?: unknown;
    /** What the take-over answers instead, as a refusal. */
    takeOverRefused?: { status: number; body: unknown };
  } = {},
) {
  let tokenCall = 0;
  answerWith((call) => {
    if (call.path.startsWith("/api/provider/email-routing")) return Response.json(NO_RECORDS);
    if (call.path === "/api/provider/verified-destinations" && call.method === "POST" && parts.verified !== undefined) {
      return Response.json(parts.verified.body, { status: parts.verified.status });
    }
    if (call.path.startsWith("/api/provider/routing-rules?") && call.method === "GET") return Response.json(parts.rules);
    if (call.path === "/api/provider/destination-addresses" && call.method === "POST") {
      return Response.json({ destination: { email: (call.body as { email: string }).email, state: "waiting", added: true } });
    }
    if (call.path === "/api/provider/routing-rules/take-over" && call.method === "POST") {
      return parts.takeOverRefused === undefined ? Response.json(parts.takenOver) : Response.json(parts.takeOverRefused.body, { status: parts.takeOverRefused.status });
    }
    if (call.path === "/api/mailboxes" && call.method === "POST") {
      // Made, so listed from now on, as the Node would.
      const name = (call.body as { name: string }).name;
      answerMailboxes([{ id: "mbx_test", name: "Support", addresses: "support@example.test" }, { id: "mbx_new", name, addresses: null }]);
      return Response.json({ mailboxId: "mbx_new", name });
    }
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
  fireEvent.click(screen.getByText("See what pointing this here would do"));
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
          routing: { state: "rule_written", detail: "a rule now routes inbox@mail.example.com to this Node" },
        },
      },
    });

    await propose("mail.example.com", "inbox@mail.example.com");
    fireEvent.click(await screen.findByText("Do this"));

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
          routing: { state: "not_written", detail: "The records were not visible when read back." },
        },
      },
    });

    await propose("mail.example.com", "inbox@mail.example.com");
    fireEvent.click(await screen.findByText("Do this"));

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
    fireEvent.click(await screen.findByText("Do this"));

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
    fireEvent.click(screen.getByText("See what subscribing this would do"));
    expect(await screen.findByText(/Would publish 2 event types/)).toBeTruthy();

    fireEvent.click(screen.getByText("Subscribe this domain"));
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
    fireEvent.click(screen.getByText("See what subscribing this would do"));
    expect((await screen.findByRole("alert")).textContent).toContain("onboard it first");
    expect((screen.getByText("Subscribe this domain") as HTMLButtonElement).disabled).toBe(true);
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
    expect(screen.getByText("Open the token page").getAttribute("href")).toBe("https://dash.cloudflare.com/profile/api-tokens");
    expect(screen.queryByLabelText("Account id")).toBeNull();
  });

  it("sends the token to PUT /api/provider/token and clears the field, whatever the answer", async () => {
    mount({ provider: unconnected, tokenAnswers: [{ status: 422, body: { error: "E_PROVIDER_TOKEN_REFUSED", message: "E_PROVIDER_TOKEN_REFUSED  the token is not active\n  fix      make a new one" } }] });
    fireEvent.change(await screen.findByLabelText("API token"), { target: { value: "tok-once" } });
    fireEvent.click(screen.getByText("Connect"));
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
    fireEvent.click(screen.getByText("Connect"));
    const account = await screen.findByLabelText("Account id");
    fireEvent.change(screen.getByLabelText("API token"), { target: { value: "tok-two" } });
    fireEvent.change(account, { target: { value: "1e0170aaabc90ecf5f466128d1f0466a" } });
    fireEvent.click(screen.getByText("Connect"));
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
    fireEvent.click(screen.getByText("Forget this token"));
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
      ownRules: { addresses: [], error: null },
    },
  };
  const takenOver = {
    outcome: {
      domain: "example.com", written: [], confirmed: ["route1.mx.cloudflare.net"], rule: "catch-all", note: null,
      routing: { state: "catch_all", detail: "the catch-all on example.com routes hello@example.com here" },
      catchAll: { before: { action: "worker", destinations: ["butler"], enabled: true }, after: { action: "worker", destinations: ["mailda"], enabled: true } },
    },
  };

  it("offers the box on an apex, names the current catch-all, and sends catchAll only when ticked", async () => {
    mount({ receiving: apex, outcome: takenOver });
    await propose("example.com", "hello@example.com");
    const box = await screen.findByLabelText("Route every address at example.com without a rule of its own to this Node (catch-all)");
    expect(screen.getByText(/Currently: worker → butler, enabled\./)).toBeTruthy();
    fireEvent.click(box);
    fireEvent.click(screen.getByText("Do this"));
    await waitFor(() => {
      const posted = calls.find((one) => one.path === "/api/provider/receiving" && one.method === "POST");
      expect(posted, "the confirmation was never sent").toBeDefined();
      expect((posted!.body as { catchAll?: boolean }).catchAll).toBe(true);
    });
    // The outcome names what was replaced, so the operator can put it back knowingly.
    expect(await screen.findByText(/The catch-all on example.com now routes to this Node \(before: worker → butler\)/)).toBeTruthy();
  });

  it("says why no rule routes the address when its own rule sends it elsewhere", async () => {
    // Records confirmed and the address routed elsewhere: `routing` is what says where it goes instead.
    const detail = "hello@example.com has an Email Routing rule of its own, named \"to gmail\": forward to somebody@gmail.test.";
    mount({ receiving: apex, outcome: { outcome: { ...takenOver.outcome, rule: null, catchAll: null, routing: { state: "routed_elsewhere", detail }, note: detail } } });
    await propose("example.com", "hello@example.com");
    await screen.findByLabelText("Route every address at example.com without a rule of its own to this Node (catch-all)");
    fireEvent.click(screen.getByText("Do this"));
    expect(await screen.findByText((text) => text.includes("no rule routes the address here") && text.includes(detail))).toBeTruthy();
  });

  it("says the catch-all was taken but the address's own rules could not be checked, never that all is well", async () => {
    // The catch-all path with the rules unreadable after the take-over: `rule` is the catch-all, `routing` is not.
    const detail = "not confirmed: the catch-all routes an address here only when it has no rule of its own, and this Node "
      + "could not check whether hello@example.com has an Email Routing rule of its own: 10000 Authentication error";
    mount({ receiving: apex, outcome: { outcome: { ...takenOver.outcome, routing: { state: "unconfirmed", detail } } } });
    await propose("example.com", "hello@example.com");
    fireEvent.click(await screen.findByLabelText("Route every address at example.com without a rule of its own to this Node (catch-all)"));
    fireEvent.click(screen.getByText("Do this"));
    expect(await screen.findByText((text) => text.includes("The catch-all on example.com now routes to this Node") && text.includes(detail))).toBeTruthy();
  });

  /*
   * "Every address" read as literally all on a zone where sales@ and info@ went to another Worker by rules of their
   * own, which outrank a catch-all (28 September 2026). The box's label says "without a rule of its own", and the
   * addresses that keep one are listed with where each goes; unread is said, never shown as none.
   */
  it("lists the addresses that keep a rule of their own, and where each goes, beside the box", async () => {
    mount({
      receiving: { proposal: { ...apex.proposal, ownRules: { error: null, addresses: [
        { address: "hello@example.com", state: "rule_written", where: "worker to mailda" },
        { address: "old@example.com", state: "rule_disabled", where: "forward to old@gmail.test" },
        { address: "sales@example.com", state: "routed_elsewhere", where: "worker to info-worker-whymelabs" },
      ] } } },
      outcome: takenOver,
    });
    await propose("example.com", "hello@example.com");
    await screen.findByLabelText("Route every address at example.com without a rule of its own to this Node (catch-all)");
    // "Does not reach" is claimed of an enabled rule only; the disabled row says Cloudflare does not say.
    const heading = screen.getByText(/Addresses at example.com with a routing rule of their own \(3\)\./);
    expect(heading.textContent!.replace(/\s+/g, " ")).toBe("Addresses at example.com with a routing rule of their own (3). An enabled rule "
      + "outranks the catch-all, so the catch-all does not reach that address; this Node leaves every one of these rules as it is.");
    const list = screen.getByText("sales@example.com").closest("ul")!;
    const items = [...list.querySelectorAll("li")].map((one) => one.textContent);
    expect(items).toEqual([
      "hello@example.com: this Node",
      "old@example.com: disabled (enabled, it would be forward to old@gmail.test); Cloudflare does not say whether the catch-all then applies",
      "sales@example.com: worker to info-worker-whymelabs",
    ]);
  });

  it("says when no address keeps a rule of its own", async () => {
    mount({ receiving: apex, outcome: takenOver });
    await propose("example.com", "hello@example.com");
    expect(await screen.findByText("No address at example.com has a routing rule of its own.")).toBeTruthy();
  });

  it("says unread rules leave the catch-all's reach unknown, never that no address has one", async () => {
    mount({ receiving: { proposal: { ...apex.proposal, ownRules: { addresses: [], error: "10000 Authentication error" } } }, outcome: takenOver });
    await propose("example.com", "hello@example.com");
    expect(await screen.findByText(/could not be read, so what the\s+catch-all would not reach is unknown: 10000 Authentication error/)).toBeTruthy();
    expect(screen.queryByText(/No address at example.com/)).toBeNull();
  });

  it("sends no catchAll key when the box is left alone", async () => {
    mount({ receiving: apex, outcome: takenOver });
    await propose("example.com", "hello@example.com");
    await screen.findByLabelText("Route every address at example.com without a rule of its own to this Node (catch-all)");
    fireEvent.click(screen.getByText("Do this"));
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

/**
 * Which recipients are verified destinations (28 September 2026). Cloudflare published no delivery event for mail
 * to one in the case measured, so this read is what lets the Outbox and doctor stop waiting. What would render
 * plausibly and be wrong: a button that posts somewhere else, or twice; a failed read rendered as a count, which
 * turns could not read into none verified; a refusal summarised; an empty Node told "0 of 0".
 */
describe("reading which recipients are verified destinations", () => {
  beforeEach(reset);
  const read = (overrides: Record<string, unknown> = {}) => ({
    destinations: {
      accountId: "acc_one", readAt: "2026-09-28T05:00:00.000Z", attemptedAt: "2026-09-28T05:00:00.000Z",
      error: null, recipients: 2, verified: 1, ...overrides,
    },
  });
  const press = async () => fireEvent.click(await screen.findByText("Read verified destinations"));

  it("posts once to the route the contract names, and says how many", async () => {
    mount({ verified: { status: 200, body: read() } });
    await press();
    const said = (await screen.findByText(/addresses this Node has handed mail to/)).textContent;
    expect(said).toContain("1 of the 2 addresses this Node has handed mail to is a verified destination");
    // Not "marks those recipients": a hand-over made before an address was verified carries no mark, and the
    // count above includes that address.
    expect(said).toContain("the Outbox marks their hand-overs made while they were verified.");
    expect(calls.filter((call) => call.path === "/api/provider/verified-destinations" && call.method === "POST"))
      .toHaveLength(1);
  });

  it("says are for more than one", async () => {
    mount({ verified: { status: 200, body: read({ recipients: 3, verified: 2 }) } });
    await press();
    expect((await screen.findByRole("status")).textContent)
      .toContain("2 of the 3 addresses this Node has handed mail to are verified destinations");
  });

  it("says a failed read could not read, and never counts it", async () => {
    mount({ verified: { status: 200, body: read({ error: "fixture: refused for the test", readAt: null, accountId: null, verified: null }) } });
    await press();
    const said = await screen.findByText(/The read did not succeed/);
    expect(said.textContent).toContain("fixture: refused for the test");
    expect(said.textContent).toContain("Until a read succeeds, these recipients show as unobserved.");
    expect(said.textContent).not.toContain("nothing to compare");
    expect(said.textContent).not.toContain(" of the ");
  });

  it("says a later failure leaves the earlier read standing, even on a Node that has sent nothing", async () => {
    mount({ verified: { status: 200, body: read({ error: "fixture: refused for the test", recipients: 0, verified: 0 }) } });
    await press();
    const said = await screen.findByText(/The read did not succeed/);
    // In the viewer's zone and locale, as every other time on this screen (the owner's round three, G4).
    expect(said.textContent).toContain(`The read of ${new Date("2026-09-28T05:00:00.000Z").toLocaleString()} still stands.`);
    expect(said.textContent).not.toContain("nothing to compare");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders a refusal whole", async () => {
    const message = "E_PROVIDER_ACCOUNT_MISMATCH  the operator credential names account b, and this Node's token is bound to a\n"
      + "  why      a Node lives in one account\n"
      + "  fix      set CLOUDFLARE_ACCOUNT_ID=a and run the command again";
    mount({ verified: { status: 409, body: { error: "E_PROVIDER_ACCOUNT_MISMATCH", message } } });
    await press();
    expect((await screen.findByText(/E_PROVIDER_ACCOUNT_MISMATCH/)).textContent).toBe(message);
  });

  it("tells a Node that has sent nothing that there was nothing to compare", async () => {
    mount({ verified: { status: 200, body: read({ recipients: 0, verified: 0 }) } });
    await press();
    expect((await screen.findByRole("status")).textContent).toContain("has handed mail to nobody yet");
  });
});

describe("registering a destination address (ADR 47)", () => {
  it("posts the address and says it waits until somebody there clicks the link", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Address", { selector: "#setup-destination-email" }), { target: { value: " new@example.test " } });
    fireEvent.click(screen.getByText("Register"));
    expect((await screen.findByText(/waiting for verification until/)).textContent)
      .toBe("new@example.test is waiting for verification until someone at that address clicks the link Cloudflare mailed them.");
    expect(calls.filter((one) => one.method === "POST").map((one) => [one.path, one.body]))
      .toEqual([["/api/provider/destination-addresses", { email: "new@example.test" }]]);
  });

  it("asks for the addresses only when the box is ticked, and lists them with their state", async () => {
    mount({ verified: { status: 200, body: { destinations: {
      accountId: "acc", readAt: "2026-10-03T00:00:00.000Z", attemptedAt: "2026-10-03T00:00:00.000Z", error: null, recipients: 0, verified: 0,
      listed: { verified: 1, waiting: 1 }, addresses: [{ email: "a@gmail.test", state: "verified" }, { email: "b@gmail.test", state: "waiting" }],
    } } } });
    fireEvent.click(await screen.findByLabelText("Show the addresses"));
    fireEvent.click(screen.getByText("Read verified destinations"));
    expect((await screen.findByText(/Destination addresses in the account/)).textContent).toBe("Destination addresses in the account: 1 verified, 1 waiting for verification.");
    expect(screen.getByText("b@gmail.test").closest("li")!.textContent).toContain("waiting for verification");
    expect(calls.find((one) => one.path === "/api/provider/verified-destinations")!.body).toEqual({ addresses: true });
  });
});

describe("the rules already on a zone", () => {
  const FORWARD_OFFER = {
    label: "receive here only", says: "someone@gmail.test gets nothing more for hello@example.com", filesInto: null, asksMailbox: true,
  };
  const rule = (over: Record<string, unknown>) => ({
    id: "r1", name: "hello to gmail", enabled: true, to: "hello@example.com", action: "forward",
    destinations: ["someone@gmail.test"], catchAll: false, ours: false, digest: "e".repeat(64),
    offer: "take_over", refusal: null, takeOver: FORWARD_OFFER, ...over,
  });
  const refused = (code: string, what: string, fix: string) => ({ offer: null, refusal: { code, what, why: "w", fix } });
  const listing = (rules: unknown[]) => ({ routing: { domain: "example.com", zone: "example.com", zoneId: "z1", rules, error: null } });
  async function list() {
    await screen.findByText("List the rules on this zone");
    fireEvent.change(document.getElementById("setup-rules-domain")!, { target: { value: "example.com" } });
    fireEvent.click(screen.getByText("List the rules on this zone"));
  }

  it("offers no act on a row the Node says it would refuse, and says the Node's reason instead", async () => {
    mount({ rules: listing([
      rule({ id: "off", to: "off@example.com", enabled: false, ...refused("E_ROUTING_RULE_DISABLED", "the rule for off@example.com is disabled", "enable it in the Cloudflare dashboard") }),
      rule({ id: "two", to: "two@example.com", ...refused("E_ROUTING_RULE_MANY_DESTINATIONS", "it forwards to 2 destinations", "edit it to one destination") }),
      rule({ id: "own", to: "own@example.com", ours: true, ...refused("E_ROUTING_RULE_NEVER_TAKEN", "this Node never took over rule own", "edit it in the dashboard") }),
      rule({ id: "back", to: "back@example.com", ours: true, offer: "put_back" }),
      rule({}),
    ]) });
    await list();
    const off = (await screen.findByText("off@example.com")).closest("tr")!;
    expect(off.textContent).toContain("the rule for off@example.com is disabled: enable it in the Cloudflare dashboard");
    expect(off.querySelector("button")).toBeNull();
    // A row the listing itself cannot tell is refused (a rule with two destinations), and this Node's own rule it never took.
    expect(screen.getByText("two@example.com").closest("tr")!.querySelector("button")).toBeNull();
    expect(screen.getByText("own@example.com").closest("tr")!.querySelector("button")).toBeNull();
    expect(screen.getByText("back@example.com").closest("tr")!.querySelector("button")?.textContent).toBe("Put back");
    // The enabled rule beside it still offers one, so the absence above is about the row, not the table.
    expect(screen.getByText("hello@example.com").closest("tr")!.querySelector("button")?.textContent).toBe("receive here only");
  });

  it("names the mailbox the address files into after a take-over", async () => {
    mount({
      rules: listing([rule({})]),
      takenOver: { outcome: {
        ruleId: "r1", to: "hello@example.com", before: { action: "forward", destinations: ["someone@gmail.test"] },
        after: { action: "worker", destinations: ["mailda"] }, mailbox: { id: "mbx_1", name: "Enquiries" },
      } },
    });
    await list();
    fireEvent.click(await screen.findByText("receive here only"));
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    expect((await screen.findByText(/hello@example.com: was forward/)).textContent)
      .toBe("hello@example.com: was forward → someone@gmail.test, now worker → mailda. It files into Enquiries.");
  });

  /*
   * The same choice and words as `mailda setup` (1 October 2026): the Node's `takeOver`, and for a forward a
   * mailbox chosen for it, a new one named after the address first, never the only one by default (critic M4).
   */
  const TAKEN = { outcome: {
    ruleId: "r1", to: "hello@example.com", before: { action: "forward", destinations: [] },
    after: { action: "worker", destinations: ["mailda"] }, mailbox: { id: "mbx_new", name: "hello@example.com" },
  } };
  const posted = () => calls.filter((one) => one.method === "POST").map((one) => [one.path, one.body]);

  it("says what a forward's take-over changes, and files it into a new mailbox named after it unless another is chosen", async () => {
    mount({ rules: listing([rule({})]), takenOver: TAKEN });
    await list();
    fireEvent.click(await screen.findByText("receive here only"));
    expect(screen.getByText("someone@gmail.test gets nothing more for hello@example.com.")).toBeTruthy();
    const select = screen.getByLabelText("Into mailbox") as HTMLSelectElement;
    expect([...select.options].map((one) => one.textContent)).toEqual(["a new mailbox named hello@example.com", "Support"]);
    expect(select.value).toBe("new");
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    await screen.findByText(/hello@example.com: was forward/);
    expect(posted()).toEqual([
      ["/api/mailboxes", { name: "hello@example.com" }],
      ["/api/provider/routing-rules/take-over", { domain: "example.com", ruleId: "r1", digest: "e".repeat(64), mailboxId: "mbx_new" }],
    ]);
  });

  it("asks no mailbox for a Worker rule when there is one, and sends that one", async () => {
    const worker = rule({ action: "worker", destinations: ["info-worker"], takeOver: { label: "receive here", says: "info-worker stops receiving mail", filesInto: null, asksMailbox: false } });
    mount({ rules: listing([worker]), takenOver: TAKEN });
    await list();
    fireEvent.click(await screen.findByText("receive here"));
    expect(screen.queryByLabelText("Into mailbox")).toBeNull();
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    await screen.findByText(/hello@example.com: was forward/);
    expect(posted()).toEqual([
      ["/api/provider/routing-rules/take-over", { domain: "example.com", ruleId: "r1", digest: "e".repeat(64), mailboxId: "mbx_test" }],
    ]);
  });

  it("sends no mailbox for an address that already files somewhere, which the take-over keeps", async () => {
    mount({ rules: listing([rule({ takeOver: { ...FORWARD_OFFER, filesInto: { id: "mbx_me", name: "Me" }, asksMailbox: false } })]), takenOver: TAKEN });
    await list();
    fireEvent.click(await screen.findByText("receive here only"));
    expect(screen.queryByLabelText("Into mailbox")).toBeNull();
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    await screen.findByText(/hello@example.com: was forward/);
    expect(posted()).toEqual([["/api/provider/routing-rules/take-over", { domain: "example.com", ruleId: "r1", digest: "e".repeat(64) }]]);
  });

  // ADR 47: a forward rule's third choice, in the Node's words, sent as the choice it is.
  const KEEP = { label: "receive here and keep forwarding to someone@gmail.test", says: "hello@example.com is stored here first, then forwarded" };
  const keeping = rule({ takeOver: { ...FORWARD_OFFER, filesInto: { id: "mbx_me", name: "Me" }, asksMailbox: false, keep: KEEP } });

  it("offers keep forwarding beside receive here only, shows what it means, and sends forward: keep", async () => {
    mount({ rules: listing([keeping]), takenOver: { outcome: { ...TAKEN.outcome, keptForward: "someone@gmail.test" } } });
    await list();
    fireEvent.click(await screen.findByText(KEEP.label));
    expect(screen.getByText(`${KEEP.says}.`)).toBeTruthy();
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    expect((await screen.findByText(/hello@example.com: was forward/)).textContent)
      .toContain("It keeps forwarding to someone@gmail.test, after each message is stored here.");
    expect(posted()).toEqual([["/api/provider/routing-rules/take-over", { domain: "example.com", ruleId: "r1", digest: "e".repeat(64), forward: "keep" }]]);
  });

  it("offers copies under keep only, unticked, states what a copy is, and sends copy: true when ticked", async () => {
    mount({ rules: listing([keeping]), takenOver: { outcome: { ...TAKEN.outcome, keptForward: "someone@gmail.test", copy: true } } });
    await list();
    expect(screen.queryByLabelText(/Also send a copy/)).toBeNull();
    fireEvent.click(await screen.findByText(KEEP.label));
    const box = screen.getByLabelText(/Also send a copy/) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(/^A copy is sent from hello@example.com/).textContent)
      .toContain('the recipient sees it from "<sender> via Me", and replies go to the sender. One copy goes to every destination refused for a message, and names them all in its To. Up to 5.0 MB.');
    fireEvent.click(box);
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    expect((await screen.findByText(/hello@example.com: was forward/)).textContent)
      .toContain("When the forward is refused as not verified, a copy is sent from hello@example.com.");
    expect(posted()).toEqual([["/api/provider/routing-rules/take-over", {
      domain: "example.com", ruleId: "r1", digest: "e".repeat(64), forward: "keep", copy: true,
    }]]);
  });

  it("sends forward: stop for receive here only when the Node offers the choice", async () => {
    mount({ rules: listing([keeping]), takenOver: TAKEN });
    await list();
    fireEvent.click(await screen.findByText("receive here only"));
    // No copy box beside receive here only: a copy follows a kept forward.
    expect(screen.queryByLabelText(/Also send a copy/)).toBeNull();
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    await screen.findByText(/hello@example.com: was forward/);
    expect(posted()).toEqual([["/api/provider/routing-rules/take-over", { domain: "example.com", ruleId: "r1", digest: "e".repeat(64), forward: "stop" }]]);
  });

  // ADR 47 amended (7 October 2026): a Worker rule's forward to addresses chosen here, started from its code.
  const FORWARD_TO = {
    label: "receive here and forward to addresses you choose", says: "info-worker stops receiving mail for sales@example.com",
    found: [{ to: "a@gmail.test", verified: "verified" }, { to: "w@gmail.test", verified: "waiting" }], foundError: null,
    copy: { label: "and copies", says: "a copy is sent" },
  };
  const toWorker = (forwardTo: typeof FORWARD_TO | (Omit<typeof FORWARD_TO, "found" | "foundError"> & { found: null; foundError: string })) => rule({
    action: "worker", destinations: ["info-worker"],
    takeOver: { label: "receive here", says: "info-worker stops receiving mail", filesInto: { id: "mbx_s", name: "Sales" }, asksMailbox: false, keep: null, forwardTo },
  });

  it("offers a Worker rule its forward, filled with the verified addresses its code names, and sends the list as edited", async () => {
    mount({ rules: listing([toWorker(FORWARD_TO)]), takenOver: { outcome: { ...TAKEN.outcome, forwards: ["a@gmail.test", "b@gmail.test"] } } });
    await list();
    fireEvent.click(await screen.findByText(FORWARD_TO.label));
    expect(screen.getByText(`${FORWARD_TO.says}.`)).toBeTruthy();
    expect(screen.getByText(/Filled in from the addresses info-worker's code names/)).toBeTruthy();
    const field = screen.getByLabelText("Forward to (separated by commas)") as HTMLInputElement;
    // The waiting one is shown on the listing, never filled in.
    expect(field.value).toBe("a@gmail.test");
    fireEvent.change(field, { target: { value: "a@gmail.test, b@gmail.test" } });
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    expect((await screen.findByText(/hello@example.com: was forward/)).textContent)
      .toContain("It forwards to a@gmail.test, b@gmail.test, after each message is stored here.");
    expect(posted()).toEqual([["/api/provider/routing-rules/take-over", {
      domain: "example.com", ruleId: "r1", digest: "e".repeat(64), forwardTo: ["a@gmail.test", "b@gmail.test"],
    }]]);
  });

  it("says why the Worker's code was not read, and confirms nothing until an address is typed", async () => {
    const unread = { ...FORWARD_TO, found: null, foundError: "info-worker's code could not be read (it needs Workers Scripts Read): 10000 Authentication error" };
    mount({ rules: listing([toWorker(unread)]), takenOver: TAKEN });
    await list();
    fireEvent.click(await screen.findByText(FORWARD_TO.label));
    expect(screen.getByText(/it needs Workers Scripts Read/)).toBeTruthy();
    expect((screen.getByText("Yes, point hello@example.com here") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Forward to (separated by commas)"), { target: { value: "c@gmail.test" } });
    fireEvent.click(screen.getByLabelText(/Also send a copy/));
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    await screen.findByText(/hello@example.com: was forward/);
    expect(posted()).toEqual([["/api/provider/routing-rules/take-over", {
      domain: "example.com", ruleId: "r1", digest: "e".repeat(64), copy: true, forwardTo: ["c@gmail.test"],
    }]]);
  });

  // Review, 1 October 2026: what the screen said, and offered, around a mailbox it made for a take-over refused after.
  it("says the mailbox it made stays when the take-over is refused, and offers that one, not a second, next time", async () => {
    mount({ rules: listing([rule({})]), takeOverRefused: { status: 409, body: { error: "E_ROUTING_RULE_STALE", message: "E_ROUTING_RULE_STALE  the rule changed" } } });
    await list();
    fireEvent.click(await screen.findByText("receive here only"));
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    expect((await screen.findByText(/E_ROUTING_RULE_STALE/)).textContent).toContain("The mailbox hello@example.com was made for it and stays.");
    fireEvent.click(await screen.findByText("receive here only"));
    // By id: with two mailboxes the receiving form has an "Into mailbox" of its own.
    const select = await waitFor(() => document.getElementById("setup-rules-mailbox-r1") as HTMLSelectElement);
    await waitFor(() => expect([...select.options].map((one) => one.textContent)).toEqual(["hello@example.com", "Support"]));
    expect(select.value).toBe("mbx_new");
    // What is sent, not only shown: a select whose state matched no option would display the first and send none.
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    await waitFor(() => expect(posted().filter(([path]) => path === "/api/provider/routing-rules/take-over")).toHaveLength(2));
    expect(posted()).toEqual([
      ["/api/mailboxes", { name: "hello@example.com" }],
      ["/api/provider/routing-rules/take-over", { domain: "example.com", ruleId: "r1", digest: "e".repeat(64), mailboxId: "mbx_new" }],
      ["/api/provider/routing-rules/take-over", { domain: "example.com", ruleId: "r1", digest: "e".repeat(64), mailboxId: "mbx_new" }],
    ]);
  });

  it("offers no new mailbox for an address longer than a mailbox name may be", async () => {
    const long = `${"a".repeat(50)}@example.com`;
    mount({ rules: listing([rule({ to: long })]), takenOver: TAKEN });
    await list();
    fireEvent.click(await screen.findByText("receive here only"));
    const select = screen.getByLabelText("Into mailbox") as HTMLSelectElement;
    expect([...select.options].map((one) => one.textContent)).toEqual(["choose a mailbox…", "Support"]);
    expect(select.value).toBe("");
  });

  it("names the mailbox before the confirm wherever it asks none", async () => {
    const worker = rule({ action: "worker", destinations: ["info-worker"], takeOver: { label: "receive here", says: "info-worker stops receiving mail", filesInto: null, asksMailbox: false } });
    mount({ rules: listing([worker, rule({ id: "r2", to: "me@example.com", takeOver: { ...FORWARD_OFFER, filesInto: { id: "mbx_me", name: "Me" }, asksMailbox: false } })]), takenOver: TAKEN });
    await list();
    fireEvent.click(await screen.findByText("receive here"));
    expect(screen.getByText("Files into Support.")).toBeTruthy();
    fireEvent.click(screen.getByText("receive here only"));
    expect(screen.getByText("Files into Me.")).toBeTruthy();
  });

  it("says when the rule's name does not record where it went", async () => {
    mount({ rules: listing([rule({})]), takenOver: { outcome: { ...TAKEN.outcome, nameRecorded: false } } });
    await list();
    fireEvent.click(await screen.findByText("receive here only"));
    fireEvent.click(screen.getByText("Yes, point hello@example.com here"));
    expect((await screen.findByText(/hello@example.com: was forward/)).textContent)
      .toContain("Its name does not record where it went, so only this Node can put it back: do that before the Node is ever deleted.");
  });
});
