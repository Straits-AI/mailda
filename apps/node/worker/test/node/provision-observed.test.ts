import { afterEach, describe, expect, it, vi } from "vitest";

const { printNext, provisionNode } = await import("../../../../../packages/cli/src/verbs/provision.mjs");

/**
 * The install posts a sending proposal even when Cloudflare already has the domain onboarded, so the Node
 * records what it saw (26 September 2026). It used to print "onboarded already" and move on, and a Node
 * installed into an account that had onboarded the domain before it existed then said, in its own record
 * and at the end of every `mailda upgrade`, that sending was never set up.
 */
describe("provisionNode on a domain already in place", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts sending and subscription anyway, and says the sighting was recorded", async () => {
    const posted: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (init?.method === "POST") posted.push(path);
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === "/api/provider/receiving") return new Response("unreadable", { status: 500 });
      if (path === "/api/provider/sending") return answer({ proposal: { error: null, onboarded: true, zone: "whymelabs.com", digest: "d1", creates: [] } });
      if (path === "/api/provider/subscription") {
        return answer({ proposal: { error: null, subscribed: "sub-1", consumerAttached: true, digest: "d2", queueName: "q", events: [] } });
      }
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    vi.stubEnv("MAILDA_DOMAIN", "whymelabs.com");

    const done = await provisionNode({ origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: true, ask: async () => "" });

    expect(posted).toEqual(["/api/provider/sending", "/api/provider/subscription"]);
    expect(out.join("")).toContain("onboarded already, recorded");
    expect(out.join("")).toContain("subscribed already, as sub-1, recorded");
    expect(done).toMatchObject({ sending: "whymelabs.com", deliveryEvents: "whymelabs.com" });
  });
});

/**
 * The upgrade used to run the setup only when receiving was unrecorded, so a Node with receiving on record
 * and sending onboarded from the dashboard before it existed never got its sending recorded, however many
 * times it was upgraded (26 September 2026, whymelabs.com). Each step is now skipped on its own record.
 */
describe("provisionNode with steps already on the Node's record", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips the recorded step, asks no domain, and does the missing ones", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      asked.push(`${init?.method ?? "GET"} ${path}`);
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === "/api/provider/sending") return answer({ proposal: { error: null, onboarded: true, zone: "whymelabs.com", digest: "d1", creates: [] } });
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const act = (domain: string, observed = false) => ({ domain, at: "2026-09-25T17:10:03Z", address: "hello@whymelabs.com", observed });

    const done = await provisionNode({
      origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: false,
      ask: async (prompt) => { throw new Error(`asked: ${prompt}`); },
      provisioned: { receiving: act("whymelabs.com"), sending: null, deliveryEvents: act("whymelabs.com", true) },
    });

    expect(asked).toEqual(["GET /api/provider/sending", "POST /api/provider/sending"]);
    expect(out.join("")).toContain("recorded  2026-09-25 (in place before this Node, observed)");
    expect(done).toMatchObject({ receiving: "whymelabs.com", address: "hello@whymelabs.com", sending: "whymelabs.com", deliveryEvents: "whymelabs.com" });
  });
});

/**
 * A receiving onboard whose address has an Email Routing rule of its own that goes elsewhere answers with
 * records confirmed and its `routing` saying so (28 September 2026). The CLI used to call receiving set up
 * whenever the records read back, and then told the operator to prove it by mailing an address that routes to
 * another Worker; and on every re-run after that, it read the recorded intent and said the same.
 */
const ELSEWHERE = {
  state: "routed_elsewhere" as const,
  detail: "admin@whymelabs.com has an Email Routing rule of its own, named \"info\": worker to info-worker. It does not deliver "
    + "to this Node, and this Node left it as it is. To route the address here, list the rules with `mailda provider "
    + "--routing-rules whymelabs.com`, which prints the rule's id and digest, then `mailda provider --take-over r1 --domain "
    + "whymelabs.com --confirm <digest>`.",
};

describe("provisionNode when the address's own rule sends it elsewhere", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("says receiving is not set up, and why, from the outcome's routing", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === "/api/provider/receiving" && init?.method === "POST") {
        return answer({ outcome: { domain: "mail.whymelabs.com", written: [], confirmed: ["route1.mx.cloudflare.net."], rule: null, routing: ELSEWHERE, note: ELSEWHERE.detail, catchAll: null } });
      }
      if (path === "/api/provider/receiving") {
        return answer({ proposal: { zone: "whymelabs.com", zoneRouting: "ready", enablesZone: null, present: ["route1.mx.cloudflare.net."], creates: [], refusal: null, apex: false, digest: "d0" } });
      }
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    vi.stubEnv("MAILDA_DOMAIN", "mail.whymelabs.com");
    vi.stubEnv("MAILDA_ADDRESS", "admin@whymelabs.com");

    const done = await provisionNode({ origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: true, ask: async () => "" });

    expect(done.receiving).toBeNull();
    expect(out.join("")).toContain("receiving   not set up (admin@whymelabs.com has an Email Routing rule of its own, named \"info\": worker to info-worker.)");
  });

  it("says the same on a re-run, from the outcome recorded after the act, and never asks to prove it", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const act = (routing: typeof ELSEWHERE | null) => ({ domain: "whymelabs.com", at: "2026-09-28T17:10:03Z", address: "admin@whymelabs.com", observed: false, routing });

    const done = await provisionNode({
      origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: false,
      ask: async (prompt) => { throw new Error(`asked: ${prompt}`); },
      provisioned: { receiving: act(ELSEWHERE), sending: act(null), deliveryEvents: act(null) },
    });
    printNext("https://node.test", done);

    expect(asked).toEqual([]);
    expect(done).toMatchObject({ receiving: null, routing: ELSEWHERE });
    const said = out.join("");
    expect(said).not.toContain("prove it");
    expect(said).toContain("then        admin@whymelabs.com is not routed here: admin@whymelabs.com has an Email\n");
    expect(said).toContain("worker to info-worker");
    expect(said).toContain("mailda provider --onboard-receiving whymelabs.com --address <another> --url https://node.test");
    // A record from before outcomes were recorded still reads as the record it was, and says what it lacks.
    const legacy = await provisionNode({
      origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: false, ask: async () => "",
      provisioned: { receiving: act(null), sending: act(null), deliveryEvents: act(null) },
    });
    expect(legacy.receiving).toBe("whymelabs.com");
    expect(out.join("")).toContain("how the address is routed was not recorded");
  });
});

