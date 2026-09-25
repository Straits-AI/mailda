import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginAuthorization, completeAuthorization, registerClient,
} from "../src/provider/cloudflare-grant.ts";
import { addAddress, onboardReceiving, receivingProposalFor } from "../src/provider/receiving.ts";
import { putBackRule } from "../src/provider/routing-rules.ts";

/**
 * Pointing a subdomain at this Node to receive (#163 L2), and the inert rule it exists to prevent.
 *
 * ## The measured defect behind every test here
 *
 * `POST /email/routing/rules` accepts a rule whose `to` address is on a subdomain nobody onboarded. It
 * answers 200, marks it `enabled`, and the rule **never matches** — the name has no MX, so mail to it never
 * reaches Cloudflare at all. Verified against Cloudflare's authoritative nameserver, not a resolver.
 *
 * So the order is the property: records first, read back, then the rule. A test that only checked "a rule
 * was created" would pass on precisely the broken thing.
 */

const testEnv = env as unknown as Env;
const ORG = "org_receiving";
const ADMIN = "usr_receiving_admin";
const ACCOUNT = "acc_receiving";
const MAILBOX = "mbx_receiving_one";
const AT = Date.parse("2026-09-16T10:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

beforeEach(async () => {
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("DELETE FROM provider_authorizations"),
    testEnv.CATALOG.prepare("DELETE FROM provider_binding"),
    testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM users WHERE id = ?").bind(ADMIN),
    testEnv.CATALOG.prepare("DELETE FROM addresses WHERE org_id = ?").bind(ORG),
    testEnv.CATALOG.prepare("DELETE FROM mailboxes WHERE org_id = ?").bind(ORG),
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(AT).toISOString()).run();
  // One mailbox, so an onboarding that names none files into it.
  await testEnv.CATALOG.prepare(
    "INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)",
  ).bind(MAILBOX, ORG, "Enquiries", new Date(AT).toISOString()).run();

  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    access_token: "an-access", refresh_token: "a-refresh", expires_in: 3600, scope: "a",
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await registerClient(testEnv, atTime(AT), ORG, ADMIN, {
    clientId: "a-client", clientSecret: "a-secret",
    redirectUri: "https://node.example.test/oauth/cloudflare/callback",
  });
  const { state } = await beginAuthorization(testEnv, atTime(AT + 1000), ADMIN, ["a"]);
  await completeAuthorization(testEnv, atTime(AT + 2000), ORG, {
    state, code: "the-code", error: null, errorDescription: null,
  });
  await testEnv.CATALOG.prepare("UPDATE provider_binding SET account_id = ? WHERE id = 1")
    .bind(ACCOUNT).run();
  vi.restoreAllMocks();
});

afterEach(() => vi.restoreAllMocks());

const APEX_MX = [
  { type: "MX", name: "example.test", content: "route1.mx.cloudflare.net.", priority: 25 },
  { type: "MX", name: "example.test", content: "route2.mx.cloudflare.net.", priority: 34 },
  { type: "MX", name: "example.test", content: "route3.mx.cloudflare.net.", priority: 12 },
  // SPF and DKIM ride in the same list and belong to *sending*. They must not be copied.
  { type: "TXT", name: "example.test", content: "\"v=spf1 include:_spf.mx.cloudflare.net ~all\"" },
  { type: "TXT", name: "cf2024-1._domainkey.example.test", content: "\"v=DKIM1; …\"" },
];

/** What Email Routing says a never-enabled subdomain is missing: its own MX and SPF, named for the subdomain. */
const SUB_MISSING = [
  { type: "MX", name: "mail.example.test", content: "route1.mx.cloudflare.net.", priority: 25, ttl: 1 },
  { type: "MX", name: "mail.example.test", content: "route2.mx.cloudflare.net.", priority: 34, ttl: 1 },
  { type: "MX", name: "mail.example.test", content: "route3.mx.cloudflare.net.", priority: 12, ttl: 1 },
  { type: "TXT", name: "mail.example.test", content: "\"v=spf1 include:_spf.mx.cloudflare.net ~all\"", ttl: 1 },
];

