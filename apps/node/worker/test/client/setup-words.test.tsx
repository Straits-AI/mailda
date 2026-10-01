import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { install } from "/app/locale.js";
import { CATALOGS } from "../../src/i18n/catalog.ts";
import type { DeliveryRow, DoctorReport, ProviderBinding, Provisioned, RoutingRow } from "../../src/client/app/api.ts";
import { answerMailboxes, answerWith, reset, type Call } from "./session-stub.ts";

/**
 * Setup (`setup.tsx`) and the onboarding progress (`onboarding.tsx`) in English, byte for byte. The golden files
 * were written from the screens as they stood on 1 October 2026, before their words moved into the catalog (layer
 * 2b, ADR 46, `docs/i18n.md`), so a key whose English differs by a letter, a sentence split into fragments that no
 * longer read as one, or an element lost from inside a sentence, shows as a diff. The English is pinned as it was,
 * except the slips the migration fixed on purpose ("record(s)", "address(es)", "1 event types", "this node"), each
 * a deliberate golden change listed in the D table and held at one and at many below.
 *
 * Times are the viewer's zone and locale, so each is replaced by `[clock]` or `[date]` before comparing.
 */

const route = vi.hoisted(() => ({ pathname: "/inbox" }));
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { Setup } = await import("../../src/client/app/screens/setup.tsx");
const { ProgressList, SetupUnfinished, onboardingSteps } = await import("../../src/client/app/onboarding.tsx");

const REGISTERED = "2026-09-26T00:00:00.000Z";
/** The date `onboarding.tsx` writes for a record, computed the way it computes it. */
const day = (iso: string) => {
  const when = new Date(iso);
  return `${when.getDate()} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[when.getMonth()]} ${when.getFullYear()}`;
};
const DAYS = ["2026-09-24T10:00:00Z", "2026-09-24T10:01:00Z", "2026-09-25T10:01:00Z", "2026-09-25T11:00:00Z"];

function html(element: Element | string): string {
  let text = typeof element === "string" ? element : element.innerHTML;
  text = text.replaceAll(new Date(REGISTERED).toLocaleString(), "[clock]");
  for (const one of DAYS) text = text.replaceAll(day(one), "[date]");
  return text.replaceAll("><", ">\n<") + "\n";
}

/* ------------------------------------------------------------------------------------------- fixtures --- */

const PERMISSIONS = [
  { name: "Zone Read", scope: "zone", why: "find the zone a domain lives in", optional: false },
  { name: "Registrar Domains Read", scope: "account", why: "price a domain before buying it", optional: true },
];
const NOTE = "The permission names come from Cloudflare's token form and are not measured against it.";

const binding = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  state: "token_held", accountId: "acc_one", accountName: "Example Ltd", registeredAt: REGISTERED, verifiedAt: REGISTERED, ...over,
});
const UNCONNECTED = binding({ state: "no_token", accountId: null, accountName: null, registeredAt: null, verifiedAt: null });
const NONE: Provisioned = { receiving: null, sending: null, deliveryEvents: null };

const doctor = (ok: boolean | null): DoctorReport => ({
  verdict: "ok", claimed: true, at: "2026-09-24T00:00:00Z",
  findings: ok === null ? [] : [{ check: "inbound_routing", severity: "report", ok, detail: "prose the checklist must not read" }],
});
const routingRow = (over: Partial<RoutingRow> = {}): RoutingRow => ({
  domain: "mail.example.test", zone: "example.test", zoneId: "z", enabled: true, status: "ready", required: [], error: null, ...over,
});
const MX = { type: "MX", name: "mail.example.test", content: "route1.mx.cloudflare.net", priority: 9 };
const deliveryRow = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  domain: "example.test", zone: "example.test",
  sending: { name: "example.test", enabled: true, returnPath: null, dkimSelector: null, required: [], error: null },
  subscription: "sub", subscriptionId: "s1", enabled: true, events: ["email.sending"], queueId: "q", queueName: "mailda-sending-events",
  consumers: ["mailda"], error: null, ...over,
});

type Answer = unknown | ((call: Call) => Response | Promise<Response>);
const refused = (status: number, error: string, message: string) => () => Response.json({ error, message }, { status });
const pending = () => new Promise<Response>(() => {});

/**
 * The Node, as `METHOD /path` (no query) to a body or to a function of the call. `GET /api/provider` is assembled
 * from `provider` and `provisioned`; everything not named falls through to the stub's defaults.
 */
