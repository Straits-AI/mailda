import { afterEach, describe, expect, it, vi } from "vitest";

// A computed specifier, as `catch-all-reach.test.ts` imports it: provider.mjs has no declaration file.
const { provider } = await import(`${import.meta.dirname}/../../../../../packages/cli/src/verbs/provider.mjs`) as { provider: (argv: string[]) => Promise<void> };

/**
 * `mailda provider --routing-rules` and `--take-over` against a stubbed Node (30 September 2026). The CLI says
 * what Setup says: which rule the Node would take over or put back and which it would refuse, by the Node's own
 * `offer`, and where a taken-over address now files, since a take-over with no `--mailbox` uses the mailbox of an
 * address row already there and the operator chose none.
 */
const rule = (over: Record<string, unknown>) => ({
  id: "r1", name: "hello to gmail", enabled: true, to: "hello@example.com", action: "forward",
  destinations: ["someone@gmail.test"], catchAll: false, ours: false, digest: "e".repeat(64),
  offer: "take_over", refusal: null, ...over,
});

function node(answers: Record<string, unknown>) {
  vi.stubEnv("MAILDA_EMAIL", "admin@example.com");
  vi.stubEnv("MAILDA_PASSWORD", "a long enough password");
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/auth/login") return new Response("{}", { status: 200, headers: { "set-cookie": "session=s; Path=/" } });
    return path in answers ? Response.json(answers[path]) : new Response("no route", { status: 404 });
  });
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  return out;
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("the CLI's routing rules", () => {
  it("names the mailbox a taken-over address now files into", async () => {
    const out = node({ "/api/provider/routing-rules/take-over": { outcome: {
      ruleId: "r1", to: "hello@example.com", before: { action: "forward", destinations: ["someone@gmail.test"] },
      after: { action: "worker", destinations: ["mailda"] }, mailbox: { id: "mbx_1", name: "Wei Meng" },
    } } });
    await provider(["--take-over", "r1", "--domain", "example.com", "--confirm", "e".repeat(64), "--url", "https://node.test"]);
    expect(out.join("")).toContain("     now       worker -> mailda\n     files     into Wei Meng (mbx_1)\n");
  });

  it("offers per rule what the Node says it would do, and names the refusal where it would refuse", async () => {
    const out = node({ "/api/mailboxes": { mailboxes: [{ id: "mbx_1", name: "Shared" }] }, "/api/provider/routing-rules": { routing: { domain: "example.com", zone: "example.com", zoneId: "z1", error: null, rules: [
      rule({}),
      rule({ id: "r2", to: "two@example.com", destinations: ["a@gmail.test", "b@gmail.test"], offer: null,
        refusal: { code: "E_ROUTING_RULE_MANY_DESTINATIONS", what: "the rule for two@example.com forwards to 2 destinations", why: "w", fix: "edit it to one destination" } }),
      rule({ id: "r3", to: "in@example.com", action: "worker", destinations: ["mailda"], ours: true, offer: "put_back" }),
      // This Node's own, never taken over: nothing to put back.
      rule({ id: "r4", to: "own@example.com", action: "worker", destinations: ["mailda"], ours: true, offer: null,
        refusal: { code: "E_ROUTING_RULE_NEVER_TAKEN", what: "this Node never took over rule r4", why: "w", fix: "f" } }),
    ] } } });
    await provider(["--routing-rules", "example.com", "--url", "https://node.test"]);
    const said = out.join("");
    expect(said).toContain(`take over: mailda provider --take-over r1 --domain example.com --confirm ${"e".repeat(64)}\n`);
    expect(said).toContain("refused:   E_ROUTING_RULE_MANY_DESTINATIONS: the rule for");
    expect(said).not.toContain("--take-over r2");
    expect(said).toContain("put back:  mailda provider --put-back r3 --domain example.com\n");
    expect(said).not.toContain("--put-back r4");
    expect(said).toContain("refused:   E_ROUTING_RULE_NEVER_TAKEN");
  });

  it("prints what a take-over changes in the Node's words, and asks for a mailbox where the Node requires one (1 October 2026)", async () => {
    const out = node({ "/api/provider/routing-rules": { routing: { domain: "example.com", zone: "example.com", zoneId: "z1", error: null, rules: [
      rule({ takeOver: { label: "receive here only", says: "someone@gmail.test gets nothing more for hello@example.com", filesInto: null, asksMailbox: true } }),
    ] } } });
    await provider(["--routing-rules", "example.com", "--url", "https://node.test"]);
    const said = out.join("").replace(/\s+/g, " ");
    expect(said).toContain(`--confirm ${"e".repeat(64)} --mailbox <mailbox id> receive here only: someone@gmail.test gets nothing more for hello@example.com`);
  });

  it("names --mailbox for any rule the Node would refuse without one, and lists the mailboxes (review, 1 October 2026)", async () => {
    const worker = { label: "receive here", says: "info-worker stops receiving mail for sales@example.com", filesInto: null, asksMailbox: false };
    const listing = { routing: { domain: "example.com", zone: "example.com", zoneId: "z1", error: null, rules: [
      rule({ id: "r5", to: "sales@example.com", action: "worker", destinations: ["info-worker"], takeOver: worker }),
    ] } };
    const out = node({ "/api/mailboxes": { mailboxes: [{ id: "mbx_a", name: "A" }, { id: "mbx_b", name: "B" }] }, "/api/provider/routing-rules": listing });
    await provider(["--routing-rules", "example.com", "--url", "https://node.test"]);
    expect(out.join("")).toContain(`--take-over r5 --domain example.com --confirm ${"e".repeat(64)} --mailbox <mailbox id>\n`);
    expect(out.join("")).toMatch(/mbx_a +A\n.*mbx_b +B\n/);
    // One mailbox: the Node files into it, so the command needs none.
    const one = node({ "/api/mailboxes": { mailboxes: [{ id: "mbx_a", name: "A" }] }, "/api/provider/routing-rules": listing });
    await provider(["--routing-rules", "example.com", "--url", "https://node.test"]);
    expect(one.join("")).toContain(`--take-over r5 --domain example.com --confirm ${"e".repeat(64)}\n`);
  });
});