/**
 * Cloudflare, with the pieces a receiving onboard reads and writes.
 *
 * Raw DNS is not among them (25 September 2026): a subdomain's records are asked for and created through
 * `…/email/routing/dns?subdomain=`, which answers `{ errors: [{ code, missing }] }` until they exist and
 * `{ errors: null, records }` once they do. `existingMx` is what the subdomain already has, and `writtenMx`
 * is what a read-back returns — separate on purpose, so a test can make the write *appear* to succeed and
 * the read-back come back empty.
 */
function serving(opts: {
  routingEnabled?: boolean;
  /** Whether the zone starts listing MX once it has been enabled, which is what the real one does. */
  enableRevealsMx?: boolean;
  existingMx?: Array<{ content: string }>;
  writtenMx?: Array<{ content: string }> | null;
  rules?: unknown[];
  /** The enable answers success and leaves the zone off — the measured PATCH behaviour, for the refusal test. */
  enableIsInert?: boolean;
} = {}) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  let wrote = 0;
  let enabled = opts.routingEnabled !== false;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
    const method = init?.method ?? "GET";
    calls.push({ url: path, method, body: init?.body ? String(init.body) : null });
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), {
      status: 200, headers: { "content-type": "application/json" },
    });

    if (path.startsWith("/zones?name=example.test")) return ok([{ id: "zone_1", name: "example.test" }]);
    if (path.startsWith("/zones?name=")) return ok([]);
    if (path.endsWith("/email/routing/enable") && method === "POST") {
      if (opts.enableIsInert !== true) enabled = true;
      return ok({ enabled, status: enabled ? "ready" : "unconfigured" });
    }
    if (path.endsWith("/email/routing")) {
      // Measured: a PATCH { enabled: true } answers success and changes nothing. Answered the same here.
      return ok({ enabled, status: enabled ? "ready" : "unconfigured" });
    }
    if (path.includes("/email/routing/dns?subdomain=")) {
      const present = wrote === 0
        ? (opts.existingMx ?? [])
        : opts.writtenMx !== undefined ? (opts.writtenMx ?? []) : SUB_MISSING.filter((one) => one.type === "MX");
      if (present.length > 0) {
        return ok({ errors: null, records: present.map((one) => ({ type: "MX", name: "mail.example.test", content: one.content, priority: 1, ttl: 1 })) });
      }
      // A zone that is not routing lists nothing to be missing either; enabling is what reveals the set.
      const missing = !enabled ? [] : SUB_MISSING;
      return ok({ errors: missing.length === 0 ? null : missing.map((one) => ({ code: one.type === "MX" ? "mx.missing" : "spf.missing", missing: one })), records: null });
    }
    if (path.endsWith("/email/routing/dns")) {
      if (method === "POST") { wrote += 1; return ok({}); }
      // An un-routed zone lists nothing; enabling is what makes the records appear.
      const listing = opts.enableRevealsMx === true && !enabled ? [] : APEX_MX;
      return ok(opts.routingEnabled === false && !enabled ? [] : listing);
    }
    if (path.includes("/email/routing/rules")) {
      if (method === "POST") return ok({ name: "mailda mail.example.test" });
      return ok(opts.rules ?? []);
    }
    return ok(null);
  });
  return calls;
}

const posted = (calls: Array<{ url: string; method: string; body?: string | null }>, part: string) =>
  calls.filter((one) => one.method === "POST" && one.url.includes(part));

