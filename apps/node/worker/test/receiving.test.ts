import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginAuthorization, completeAuthorization, registerClient,
} from "../src/provider/cloudflare-grant.ts";
import { onboardReceiving, receivingProposalFor } from "../src/provider/receiving.ts";

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
  ]);
  await testEnv.CATALOG.prepare(
    "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
  ).bind(ADMIN, ORG, "admin@example.test", new Date(AT).toISOString()).run();

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

/**
 * Cloudflare, with the pieces a receiving onboard reads and writes.
 *
 * `existingMx` is what the subdomain already has, and `writtenMx` is what a read-back returns — separate on
 * purpose, so a test can make the write *appear* to succeed and the read-back come back empty.
 */
function serving(opts: {
  routingEnabled?: boolean;
  /** Whether the zone starts listing MX once it has been enabled, which is what the real one does. */
  enableRevealsMx?: boolean;
  existingMx?: Array<{ content: string }>;
  writtenMx?: Array<{ content: string }> | null;
  rules?: unknown[];
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
    if (path.endsWith("/email/routing")) {
      if (method === "PATCH") { enabled = true; return ok({ enabled: true, status: "ready" }); }
      return ok({ enabled: enabled && opts.routingEnabled !== false, status: "ready" });
    }
    if (path.endsWith("/email/routing/dns")) {
      // An un-routed zone lists nothing; enabling is what makes the records appear.
      const listing = opts.enableRevealsMx === true && !enabled ? [] : APEX_MX;
      return ok(opts.routingEnabled === false && !enabled ? [] : listing);
    }
    if (path.includes("/email/routing/rules")) {
      if (method === "POST") return ok({ name: "mailda mail.example.test" });
      return ok(opts.rules ?? []);
    }
    if (path.includes("/dns_records")) {
      if (method === "POST") { wrote += 1; return ok({ id: `rec_${wrote}` }); }
      /*
       * Before any write, the subdomain has whatever it started with. After, it has what was written —
       * unless a case says otherwise with `writtenMx`, which is how "the POST answered 200 and the record
       * is not there" is expressed. That case is the one this module exists for, so the stub has to be able
       * to produce it.
       */
      if (wrote === 0) return ok(opts.existingMx ?? []);
      if (opts.writtenMx !== undefined) return ok(opts.writtenMx ?? []);
      return ok(APEX_MX.filter((one) => one.type === "MX").map((one) => ({ content: one.content })));
    }
    return ok(null);
  });
  return calls;
}

const posted = (calls: Array<{ url: string; method: string }>, part: string) =>
  calls.filter((one) => one.method === "POST" && one.url.includes(part));

describe("proposing to receive on a subdomain", () => {
  it("copies the zone's MX and leaves its SPF and DKIM alone", async () => {
    /*
     * The zone's record list carries SPF and DKIM too, and both belong to **sending** at the apex. Copying
     * them onto a receiving subdomain would assert a sending posture nobody asked for.
     */
    serving();
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");

    expect(proposal.refusal).toBeNull();
    expect(proposal.creates).toHaveLength(3);
    expect(proposal.creates.every((one) => one.type === "MX")).toBe(true);
    // Named for the subdomain, not the apex the records were read from.
    expect(proposal.creates.every((one) => one.name === "mail.example.test")).toBe(true);
    expect(proposal.creates.map((one) => one.priority).sort((a, b) => (a ?? 0) - (b ?? 0)))
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
    expect(proposal.creates).toHaveLength(3);
  });

  it("refuses a subdomain that already points somewhere", async () => {
    serving({ existingMx: [{ content: "mx.somebody-else.net." }] });
    const proposal = await receivingProposalFor(testEnv, atTime(AT + 3000), ORG, "mail.example.test");
    expect(proposal.present).toEqual(["mx.somebody-else.net."]);
    expect(proposal.refusal).toContain("already");
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
    expect(posted(calls, "/dns_records")).toHaveLength(0);
    expect(posted(calls, "/email/routing/rules")).toHaveLength(1);
    expect(outcome.rule).toBe("mailda mail.example.test");
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
    expect(proposal.creates).toHaveLength(3);
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

    expect(outcome.written).toHaveLength(3);
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
     * The **last** write and the **last** read-back, not the first of each: the proposal reads `dns_records`
     * too, so a `findIndex` here matches the proposal's read and compares the wrong pair. An earlier version
     * of this assertion did exactly that and passed on the order it was meant to check.
     */
    const lastWrite = at((one) => one.method === "POST" && one.url.includes("/dns_records"), true);
    const readBack = at((one) => one.method === "GET" && one.url.includes("/dns_records"), true);
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

  it("refuses a digest taken against a different subdomain", async () => {
    serving();
    const other = await digestFor("other.example.test");
    const calls = serving();

    await expect(onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", other, "restore@mail.example.test",
    )).rejects.toThrow(/E_RECEIVING_STALE/);
    expect(posted(calls, "/dns_records")).toEqual([]);
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

    const patched = calls.findIndex((one) => one.method === "PATCH" && one.url.endsWith("/email/routing"));
    const wrote = calls.findIndex((one) => one.method === "POST" && one.url.includes("/dns_records"));
    expect(patched, "the zone was never enabled").toBeGreaterThanOrEqual(0);
    expect(wrote, "records were written before the zone could list any").toBeGreaterThan(patched);
    expect(outcome.written).toHaveLength(3);
  });

  it("writes nothing when the proposal refuses", async () => {
    const calls = serving({ existingMx: [{ content: "mx.somebody-else.net." }] });
    await expect(onboardReceiving(
      testEnv, atTime(AT + 4000), ORG, ADMIN, "mail.example.test", "0".repeat(64),
      "restore@mail.example.test",
    )).rejects.toThrow(/E_RECEIVING_WILL_NOT_ONBOARD/);
    expect(posted(calls, "/dns_records")).toEqual([]);
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
    expect(detail.creates).toHaveLength(3);
    expect(detail.address).toBe("restore@mail.example.test");
  });
});
