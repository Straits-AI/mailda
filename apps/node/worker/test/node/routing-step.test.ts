import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordedInName, takenOverName } from "@mailda/contract/routing-rule-name";

const { putBackWithoutNode, routingRulesStep, rulesPlan } = await import("../../../../../packages/cli/src/verbs/routing-step.mjs");

/**
 * The routing step in `mailda setup`, `mailda upgrade` and `mailda install` (1 October 2026): the rules that keep
 * addresses from reaching this Node, and the choice of pointing each here. What would print plausibly and be
 * wrong: a `--yes` run that changes a rule; a forward filed into the only mailbox without a question; a refusal
 * that ends the run or skips the rows after it; a subdomain's rules offered as if this Node received for them.
 */

const ORIGIN = "https://node.test";
const DOMAIN = "whymelabs.test";
const digest = (n: number) => String(n).repeat(64).slice(0, 64);

type Rule = import("../../../../../packages/cli/src/verbs/routing-step.mjs").ListedRule;
type Offer = NonNullable<Rule["takeOver"]>;
const rule = (id: string, to: string, action: string, destinations: string[], over: Partial<Rule> = {}): Rule => ({
  id, name: "", enabled: true, to, action, destinations, catchAll: false, ours: false, digest: digest(id.length),
  offer: "take_over", refusal: null, takeOver: null, ...over,
});
const offered = (says: string, over: Partial<Offer> = {}): Offer => ({ label: "receive here", says, filesInto: null, asksMailbox: false, keep: null, ...over });

/** A zone shaped like whymelabs.com, with placeholder personal destinations. */
const RULES: Rule[] = [
  rule("r_me", `me@${DOMAIN}`, "forward", ["<personal-1>"], {
    takeOver: offered("<personal-1> gets nothing more for me@", { label: "receive here only", asksMailbox: true }),
  }),
  rule("r_sales", `sales@${DOMAIN}`, "worker", ["info-worker"], { takeOver: offered("info-worker stops receiving mail for sales@") }),
  rule("r_junk", `junk@${DOMAIN}`, "drop", [], { takeOver: offered("mail Cloudflare was discarding for junk@ is kept from now on") }),
  rule("r_off", `off@${DOMAIN}`, "forward", ["<personal-2>"], {
    enabled: false, offer: null, refusal: { code: "E_ROUTING_RULE_DISABLED", what: "the rule for off@ is disabled", why: "w", fix: "enable it" },
  }),
  rule("r_admin", `admin@${DOMAIN}`, "worker", ["mailda"], { ours: true, offer: "put_back" }),
  rule("r_sub1", `me@shop.${DOMAIN}`, "forward", ["<personal-1>"], { takeOver: offered("x", { asksMailbox: true }) }),
  rule("r_sub2", `info@shop.${DOMAIN}`, "worker", ["info-worker"], { takeOver: offered("y") }),
  rule("r_sub3", `inbox@test.${DOMAIN}`, "worker", ["mailda-other"], { takeOver: offered("z") }),
  { ...rule("r_all", "*", "worker", ["mailda"], { ours: true, offer: "put_back" }), catchAll: true },
];
const listing = (rules: Rule[] = RULES) => ({ routing: { domain: DOMAIN, zone: DOMAIN, zoneId: "z", rules, error: null } });

let out: string[] = [];
let calls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
const printed = () => out.join("");