describe("the CLI's kept forwards and destination addresses (ADR 47)", () => {
  it("sends --forward as typed with the take-over, and says where the address now forwards", async () => {
    const sent: unknown[] = [];
    const out = node({ "/api/provider/routing-rules/take-over": { outcome: {
      ruleId: "r1", to: "hello@example.com", before: { action: "forward", destinations: ["someone@gmail.test"] },
      after: { action: "worker", destinations: ["mailda"] }, mailbox: { id: "mbx_1", name: "Hello" }, keptForward: "someone@gmail.test",
    } } });
    const stubbed = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => { if (init?.body !== undefined) sent.push(JSON.parse(String(init.body))); return stubbed(url, init); });
    await provider(["--take-over", "r1", "--domain", "example.com", "--confirm", "e".repeat(64), "--mailbox", "mbx_1", "--forward", "keep", "--url", "https://node.test"]);
    expect(sent.at(-1)).toEqual({ domain: "example.com", ruleId: "r1", digest: "e".repeat(64), mailboxId: "mbx_1", forward: "keep" });
    expect(out.join("")).toContain("     forwards  to someone@gmail.test, after each message is stored here\n");
  });

  it("lists each kept forward with its latest attempt in Cloudflare's words", async () => {
    const out = node({ "/api/forwards": { forwards: [{
      address: "hello@example.com", mailboxId: "mbx_1", to: "someone@gmail.test", verified: "waiting", checkedAt: "2026-10-03T00:00:00.000Z",
      last: { state: "refused", at: "2026-10-03T01:00:00.000Z", error: "destination address not verified" }, lastHandedOverAt: null,
    }] } });
    await provider(["--forwards", "--url", "https://node.test"]);
    const said = out.join("");
    expect(said).toContain("hello@example.com  forwards to someone@gmail.test (waiting for verification, read 2026-10-03T00:00:00.000Z)");
    expect(said).toContain("not forwarded at 2026-10-03T01:00:00.000Z: destination address not verified");
  });

  it("registers a destination and says what ends the wait", async () => {
    const out = node({ "/api/provider/destination-addresses": { destination: { email: "new@gmail.test", state: "waiting", added: true } } });
    await provider(["--add-destination", "new@gmail.test", "--url", "https://node.test"]);
    expect(out.join("").replace(/\s+/g, " ")).toContain("registered: waiting for verification until someone at new@gmail.test clicks the link Cloudflare mailed them");
  });

  it("prints the account's addresses only when they came back, and the counts always", async () => {
    const destinations = { accountId: "acc", readAt: "2026-10-03T00:00:00.000Z", attemptedAt: "2026-10-03T00:00:00.000Z", error: null, recipients: 0, verified: 0, listed: { verified: 1, waiting: 1 } };
    const counted = node({ "/api/provider/verified-destinations": { destinations: { ...destinations, addresses: null } } });
    await provider(["--destinations", "--url", "https://node.test"]);
    expect(counted.join("")).toContain("destination addresses  1 verified, 1 waiting for verification");
    expect(counted.join("")).not.toContain("@gmail.test");
    const listed = node({ "/api/provider/verified-destinations": { destinations: { ...destinations, addresses: [{ email: "b@gmail.test", state: "waiting" }] } } });
    await provider(["--destinations", "--addresses", "--url", "https://node.test"]);
    expect(listed.join("")).toContain("b@gmail.test  waiting for verification");
  });
});

