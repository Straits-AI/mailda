import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { path, route, schemaCoverage } from "@mailda/contract/routes";
import { createSystemCtx } from "@mailda/runtime";

import { log } from "../src/audit.ts";
import { createButlerDraft } from "../src/butlers.ts";
import { issueSession } from "../src/auth/session.ts";
import { SoftwareAuthenticator } from "./authenticator.ts";

/**
 * The contract's schemas, checked against what the routes actually answer (#85 step 2, ADR 12).
 *
 * ## Why this file is the whole point of step 2
 *
 * Step 1 pinned the route *set* — `test/node/route-registry.test.ts` holds `packages/contract` and
 * `src/index.ts` to each other on every path and every verb, in both directions. Step 2 describes what
 * travels over them, and a schema that nothing compares against a real response is **worse than none**: it
 * is a guess wearing the clothes of a contract, and a generated client would trust it.
 *
 * So every schema in `packages/contract/src/schemas.ts` is driven here, through `SELF.fetch`, against a real
 * Node, and parsed. A schema that does not describe reality fails.
 *
 * ## `.strict()` is what makes these tests bite
 *
 * Zod's default tolerates unknown keys, so a lenient response schema would pass over a route that had grown
 * a field the contract does not mention — which is the drift ADR 12 exists to stop, arriving through the door
 * marked "compatible". Two of these schemas turn that into a security property rather than a tidiness one:
 * `GET /api/transport` must never return the API token it reads, and `GET /api/auth/passkeys` must never
 * return a public key. `.strict()` is how a test notices either.
 */

const testEnv = env as unknown as Env;
const ORG = "org_contract";
/*
 * A **minted** user id, not a readable placeholder.
 *
 * `usr_contract` was the first version and the schema refused it, correctly: `S.signedInResponse` requires
 * the registry's pattern, and a fixture that could not satisfy the contract it was testing would have been a
 * test of the fixture. This is also how `usr` came to be in `ID_PREFIXES` at all — #85 is the first thing
 * that needed to *validate* a user id rather than mint one.
 */
const USER = createSystemCtx().id("usr");
const ORIGIN = "https://node";