function node(routes: Record<string, Answer> = {}, provider = binding(), provisioned = NONE) {
  const all: Record<string, Answer> = {
    "GET /api/provider": { provider, provisioned, permissions: PERMISSIONS, note: NOTE },
    "GET /api/provider/email-routing": { routing: [] },
    "GET /api/doctor": doctor(true),
    ...routes,
  };
  answerWith((call) => {
    const answer = all[`${call.method} ${new URL(call.path, "https://node.example").pathname}`];
    if (answer === undefined) return undefined;
    return typeof answer === "function" ? (answer as (call: Call) => Response)(call) : Response.json(answer);
  });
}

function mount(element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}>{element}</QueryClientProvider>) };
}

/** The screen once it has settled, with every block it owns present, so a golden never pins a spinner. */
async function setup(): Promise<HTMLElement> {
  const { container } = mount(<Setup />);
  await screen.findByRole("region", { name: "Setup progress" });
  await waitFor(() => { expect(screen.queryByText("Reading…")).toBeNull(); });
  const blocks = ["h1", "[aria-label='Setup progress']", "[aria-label='Optional connection']", "[aria-label='Receiving mail'], [aria-label='Receiving']",
    "[aria-label='Sending mail'], [aria-label='Sending']", "[aria-label='Delivery outcomes']"];
  expect(blocks.every((one) => container.querySelector(one) !== null), "a block is missing, so this compares less than it says").toBe(true);
  return container;
}

const field = (label: string, value: string, selector?: string) =>
  fireEvent.change(screen.getByLabelText(label, selector === undefined ? {} : { selector }), { target: { value } });

/* --------------------------------------------------------------------------------------- the proposals --- */

const RECEIVE = {
  domain: "example.com", zone: "example.com", zoneId: "z1", zoneRouting: null, enablesZone: "example.com",
  creates: [{ type: "MX", name: "example.com", content: "route1.mx.cloudflare.net", priority: 9 }, { type: "TXT", name: "example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all", priority: null }],
  present: ["route2.mx.cloudflare.net"], rule: null, digest: "d".repeat(64), refusal: null,
  apex: true, catchAll: { action: "worker", destinations: ["butler"], enabled: false },
  ownRules: { error: null, addresses: [
    { address: "hello@example.com", state: "rule_written", where: "worker to mailda" },
    { address: "old@example.com", state: "rule_disabled", where: "forward to old@gmail.test" },
    { address: "sales@example.com", state: "routed_elsewhere", where: "worker to info-worker" },
  ] },
};
const SEND = {
  domain: "mail.example.com", zone: "example.com", zoneId: "z1", onboarded: false, coveredBy: "example.com",
  creates: ["TXT cf-bounce.mail.example.com", "MX cf-bounce.mail.example.com"], leavesBehind: ["the DKIM record cf2024-1._domainkey.mail.example.com"],
  digest: "s".repeat(64), error: null,
};
const SUBSCRIBE = {
  domain: "mail.example.com", zone: "example.com", zoneId: "z1", sendingDomain: "example.com", subscribed: null,
  queueId: "q1", queueName: "mailda-sending-events", consumerAttached: false, events: ["message.delivered", "message.bounced"],
  digest: "b".repeat(64), error: null,
};
const FORWARD = { label: "receive here only", says: "someone@gmail.test gets nothing more for hello@example.com", filesInto: null, asksMailbox: true };
const rule = (over: Record<string, unknown>) => ({
  id: "r1", name: "hello to gmail", enabled: true, to: "hello@example.com", action: "forward", destinations: ["someone@gmail.test"],
  catchAll: false, ours: false, digest: "e".repeat(64), offer: "take_over", refusal: null, takeOver: FORWARD, ...over,
});
const RULES = [
  rule({ id: "all", to: "*@example.com", catchAll: true, action: "worker", destinations: ["butler"], offer: null, takeOver: null }),
  rule({ id: "off", to: "off@example.com", enabled: false, offer: null, takeOver: null, refusal: { code: "E_ROUTING_RULE_DISABLED", what: "the rule for off@example.com is disabled", why: "w", fix: "enable it in the Cloudflare dashboard" } }),
  rule({ id: "back", to: "back@example.com", ours: true, offer: "put_back", takeOver: null }),
  rule({ id: "drop", to: "drop@example.com", action: "drop", destinations: [], takeOver: { label: "receive here", says: "drop@example.com stops being dropped", filesInto: null, asksMailbox: false } }),
  rule({}),
];
const listing = (rules: unknown[], error: string | null = null) => ({ routing: { domain: "example.com", zone: "example.com", zoneId: "z1", rules, error } });
const READ = { accountId: "acc_one", readAt: "2026-09-28T05:00:00.000Z", attemptedAt: "2026-09-28T05:00:00.000Z", error: null, recipients: 2, verified: 1 };

