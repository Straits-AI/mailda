import { afterEach, describe, expect, it, vi } from "vitest";

const { defaultLocalFor, firstAddress, provisionNode, signInLine } = await import("../../../../../packages/cli/src/verbs/provision.mjs");

/**
 * The install asks for the mailbox's first address as its local part and shows the domain beside it (28 September
 * 2026), as People's address field does, so nobody types a second domain or a different one by accident. A whole
 * address typed with its own `@` is taken as typed.
 */
describe("the first address from what was typed", () => {
  it("puts a local part on the domain, and blank is the default", () => {
    expect(firstAddress(" Admin ", "whymelabs.com")).toBe("admin@whymelabs.com");
    expect(firstAddress("", "whymelabs.com")).toBe("hello@whymelabs.com");
    expect(firstAddress(undefined, "whymelabs.com")).toBe("hello@whymelabs.com");
    expect(firstAddress("", "whymelabs.com", "weimeng")).toBe("weimeng@whymelabs.com");
  });

  it("takes an answer carrying its own @ whole, so a pasted address gets no second domain", () => {
    expect(firstAddress("Sales@WhymeLabs.com", "whymelabs.com")).toBe("sales@whymelabs.com");
  });
});

describe("the install's first-address prompt", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("asks for the part before @domain and sends local@domain", async () => {
    let posted: { address?: string } = {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const { hostname, pathname } = new URL(url);
      const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      // No zone listed, so the domain is typed rather than picked from a terminal list.
      if (hostname === "api.cloudflare.com") return answer({ result: [] });
      if (pathname === "/api/provider/receiving" && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as { address?: string };
        return answer({ outcome: { domain: "mail.whymelabs.com", written: [], confirmed: [], rule: null, routing: null, note: null, catchAll: null } });
      }
      if (pathname === "/api/provider/receiving") {
        return answer({ proposal: { zone: "whymelabs.com", zoneRouting: "ready", enablesZone: null, present: [], creates: [], refusal: null, apex: false, catchAll: null, digest: "d0" } });
      }
      return new Response("no route", { status: 404 });
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const asked: string[] = [];
    const answers = ["mail.whymelabs.com", "admin"];
    await provisionNode({
      origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: false,
      ask: async (prompt: string) => { asked.push(prompt); return answers.shift() ?? ""; },
    });
    expect(asked[1]).toBe("     the mailbox's first address: the part before @mail.whymelabs.com [hello]: ");
    expect(posted.address).toBe("admin@mail.whymelabs.com");
  });
});

/**
 * The first address defaults to the administrator's own (28 September 2026), when they sign in with an address on
 * the domain being set up and no rule of its own sends it elsewhere: the founder claimed as admin@ and found replies
 * going out as hello@. A rule elsewhere, or rules that could not be read, fall back to hello and say why.
 */
describe("the first address's default", () => {
  const rules = (addresses: Array<{ address: string; state: "rule_written" | "routed_elsewhere" | "rule_disabled"; where: string }>) => ({ addresses, error: null });

  it("is the sign-in address's local part when it is on the domain and has no rule of its own elsewhere", () => {
    expect(defaultLocalFor("Weimeng.Soh@WhymeLabs.com", "whymelabs.com", rules([]))).toEqual({ local: "weimeng.soh", said: null });
    // A rule of its own that already routes it here is no reason to fall back.
    expect(defaultLocalFor("admin@whymelabs.com", "whymelabs.com", rules([{ address: "admin@whymelabs.com", state: "rule_written", where: "worker to mailda" }])))
      .toEqual({ local: "admin", said: null });
  });

  it("is hello, silently, when the sign-in address is on another domain, a subdomain's parent included", () => {
    expect(defaultLocalFor("admin@gmail.com", "whymelabs.com", rules([]))).toEqual({ local: "hello", said: null });
    expect(defaultLocalFor("admin@whymelabs.com", "mail.whymelabs.com", rules([]))).toEqual({ local: "hello", said: null });
    expect(defaultLocalFor("admin@mail.whymelabs.com", "whymelabs.com", rules([]))).toEqual({ local: "hello", said: null });
    expect(defaultLocalFor(null, "whymelabs.com", rules([]))).toEqual({ local: "hello", said: null });
  });

  it("is hello, saying where, when a rule of its own sends it elsewhere or is disabled", () => {
    expect(defaultLocalFor("sales@whymelabs.com", "whymelabs.com", rules([{ address: "sales@whymelabs.com", state: "routed_elsewhere", where: "worker to info-worker-whymelabs" }])))
      .toEqual({ local: "hello", said: "sales@whymelabs.com is not the default: it has an Email Routing rule of its own, worker to info-worker-whymelabs" });
    expect(defaultLocalFor("old@whymelabs.com", "whymelabs.com", rules([{ address: "old@whymelabs.com", state: "rule_disabled", where: "forward to old@gmail.test" }])).said)
      .toBe("old@whymelabs.com is not the default: it has an Email Routing rule of its own, disabled (enabled, it would be forward to old@gmail.test)");
  });

  it("is hello when the rules could not be read, or the Node is too old to list them, and says it could not check", () => {
    const unread = defaultLocalFor("admin@whymelabs.com", "whymelabs.com", { addresses: [], error: "10000 Authentication error" });
    expect(unread).toEqual({ local: "hello", said: "admin@whymelabs.com is not the default: whether it has an Email Routing rule of its own could not be checked" });
    expect(defaultLocalFor("admin@whymelabs.com", "whymelabs.com", undefined).local).toBe("hello");
  });
});