/** The Node's routes, as `fetch`: the listing, the mailboxes, a new mailbox, and the take-over (or its refusal). */
function node({
  rules = RULES, mailboxes = [{ id: "mbx_shared", name: "Shared" }], refuse = new Set<string>(),
  unconfirmed = new Set<string>(), lost = new Set<string>(), nameless = new Set<string>(),
} = {}) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, path: pathname, body, headers: init?.headers as Record<string, string> });
    if (pathname === "/api/provider/routing-rules" && method === "GET") return Response.json(listing(rules));
    if (pathname === "/api/mailboxes" && method === "GET") return Response.json({ mailboxes });
    if (pathname === "/api/mailboxes" && method === "POST") return Response.json({ mailboxId: "mbx_new", name: body.name });
    if (pathname === "/api/provider/routing-rules/take-over") {
      if (refuse.has(body.ruleId)) return new Response("E_ROUTING_RULE_STALE: the rule confirmed is not the one", { status: 409 });
      if (unconfirmed.has(body.ruleId)) {
        return Response.json({ error: "E_ROUTING_RULE_NOT_CONFIRMED", message: "E_ROUTING_RULE_NOT_CONFIRMED  Cloudflare may have applied the change" }, { status: 422 });
      }
      if (lost.has(body.ruleId)) throw new TypeError("connection reset");
      const box = body.mailboxId === "mbx_new" ? { id: "mbx_new", name: "new" } : { id: body.mailboxId, name: "Shared" };
      return Response.json({ outcome: {
        ruleId: body.ruleId, to: "?", before: { action: "x", destinations: [] }, after: { action: "worker", destinations: ["mailda"] }, mailbox: box,
        nameRecorded: !nameless.has(body.ruleId),
      } });
    }
    return new Response("no route", { status: 404 });
  });
}

/** A terminal: `isTTY`, and answers given in order to `ask` and `choose`, each recording what it was offered. */
function terminal(asks: string[], choices: Array<(options: Array<{ label: string; value: unknown }>) => unknown>) {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  const asked: string[] = [];
  const offered: Array<{ prompt: string; labels: string[] }> = [];
  return {
    asked, offered,
    ask: async (prompt: string) => { asked.push(prompt); return asks.shift() ?? ""; },
    choose: async (prompt: string, options: Array<{ label: string; value: unknown }>) => {
      offered.push({ prompt, labels: options.map((one) => one.label) });
      const pick = choices.shift();
      if (pick === undefined) throw new Error(`unexpected choice: ${prompt}`);
      return pick(options);
    },
  };
}
const leave = (options: Array<{ value: unknown }>) => options[0]!.value;
const take = (options: Array<{ value: unknown }>) => options[1]!.value;
const first = (options: Array<{ value: unknown }>) => options[0]!.value;

const posts = () => calls.filter((one) => one.method === "POST").map((one) => [one.path, one.body]);
const step = (input: Partial<Parameters<typeof routingRulesStep>[0]> = {}) => routingRulesStep({
  origin: ORIGIN, cookie: "c", accountId: "a".repeat(32), token: "t", yes: false, domain: DOMAIN,
  ask: async () => { throw new Error("asked"); }, choose: async () => { throw new Error("chose"); }, ...input,
});

/** The real `isTTY` of this process's stdin, put back after each test that pretends to be a terminal. */
const realTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

beforeEach(() => {
  out = [];
  calls = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (realTty === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stdin, "isTTY", realTty);
});

describe("rulesPlan", () => {
  it("shows the names this Node receives for, offers only what the Node offers, and counts the rest", () => {
    const plan = rulesPlan(listing().routing, DOMAIN);
    expect(plan.shown.map((one) => one.id)).toEqual(["r_me", "r_sales", "r_junk", "r_off", "r_admin"]);
    expect(plan.offered.map((one) => one.id)).toEqual(["r_me", "r_sales", "r_junk"]);
    expect(plan.hidden).toEqual({ count: 3, names: [`shop.${DOMAIN}`, `test.${DOMAIN}`] });
  });

  it("receives for a name a rule already routes to this Node", () => {
    const rules = [...RULES, rule("r_shop_ours", `hello@shop.${DOMAIN}`, "worker", ["mailda"], { ours: true, offer: "put_back" })];
    const plan = rulesPlan(listing(rules).routing, DOMAIN);
    expect(plan.offered.map((one) => one.id)).toContain("r_sub1");
    expect(plan.hidden.names).toEqual([`test.${DOMAIN}`]);
  });
});