beforeEach(() => {
  reset();
  route.pathname = "/inbox";
});
afterEach(() => {
  install({ locale: "en", formatLocale: undefined, source: "default" }, { ...CATALOGS.en.preauth, ...CATALOGS.en.app });
});

/* ------------------------------------------------------------------------------------------- the goldens --- */

describe("Setup in English", () => {
  it("renders a Node with no token, its permission list, and a token that sees two accounts, as before", async () => {
    node({
      "GET /api/doctor": doctor(false),
      "PUT /api/provider/token": refused(422, "E_PROVIDER_ACCOUNT_AMBIGUOUS", "E_PROVIDER_ACCOUNT_AMBIGUOUS  the token can see 2 accounts\n  fix      pass accountId"),
    }, UNCONNECTED);
    const container = await setup();
    field("API token", "tok-two");
    fireEvent.click(screen.getByText("Connect"));
    await screen.findByLabelText("Account id");
    await expect(html(container)).toMatchFileSnapshot("./golden/setup.unconnected.en.html");
  });

  it("renders a connected Node with every form opened, as before", async () => {
    answerMailboxes([{ id: "mbx_test", name: "Support", addresses: "support@example.test" }, { id: "mbx_sales", name: "Sales", addresses: null }]);
    node({
      "GET /api/provider/email-routing": { routing: [
        routingRow({ domain: "mail.example.com", zone: "example.com" }),
        routingRow({ domain: "in.example.org", zone: null, enabled: false, status: null, required: [MX] }),
        routingRow({ domain: "broken.example.net", zone: "example.net", enabled: null, status: null, error: "10000 Authentication error" }),
        routingRow({ domain: "pending.example.com", zone: "example.com", status: null, required: [MX] }),
      ] },
      "GET /api/provider/delivery-events": { delivery: [deliveryRow({ domain: "example.com" })] },
      "GET /api/provider/receiving": { proposal: RECEIVE },
      "GET /api/provider/sending": { proposal: SEND },
      "GET /api/provider/subscription": { proposal: SUBSCRIBE },
      "GET /api/provider/routing-rules": listing(RULES),
      "POST /api/provider/verified-destinations": { destinations: READ },
    });
    const container = await setup();
    field("Subdomain", "example.com");
    field("Address to route here", "hello@example.com");
    fireEvent.click(screen.getByText("See what pointing this here would do"));
    await screen.findByText("What would happen to example.com");
    field("Domain", "mail.example.com", "#setup-send-domain");
    fireEvent.click(screen.getByText("See what onboarding this would do"));
    field("Domain", "mail.example.com", "#setup-subscribe-domain");
    fireEvent.click(screen.getByText("See what subscribing this would do"));
    field("Domain", "example.com", "#setup-rules-domain");
    fireEvent.click(screen.getByText("List the rules on this zone"));
    fireEvent.click(await screen.findByText("receive here only"));
    fireEvent.click(screen.getByText("Read verified destinations"));
    await screen.findByText(/Would publish 2 event types/);
    await screen.findByText(/Already covered by/);
    await screen.findByText(/addresses this Node has handed mail to/);
    await expect(html(container)).toMatchFileSnapshot("./golden/setup.connected.en.html");
  });

  it("renders the other shapes of each plan and of the rules' listing, as before", async () => {
    const parts: string[] = [];
    const plan = async (name: string, routes: Record<string, Answer>, open: () => Promise<Element>) => {
      cleanup();
      reset();
      node(routes);
      await setup();
      parts.push(`<!-- ${name} -->`, html(await open()));
    };
    const receive = async () => {
      field("Subdomain", "example.com");
      fireEvent.click(screen.getByText("See what pointing this here would do"));
      return (await screen.findByText(/^What would happen to /)).closest(".setup-plan")!;
    };
    const send = async () => {
      field("Domain", "mail.example.com", "#setup-send-domain");
      fireEvent.click(screen.getByText("See what onboarding this would do"));
      return (await screen.findByText("mail.example.com", { selector: "[aria-label='Sending mail'] h3" })).closest(".setup-plan")!;
    };
    const subscribe = async () => {
      field("Domain", "mail.example.com", "#setup-subscribe-domain");
      fireEvent.click(screen.getByText("See what subscribing this would do"));
      return (await screen.findByText("mail.example.com", { selector: "[aria-label='Delivery outcomes'] h3" })).closest(".setup-plan")!;
    };
    const rules = (arm?: string) => async () => {
      field("Domain", "example.com", "#setup-rules-domain");
      fireEvent.click(screen.getByText("List the rules on this zone"));
      const block = (await screen.findByText("Rules already on a zone")).closest(".setup-plan")!;
      await waitFor(() => { expect(block.querySelector("table, p.dim + p, pre, .dim:last-child")).not.toBeNull(); });
      if (arm !== undefined) fireEvent.click(await screen.findByText(arm));
      return block;
    };

    await plan("receiving: a subdomain, refused, no records, no address", {
      "GET /api/provider/receiving": { proposal: {
        ...RECEIVE, domain: "mail.example.com", enablesZone: null, creates: [], present: [], apex: false, catchAll: null,
        refusal: "E_PROVIDER_ZONE_NOT_FOUND  no zone in this account holds mail.example.com\n  fix      add the zone first",
      } },
    }, receive);
    await plan("receiving: an apex with no catch-all, its own rules unread", {
      "GET /api/provider/receiving": { proposal: { ...RECEIVE, enablesZone: null, catchAll: null, ownRules: { addresses: [], error: "10000 Authentication error" } } },
    }, receive);
    await plan("receiving: an apex whose catch-all goes nowhere, no address with a rule of its own", {
      "GET /api/provider/receiving": { proposal: { ...RECEIVE, enablesZone: null, catchAll: { action: "drop", destinations: [], enabled: true }, ownRules: { addresses: [], error: null } } },
    }, receive);
    await plan("sending: already onboarded", {
      "GET /api/provider/sending": { proposal: { ...SEND, onboarded: true, coveredBy: null, creates: [], leavesBehind: [] } },
    }, send);
    await plan("sending: refused", {
      "GET /api/provider/sending": { proposal: { ...SEND, coveredBy: null, creates: [], leavesBehind: [], error: "mail.example.com is not in a zone of this account" } },
    }, send);
    await plan("delivery outcomes: already subscribed", {
      "GET /api/provider/subscription": { proposal: { ...SUBSCRIBE, sendingDomain: "mail.example.com", subscribed: "mailda-sending-events-mail.example.com", consumerAttached: true } },
    }, subscribe);
    await plan("delivery outcomes: refused", {
      "GET /api/provider/subscription": { proposal: { ...SUBSCRIBE, sendingDomain: null, queueId: null, queueName: null, consumerAttached: null, events: [], error: "mail.example.com is not onboarded for sending — onboard it first: POST /api/provider/sending" } },
    }, subscribe);
    await plan("rules: none on the zone", { "GET /api/provider/routing-rules": listing([]) }, rules());
    await plan("rules: unreadable", { "GET /api/provider/routing-rules": listing([], "10000 Authentication error") }, rules());
    await plan("rules: putting one back", { "GET /api/provider/routing-rules": listing(RULES) }, rules("Put back"));
    await plan("rules: a rule asking no mailbox, the only one named", { "GET /api/provider/routing-rules": listing(RULES) }, rules("receive here"));
    await plan("rules: an address too long to name a mailbox", { "GET /api/provider/routing-rules": listing([rule({ to: `${"a".repeat(50)}@example.com` })]) }, rules("receive here only"));
    await expect(parts.join("\n")).toMatchFileSnapshot("./golden/setup.plans.en.html");
  });

  it("says what each act did, and what each refusal said, as before", async () => {
    const lines: string[] = [];
    const said = async (name: string, routes: Record<string, Answer>, act: () => Promise<void>, role: "status" | "alert" = "status") => {
      cleanup();
      reset();
      node(routes);
      await setup();
      await act();
      const shown = await screen.findAllByRole(role);
      lines.push(`${name}: ${shown.map((one) => one.textContent).join(" | ")}`);
    };
    const RECEIVE_ON = { "GET /api/provider/receiving": { proposal: { ...RECEIVE, enablesZone: null, apex: false, catchAll: null } } };
    const receive = (outcome: unknown) => async () => {
      node({ ...RECEIVE_ON, "POST /api/provider/receiving": typeof outcome === "function" ? outcome : { outcome } });
      field("Subdomain", "example.com");
      field("Address to route here", "hello@example.com");
      fireEvent.click(screen.getByText("See what pointing this here would do"));
      fireEvent.click(await screen.findByText("Do this"));
    };
    const outcome = (over: Record<string, unknown>) => ({
      domain: "example.com", written: ["MX example.com"], confirmed: ["MX example.com", "TXT example.com"], rule: "hello@example.com",
      note: null, catchAll: null, routing: { state: "rule_written", detail: "a rule now routes hello@example.com to this Node" }, ...over,
    });
    const before = { action: "worker", destinations: ["butler"], enabled: true };
    await said("receiving, routed", {}, receive(outcome({})));
    await said("receiving, routed elsewhere", {}, receive(outcome({ rule: null, routing: { state: "routed_elsewhere", detail: "hello@example.com has an Email Routing rule of its own, named \"to gmail\": forward to somebody@gmail.test." } })));
    await said("receiving, nothing confirmed", {}, receive(outcome({ confirmed: [], rule: null, note: "The records were not visible when read back.", routing: { state: "not_written", detail: "x" } })));
    await said("receiving, nothing confirmed, no note", {}, receive(outcome({ confirmed: [], rule: null, routing: { state: "not_written", detail: "x" } })));
    await said("receiving, catch-all", {}, receive(outcome({ rule: "catch-all", routing: { state: "catch_all", detail: "x" }, catchAll: { before, after: { action: "worker", destinations: ["mailda"], enabled: true } } })));
    await said("receiving, catch-all unconfirmed", {}, receive(outcome({ rule: "catch-all", routing: { state: "unconfirmed", detail: "not confirmed: the rules could not be read" }, catchAll: { before: { action: "drop", destinations: [], enabled: false }, after: before } })));
    await said("receiving, refused", {}, receive(refused(409, "E_PROVIDER_STALE_PROPOSAL", "E_PROVIDER_STALE_PROPOSAL  the zone changed since this plan was read\n  why      the digest no longer matches\n  fix      read the plan again before confirming it")), "alert");

    const send = (after: unknown) => async () => {
      node({ "GET /api/provider/sending": { proposal: { ...SEND, coveredBy: null, leavesBehind: [] } }, "POST /api/provider/sending": { proposal: after } });
      field("Domain", "mail.example.com", "#setup-send-domain");
      fireEvent.click(screen.getByText("See what onboarding this would do"));
      fireEvent.click(await screen.findByText("Onboard this domain"));
      await screen.findByText(/^mail\.example\.com is /);
    };
    await said("sending, onboarded", {}, send({ ...SEND, onboarded: true, coveredBy: null, creates: [], leavesBehind: [] }));
    await said("sending, not onboarded", {}, send({ ...SEND, coveredBy: null, creates: [], leavesBehind: [] }));

    const subscribe = (after: unknown) => async () => {
      node({ "GET /api/provider/subscription": { proposal: SUBSCRIBE }, "POST /api/provider/subscription": { proposal: after } });
      field("Domain", "mail.example.com", "#setup-subscribe-domain");
      fireEvent.click(screen.getByText("See what subscribing this would do"));
      fireEvent.click(await screen.findByText("Subscribe this domain"));
      await screen.findByText(/^mail\.example\.com(.s delivery| is still)/);
    };
    await said("delivery outcomes, subscribed", {}, subscribe({ ...SUBSCRIBE, subscribed: "mailda-sending-events-mail.example.com", consumerAttached: true }));
    await said("delivery outcomes, not subscribed", {}, subscribe({ ...SUBSCRIBE, consumerAttached: true }));

    const take = (routes: Record<string, Answer>, button: string) => async () => {
      node({ "GET /api/provider/routing-rules": listing(RULES), ...routes });
      field("Domain", "example.com", "#setup-rules-domain");
      fireEvent.click(screen.getByText("List the rules on this zone"));
      fireEvent.click(await screen.findByText(button));
      fireEvent.click(screen.getByText(/^Yes, /));
    };
    const taken = {
      ruleId: "r1", to: "hello@example.com", before: { action: "forward", destinations: ["someone@gmail.test"] },
      after: { action: "worker", destinations: ["mailda"] }, mailbox: { id: "mbx_test", name: "Support" },
    };
    await said("rules, taken over", {}, take({ "POST /api/provider/routing-rules/take-over": { outcome: { ...taken, nameRecorded: false } }, "POST /api/mailboxes": { mailboxId: "mbx_new", name: "hello@example.com" } }, "receive here only"));
    await said("rules, put back", {}, take({ "POST /api/provider/routing-rules/put-back": { outcome: { ...taken, to: "back@example.com", before: taken.after, after: { action: "drop", destinations: [] }, mailbox: null } } }, "Put back"));
    await said("rules, refused after a mailbox was made", {}, take({
      "POST /api/mailboxes": { mailboxId: "mbx_new", name: "hello@example.com" },
      "POST /api/provider/routing-rules/take-over": refused(409, "E_ROUTING_RULE_STALE", "E_ROUTING_RULE_STALE  the rule changed"),
    }, "receive here only"), "alert");

    const verified = (answer: Answer) => async () => {
      node({ "POST /api/provider/verified-destinations": answer });
      fireEvent.click(screen.getByText("Read verified destinations"));
    };
    await said("verified, one of two", {}, verified({ destinations: READ }));
    await said("verified, two of three", {}, verified({ destinations: { ...READ, recipients: 3, verified: 2 } }));
    await said("verified, nobody yet", {}, verified({ destinations: { ...READ, recipients: 0, verified: 0 } }));
    await said("verified, failed, never read", {}, verified({ destinations: { ...READ, error: "fixture: refused for the test", readAt: null, accountId: null, verified: null } }), "alert");
    await said("verified, failed, an earlier read stands", {}, verified({ destinations: { ...READ, error: "fixture: refused for the test" } }), "alert");
    await said("verified, refused", {}, verified(refused(409, "E_PROVIDER_ACCOUNT_MISMATCH", "E_PROVIDER_ACCOUNT_MISMATCH  the token is bound to another account\n  fix      run the command again")), "alert");
    await expect(lines.join("\n") + "\n").toMatchFileSnapshot("./golden/setup.outcomes.en.txt");
  });

  it("says what each button says while its act is in flight, and the screen before and without its data, as before", async () => {
    const lines: string[] = [];
    const busy = async (name: string, routes: Record<string, Answer>, provider: ProviderBinding, act: () => Promise<string>) => {
      cleanup();
      reset();
      node(routes, provider);
      await setup();
      lines.push(`${name}: ${await act()}`);
    };
    await busy("connecting", { "PUT /api/provider/token": pending }, UNCONNECTED, async () => {
      field("API token", "tok");
      fireEvent.click(screen.getByText("Connect"));
      return (await screen.findByText("Connecting…")).outerHTML;
    });
    await busy("forgetting", { "DELETE /api/provider/token": pending }, binding(), async () => {
      fireEvent.click(screen.getByText("Forget this token"));
      return (await screen.findByText("Forgetting…")).outerHTML;
    });
    await busy("working", { "GET /api/provider/receiving": { proposal: { ...RECEIVE, enablesZone: null } }, "POST /api/provider/receiving": pending }, binding(), async () => {
      field("Subdomain", "example.com");
      field("Address to route here", "hello@example.com");
      fireEvent.click(screen.getByText("See what pointing this here would do"));
      fireEvent.click(await screen.findByText("Do this"));
      return (await screen.findByText("Working…")).outerHTML;
    });
    await busy("an unnamed account, never registered", {}, binding({ accountName: null, accountId: null, registeredAt: null }), async () =>
      screen.getByText(/^Connected to account/).outerHTML);

    cleanup();
    reset();
    node({ "GET /api/provider": pending });
    const loading = mount(<Setup />).container;
    lines.push(`loading: ${loading.innerHTML}`);
    cleanup();
    reset();
    node({ "GET /api/provider": refused(404, "E_NOT_FOUND", "E_NOT_FOUND  no such route for this principal") });
    const failed = mount(<Setup />).container;
    await screen.findByRole("alert");
    lines.push(`failed: ${failed.innerHTML}`);
    await expect(html(lines.join("\n"))).toMatchFileSnapshot("./golden/setup.states.en.html");
  });
});