beforeEach(async () => {
  for (const table of [
    "credentials", "webauthn_challenges", "refresh_tokens", "audit_entries", "log_entries",
    "butler_versions", "butlers", "sending_transport", "relationship_tuples", "users", "node_claim",
  ]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(USER, ORG, "person@local.invalid", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim','x',?,?)",
    ).bind(at, ORG),
    testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'org.admin','organization',?,?)`,
    ).bind(ctx.id("rt"), ORG, USER, ORG, at),
  ]);
});

async function cookie(): Promise<string> {
  const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId: USER });
  return `mailda_at=${session.accessToken}`;
}

/**
 * Drives one route and parses its answer with the schema the contract declares for it.
 *
 * Looked up by `route(method, template)` rather than passed in, so a test cannot validate against a schema
 * the registry does not actually carry for that route — which would be the same correspondence problem one
 * level up.
 */
async function answers(
  method: "GET" | "POST" | "PUT" | "DELETE",
  template: string,
  init: { params?: Record<string, string>; body?: unknown; cookie?: string } = {},
): Promise<unknown> {
  const spec = route(method as never, template as never);
  expect(spec.response, `${method} ${template} has no response schema to check`).toBeDefined();

  const response = await SELF.fetch(`${ORIGIN}${path(spec, init.params ?? {})}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  expect(response.status, `${method} ${template} answered ${response.status}: ${text}`).toBe(200);
  // Throws on mismatch, with the path of the offending field — which is the failure worth having.
  return spec.response!.parse(JSON.parse(text));
}

const STARTER = JSON.stringify({
  apiVersion: "mailda/v1",
  kind: "Butler",
  metadata: { name: "contract", owner: "team:support" },
  capabilities: [],
  trigger: { event: "mail.received", mailbox: "support@example.com" },
  entry: "halt",
  nodes: [{ id: "halt", type: "stop", reason: "nothing yet" }],
});

describe("every schema-bearing route answers what the contract says it does", () => {
  it("GET /api/me", async () => {
    await answers("GET", "/api/me", { cookie: await cookie() });
  });

  it("POST /api/auth/passkeys/challenge, both ceremonies", async () => {
    /*
     * One route, two shapes, and the union in the schema is how the contract states *why*: a registration
     * names the account it is for and an authentication must not, because that absence is what stops the
     * route answering "does this address have a passkey".
     */
    await answers("POST", "/api/auth/passkeys/challenge", {
      body: { purpose: "register" }, cookie: await cookie(),
    });
    await answers("POST", "/api/auth/passkeys/challenge", { body: { purpose: "authenticate" } });
  });

  it("GET /api/auth/passkeys, and it returns no public key", async () => {
    /*
     * `.strict()` doing security work rather than tidiness. The row in D1 holds a public key; the schema
     * has no field for one, so a route that started returning it would fail here.
     */
    const held = await cookie();
    const challenged = await SELF.fetch(`${ORIGIN}/api/auth/passkeys/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: held },
      body: JSON.stringify({ purpose: "register" }),
    });
    const { publicKey } = await challenged.json() as { publicKey: { challenge: string } };
    const authenticator = new SoftwareAuthenticator();
    const ceremony = await authenticator.register(publicKey.challenge, "node", ORIGIN);
    await answers("POST", "/api/auth/passkeys", {
      body: { credential: ceremony.credential, label: "laptop" }, cookie: held,
    });

    const listed = await answers("GET", "/api/auth/passkeys", { cookie: held }) as {
      passkeys: Array<Record<string, unknown>>;
    };
    expect(listed.passkeys).toHaveLength(1);
    expect(Object.keys(listed.passkeys[0]!)).not.toContain("publicKey");
  });

  it("POST /api/auth/passkeys/verify answers the same shape a password sign-in does", async () => {
    /*
     * The property ADR 29 needs and #84 built: nothing downstream learns which mechanism signed you in. Both
     * routes carry `S.signedInResponse`, so the schema is where that is stated — and this is where it is
     * checked, by parsing a real assertion's answer with the schema the password route also declares.
     */
    const held = await cookie();
    const challenged = await SELF.fetch(`${ORIGIN}/api/auth/passkeys/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: held },
      body: JSON.stringify({ purpose: "register" }),
    });
    const registration = await challenged.json() as { publicKey: { challenge: string } };
    const authenticator = new SoftwareAuthenticator();
    await SELF.fetch(`${ORIGIN}/api/auth/passkeys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: held },
      body: JSON.stringify({
        credential: (await authenticator.register(registration.publicKey.challenge, "node", ORIGIN)).credential,
        label: "laptop",
      }),
    });

    const asserted = await SELF.fetch(`${ORIGIN}/api/auth/passkeys/challenge`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "authenticate" }),
    });
    const { publicKey } = await asserted.json() as { publicKey: { challenge: string } };
    await answers("POST", "/api/auth/passkeys/verify", {
      body: {
        credential: (await authenticator.authenticate(publicKey.challenge, "node", ORIGIN)).credential,
      },
    });
  });

  it("GET /api/transport, and it returns no API token", async () => {
    /*
     * The other place `.strict()` is a security property. This route reads a credential to decide which
     * adapter is available and must never return it — so the schema has no field for one, and a route that
     * grew one would fail rather than leak.
     */
    const held = await cookie();
    await answers("PUT", "/api/transport", {
      body: { accountId: "acc_contract", apiToken: "a-token-value" }, cookie: held,
    });
    const reported = JSON.stringify(await answers("GET", "/api/transport", { cookie: held }));
    expect(reported).not.toContain("a-token-value");
  });

  it("the Butler authoring routes", async () => {
    const held = await cookie();
    const created = await answers("POST", "/api/butlers", {
      body: { name: "contract", source: STARTER, sourceFormat: "json" }, cookie: held,
    }) as { butler: { butlerId: string } };

    await answers("PUT", "/api/butlers/:butlerId/draft", {
      params: { butlerId: created.butler.butlerId },
      body: { source: STARTER, sourceFormat: "json" },
      cookie: held,
    });
    await answers("POST", "/api/butlers/:butlerId/publish", {
      params: { butlerId: created.butler.butlerId }, cookie: held,
    });
  });

  it("POST /api/butlers/:butlerId/simulate", async () => {
    const held = await cookie();
    const draft = await createButlerDraft(testEnv, createSystemCtx(), ORG, USER, {
      name: "simulated", source: STARTER,
    });
    const report = await answers("POST", "/api/butlers/:butlerId/simulate", {
      params: { butlerId: draft.butlerId }, body: { facts: {} }, cookie: held,
    }) as { simulation: { limits: string[] } };
    // The field that stops a dry run reading as a green light is in the schema, so it cannot quietly go.
    expect(report.simulation.limits.length).toBeGreaterThan(0);
  });
});

describe("the ledgers answer what the contract says they do", () => {
  /*
   * **Seeded, because an empty list validates nothing.** `z.array(rowSchema)` is satisfied by `[]`, so a
   * test that drove these routes against empty tables would check the envelope and leave every row shape
   * unexamined — which is the vacuity this repository keeps finding, arriving through a schema instead of an
   * assertion.
   *
   * Rows go in with direct `INSERT`s rather than through the ingest path. That is honest for what is being
   * checked: these schemas describe a route's **projection**, and a projection reads columns. What it would
   * not be honest for is a claim about ingest, and none is made here.
   */
  async function seedMailbox(): Promise<string> {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const mailboxId = ctx.id("mbx");
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        "INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)",
      ).bind(mailboxId, ORG, "support", at),
      testEnv.CATALOG.prepare(
        "INSERT INTO addresses (id, org_id, mailbox_id, address, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("adr"), ORG, mailboxId, "support@acme.example", at),
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'send.propose','mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, mailboxId, at),
    ]);
    return mailboxId;
  }

  it("GET /health", async () => {
    await answers("GET", "/health");
  });

  it("GET /api/doctor, with its findings", async () => {
    const report = await answers("GET", "/api/doctor", { cookie: await cookie() }) as {
      findings: unknown[];
    };
    // Non-vacuity: an empty findings array would satisfy the schema and check no finding's shape.
    expect(report.findings.length).toBeGreaterThan(5);
  });

  it("GET /api/breakers, with real readings", async () => {
    const held = await cookie();
    const read = await answers("GET", "/api/breakers", { cookie: held }) as { breakers: unknown[] };
    expect(read.breakers.length).toBeGreaterThan(0);
  });

  it("GET /api/mailboxes, with a mailbox in it", async () => {
    await seedMailbox();
    const read = await answers("GET", "/api/mailboxes", { cookie: await cookie() }) as {
      mailboxes: unknown[];
    };
    expect(read.mailboxes.length).toBe(1);
  });

  it("GET /api/audit, with an entry a real act produced", async () => {
    /*
     * The entry comes from `createButlerDraft` rather than an `INSERT`, deliberately: `audit_entries` is a
     * hash chain, and a hand-written row would carry a `hash` this schema's pattern would accept and the
     * chain would not. Producing it through an act is the only way the row is real.
     */
    const held = await cookie();
    await createButlerDraft(testEnv, createSystemCtx(), ORG, USER, {
      name: "audited", source: STARTER,
    });
    const read = await answers("GET", "/api/audit", { cookie: held }) as { entries: unknown[] };
    expect(read.entries.length).toBeGreaterThan(0);
  });

  it("GET /api/logs, with an entry the logger produced", async () => {
    /*
     * Through `log()` rather than an `INSERT`, and the first version of this test got that wrong: it wrote
     * the columns by hand, left `id` null, and the schema refused the answer. It was right to — `log()`
     * mints a `log_` identifier, so a row without one is a row this Node cannot produce, and a test that
     * seeded it would have been checking a shape that never occurs.
     */
    const held = await cookie();
    await log(testEnv, createSystemCtx(), {
      level: "info", event: "contract.check", message: "a line",
    });
    const read = await answers("GET", "/api/logs", { cookie: held }) as { entries: unknown[] };
    expect(read.entries.length).toBeGreaterThan(0);
  });
});

describe("the coverage of step 2 is a number, and it only goes up", () => {
  it("describes the routes it claims to, and names what is left", () => {
    /*
     * A floor rather than an equality, and a deliberate one.
     *
     * Step 2 is **partial**: schemas arrive with the tests that check them, one tranche at a time, because
     * eighty-six hand-written shapes nothing validates would be eighty-six guesses a generated client
     * trusts. So this asserts the count never *falls* — a route losing its schema fails — and does not
     * demand editing every time somebody adds a route.
     *
     * The number itself is the honest part: it is what a reader should watch move, and the ticket's step 3
     * (SDK, Skill, MCP, each generated) is blocked until `missing` is empty.
     */
    const coverage = schemaCoverage();
    expect(coverage.total).toBeGreaterThan(70);
    expect(coverage.described).toBeGreaterThanOrEqual(21);
    // Stated rather than asserted away: the remainder is real and this is where it is counted.
    expect(coverage.missing.length).toBe(coverage.total - coverage.described);
  });

  it("counts a schema for every route that declares one, and no others", () => {
    /*
     * `schemaCoverage` reads through `RouteSpec`, which is the only way to ask the question: `as const` gives
     * each entry exactly the fields it has, so an entry without a `response` has no such property to read.
     * That is worth a test because it is the kind of thing that silently starts counting zero.
     */
    const coverage = schemaCoverage();
    expect(coverage.described + coverage.missing.length).toBe(coverage.total);
    expect(coverage.missing).not.toContain("GET /api/transport");
    // A route that still has none. Updated as tranches land, which is the point of the count moving.
    expect(coverage.missing).toContain("GET /api/cases");
  });
});
