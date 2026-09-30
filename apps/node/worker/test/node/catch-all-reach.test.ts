import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * `choose` needs a terminal, so it is replaced here by one that records what it was asked and takes the catch-all;
 * everything else in support.mjs is the real module.
 */
const chosen: Array<{ prompt: string; labels: string[] }> = [];
vi.mock("../../../../../packages/cli/src/support.mjs", async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  choose: async (prompt: string, options: Array<{ label: string; value: unknown }>) => {
    chosen.push({ prompt, labels: options.map((one) => one.label) });
    return options[0]!.value;
  },
}));

const { ownRulesLines, provisionNode } = await import("../../../../../packages/cli/src/verbs/provision.mjs");
// A computed specifier, as `provision-observed.test.ts` imports it: provider.mjs has no declaration file.
const { provider } = await import(`${import.meta.dirname}/../../../../../packages/cli/src/verbs/provider.mjs`) as { provider: (argv: string[]) => Promise<void> };

/**
 * What a catch-all take-over does not reach (28 September 2026). A literal rule outranks the catch-all, and the
 * prompt said "every address at it" on a zone where sales@, contact@ and info@ went to another Worker and one more
 * address was forwarded. The Node lists the addresses with rules of their own, classified; the prompt prints them
 * before the choice and the choice says "without a rule of its own". Unread, or a Node too old to list them, is said.
 */
const LIVE = {
  error: null,
  addresses: [
    { address: "contact@whymelabs.com", state: "routed_elsewhere" as const, where: "worker to info-worker-whymelabs" },
    { address: "hello@whymelabs.com", state: "rule_written" as const, where: "worker to mailda" },
    { address: "weimeng.soh@whymelabs.com", state: "routed_elsewhere" as const, where: "forward to weimeng@gmail.test" },
    { address: "old@whymelabs.com", state: "rule_disabled" as const, where: "drop" },
  ],
};

describe("the addresses a catch-all does not reach, as lines", () => {
  it("counts them and lists each with where it goes, aligned", () => {
    expect(ownRulesLines(LIVE, "whymelabs.com")).toEqual([
      "addresses at whymelabs.com with an Email Routing rule of their own",
      "(4). An enabled rule outranks the catch-all, so the catch-all does not",
      "reach that address; this Node leaves every one of these rules as it",
      "is:",
      "  contact@whymelabs.com      worker to info-worker-whymelabs",
      "  hello@whymelabs.com        this Node",
      "  weimeng.soh@whymelabs.com  forward to weimeng@gmail.test",
      "  old@whymelabs.com          disabled (enabled, it would be drop)",
      "for a disabled rule, Cloudflare does not say whether the catch-all",
      "then applies to its address",
    ]);
  });

  /*
   * "Will not reach" is said of enabled rules only (28 September 2026): Cloudflare does not say whether a disabled
   * rule's address falls to the catch-all, and the classifier claims neither, as the Setup screen's row says.
   */
  it("claims nothing of a disabled rule's address, and says so only when one is listed", () => {
    const lines = ownRulesLines(LIVE, "whymelabs.com").join(" ");
    expect(lines).not.toContain("will not reach them");
    expect(lines).toContain("for a disabled rule, Cloudflare does not say whether the catch-all then applies to its address");
    const enabledOnly = { error: null, addresses: LIVE.addresses.filter((one) => one.state !== "rule_disabled") };
    expect(ownRulesLines(enabledOnly, "whymelabs.com").join(" ")).not.toContain("disabled");
  });

  it("says none only when the rules were read, and says why otherwise", () => {
    expect(ownRulesLines({ addresses: [], error: null }, "whymelabs.com")).toEqual(["no address at whymelabs.com has an Email Routing rule of its own"]);
    expect(ownRulesLines({ addresses: [], error: "10000 Authentication error" }, "whymelabs.com").join(" "))
      .toBe("which addresses at whymelabs.com have an Email Routing rule of their own could not be read, so what the catch-all would not reach is unknown: 10000 Authentication error");
    expect(ownRulesLines(undefined, "whymelabs.com").join(" ")).toContain("this Node does not list which addresses at whymelabs.com");
  });
});

describe("taking the catch-all from the install's prompt", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); chosen.length = 0; });

  it("prints the addresses before the choice, and the choice says the catch-all is for the rest", async () => {
    let posted: { catchAll?: boolean } = {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const { hostname, pathname } = new URL(url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (hostname === "api.cloudflare.com") return json({ result: [] });
      if (pathname === "/api/provider/receiving" && init?.method === "POST") {
        posted = JSON.parse(String(init.body)) as { catchAll?: boolean };
        return new Response("refused", { status: 409 });
      }
      if (pathname === "/api/provider/receiving") {
        return json({ proposal: { zone: "whymelabs.com", zoneRouting: "ready", enablesZone: null, present: [], creates: [], refusal: null, apex: true, catchAll: { action: "drop", destinations: [], enabled: true }, ownRules: LIVE, digest: "d0" } });
      }
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const answers = ["whymelabs.com", ""];
    await provisionNode({ origin: "https://node.test", cookie: "c", accountId: "acc", token: "t", yes: false, ask: async () => answers.shift() ?? "" });

    const said = out.join("");
    expect(said).toContain("     whymelabs.com is a zone's own name. Its catch-all today: drop (enabled).\n"
      + "     addresses at whymelabs.com with an Email Routing rule of their own\n     (4). An enabled rule outranks the catch-all");
    expect(said).toContain("       weimeng.soh@whymelabs.com  forward to weimeng@gmail.test\n");
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.labels[0]).toBe("every address without a rule of its own: take the catch-all; addresses live in the Node, unknown ones bounce");
    expect(posted.catchAll).toBe(true);
  });

  it("prints the same under `mailda provider --onboard-receiving`, which --catch-all confirms", async () => {
    vi.stubEnv("MAILDA_EMAIL", "admin@whymelabs.com");
    vi.stubEnv("MAILDA_PASSWORD", "a long enough password");
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/auth/login") return new Response("{}", { status: 200, headers: { "set-cookie": "session=s; Path=/" } });
      if (path === "/api/provider/receiving") {
        return Response.json({ proposal: { domain: "whymelabs.com", zone: "whymelabs.com", zoneRouting: "ready", enablesZone: null, present: ["route1.mx.cloudflare.net."], creates: [], rule: null, refusal: null, apex: true, catchAll: null, ownRules: LIVE, digest: "d0" } });
      }
      return new Response("no route", { status: 404 });
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    await provider(["--onboard-receiving", "whymelabs.com", "--url", "https://node.test"]);
    const said = out.join("");
    expect(said).toContain("     apex      yes; catch-all today: nothing\n               addresses at whymelabs.com with an Email Routing rule of their own\n");
    expect(said).toContain("                 contact@whymelabs.com      worker to info-worker-whymelabs\n");
    expect(said).toContain("   confirm: mailda provider --onboard-receiving whymelabs.com \\\n");
    expect(said).toContain("add --catch-all to route every address at it without a rule of its own here");
  });
});