describe("the onboarding progress in English", () => {
  it("words every step in every state, and the count, as before", async () => {
    const record = (domain: string, at: string, over: Record<string, unknown> = {}) => ({
      domain, at, authority: "operator" as const, address: null, observed: false, routing: null, ...over,
    });
    const RECORDED: Provisioned = {
      receiving: record("mail.example.test", DAYS[0]!, { address: "hello@mail.example.test" }),
      sending: record("whymelabs.com", DAYS[2]!, { observed: true }),
      deliveryEvents: record("mail.example.test", DAYS[3]!, { authority: "token" }),
    };
    const elsewhere = (state: string, detail: string): Provisioned => ({
      ...RECORDED, receiving: { ...RECORDED.receiving!, domain: "whymelabs.com", routing: { state, detail } as never },
    });
    const COMBOS: Array<[string, Parameters<typeof onboardingSteps>[0]]> = [
      ["connected, all done", { provider: binding(), doctor: doctor(true), routing: [routingRow()], delivery: [deliveryRow()] }],
      ["connected, account unnamed, nothing read", { provider: binding({ accountName: null }), doctor: doctor(null) }],
      ["connected, an unnamed account with no id, sources unreadable", { provider: binding({ accountName: null, accountId: null }), doctor: null, routing: null, delivery: null }],
      ["connected, sources empty", { provider: binding(), doctor: doctor(false), routing: [], delivery: [] }],
      ["connected, every way a domain is not ready", {
        provider: binding(), doctor: doctor(true),
        routing: [routingRow({ required: [MX] }), routingRow({ domain: "off.example.test", enabled: false }), routingRow({ domain: "bad.example.test", error: "10000 Authentication error" })],
        delivery: [
          deliveryRow({ domain: "a.test", sending: null, subscription: null }),
          deliveryRow({ domain: "b.test", sending: { ...deliveryRow().sending!, error: "zone not found" }, enabled: false }),
          deliveryRow({ domain: "c.test", sending: { ...deliveryRow().sending!, required: [MX] }, queueId: null }),
          deliveryRow({ domain: "d.test", sending: { ...deliveryRow().sending!, enabled: false }, consumers: [] }),
          deliveryRow({ domain: "e.test", sending: null, consumers: [], error: "the queue could not be read" }),
        ],
      }],
      ["no connection state", { provider: null, doctor: doctor(true) }],
      ["no token, nothing recorded", { provider: UNCONNECTED, doctor: doctor(false) }],
      ["no token, an empty record", { provider: UNCONNECTED, doctor: doctor(true), provisioned: NONE }],
      ["no token, recorded", { provider: UNCONNECTED, doctor: doctor(true), provisioned: RECORDED }],
      ["no token, the address routed elsewhere", { provider: UNCONNECTED, doctor: doctor(true), provisioned: elsewhere("routed_elsewhere", "admin@whymelabs.com has an Email Routing rule of its own, named \"info\": worker to info-worker.") }],
      ["no token, the address unconfirmed", { provider: UNCONNECTED, doctor: doctor(true), provisioned: elsewhere("unconfirmed", "not confirmed: the rules could not be read") }],
    ];
    const parts: string[] = [];
    for (const [name, sources] of COMBOS) {
      const { container } = mount(<ProgressList steps={onboardingSteps(sources)} />);
      parts.push(`<!-- ${name} -->`, html(container));
      cleanup();
    }
    expect(parts.filter((one) => one.includes("onboarding-label")).length, "a combination rendered nothing, so this compares less than it says")
      .toBe(COMBOS.length);
    await expect(parts.join("\n")).toMatchFileSnapshot("./golden/onboarding.progress.en.html");
  });

  it("says the shell's one line when an address or the routing is undone, and nothing otherwise, as before", async () => {
    const lines: string[] = [];
    const notice = async (name: string, provider: ProviderBinding, provisioned: Provisioned, report: DoctorReport) => {
      cleanup();
      reset();
      node({ "GET /api/doctor": report }, provider, provisioned);
      const { container } = mount(<SetupUnfinished />);
      await waitFor(() => { expect(screen.queryByRole("status")).not.toBeNull(); });
      lines.push(`${name}: ${container.innerHTML}`);
    };
    await notice("no address", UNCONNECTED, NONE, doctor(false));
    await notice("not routed", UNCONNECTED, NONE, doctor(true));
    // The quiet half: both steps done, so the line says nothing at all.
    cleanup();
    reset();
    node({}, UNCONNECTED, { ...NONE, receiving: { domain: "d.test", at: DAYS[0]!, authority: "operator", address: null, observed: false, routing: null } });
    const { container: quiet, client } = mount(<SetupUnfinished />);
    // Settled, both sources read, so the empty line is the screen's answer and not a query still in flight.
    await waitFor(() => { expect(client.getQueryData(["provider"]) !== undefined && client.getQueryData(["doctor"]) !== undefined).toBe(true); });
    expect(document.querySelectorAll("[role=status]").length).toBe(0);
    lines.push(`done: ${quiet.innerHTML}`);
    expect(lines.filter((one) => one.includes("Setup is unfinished")).length, "a notice did not render, so this compares less than it says").toBe(2);
    await expect(html(lines.join("\n"))).toMatchFileSnapshot("./golden/onboarding.notice.en.html");
  });
});