describe("provisionNode when the catch-all is taken and the first address is not routed here", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const catchAll = { before: { action: "drop", destinations: [], enabled: false }, after: { action: "worker", destinations: ["mailda"], enabled: true } };
  async function onboard(routing: { state: string; detail: string }) {
    const note = `the catch-all on whymelabs.com now routes to this Node; before, it was disabled. Every address this Node knows files unless a rule of its own sends it elsewhere. ${routing.detail}`;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === "/api/provider/receiving" && init?.method === "POST") {
        return answer({ outcome: { domain: "whymelabs.com", written: [], confirmed: ["catch-all → mailda"], rule: "catch-all", routing, note, catchAll } });
      }
      if (path === "/api/provider/receiving") {
        return answer({ proposal: { zone: "whymelabs.com", zoneRouting: "ready", enablesZone: null, present: ["route1.mx.cloudflare.net."], creates: [], refusal: null, apex: true, catchAll: catchAll.before, digest: "d0" } });
      }
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    vi.stubEnv("MAILDA_DOMAIN", "whymelabs.com");
    vi.stubEnv("MAILDA_ADDRESS", "admin@whymelabs.com");
    vi.stubEnv("MAILDA_CATCH_ALL", "1");
    const done = await provisionNode({ origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: true, ask: async () => "" });
    printNext("https://node.test", done);
    return { done, said: out.join("") };
  }

  it("says the catch-all routes here and the address does not, naming the rule rather than the catch-all", async () => {
    const { done, said } = await onboard(ELSEWHERE);
    expect(done).toMatchObject({ receiving: null, catchAll: true });
    // The reason is the sentence about the address's own rule, not the note's first sentence about the catch-all.
    expect(said).toContain("receiving   catch-all on whymelabs.com, but admin@whymelabs.com is not routed here "
      + "(admin@whymelabs.com has an Email Routing rule of its own, named \"info\": worker to info-worker.)");
    expect(said).not.toContain("prove it");
    // A re-run reads the same record, so "the step runs again" would send the operator in a circle.
    expect(said).not.toContain("the app shows the next setup step");
  });

  it("does not count receiving as set up when the address's own rules could not be read", async () => {
    const { done, said } = await onboard({
      state: "unconfirmed",
      detail: "not confirmed: the catch-all routes an address here only when it has no rule of its own, and this Node could not check whether admin@whymelabs.com has an Email Routing rule of its own: 10000 Authentication error",
    });
    expect(done.receiving).toBeNull();
    expect(said).toContain("is not routed here (not confirmed:");
    expect(said).not.toContain("prove it");
  });
});

/**
 * `mailda provider --onboard-receiving`, the command `printNext` names for routing another address, ended every
 * onboard with "send a message from OUTSIDE this Cloudflare account", including one whose address a rule of its
 * own sends to another Worker (28 September 2026). The prove-it line is for an address that reaches this Node.
 */
describe("mailda provider --onboard-receiving", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  async function onboard(routing: { state: string; detail: string }) {
    const { provider } = await import(`${import.meta.dirname}/../../../../../packages/cli/src/verbs/provider.mjs`) as {
      provider: (argv: string[]) => Promise<void>;
    };
    vi.stubEnv("MAILDA_EMAIL", "admin@whymelabs.com");
    vi.stubEnv("MAILDA_PASSWORD", "a long enough password");
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/auth/login") return new Response("{}", { status: 200, headers: { "set-cookie": "session=s; Path=/" } });
      if (path === "/api/provider/receiving") {
        return Response.json({ outcome: { domain: "whymelabs.com", written: [], confirmed: ["route1.mx.cloudflare.net."], rule: null, routing, note: routing.detail, catchAll: null } });
      }
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await provider(["--onboard-receiving", "whymelabs.com", "--address", "admin@whymelabs.com", "--confirm", "d0", "--url", "https://node.test"]);
    return out.join("");
  }

  it("asks for a test message only when the address reaches this Node", async () => {
    const elsewhere = await onboard(ELSEWHERE);
    expect(elsewhere).not.toContain("Send a message from OUTSIDE");
    expect(elsewhere).toContain("admin@whymelabs.com is not routed here, or could not be confirmed");
    const here = await onboard({ state: "rule_written", detail: "a rule now routes admin@whymelabs.com to this Node" });
    expect(here).toContain("Send a message from OUTSIDE");
  });
});