describe("the list, printed on every run", () => {
  it("says what it claims, every row, why a row is not offered, the put-back, and the names not shown", async () => {
    node();
    await step({ yes: true });
    const text = printed();
    expect(text.replace(/\s+/g, " ")).toContain("Nothing changes unless you choose it here. Every rule can be pointed back; "
      + "mail that arrived here meanwhile stays here.");
    expect(text).not.toMatch(/every change can be/i);
    // Not "these addresses do not reach this Node": admin@ below does (review, 1 October 2026).
    expect(text.replace(/\s+/g, " ")).toContain("A rule for one address outranks the catch-all, so each address below goes where its own rule says, not to the catch-all (a disabled rule's address, Cloudflare does not say).");
    expect(text).not.toContain("do not reach this Node");
    expect(text).toMatch(new RegExp(`me@${DOMAIN} +forward to <personal-1>`));
    expect(text).toMatch(/off@whymelabs.test +forward to <personal-2> +\(disabled\)\n +not offered: the rule for off@ is disabled; enable it/);
    expect(text).toMatch(/admin@whymelabs.test +this Node\n +put back: mailda provider --put-back r_admin --domain whymelabs.test --url https:\/\/node.test/);
    expect(text).toContain("3 rules on shop.whymelabs.test and test.whymelabs.test are not shown");
    expect(text).toContain("mailda provider --routing-rules shop.whymelabs.test");
    expect(text).not.toContain("inbox@test.");
  });
});

describe("--yes, and no terminal", () => {
  it("--yes prints the command for each offered rule and changes nothing", async () => {
    node();
    await step({ yes: true });
    expect(printed()).toContain("--yes changes no routing rule. To point one here:");
    expect(printed()).toContain(`mailda provider --take-over r_me --domain ${DOMAIN} --confirm ${digest(4)} --mailbox <mailbox id> --url ${ORIGIN}`);
    expect(printed()).toContain(`mailda provider --take-over r_sales --domain ${DOMAIN} --confirm ${digest(7)} --url ${ORIGIN}`);
    expect(posts()).toEqual([]);
  });

  it("--yes names --mailbox wherever the Node would otherwise refuse, and lists the mailboxes to fill it with", async () => {
    node({ mailboxes: [{ id: "mbx_a", name: "A" }, { id: "mbx_b", name: "B" }] });
    await step({ yes: true });
    expect(printed()).toContain(`mailda provider --take-over r_sales --domain ${DOMAIN} --confirm ${digest(7)} --mailbox <mailbox id> --url ${ORIGIN}`);
    expect(printed()).toMatch(/mbx_a +A\n.*mbx_b +B\n/);
    expect(posts()).toEqual([]);
  });

  it("with no terminal to ask in, does the same and says why", async () => {
    node();
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    await step();
    expect(printed()).toContain("With no terminal to ask in, this changes no routing rule.");
    expect(posts()).toEqual([]);
  });

  it("sends the operator's credential with the listing, and the cookie alone when there is none", async () => {
    node();
    await step({ yes: true });
    expect(calls[0]!.headers).toMatchObject({ cookie: "c", "x-cloudflare-token": "t", "x-cloudflare-account": "a".repeat(32) });
    calls = [];
    await step({ yes: true, token: null });
    expect(calls[0]!.headers["x-cloudflare-token"]).toBeUndefined();
  });
});