/* ------------------------------------------------------------------------- the counts, at one and at many --- */

describe("Setup's counts in English", () => {
  it("says each count as a plural on it, at one and at many (the D-rows for record(s), address(es) and event types)", async () => {
    const said: string[] = [];
    const receive = async (confirmed: string[]) => {
      cleanup();
      reset();
      node({
        "GET /api/provider/receiving": { proposal: { ...RECEIVE, enablesZone: null, apex: false, catchAll: null } },
        "POST /api/provider/receiving": { outcome: {
          domain: "example.com", written: [], confirmed, rule: "hello@example.com", note: null, catchAll: null,
          routing: { state: "rule_written", detail: "x" },
        } },
      });
      await setup();
      field("Subdomain", "example.com");
      field("Address to route here", "hello@example.com");
      fireEvent.click(screen.getByText("See what pointing this here would do"));
      fireEvent.click(await screen.findByText("Do this"));
      said.push((await screen.findByRole("status")).textContent!);
    };
    await receive(["MX example.com"]);
    await receive(["MX example.com", "TXT example.com"]);
    expect(said).toEqual([
      "example.com now has 1 confirmed record and mail is routed to hello@example.com.",
      "example.com now has 2 confirmed records and mail is routed to hello@example.com.",
    ]);

    const publish = async (events: string[]) => {
      cleanup();
      reset();
      node({ "GET /api/provider/subscription": { proposal: { ...SUBSCRIBE, events } } });
      await setup();
      field("Domain", "mail.example.com", "#setup-subscribe-domain");
      fireEvent.click(screen.getByText("See what subscribing this would do"));
      return (await screen.findByText(/^Would publish/)).textContent;
    };
    expect(await publish(["message.delivered"])).toBe("Would publish 1 event type into mailda-sending-events.");
    expect(await publish(["message.delivered", "message.bounced"])).toBe("Would publish 2 event types into mailda-sending-events.");

    const verified = async (recipients: number, many: number) => {
      cleanup();
      reset();
      node({ "POST /api/provider/verified-destinations": { destinations: { ...READ, recipients, verified: many } } });
      await setup();
      fireEvent.click(screen.getByText("Read verified destinations"));
      return (await screen.findByRole("status")).textContent!.split(". ")[1];
    };
    expect(await verified(1, 1)).toBe("1 of the 1 address this Node has handed mail to is a verified destination");
    expect(await verified(2, 0)).toBe("0 of the 2 addresses this Node has handed mail to are verified destinations");
  });
});