describe("proposing to receive on a subdomain", () => {
  it("lists exactly what Cloudflare says the subdomain is missing, named for the subdomain", async () => {
    /*
     * Cloudflare's own list, from the subdomain endpoint: three MX and the subdomain's SPF. Not a copy of
     * the apex's records, and not read through raw DNS, which wrangler's login cannot reach.
     */
    serving();
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");

    expect(proposal.refusal).toBeNull();
    expect(proposal.creates).toHaveLength(4);
    expect(proposal.creates.filter((one) => one.type === "MX")).toHaveLength(3);
    expect(proposal.creates.every((one) => one.name === "mail.example.test")).toBe(true);
    expect(proposal.creates.filter((one) => one.type === "MX").map((one) => one.priority).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([12, 25, 34]);
  });

  it("offers to turn the zone into a mail zone rather than sending somebody to the dashboard", async () => {
    /*
     * **This used to refuse**, on the argument that enabling Email Routing writes MX at the apex and so
     * decides where a whole domain's mail goes. The argument is right and the conclusion was wrong: refusing
     * sent the operator to the Cloudflare dashboard to do the same thing with less information, which is
     * what #108 exists to remove. ADR 42's line is *remove routine dashboard work, and do not disguise
     * legal or security decisions as automation* — this is routine dashboard work.
     *
     * So it is offered, named as its own field, and bound by the digest like everything else here.
     */
    serving({ routingEnabled: false });
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");

    expect(proposal.refusal).toBeNull();
    expect(proposal.enablesZone).toBe("example.test");
    /*
     * And `creates` is empty, which is honest rather than incomplete: a zone that is not routing lists no
     * MX, so the records are read after it is on. A proposal that enumerated them here would be inventing
     * them.
     */
    expect(proposal.creates).toEqual([]);
  });

  it("does not offer to enable a zone that is already routing", async () => {
    serving();
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    expect(proposal.enablesZone).toBeNull();
    expect(proposal.creates).toHaveLength(4);
  });

  it("names the credential when the routing state cannot be read, not the records", async () => {
    /*
     * The first real setup (25 September 2026) refused with "could not read the MX already on … 10000
     * Authentication error" — the raw DNS read that wrangler's login cannot make. That read is gone; a
     * refused routing read says what it is, so the next step is about the credential, not the domain.
     */
    serving();
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/email/routing/dns?subdomain=")) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
      }
      return base(url, init);
    });
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    expect(proposal.refusal).toContain("credential it holds");
    expect(proposal.refusal).toContain("10000 Authentication error");
    expect(proposal.creates).toEqual([]);
  });

  it("resumes when the MX present are Cloudflare's own, rather than refusing its own half-done work", async () => {
    /*
     * The #92 drill: records written, rule refused for a missing scope, and the next proposal said
     * "already has MX" about records this Node had put there. Cloudflare's routing hosts are not a mail host
     * somebody else chose, so the proposal keeps them, creates nothing, and the confirm writes the rule.
     */
    const calls = serving({
      existingMx: [{ content: "route1.mx.cloudflare.net." }, { content: "route2.mx.cloudflare.net." }],
    });
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    expect(proposal.refusal).toBeNull();
    expect(proposal.creates).toEqual([]);
    expect(proposal.present).toHaveLength(2);

    const outcome = await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", proposal.digest, "inbox@mail.example.test",
    );
    expect(posted(calls, "/email/routing/dns")).toHaveLength(0);
    expect(posted(calls, "/email/routing/rules")).toHaveLength(1);
    expect(outcome.rule).toBe("mailda mail.example.test");
  });

  it("registers the address on this Node, so the rule it writes delivers to a known recipient", async () => {
    /*
     * The #92 drill's finding: a rule was written for an address ingress would have refused as
     * `unknown_recipient`, because nothing in the product had ever inserted an `addresses` row. The row is
     * written in the same batch as the audit entry and before Cloudflare is asked, so a refusal from
     * Cloudflare leaves an address that files and no rule — harmless — never the reverse.
     */
    const calls = serving();
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", proposal.digest, "Inbox@Mail.Example.Test",
    );
    const row = await testEnv.CATALOG.prepare(
      "SELECT address, mailbox_id FROM addresses WHERE org_id = ?",
    ).bind(ORG).first<{ address: string; mailbox_id: string }>();
    expect(row).toEqual({ address: "inbox@mail.example.test", mailbox_id: MAILBOX });
    // And the rule matches the same lower-cased address the Node will look up.
    expect(posted(calls, "/email/routing/rules")[0]!.body).toContain('"value":"inbox@mail.example.test"');

    // Onboarding again is the resumable case: the row is kept, not duplicated and not a conflict.
    const again = await receivingProposalFor(testEnv, atTime(AT + 5000), ORG, "mail.example.test");
    await onboardReceiving(
      testEnv, atTime(AT + 6000), ORG, ADMIN, "mail.example.test", again.digest, "inbox@mail.example.test",
    ).catch(() => undefined);
    const count = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM addresses WHERE org_id = ?",
    ).bind(ORG).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("keeps a rule that already routes the address rather than asking Cloudflare for a duplicate", async () => {
    // The #92 drill's third run: Cloudflare answers `2014 Duplicated Zone rule` to a second identical rule.
    const calls = serving({
      rules: [{ name: "mailda mail.example.test", matchers: [{ field: "to", value: "Inbox@mail.example.test" }] }],
      existingMx: [{ content: "route1.mx.cloudflare.net." }],
    });
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    const outcome = await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", proposal.digest, "inbox@mail.example.test",
    );
    expect(posted(calls, "/email/routing/rules")).toHaveLength(0);
    expect(outcome.rule).toBe("mailda mail.example.test");
    expect(outcome.note).toContain("kept rather than duplicated");
  });

  it("refuses to choose a mailbox when there are several, and an address off the subdomain", async () => {
    serving();
    await testEnv.CATALOG.prepare(
      "INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)",
    ).bind("mbx_receiving_two", ORG, "Second", new Date(AT).toISOString()).run();
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    await expect(onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", proposal.digest, "inbox@mail.example.test",
    )).rejects.toThrow(/E_RECEIVING_MAILBOX_AMBIGUOUS/);
    await expect(onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", proposal.digest, "inbox@mail.example.test",
      "mbx_nowhere",
    )).rejects.toThrow(/E_RECEIVING_NO_SUCH_MAILBOX/);
    await expect(onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", proposal.digest, "inbox@elsewhere.test",
      MAILBOX,
    )).rejects.toThrow(/E_RECEIVING_ADDRESS_ELSEWHERE/);
    // Naming one works.
    await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", proposal.digest, "inbox@mail.example.test",
      "mbx_receiving_two",
    );
    const row = await testEnv.CATALOG.prepare(
      "SELECT mailbox_id FROM addresses WHERE org_id = ? AND address = ?",
    ).bind(ORG, "inbox@mail.example.test").first<{ mailbox_id: string }>();
    expect(row?.mailbox_id).toBe("mbx_receiving_two");
  });

  it("names an existing rule, which is how an inert one becomes visible", async () => {
    /*
     * **The defect, seen from the proposal side.** A rule exists, the subdomain has no MX, and every
     * listing shows the rule as enabled. Reporting the rule without the absent records is what would let
     * somebody read that as configured.
     */
    serving({ rules: [{
      id: "r1", name: "somebody's rule",
      matchers: [{ field: "to", value: "restore@mail.example.test" }],
    }] });
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");

    expect(proposal.rule).toBe("somebody's rule");
    expect(proposal.present).toEqual([]);
    // Not a refusal: the fix is to write the records, which is exactly what this proposal offers.
    expect(proposal.refusal).toBeNull();
    expect(proposal.creates).toHaveLength(4);
  });
});