describe("the question", () => {
  it("is not asked when no rule can be offered", async () => {
    node({ rules: RULES.filter((one) => one.id === "r_off" || one.id === "r_admin") });
    const tty = terminal([], []);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.asked).toEqual([]);
  });

  it("changes nothing on N, and lists no mailbox", async () => {
    node();
    const tty = terminal(["n"], []);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.asked).toEqual(["\n   Point any of these at this Node? [y/N] "]);
    expect(calls.map((one) => one.path)).toEqual(["/api/provider/routing-rules"]);
  });

  it("offers leave first for every rule, and applies only what was chosen once the plan is confirmed", async () => {
    node();
    // me@: take, into a new mailbox; sales@: leave; junk@: take, into the only mailbox without a question.
    const tty = terminal(["y", "y"], [take, first, leave, take]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.offered).toEqual([
      { prompt: `   me@${DOMAIN}`, labels: ["leave it", "receive here only"] },
      { prompt: `   which mailbox receives me@${DOMAIN}?`, labels: [`a new mailbox named me@${DOMAIN}`, "Shared"] },
      { prompt: `   sales@${DOMAIN}`, labels: ["leave it", "receive here"] },
      { prompt: `   junk@${DOMAIN}`, labels: ["leave it", "receive here"] },
    ]);
    expect(posts()).toEqual([
      ["/api/mailboxes", { name: `me@${DOMAIN}` }],
      ["/api/provider/routing-rules/take-over", { domain: DOMAIN, ruleId: "r_me", digest: digest(4), mailboxId: "mbx_new" }],
      ["/api/provider/routing-rules/take-over", { domain: DOMAIN, ruleId: "r_junk", digest: digest(6), mailboxId: "mbx_shared" }],
    ]);
    const text = printed();
    expect(text).toContain("<personal-1> gets nothing more for me@");
    expect(text).toContain(`me@${DOMAIN}   forward to <personal-1>  ->  this Node, into a new mailbox named me@${DOMAIN}`);
    expect(text).toContain(`put back: mailda provider --put-back r_junk --domain ${DOMAIN} --url ${ORIGIN}`);
    expect(text.replace(/\s+/g, " ")).toContain(`--put-back <rule id> --domain ${DOMAIN} --without-node`);
  });

  it("asks which mailbox for a Worker rule only when there is more than one, and offers the existing ones first", async () => {
    node({ mailboxes: [{ id: "mbx_a", name: "A" }, { id: "mbx_b", name: "B" }] });
    const tty = terminal(["y", "y"], [leave, (options) => options[1]!.value, (options) => options[1]!.value, leave]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.offered[2]).toEqual({ prompt: `   which mailbox receives sales@${DOMAIN}?`, labels: ["A", "B", `a new mailbox named sales@${DOMAIN}`] });
    expect(posts()).toEqual([["/api/provider/routing-rules/take-over", { domain: DOMAIN, ruleId: "r_sales", digest: digest(7), mailboxId: "mbx_b" }]]);
  });

  it("asks no mailbox for an address already filing somewhere, and sends that one", async () => {
    const rules = RULES.map((one) => one.id === "r_me"
      ? { ...one, takeOver: offered("s", { label: "receive here only", filesInto: { id: "mbx_me", name: "Me" } }) } : one);
    node({ rules });
    const tty = terminal(["y", "y"], [take, leave, leave]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.offered.map((one) => one.prompt)).not.toContain(`   which mailbox receives me@${DOMAIN}?`);
    expect(posts()).toEqual([["/api/provider/routing-rules/take-over", { domain: DOMAIN, ruleId: "r_me", digest: digest(4), mailboxId: "mbx_me" }]]);
  });

  it("offers a forward rule its third choice, keep forwarding, in the Node's words, and sends the choice (ADR 47)", async () => {
    const keep = { label: "receive here and keep forwarding to <personal-1>", says: "me@ is stored here first, then forwarded" };
    const rules = RULES.map((one) => one.id === "r_me"
      ? { ...one, takeOver: offered("<personal-1> gets nothing more for me@", { label: "receive here only", filesInto: { id: "mbx_me", name: "Me" }, keep: keep as never /* a Node before copies */ }) } : one);
    node({ rules });
    const tty = terminal(["y", "y"], [(options) => options[2]!.value, leave, leave]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.offered[0]).toEqual({ prompt: `   me@${DOMAIN}`, labels: ["leave it", "receive here only", keep.label] });
    expect(posts()).toEqual([["/api/provider/routing-rules/take-over", {
      domain: DOMAIN, ruleId: "r_me", digest: digest(4), mailboxId: "mbx_me", forward: "keep",
    }]]);
    expect(printed()).toContain("me@ is stored here first, then forwarded");
    expect(printed()).toContain("and keeps forwarding to <personal-1>");
  });

  it("sends stop for a forward rule's 'receive here only' to a Node that offers the choice, and prints both commands under --yes", async () => {
    const keep = { label: "receive here and keep forwarding to <personal-1>", says: "s" };
    const rules = RULES.map((one) => one.id === "r_me" ? { ...one, takeOver: offered("x", { label: "receive here only", filesInto: { id: "mbx_me", name: "Me" }, keep: keep as never /* a Node before copies */ }) } : one);
    node({ rules });
    const tty = terminal(["y", "y"], [take, leave, leave]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(posts()).toEqual([["/api/provider/routing-rules/take-over", {
      domain: DOMAIN, ruleId: "r_me", digest: digest(4), mailboxId: "mbx_me", forward: "stop",
    }]]);
    out = [];
    await step({ yes: true });
    expect(printed()).toContain(`--take-over r_me --domain ${DOMAIN} --confirm ${digest(4)} --forward stop --url ${ORIGIN}`);
    expect(printed()).toContain(`--take-over r_me --domain ${DOMAIN} --confirm ${digest(4)} --forward keep --url ${ORIGIN}`);
  });

  it("offers keep forwarding with copies as a fourth choice, in the Node's words, sends copy: true, and prints its command under --yes", async () => {
    const copy = { label: "receive here, keep forwarding to <personal-1>, and send a copy when it is refused", says: "a copy is sent from me@ as \"<sender> via <mailbox>\"" };
    const keep = { label: "receive here and keep forwarding to <personal-1>", says: "me@ is stored here first, then forwarded", copy };
    const rules = RULES.map((one) => one.id === "r_me"
      ? { ...one, takeOver: offered("<personal-1> gets nothing more for me@", { label: "receive here only", filesInto: { id: "mbx_me", name: "Me" }, keep }) } : one);
    node({ rules });
    const tty = terminal(["y", "y"], [(options) => options[3]!.value, leave, leave]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.offered[0]).toEqual({ prompt: `   me@${DOMAIN}`, labels: ["leave it", "receive here only", keep.label, copy.label] });
    expect(posts()).toEqual([["/api/provider/routing-rules/take-over", {
      domain: DOMAIN, ruleId: "r_me", digest: digest(4), mailboxId: "mbx_me", forward: "keep", copy: true,
    }]]);
    expect(printed()).toContain(copy.says);
    out = [];
    await step({ yes: true });
    expect(printed()).toContain(`${copy.label}:`);
    expect(printed()).toContain(`--take-over r_me --domain ${DOMAIN} --confirm ${digest(4)} --forward keep --copy --url ${ORIGIN}`);
  });

  it("changes nothing when the plan is not confirmed", async () => {
    node();
    const tty = terminal(["y", "n"], [leave, leave, take]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(posts()).toEqual([]);
    expect(printed()).toContain("nothing was changed.");
  });

  it("prints a refusal under its row and goes on with the next", async () => {
    node({ refuse: new Set(["r_sales"]) });
    const tty = terminal(["y", "y"], [leave, take, take]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(printed()).toMatch(/sales@whymelabs.test +not taken over:\n.*answered 409:\n.*E_ROUTING_RULE_STALE/);
    expect(posts().map(([, body]) => (body as { ruleId: string }).ruleId)).toEqual(["r_sales", "r_junk"]);
    expect(printed()).toContain(`junk@${DOMAIN}   taken over, files into Shared`);
  });
});

describe("what the step says after applying (review, 1 October 2026)", () => {
  it("says a take-over the Node could not confirm may have been applied, never that it was not taken over", async () => {
    node({ unconfirmed: new Set(["r_me"]), lost: new Set(["r_junk"]) });
    const tty = terminal(["y", "y"], [take, first, leave, take]);
    await step({ ask: tty.ask, choose: tty.choose });
    const text = printed();
    expect(text).toMatch(/me@whymelabs.test +not confirmed: Cloudflare may have applied this\n/);
    expect(text).toMatch(/junk@whymelabs.test +not confirmed: Cloudflare may have applied this\n/);
    expect(text).not.toContain("not taken over");
    expect(text).not.toContain("stays, empty");
    expect(text).toContain(`put back, if it was: mailda provider --put-back r_me --domain ${DOMAIN} --url ${ORIGIN}`);
  });

  it("says nothing about names recording anything when no take-over was confirmed with its name", async () => {
    node({ refuse: new Set(["r_sales"]), nameless: new Set(["r_junk"]) });
    const tty = terminal(["y", "y"], [leave, take, take]);
    await step({ ask: tty.ask, choose: tty.choose });
    const text = printed();
    expect(text).not.toContain("Before this Node is ever deleted");
    expect(text).not.toContain("--without-node");
    expect(text.replace(/\s+/g, " ")).toContain("its name does not record where it went, so only this Node can put it back: do that before the Node is ever deleted");
  });
});

describe("the mailbox named after the address", () => {
  it("is offered as the one already there, not made again, when a mailbox has that name", async () => {
    node({ mailboxes: [{ id: "mbx_shared", name: "Shared" }, { id: "mbx_me", name: `ME@${DOMAIN}` }] });
    const tty = terminal(["y", "y"], [take, first, leave, leave]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.offered[1]).toEqual({ prompt: `   which mailbox receives me@${DOMAIN}?`, labels: [`ME@${DOMAIN}`, "Shared"] });
    expect(posts()).toEqual([["/api/provider/routing-rules/take-over", { domain: DOMAIN, ruleId: "r_me", digest: digest(4), mailboxId: "mbx_me" }]]);
  });

  it("is not offered for an address longer than a mailbox name may be", async () => {
    const long = `${"a".repeat(50)}@${DOMAIN}`;
    node({ rules: [rule("r_long", long, "forward", ["<personal-1>"], { takeOver: offered("s", { label: "receive here only", asksMailbox: true }) })] });
    const tty = terminal(["y", "y"], [take, first]);
    await step({ ask: tty.ask, choose: tty.choose });
    expect(tty.offered[1]!.labels).toEqual(["Shared"]);
  });
});

describe("never exits, never throws", () => {
  it("prints a listing that could not be read and returns", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("connection refused"); });
    await expect(step({ yes: true })).resolves.toBeUndefined();
    expect(printed()).toContain("could not be read from https://node.test: connection refused");
  });

  it("prints the Node's own error for a zone it could not read", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ routing: { domain: DOMAIN, zone: null, zoneId: null, rules: [], error: "no zone in this account carries x" } }));
    await step({ yes: true });
    expect(printed()).toContain("not read: no zone in this account carries x");
  });

  it("does nothing without a receiving domain or a session", async () => {
    node();
    await step({ domain: null });
    await step({ cookie: null });
    expect(calls).toEqual([]);
  });
});