/* -------------------------------------------------------------------------------------------- zh-Hans --- */

/** Setup read in Chinese: the catalog's words, and every word the Node or Cloudflare wrote marked as English. */
describe("Setup in zh-Hans", () => {
  const zh = () => install({ locale: "zh-Hans", formatLocale: "zh-Hans", source: "flag" }, { ...CATALOGS["zh-Hans"].preauth, ...CATALOGS["zh-Hans"].app });
  const english = (text: string) => screen.getByText(text).closest("[lang]")?.getAttribute("lang");
  /** The screen once settled, in Chinese. */
  const settled = async () => {
    mount(<Setup />);
    await screen.findByRole("region", { name: "配置进度" });
    await waitFor(() => { expect(screen.queryByText(CATALOGS["zh-Hans"].app["chrome.nothing.loading"])).toBeNull(); });
  };

  it("names the screen 配置 and marks the permissions' purposes, the note and a refusal as the Node's English", async () => {
    zh();
    node({ "PUT /api/provider/token": refused(409, "E_PROVIDER_TOKEN_REFUSED", "E_PROVIDER_TOKEN_REFUSED  Cloudflare refused the token") }, UNCONNECTED);
    await settled();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("配置");
    expect(english("find the zone a domain lives in")).toBe("en");
    // A permission's scope is Cloudflare's token, shown as the Node lists it.
    expect(screen.getAllByText("account").map((one) => one.getAttribute("lang"))).toEqual(["en"]);
    expect(english(NOTE)).toBe("en");
    field("API 令牌", "tok");
    fireEvent.click(screen.getByText("连接"));
    expect((await screen.findByRole("alert")).querySelector("[lang=en]")?.textContent).toBe("E_PROVIDER_TOKEN_REFUSED  Cloudflare refused the token");
  });

  it("says an outcome in Chinese with the Node's own sentence after it marked as English, and counts with a measure word", async () => {
    zh();
    answerMailboxes([{ id: "mbx_test", name: "Support", addresses: "support@example.test" }]);
    node({
      "GET /api/provider/receiving": { proposal: { ...RECEIVE, enablesZone: null, apex: false, catchAll: null } },
      "POST /api/provider/receiving": { outcome: {
        domain: "example.com", written: [], confirmed: ["MX example.com", "TXT example.com"], rule: null, note: null, catchAll: null,
        routing: { state: "routed_elsewhere", detail: "hello@example.com goes to another Worker." },
      } },
    });
    await settled();
    field("子域名", "example.com");
    field("要路由到这里的邮件地址", "hello@example.com");
    fireEvent.click(screen.getByText("看看把它指向这里会做什么"));
    fireEvent.click(await screen.findByText("执行"));
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("example.com 现在有 2 条已确认的记录，但没有规则把这个邮件地址路由到这里。 hello@example.com goes to another Worker.");
    expect(english("hello@example.com goes to another Worker.")).toBe("en");
  });

  it("counts the steps in Chinese and marks a source's own words in a step's detail as English", () => {
    zh();
    const { container } = mount(<ProgressList steps={onboardingSteps({
      provider: binding(), doctor: doctor(true), routing: [routingRow({ error: "10000 Authentication error" }), routingRow({ domain: "b.test", required: [MX, MX] })],
    })} />);
    expect(container.querySelector("p")!.textContent).toBe("已完成 2/5 步；下一步：邮件已路由到本节点。");
    expect(english("10000 Authentication error")).toBe("en");
    expect(container.querySelectorAll(".onboarding-detail")[1]!.textContent)
      .toBe("mail.example.test：10000 Authentication error；b.test：仍需 2 条记录");
  });
});