describe("onboarding it", () => {
  const digestFor = async (d = "mail.example.test") =>
    (await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, d)).digest;

  it("writes the records before the rule, and reads them back first", async () => {
    serving();
    const digest = await digestFor();
    const calls = serving();

    const outcome = await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", digest, "restore@mail.example.test",
    );

    expect(outcome.written).toHaveLength(4);
    expect(outcome.confirmed).toHaveLength(3);
    expect(outcome.rule).toBe("mailda mail.example.test");

    /*
     * The order is the finding. Every DNS write precedes the rule, and a read-back sits between them — a
     * rule written first is the inert rule this module exists to prevent.
     */
    const at = (pred: (one: { url: string; method: string }) => boolean, last = false) => {
      const hits = calls.map((one, i) => (pred(one) ? i : -1)).filter((i) => i >= 0);
      return hits.length === 0 ? -1 : (last ? hits[hits.length - 1]! : hits[0]!);
    };
    /*
     * The **last** write and the **last** read-back, not the first of each: the proposal reads the subdomain
     * endpoint too, so a `findIndex` here matches the proposal's read and compares the wrong pair. An earlier
     * version of this assertion did exactly that and passed on the order it was meant to check. One POST:
     * the endpoint creates the whole set.
     */
    expect(posted(calls, "/email/routing/dns")).toHaveLength(1);
    const lastWrite = at((one) => one.method === "POST" && one.url.endsWith("/email/routing/dns"), true);
    const readBack = at((one) => one.method === "GET" && one.url.includes("/email/routing/dns?subdomain="), true);
    const rule = at((one) => one.method === "POST" && one.url.includes("/routing/rules"));

    expect(lastWrite).toBeGreaterThanOrEqual(0);
    expect(readBack, "the records were not read back before the rule").toBeGreaterThan(lastWrite);
    expect(rule, "the rule was written before its records were confirmed").toBeGreaterThan(readBack);
  });

  it("does not write the rule when the records read back empty", async () => {
    /*
     * **The test this module exists for.** The writes answer 200 and the read-back finds nothing — a state
     * a caller cannot distinguish from success without looking. Creating the rule here would produce
     * exactly the accepted-and-silent rule that Cloudflare allows, so it is refused instead.
     */
    serving();
    const digest = await digestFor();
    const calls = serving({ writtenMx: [] });

    const outcome = await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", digest, "restore@mail.example.test",
    );

    expect(outcome.confirmed).toEqual([]);
    expect(outcome.rule).toBeNull();
    expect(outcome.note).toContain("never matches");
    expect(posted(calls, "/routing/rules")).toEqual([]);
  });

  it("does not write the rule when the read-back itself is refused", async () => {
    // A read-back that fails is not a confirmation: the rule is held back exactly as for an empty one.
    serving();
    const digest = await digestFor();
    const calls = serving();
    const base = globalThis.fetch;
    let reads = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      // The proposal's read and the pre-write read pass; the read-back after the POST is refused.
      if (String(url).includes("/email/routing/dns?subdomain=") && (init?.method ?? "GET") === "GET" && ++reads >= 3) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
      }
      return base(url, init);
    });
    const outcome = await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", digest, "restore@mail.example.test",
    );
    expect(outcome.confirmed).toEqual([]);
    expect(outcome.rule).toBeNull();
    expect(posted(calls, "/routing/rules")).toEqual([]);
  });

  it("refuses a digest taken against a different subdomain", async () => {
    serving();
    const other = await digestFor("other.example.test");
    const calls = serving();

    await expect(onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", other, "restore@mail.example.test",
    )).rejects.toThrow(/E_RECEIVING_STALE/);
    expect(posted(calls, "/email/routing/dns")).toEqual([]);
  });

  it("enables the zone, then reads the records it produces, then writes them", async () => {
    /*
     * The order the un-routed case forces: nothing can be copied onto the subdomain until the zone lists
     * something to copy. A version that wrote first would have had nothing to write.
     */
    serving({ routingEnabled: false });
    const digest = await digestFor();
    const calls = serving({ routingEnabled: false, enableRevealsMx: true });

    const outcome = await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", digest, "restore@mail.example.test",
    );

    const enabled = calls.findIndex((one) => one.method === "POST" && one.url.endsWith("/email/routing/enable"));
    const wrote = calls.findIndex((one) => one.method === "POST" && one.url.endsWith("/email/routing/dns"));
    expect(enabled, "the zone was never enabled").toBeGreaterThanOrEqual(0);
    expect(wrote, "records were written before the zone could list any").toBeGreaterThan(enabled);
    expect(outcome.written).toHaveLength(4);
    // And the answer is read back: a PATCH is never sent, because it was measured to change nothing.
    expect(calls.some((one) => one.method === "PATCH")).toBe(false);
  });

  it("refuses when the zone is still off after the enable, rather than writing records it will not route", async () => {
    // A success that does nothing is the shape this refuses: the stub's enable is inert here, as the PATCH
    // was measured to be on the drill, and the outcome has to be a refusal with nothing written.
    serving({ routingEnabled: false });
    const digest = await digestFor();
    const calls = serving({ routingEnabled: false, enableRevealsMx: true, enableIsInert: true });
    await expect(onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", digest, "restore@mail.example.test",
    )).rejects.toThrow(/E_RECEIVING_ZONE_STILL_OFF/);
    expect(posted(calls, "/email/routing/dns")).toEqual([]);
    expect(posted(calls, "/email/routing/rules")).toEqual([]);
  });

  it("writes nothing when the proposal refuses", async () => {
    // A zone nothing in this account carries: the proposal refuses, and the apply refuses with it.
    const calls = serving();
    await expect(onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.nowhere.test", "0".repeat(64),
      "restore@mail.nowhere.test",
    )).rejects.toThrow(/E_RECEIVING_WILL_NOT_ONBOARD/);
    expect(posted(calls, "/email/routing/dns")).toEqual([]);
  });

  it("records the act before the DNS changes, naming what it was about to write", async () => {
    // A write that changes a customer's DNS and loses its answer has still changed their DNS.
    serving();
    const digest = await digestFor();
    serving();
    await onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", digest, "restore@mail.example.test",
    );

    const entry = await testEnv.CATALOG.prepare(
      "SELECT subject, detail FROM audit_entries WHERE org_id = ? AND action = ?",
    ).bind(ORG, "provider.receiving_onboarded").first<{ subject: string; detail: string }>();
    expect(entry?.subject).toBe("mail.example.test");
    const detail = JSON.parse(entry!.detail) as { zone: string; creates: string[]; address: string };
    expect(detail.zone).toBe("example.test");
    expect(detail.creates).toHaveLength(4);
    expect(detail.address).toBe("restore@mail.example.test");
  });
});