describe("the take-over's record in a rule's name (critic H1)", () => {
  it("round-trips each kind, and reads nothing it did not write", () => {
    const at = new Date("2026-10-01T09:00:00Z");
    for (const before of [
      { action: "forward", destinations: ["someone@gmail.test"] },
      { action: "worker", destinations: ["info-worker-whymelabs"] },
      { action: "drop", destinations: [] },
    ]) {
      expect(recordedInName(takenOverName("mailda-whymelabs", before, at))).toEqual({ ...before, worker: "mailda-whymelabs", at: "2026-10-01" });
    }
    expect(takenOverName("mailda", { action: "worker", destinations: ["info-worker"] }, at)).toBe("mailda mailda (was worker info-worker, repointed 2026-10-01)");
    // The hand-written precedent names no action, so it is not read as one.
    expect(recordedInName("mailda whymelabs.com (was info-worker-whymelabs, repointed 2026-09-28)")).toBeNull();
    expect(recordedInName("mailda x (was drop someone@gmail.test, repointed 2026-10-01)")).toBeNull();
    expect(recordedInName("mailda x (was forward, repointed 2026-10-01)")).toBeNull();
    expect(recordedInName("Rule created at 2025-04-04T14:38:50.063Z")).toBeNull();
  });
});

describe("put-back without a Node", () => {
  const RULE = {
    id: "r_me", name: "mailda mailda-whymelabs (was forward someone@gmail.test, repointed 2026-10-01)", enabled: true,
    matchers: [{ type: "literal", field: "to", value: `me@${DOMAIN}` }], actions: [{ type: "worker", value: ["mailda-whymelabs"] }],
  };
  function cloudflare(initial: Record<string, unknown>) {
    let held = { ...initial };
    const seen: Array<[string, string, unknown]> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      seen.push([method, path, body]);
      const ok = (result: unknown) => Response.json({ success: true, result });
      if (path.startsWith(`/zones?name=${DOMAIN}&`)) return ok([{ id: "zone_w", name: DOMAIN }]);
      if (path.startsWith("/zones?name=")) return ok([]);
      if (path === "/zones/zone_w/email/routing/rules/r_me") {
        if (method === "PUT") held = { ...held, ...body };
        return ok(held);
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, seen, held: () => held };
  }
  const exits = () => vi.spyOn(process, "exit").mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);

  it("restores the action the name records, from the zone that carries a subdomain, and reads it back", async () => {
    const cf = cloudflare(RULE);
    await putBackWithoutNode({ domain: `mail.${DOMAIN}`, ruleId: "r_me", token: "t", accountId: "acc", fetchImpl: cf.fetchImpl });
    expect(cf.held()).toMatchObject({ name: "", actions: [{ type: "forward", value: ["someone@gmail.test"] }], matchers: RULE.matchers, enabled: true });
    expect(printed()).toContain("now       forward -> someone@gmail.test, read back");
    expect(printed()).toContain("no Node was asked, so no audit entry records this");
  });

  it("refuses a rule whose name records no take-over, and one pointed elsewhere since", async () => {
    const said = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exits();
    const plain = cloudflare({ ...RULE, name: "Rule created at 2025-04-04" });
    await expect(putBackWithoutNode({ domain: DOMAIN, ruleId: "r_me", token: "t", accountId: "acc", fetchImpl: plain.fetchImpl })).rejects.toThrow("exit 1");
    expect(plain.seen.filter(([method]) => method === "PUT")).toEqual([]);
    // The catch-all's take-over never writes a name, so the refusal says so rather than blame the date alone.
    expect(said.mock.calls.join("").replace(/\s+/g, " ")).toMatch(/never for the catch-all/);
    const moved = cloudflare({ ...RULE, actions: [{ type: "drop" }] });
    await expect(putBackWithoutNode({ domain: DOMAIN, ruleId: "r_me", token: "t", accountId: "acc", fetchImpl: moved.fetchImpl })).rejects.toThrow("exit 1");
    expect(moved.seen.filter(([method]) => method === "PUT")).toEqual([]);
  });

  it("says the put-back is not confirmed when Cloudflare answers the PUT but the rule reads back unchanged", async () => {
    const said = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exits();
    const cf = cloudflare(RULE);
    // A PUT that answers success and changes nothing: only the read-back can tell.
    const deaf = (async (url: string, init?: RequestInit) =>
      cf.fetchImpl(url, init?.method === "PUT" ? { ...init, body: JSON.stringify({}) } : init)) as typeof fetch;
    await expect(putBackWithoutNode({ domain: DOMAIN, ruleId: "r_me", token: "t", accountId: "acc", fetchImpl: deaf })).rejects.toThrow("exit 1");
    expect(said.mock.calls.join("")).toContain("the put-back of r_me is not confirmed");
    expect(printed()).not.toContain("read back");
  });
});
