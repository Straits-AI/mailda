import { afterEach, describe, expect, it, vi } from "vitest";

const { provisionNode } = await import("../../../../../packages/cli/src/verbs/provision.mjs");

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