/**
 * The apex catch-all (25 September 2026). Cloudflare's catch-all supports apex domains only, so one rule
 * can route every address at the apex here, and addresses are then managed inside the Node — which is
 * safe because `email()` bounces what it does not know. What would render plausibly and be wrong: a
 * subdomain accepting `catchAll`; the take-over not recording what the catch-all pointed at; a put-back
 * writing to `/rules/{id}` instead of the catch-all's own endpoint; and an address added under a catch-all
 * domain trying to write a rule anyway.
 */
describe("the apex catch-all", () => {
  /** `serving()` plus the catch-all endpoint: GET reads it, PUT records what was written and reads back as it. */
  function servingApex(current: { action: string; value?: string[]; enabled: boolean }) {
    const calls = serving({ existingMx: [] });
    const base = globalThis.fetch;
    let catchAll = { name: "", enabled: current.enabled, matchers: [{ type: "all" }], actions: [{ type: current.action, ...(current.value === undefined ? {} : { value: current.value }) }] };
    const puts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      if (path.endsWith("/email/routing/rules/catch_all")) {
        if (init?.method === "PUT") { puts.push(String(init.body)); catchAll = { ...catchAll, ...(JSON.parse(String(init.body)) as typeof catchAll) }; }
        return new Response(JSON.stringify({ success: true, result: { id: "catch_all_id", ...catchAll } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(url, init);
    });
    return { calls, puts, current: () => catchAll };
  }

  it("reports the apex and what its catch-all points at today, and nothing of the kind on a subdomain", async () => {
    servingApex({ action: "worker", value: ["butler"], enabled: true });
    const apex = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "example.test");
    expect(apex.apex).toBe(true);
    expect(apex.catchAll).toEqual({ action: "worker", destinations: ["butler"], enabled: true });
    // Its records are the zone's own MX, read from the zone list: nothing to create, and the SPF and
    // DKIM in that same list are sending's, not "present" receiving records.
    expect(apex.creates).toEqual([]);
    expect(apex.present).toEqual(["route1.mx.cloudflare.net.", "route2.mx.cloudflare.net.", "route3.mx.cloudflare.net."]);
    const sub = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    expect(sub.apex).toBe(false);
    expect(sub.catchAll).toBeNull();
  });

  it("refuses catchAll on a subdomain, by name", async () => {
    servingApex({ action: "drop", enabled: false });
    const sub = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    await expect(onboardReceiving(testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", sub.digest, "a@mail.example.test", null, true))
      .rejects.toThrow(/E_RECEIVING_CATCH_ALL_NOT_APEX/);
  });

  it("takes the catch-all over on the apex: records what it was, writes this Worker, reads it back, writes no MX", async () => {
    const { calls, puts } = servingApex({ action: "worker", value: ["butler"], enabled: true });
    const apex = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "example.test");
    const outcome = await onboardReceiving(testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", apex.digest, "hello@example.test", null, true);
    expect(outcome.rule).toBe("catch-all");
    expect(outcome.catchAll?.before).toEqual({ action: "worker", destinations: ["butler"], enabled: true });
    expect(outcome.catchAll?.after.destinations).toEqual([testEnv.WORKER_NAME]);
    expect(outcome.confirmed).toEqual([`catch-all → ${testEnv.WORKER_NAME}`]);
    expect(outcome.note).toContain("butler");
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!)).toMatchObject({ enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [testEnv.WORKER_NAME] }] });
    // No subdomain records and no literal rule: the catch-all is the whole routing.
    expect(posted(calls, "/email/routing/dns")).toHaveLength(0);
    expect(posted(calls, "/email/routing/rules")).toHaveLength(0);
    // The address files, and the two entries say who did what.
    const address = await testEnv.CATALOG.prepare("SELECT address FROM addresses WHERE org_id = ?").bind(ORG).first<{ address: string }>();
    expect(address?.address).toBe("hello@example.test");
    const entries = await testEnv.CATALOG.prepare("SELECT action, subject, detail FROM audit_entries WHERE org_id = ? ORDER BY seq").bind(ORG).all<{ action: string; subject: string; detail: string }>();
    const taken = entries.results.find((one) => one.action === "provider.catch_all_taken_over");
    expect(taken?.subject).toBe("example.test");
    expect(JSON.parse(taken!.detail).before).toEqual({ action: "worker", destinations: ["butler"], enabled: true });
    const onboarded = entries.results.find((one) => one.action === "provider.receiving_onboarded");
    expect(JSON.parse(onboarded!.detail).catchAll).toBe(true);
  });

  it("puts the catch-all back to what the take-over recorded, through the catch-all's own endpoint", async () => {
    const { puts } = servingApex({ action: "worker", value: ["butler"], enabled: true });
    const apex = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "example.test");
    await onboardReceiving(testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", apex.digest, "hello@example.test", null, true);
    // The listing shows the catch-all as a rule with `to: "*"`, and put-back is addressed by its id.
    const { routingRulesFor } = await import("../src/provider/routing-rules.ts");
    vi.stubGlobal("fetch", ((base) => async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
      // The listing is paged (`?page=`), so the match allows a query string and excludes `/rules/{id}`.
      if (/\/email\/routing\/rules(\?|$)/.test(path) && (init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ success: true, result: [{ id: "catch_all_id", name: "", enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [testEnv.WORKER_NAME] }] }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(url, init);
    })(globalThis.fetch));
    const listed = await routingRulesFor(testEnv, atTime(AT + 5000), ORG, "example.test");
    const rule = listed.rules.find((one) => one.catchAll)!;
    expect(rule.ours).toBe(true);
    const back = await putBackRule(testEnv, atTime(AT + 6000), ORG, ADMIN, "example.test", rule.id);
    expect(back.after).toEqual({ action: "worker", destinations: ["butler"] });
    expect(puts).toHaveLength(2);
    expect(JSON.parse(puts[1]!)).toMatchObject({ enabled: true, actions: [{ type: "worker", value: ["butler"] }] });
    const entry = await testEnv.CATALOG.prepare("SELECT subject FROM audit_entries WHERE org_id = ? AND action = 'provider.catch_all_put_back'").bind(ORG).first<{ subject: string }>();
    expect(entry?.subject).toBe("example.test");
  });
});