describe("the install's first-address prompt, from the sign-in address", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function run(ownRules: unknown, answer: string, status = 200) {
    let posted: { address?: string } = {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const { hostname, pathname } = new URL(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (hostname === "api.cloudflare.com") return json({ result: [] });
      if (pathname === "/api/provider/receiving" && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as { address?: string };
        if (status !== 200) return new Response("{\"error\":\"E_RECEIVING_STALE\"}", { status });
        return json({ outcome: { domain: "whymelabs.com", written: [], confirmed: ["route1.mx.cloudflare.net."], rule: "mailda whymelabs.com", routing: { state: "rule_written", detail: "a rule now routes it here" }, note: null, catchAll: null } });
      }
      if (pathname === "/api/provider/receiving") {
        return json({ proposal: { zone: "whymelabs.com", zoneRouting: "ready", enablesZone: null, present: ["route1.mx.cloudflare.net."], creates: [], refusal: null, apex: false, catchAll: null, ownRules, digest: "d0" } });
      }
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const asked: string[] = [];
    const answers = ["whymelabs.com", answer];
    const done = await provisionNode({
      origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: false, signInEmail: "admin@whymelabs.com",
      ask: async (prompt: string) => { asked.push(prompt); return answers.shift() ?? ""; },
    });
    return { asked, posted, said: out.join(""), done };
  }

  it("offers the administrator's own local part, and Enter takes it", async () => {
    const { asked, posted, done } = await run({ addresses: [], error: null }, "");
    expect(asked[1]).toBe("     the mailbox's first address: the part before @whymelabs.com [admin]: ");
    expect(posted.address).toBe("admin@whymelabs.com");
    expect(done.address).toBe("admin@whymelabs.com");
  });

  it("says where the administrator's address goes when a rule of its own sends it elsewhere, and offers hello", async () => {
    const { asked, posted, said } = await run({ addresses: [{ address: "admin@whymelabs.com", state: "routed_elsewhere", where: "worker to info-worker-whymelabs" }], error: null }, "");
    expect(said).toContain("     admin@whymelabs.com is not the default: it has an Email Routing rule\n     of its own, worker to info-worker-whymelabs.\n");
    // The header names the domain, not a default the question below may not offer.
    expect(said).toContain("\n   receiving at whymelabs.com\n");
    expect(asked[1]).toBe("     the mailbox's first address: the part before @whymelabs.com [hello]: ");
    expect(posted.address).toBe("hello@whymelabs.com");
  });

  it("names no address as the mailbox's when the Node refused the onboarding, and keeps the one it asked for", async () => {
    const { posted, done } = await run({ addresses: [], error: null }, "", 409);
    expect(posted.address).toBe("admin@whymelabs.com");
    expect(done.address).toBeNull();
    // A refusal raised after the Node registered the address leaves it on the mailbox; the last line says it may be.
    expect(done.attempted).toBe("admin@whymelabs.com");
  });
});

describe("the install's last line", () => {
  const setUp = { receiving: "whymelabs.com", sending: "whymelabs.com", deliveryEvents: null, address: "admin@whymelabs.com", attempted: null, catchAll: false, routing: null };

  it("names the sign-in address and the address mail goes out as", () => {
    expect(signInLine("admin@whymelabs.com", setUp)).toBe("You sign in as admin@whymelabs.com. Mail goes out as admin@whymelabs.com.");
  });

  it("says when sending is not set up, when replies to it go elsewhere, and when there is no address", () => {
    expect(signInLine("a@b.c", { ...setUp, sending: null })).toBe("You sign in as a@b.c. Mail goes out as admin@whymelabs.com once sending is set up.");
    expect(signInLine("a@b.c", { ...setUp, receiving: null, routing: { state: "routed_elsewhere", detail: "elsewhere" } }))
      .toBe("You sign in as a@b.c. Mail goes out as admin@whymelabs.com, and mail to it does not reach this Node (above).");
    expect(signInLine("a@b.c", { ...setUp, address: null }))
      .toBe("You sign in as a@b.c. Mail goes out from the mailbox's address, and this run set none up; People adds one.");
  });

  /*
   * "Could not tell" is not "does not" (28 September 2026): `unconfirmed` is a check that could not be made, and
   * `rule_disabled` is a rule Cloudflare does not apply without saying whether the catch-all then does.
   */
  it("says whether mail reaches this Node could not be confirmed, when the Node could not tell", () => {
    for (const state of ["unconfirmed", "rule_disabled"] as const) {
      expect(signInLine("a@b.c", { ...setUp, receiving: null, routing: { state, detail: "could not tell" } }))
        .toBe("You sign in as a@b.c. Mail goes out as admin@whymelabs.com, and whether mail to it reaches this Node could not be confirmed (above).");
    }
    expect(signInLine("a@b.c", { ...setUp, receiving: null, routing: { state: "not_written", detail: "stopped" } }))
      .toBe("You sign in as a@b.c. Mail goes out as admin@whymelabs.com, and mail to it does not reach this Node (above).");
  });

  it("says the address it asked for may be on the mailbox when the onboarding stopped after asking", () => {
    expect(signInLine("a@b.c", { ...setUp, address: null, attempted: "admin@whymelabs.com" }))
      .toBe("You sign in as a@b.c. The onboarding stopped, and admin@whymelabs.com may already be on the mailbox; People shows its addresses.");
  });
});