describe("adding an address routes it in the same act", () => {
  it("writes nothing under a domain whose catch-all was taken over, and says so", async () => {
    const { calls } = (() => {
      const calls = serving({ existingMx: [] });
      const base = globalThis.fetch;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        const path = String(url).replace("https://api.cloudflare.com/client/v4", "");
        if (path.endsWith("/rules/catch_all")) return new Response(JSON.stringify({ success: true, result: { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: [testEnv.WORKER_NAME] }] } }), { status: 200, headers: { "content-type": "application/json" } });
        return base(url, init);
      });
      return { calls };
    })();
    const apex = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "example.test");
    await onboardReceiving(testEnv, atTime(AT + 4000), ORG, ADMIN, "example.test", apex.digest, "hello@example.test", null, true);
    const before = calls.length;
    const added = await addAddress(testEnv, atTime(AT + 5000), ORG, ADMIN, "Sales@Example.test", null);
    expect(added.routing.state).toBe("catch_all");
    expect(added.address.address).toBe("sales@example.test");
    expect(calls.length).toBe(before);
    const rows = await testEnv.CATALOG.prepare("SELECT address FROM addresses WHERE org_id = ? ORDER BY address").bind(ORG).all<{ address: string }>();
    expect(rows.results.map((one) => one.address)).toEqual(["hello@example.test", "sales@example.test"]);
  });

  it("writes a literal rule on a subdomain routed by rules, and keeps an existing one", async () => {
    const calls = serving({ existingMx: [{ content: "route1.mx.cloudflare.net." }] });
    const added = await addAddress(testEnv, atTime(AT + 5000), ORG, ADMIN, "sales@mail.example.test", null);
    expect(added.routing.state).toBe("rule_written");
    expect(posted(calls, "/email/routing/rules")).toHaveLength(1);
    expect(JSON.parse(posted(calls, "/email/routing/rules")[0]!.body!)).toMatchObject({ matchers: [{ type: "literal", field: "to", value: "sales@mail.example.test" }] });
  });

  it("names not_written with Cloudflare's own words when the rule write is refused", async () => {
    serving({ existingMx: [{ content: "route1.mx.cloudflare.net." }] });
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/email/routing/rules") && init?.method === "POST") {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 2015, message: "rules limit reached" }] }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return base(url, init);
    });
    const added = await addAddress(testEnv, atTime(AT + 5000), ORG, ADMIN, "sales@mail.example.test", null);
    expect(added.routing.state).toBe("not_written");
    expect(added.routing.detail).toContain("2015 rules limit reached");
    expect(added.routing.detail).toContain("mailda provider --onboard-receiving");
  });

  it("names not_written and the next step when no credential can write a rule, and still adds the address", async () => {
    await testEnv.CATALOG.prepare("UPDATE provider_binding SET access_token = NULL WHERE id = 1").run();
    const added = await addAddress(testEnv, atTime(AT + 5000), ORG, ADMIN, "sales@mail.example.test", null);
    expect(added.routing.state).toBe("not_written");
    expect(added.routing.detail).toContain("mailda provider --onboard-receiving mail.example.test --address sales@mail.example.test");
    const row = await testEnv.CATALOG.prepare("SELECT address FROM addresses WHERE org_id = ?").bind(ORG).first<{ address: string }>();
    expect(row?.address).toBe("sales@mail.example.test");
    const entry = await testEnv.CATALOG.prepare("SELECT detail FROM audit_entries WHERE org_id = ? AND action = 'address.added'").bind(ORG).first<{ detail: string }>();
    expect(JSON.parse(entry!.detail).routing).toBe("not_written");
  });
});
