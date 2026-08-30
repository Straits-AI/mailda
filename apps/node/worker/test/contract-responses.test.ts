import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { path, route, schemaCoverage } from "@mailda/contract/routes";
import { createSystemCtx } from "@mailda/runtime";

import { log } from "../src/audit.ts";
import { createButlerDraft } from "../src/butlers.ts";
import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";
import { SoftwareAuthenticator } from "./authenticator.ts";
import { seedDelivery } from "./fixtures/delivery.ts";
import { dispatchDue } from "../src/outbound/dispatch.ts";
import type { SubmitOutcome, TransportAdapter } from "../src/outbound/transport.ts";
import { claimSecretHash } from "../src/claim-secret.ts";
import { createClient } from "@mailda/sdk";
import { publishButler } from "../src/butlers.ts";
import { interpret, type RunSteps } from "../src/butler/interpret.ts";
import { deliveryFacts } from "../src/butler/trigger.ts";
import { placeButlerPause } from "../src/butler/pause-acts.ts";

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

/**
 * A transport that refuses, for the one route that needs a send to have been attempted.
 *
 * Refusing rather than accepting, deliberately: `retry-effect` is offered only where non-acceptance is
 * recorded, so a stub that accepted would produce a send with nothing to retry.
 */
const refusingTransport: TransportAdapter = {
  name: "test-refusing",
  capability: async () => ({ canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "test" }),
  submit: async (): Promise<SubmitOutcome> =>
    ({ kind: "refused", reason: "the test transport refused", retryable: true }),
};

beforeEach(async () => {
  for (const table of [
    "credentials", "webauthn_challenges", "refresh_tokens", "audit_entries", "log_entries",
    "butler_versions", "butlers", "sending_transport", "invitations", "teams", "team_members",
    "matters", "holds", "policy_versions", "policies", "drafts", "addresses", "mailboxes",
    "mailbox_items", "messages", "cases", "conversations", "ingress_receipts",
    "relationship_tuples", "users", "node_claim",
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
  return `${ACCESS_COOKIE}=${session.accessToken}`;
}

/**
 * Drives one route and parses its answer with the schema the contract declares for it.
 *
 * Looked up by `route(method, template)` rather than passed in, so a test cannot validate against a schema
 * the registry does not actually carry for that route — which would be the same correspondence problem one
 * level up.
 */
async function answers(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
      ).bind(ctx.id("adr"), ORG, mailboxId, `${mailboxId}@acme.example`, at),
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'send.propose','mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, mailboxId, at),
      /*
       * `message.export`, because `GET /api/sends/:sendId/submitted` requires it since #95 — the outbound
       * original-message download now asks for the same relation the inbound `.eml` always did. Before that
       * it took content access alone, which is why this fixture never needed it and why the divergence
       * survived: the test that exercised the route could not have noticed the weaker requirement.
       */
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'message.export','mailbox',?,?)`,
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

  it("POST /api/agents, whose success shape was wrong and unexercised", async () => {
    /*
     * This route answered with the bare agent while its strict schema embeds `agentSummary`, which carries
     * `held` and `unnamed`. A deterministic contract violation on a success path, with CI green — because
     * nothing drove it. `schemaCoverage()` proves a route *has* a schema and never that a test executes one,
     * and the difference is the whole of that finding.
     */
    const held = await cookie();
    const person = await testEnv.CATALOG.prepare("SELECT id FROM users WHERE org_id = ? LIMIT 1")
      .bind(ORG).first<{ id: string }>();
    const minted = await answers("POST", "/api/agents", {
      cookie: held,
      body: { name: "contract", sponsorUserId: person!.id, capabilities: ["health.read"] },
    }) as { agent: { held: unknown[]; unnamed: unknown[] }; token: string };

    expect(Array.isArray(minted.agent.held), "the summary's capability view is missing").toBe(true);
    expect(Array.isArray(minted.agent.unnamed)).toBe(true);
  });

  it("POST /api/recovery-codes/rotate and confirm, whose extra fields were undeclared", async () => {
    /*
     * Both handlers send a field their strict schema did not declare — `set` on the rotation and
     * `alreadyConfirmed` on the confirmation. Undeclared *and* unexercised, which is the pairing that let
     * three of these ship at once.
     */
    const held = await cookie();
    const minted = await answers("POST", "/api/recovery-codes/rotate", { cookie: held }) as {
      codes: string[]; set: string;
    };
    expect(minted.set, "the rotation does not say which sheet it printed").toBeTruthy();

    const confirmed = await answers("POST", "/api/recovery-codes/confirm", {
      cookie: held, body: { code: minted.codes[0] },
    }) as { confirmed: number; alreadyConfirmed: boolean };
    expect(confirmed.alreadyConfirmed).toBe(false);
    expect(confirmed.confirmed).toBeGreaterThan(0);
  });

  it("GET /api/mailboxes/readable, which is not the work-queue list", async () => {
    /*
     * The catalogue `mail.read` needs. `GET /api/mailboxes` is the queue rail — mailboxes the caller holds
     * `send.propose` on — and it sat inside the reading capability, so a read-only agent could open messages
     * and received an empty list with no way to discover the ids it was allowed to read.
     */
    const held = await cookie();
    const read = await answers("GET", "/api/mailboxes/readable", { cookie: held }) as {
      mailboxes: { id: string; name: string }[];
    };
    expect(Array.isArray(read.mailboxes)).toBe(true);
  });

  it("GET /api/agent-capabilities, which the mint surface is chosen from", async () => {
    /*
     * Live, not only schema-covered. The vocabulary is published so the interface does not restate it, and a
     * route that answers out of shape would put the client back to guessing — which is the thing publishing
     * it was meant to stop.
     */
    const held = await cookie();
    const read = await answers("GET", "/api/agent-capabilities", { cookie: held }) as {
      capabilities: { id: string; routes: string[] }[];
    };
    expect(read.capabilities.length).toBeGreaterThan(5);
    expect(read.capabilities.every((one) => one.routes.length > 0)).toBe(true);
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

describe("the governance reads answer what the contract says they do", () => {
  /*
   * **Produced by real acts, not seeded.** Everything below is created through the route or the function
   * that creates it in production, which is a stronger check than an `INSERT`: a hand-written row can carry
   * a shape this Node never mints, and a schema validated against one would describe something that does
   * not occur. The two exceptions in the tranche above earned their `INSERT`s by being projections.
   */
  async function post(path: string, body: unknown, held: string): Promise<Response> {
    return await SELF.fetch(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: held },
      body: JSON.stringify(body),
    });
  }

  it("GET /api/people, with the account that exists", async () => {
    const read = await answers("GET", "/api/people", { cookie: await cookie() }) as { people: unknown[] };
    expect(read.people.length).toBeGreaterThan(0);
  });

  it("GET /api/teams and its members, after creating one", async () => {
    const held = await cookie();
    const made = await post("/api/teams", { name: "support" }, held);
    expect(made.status, await made.clone().text()).toBe(200);
    const { team } = await made.json() as { team: { id: string } };

    const teams = await answers("GET", "/api/teams", { cookie: held }) as { teams: unknown[] };
    expect(teams.teams.length).toBe(1);
    await answers("GET", "/api/teams/:teamId/members", { params: { teamId: team.id }, cookie: held });
  });

  it("GET /api/invitations, after minting one", async () => {
    const held = await cookie();
    const invited = await post("/api/invitations", { email: "colleague@local.invalid" }, held);
    expect(invited.status, await invited.clone().text()).toBe(200);
    const read = await answers("GET", "/api/invitations", { cookie: held }) as { invitations: unknown[] };
    expect(read.invitations.length).toBe(1);
  });

  it("GET /api/matters, after opening one", async () => {
    const held = await cookie();
    /*
     * `legal_hold`, not `investigation`. The first version of this test invented a type and the Node refused
     * it with all four parts — naming the four it does recognise, which is why the fix took one reading.
     */
    const opened = await post("/api/matters", { type: "legal_hold", description: "a matter" }, held);
    expect(opened.status, await opened.clone().text()).toBe(200);
    const read = await answers("GET", "/api/matters", { cookie: held }) as { matters: unknown[] };
    expect(read.matters.length).toBe(1);
  });

  it("GET /api/domain-pauses, which one person cannot fill", async () => {
    /*
     * **Dual control makes this row unproducible here, and that is the feature working.**
     *
     * #66 requires two distinct administrators to stop a domain's mail and excludes whoever asked, so on a
     * Node with one admin the refusal is `E_DOMAIN_PAUSE_UNSATISFIABLE` — which this test met on its first
     * run and which is the correct answer, not an obstacle to route around. Seeding the row directly would
     * have produced a pause no governance path can create.
     *
     * So the envelope is checked and `domainPauseRow` waits for a tranche with an approval fixture. Said
     * here rather than left as an untested schema nobody notices.
     */
    const held = await cookie();
    const refused = await post("/api/domain-pauses", { domain: "example.net", reason: "a reason" }, held);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("E_DOMAIN_PAUSE_UNSATISFIABLE");

    const read = await answers("GET", "/api/domain-pauses", { cookie: held }) as { pauses: unknown[] };
    expect(read.pauses).toEqual([]);
  });

  it("GET /api/policies, after writing one", async () => {
    const held = await cookie();
    const made = await post("/api/policies", {
      name: "hold everything", outcome: "hold", conditions: {}, stages: [],
    }, held);
    expect(made.status, await made.clone().text()).toBe(200);
    const read = await answers("GET", "/api/policies", { cookie: held }) as { policies: unknown[] };
    expect(read.policies.length).toBe(1);
  });

  it("GET /api/butlers and one Butler's history", async () => {
    const held = await cookie();
    const draft = await createButlerDraft(testEnv, createSystemCtx(), ORG, USER, {
      name: "listed", source: STARTER,
    });
    const listed = await answers("GET", "/api/butlers", { cookie: held }) as { butlers: unknown[] };
    expect(listed.butlers.length).toBe(1);

    const detail = await answers("GET", "/api/butlers/:butlerId", {
      params: { butlerId: draft.butlerId }, cookie: held,
    }) as { versions: unknown[] };
    // Non-vacuity: the version row's shape is the point, and an empty history would check none of it.
    expect(detail.versions.length).toBe(1);
  });

  it("GET /api/butler-runs and /api/butler-pauses, which are empty here", async () => {
    /*
     * Envelopes only, and the cost of that showed up two tranches later: `butlerRunRow` was declared and
     * never exercised, so it was missing `state_at` — which the list has always returned. A list schema is
     * only as good as a row to check it against, and the group below now produces one.
     */
    const held = await cookie();
    const runs = await answers("GET", "/api/butler-runs", { cookie: held }) as { runs: unknown[] };
    const pauses = await answers("GET", "/api/butler-pauses", { cookie: held }) as { pauses: unknown[] };
    expect(runs.runs).toEqual([]);
    expect(pauses.pauses).toEqual([]);
  });
});

describe("the acts answer what the contract says they do", () => {
  /*
   * Captured by driving every one of these against a real Node and reading the body, then written down —
   * the opposite order from the ledgers, and the right one here. A write's answer is declared nowhere on the
   * consumer side: the client's act helpers return `unknown` and the screens destructure what they need, so
   * there was no second view to compare against. These schemas are the first statement of the shape at all.
   */
  async function act(
    method: "POST" | "PUT" | "DELETE", template: string,
    init: { params?: Record<string, string>; body?: unknown; cookie: string },
  ): Promise<unknown> {
    return await answers(method, template, init);
  }

  async function mailbox(): Promise<string> {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const mailboxId = ctx.id("mbx");
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(mailboxId, ORG, "support", at),
      testEnv.CATALOG.prepare(
        "INSERT INTO addresses (id, org_id, mailbox_id, address, created_at) VALUES (?,?,?,?,?)",
      // Unique per mailbox: `addresses` is UNIQUE on (org_id, address), and several tests here seed one.
      ).bind(ctx.id("adr"), ORG, mailboxId, `${mailboxId}@acme.example`, at),
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'send.propose','mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, mailboxId, at),
      /*
       * `message.export`, because `GET /api/sends/:sendId/submitted` requires it since #95 — the outbound
       * original-message download now asks for the same relation the inbound `.eml` always did. Before that
       * it took content access alone, which is why this fixture never needed it and why the divergence
       * survived: the test that exercised the route could not have noticed the weaker requirement.
       */
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'message.export','mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, mailboxId, at),
    ]);
    return mailboxId;
  }

  it("the team acts, including the idempotent ones", async () => {
    const held = await cookie();
    const made = await act("POST", "/api/teams", { body: { name: "t1" }, cookie: held }) as {
      team: { id: string };
    };
    await answers("GET", "/api/teams/:teamId", { params: { teamId: made.team.id }, cookie: held });
    await act("POST", "/api/teams/:teamId/rename", {
      params: { teamId: made.team.id }, body: { name: "t2" }, cookie: held,
    });
    const joined = await act("POST", "/api/teams/:teamId/members", {
      params: { teamId: made.team.id }, body: { userId: USER }, cookie: held,
    }) as { membership: { changed: boolean; members: number } };
    // `changed` is the field that distinguishes an act from a no-op on an idempotent route.
    expect(joined.membership).toMatchObject({ changed: true, members: 1 });
    await act("DELETE", "/api/teams/:teamId/members", {
      params: { teamId: made.team.id }, body: { userId: USER }, cookie: held,
    });
  });

  it("minting an invitation, which is the one route that returns a secret", async () => {
    /*
     * The schema names `secret` so its presence is a decision on the record. `invitations` stores only the
     * hash, so this is the one moment it is readable — the same mechanism `mailda claim-secret` uses.
     */
    const held = await cookie();
    const minted = await act("POST", "/api/invitations", {
      body: { email: "colleague@local.invalid" }, cookie: held,
    }) as { invitation: { secret: string; replacedId: string | null } };
    expect(minted.invitation.secret.length).toBeGreaterThan(20);
    expect(minted.invitation.replacedId).toBeNull();
  });

  it("matters, and a hold placed against one", async () => {
    const held = await cookie();
    const mailboxId = await mailbox();
    const opened = await act("POST", "/api/matters", {
      body: { type: "legal_hold", description: "a matter" }, cookie: held,
    }) as { matter: { id: string } };
    await act("POST", "/api/holds", {
      body: { mailboxId, matterId: opened.matter.id }, cookie: held,
    });
    /*
     * Closed **after** the hold, because closing is what makes `closedAt`/`closedBy` non-null and the schema
     * describes both states with one shape. A test that only opened one would leave half of it unexercised.
     */
    const closed = await act("POST", "/api/matters/:matterId/close", {
      params: { matterId: opened.matter.id }, cookie: held,
    }) as { matter: { closedAt: string | null } };
    expect(closed.matter.closedAt).not.toBeNull();
  });

  it("the reads that answer with what a person holds", async () => {
    const held = await cookie();
    await mailbox();
    const access = await answers("GET", "/api/access", { cookie: held }) as { relations: unknown[] };
    expect(access.relations.length).toBeGreaterThan(0);
    await answers("GET", "/api/supervised", { cookie: held });
    await answers("GET", "/api/sends", { cookie: held });
    await answers("GET", "/api/drafts", { cookie: held });
  });

  it("saving a draft", async () => {
    const held = await cookie();
    const mailboxId = await mailbox();
    const saved = await act("PUT", "/api/drafts", {
      body: { mailboxId, subject: "s", body: "b", to: ["a@b.test"] }, cookie: held,
    }) as { draft: { bodyBytes: number } };
    expect(saved.draft.bodyBytes).toBe(1);
  });

  it("the policy acts", async () => {
    const held = await cookie();
    const made = await act("POST", "/api/policies", {
      body: { name: "p", outcome: "hold", conditions: {}, stages: [] }, cookie: held,
    }) as { policy: { policyId: string } };
    await act("PUT", "/api/policies/:policyId/draft", {
      params: { policyId: made.policy.policyId },
      body: { outcome: "deny", conditions: {}, stages: [] },
      cookie: held,
    });
    const published = await act("POST", "/api/policies/:policyId/publish", {
      params: { policyId: made.policy.policyId }, cookie: held,
    }) as { published: { version: number } };
    expect(published.published.version).toBe(1);
  });

  it("verifying the audit chain, over a chain with something in it", async () => {
    const held = await cookie();
    await createButlerDraft(testEnv, createSystemCtx(), ORG, USER, { name: "chained", source: STARTER });
    const verified = await act("POST", "/api/audit/verify", { body: {}, cookie: held }) as {
      checked: number; intact: boolean; resumeFrom: number | null;
    };
    // Non-vacuity: `intact: true` over nothing is not a claim about anything.
    expect(verified.checked).toBeGreaterThan(0);
    expect(verified.intact).toBe(true);
    // `null` means the whole chain was covered, which is a different claim from `intact` alone.
    expect(verified.resumeFrom).toBeNull();
  });

  it("signing out, which answers the same shape an expired session does", async () => {
    /*
     * A `200` carrying an `error` field reads oddly and is correct: one shape means a client has a single
     * thing to recognise for "you are not signed in", whether it was thrown out or left. Written down so
     * that nobody tidies it into `{ ok: true }` and breaks that.
     */
    await act("POST", "/api/auth/logout", { body: {}, cookie: await cookie() });
  });
});

describe("the operator and key surfaces", () => {
  async function mailboxWithSend(): Promise<string> {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const mailboxId = ctx.id("mbx");
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(mailboxId, ORG, "support", at),
      testEnv.CATALOG.prepare(
        "INSERT INTO addresses (id, org_id, mailbox_id, address, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("adr"), ORG, mailboxId, `${mailboxId}@acme.example`, at),
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'send.propose','mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, mailboxId, at),
      /*
       * `message.export`, because `GET /api/sends/:sendId/submitted` requires it since #95 — the outbound
       * original-message download now asks for the same relation the inbound `.eml` always did. Before that
       * it took content access alone, which is why this fixture never needed it and why the divergence
       * survived: the test that exercised the route could not have noticed the weaker requirement.
       */
      testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,'message.export','mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, mailboxId, at),
    ]);
    return mailboxId;
  }

  it("GET /.well-known/jwks.json, with a key in it", async () => {
    const jwks = await answers("GET", "/.well-known/jwks.json") as { keys: unknown[] };
    // Non-vacuity, and it matters here: an empty JWKS is a Node whose tokens nothing can verify.
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  it("granting and revoking, and the field that says which it was", async () => {
    const held = await cookie();
    const mailboxId = await mailboxWithSend();
    const first = await answers("POST", "/api/access", {
      body: { subjectId: USER, relation: "mailbox.content.read", objectId: mailboxId }, cookie: held,
    }) as { alreadyHeld: boolean };
    expect(first.alreadyHeld).toBe(false);

    /*
     * The second grant is the point. Without `alreadyHeld` a caller cannot tell a grant it just made from
     * one that was already there — the difference between "I did this" and "I confirmed this" in an access
     * review.
     */
    const again = await answers("POST", "/api/access", {
      body: { subjectId: USER, relation: "mailbox.content.read", objectId: mailboxId }, cookie: held,
    }) as { alreadyHeld: boolean };
    expect(again.alreadyHeld).toBe(true);

    await answers("DELETE", "/api/access", {
      body: { subjectId: USER, relation: "mailbox.content.read", objectId: mailboxId }, cookie: held,
    });
  });

  it("PATCH a mailbox's response target", async () => {
    const held = await cookie();
    const mailboxId = await mailboxWithSend();
    await answers("PATCH", "/api/mailboxes/:mailboxId", {
      params: { mailboxId }, body: { responseTargetMinutes: 60 }, cookie: held,
    });
  });

  it("a draft, read back and discarded", async () => {
    const held = await cookie();
    const mailboxId = await mailboxWithSend();
    const saved = await answers("PUT", "/api/drafts", {
      body: { mailboxId, subject: "s", body: "b", to: ["a@b.test"] }, cookie: held,
    }) as { draft: { id: string } };
    await answers("GET", "/api/drafts/:draftId", { params: { draftId: saved.draft.id }, cookie: held });
    await answers("DELETE", "/api/drafts/:draftId", { params: { draftId: saved.draft.id }, cookie: held });
  });

  it("the maintenance sweeps", async () => {
    const held = await cookie();
    await answers("POST", "/api/maintenance/reconcile", { body: {}, cookie: held });
    await answers("POST", "/api/maintenance/reseal", { body: {}, cookie: held });
  });

  it("GET /api/approvals, which one person cannot fill either", async () => {
    /*
     * Same shape as the domain pause: §7 requires two distinct approvers for a supervised read and for an
     * export, so a one-admin Node refuses both with `E_..._UNSATISFIABLE` before an approval exists. The
     * envelope is checked; the row waits for a tranche with a second administrator.
     */
    const read = await answers("GET", "/api/approvals", { cookie: await cookie() }) as {
      approvals: unknown[];
    };
    expect(read.approvals).toEqual([]);
  });

  it("rotating the signing key, and the grace it reports", async () => {
    const held = await cookie();
    const rotated = await answers("POST", "/api/auth/rotate-signing-key", { body: {}, cookie: held }) as {
      stillVerifiesForSeconds: number;
    };
    /*
     * The field a tidier shape would drop. A rotation is not a cliff — the retiring key keeps verifying for
     * a grace window — and a caller that did not know would expect every existing token to fail at once.
     */
    expect(rotated.stillVerifiesForSeconds).toBeGreaterThan(0);
  });
});

describe("dual control, with the second and third people it needs", () => {
  /*
   * **Three administrators, because two of these routes need two approvers who are not the asker.**
   *
   * Every earlier tranche ran as one person, and four routes refused with `E_..._UNSATISFIABLE` — correctly,
   * and the tests recorded that rather than routing around it. This is the fixture that lets those rows
   * exist: §7 requires dual approval for a supervised read and an export, #61 for a hold lift, #66 for a
   * domain pause, and all four exclude whoever asked. One asker plus two deciders is the smallest
   * organization in which any of it can complete.
   */
  const OTHER = createSystemCtx().id("usr");
  const THIRD = createSystemCtx().id("usr");
  let mailboxId = "";

  beforeEach(async () => {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    mailboxId = ctx.id("mbx");
    const rows = [
      testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(mailboxId, ORG, "support", at),
      testEnv.CATALOG.prepare(
        "INSERT INTO addresses (id, org_id, mailbox_id, address, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("adr"), ORG, mailboxId, `${mailboxId}@acme.example`, at),
    ];
    for (const person of [USER, OTHER, THIRD]) {
      if (person !== USER) {
        rows.push(testEnv.CATALOG.prepare(
          "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
        ).bind(person, ORG, `${person}@local.invalid`, at));
        rows.push(testEnv.CATALOG.prepare(
          `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
           VALUES (?,?,?,'org.admin','organization',?,?)`,
        ).bind(ctx.id("rt"), ORG, person, ORG, at));
      }
      for (const relation of ["approval.decide", "ediscovery.export", "send.propose"]) {
        rows.push(testEnv.CATALOG.prepare(
          `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
           VALUES (?,?,?,?,'mailbox',?,?)`,
        ).bind(ctx.id("rt"), ORG, person, relation, mailboxId, at));
      }
    }
    await testEnv.CATALOG.batch(rows);
  });

  async function cookieFor(person: string): Promise<string> {
    const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId: person });
    return `${ACCESS_COOKIE}=${session.accessToken}`;
  }

  async function matter(held: string): Promise<string> {
    const opened = await answers("POST", "/api/matters", {
      body: { type: "legal_hold", description: "a matter" }, cookie: held,
    }) as { matter: { id: string } };
    return opened.matter.id;
  }

  it("a supervised read: requested, approved twice, and live", async () => {
    const asker = await cookieFor(USER);
    const matterId = await matter(asker);
    const requested = await answers("POST", "/api/supervised", {
      body: { subjectId: USER, mailboxId, scope: "metadata", durationSeconds: 3600, matterId },
      cookie: asker,
    }) as { supervised: { approvalId: string; eligible: number } };
    // `eligible` beside `stages` is what lets a caller see the arithmetic rather than wait to discover it.
    expect(requested.supervised.eligible).toBe(2);

    const waiting = await answers("GET", "/api/approvals", { cookie: await cookieFor(OTHER) }) as {
      approvals: Array<{ id: string; decidedByMe: boolean }>;
    };
    expect(waiting.approvals).toHaveLength(1);
    expect(waiting.approvals[0]!.decidedByMe).toBe(false);

    const first = await answers("POST", "/api/approvals/:approvalId/decide", {
      params: { approvalId: requested.supervised.approvalId },
      body: { decision: "approve" }, cookie: await cookieFor(OTHER),
    }) as { decided: { completed: boolean } };
    expect(first.decided.completed).toBe(false);

    const second = await answers("POST", "/api/approvals/:approvalId/decide", {
      params: { approvalId: requested.supervised.approvalId },
      body: { decision: "approve" }, cookie: await cookieFor(THIRD),
    }) as { decided: { completed: boolean } };
    expect(second.decided.completed).toBe(true);

    // And the grant is now live, which is the row `supervisedListResponse` describes.
    const live = await answers("GET", "/api/supervised", { cookie: asker }) as {
      supervised: Array<{ live: boolean }>;
    };
    expect(live.supervised).toHaveLength(1);
    expect(live.supervised[0]!.live).toBe(true);
  });

  it("an export: requested with a frozen predicate", async () => {
    const asker = await cookieFor(USER);
    const matterId = await matter(asker);
    const requested = await answers("POST", "/api/exports", {
      body: { matterId, mailboxId, maxMessages: 10 }, cookie: asker,
    }) as { export: { predicateSha256: string } };
    /*
     * The digest is what makes the scope provable after the fact: the predicate is frozen at the request, so
     * an approval approves *that* question rather than a name somebody could widen afterwards.
     */
    expect(requested.export.predicateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a hold lift and a domain pause, both of which open an approval", async () => {
    const asker = await cookieFor(USER);
    const matterId = await matter(asker);
    const placed = await answers("POST", "/api/holds", {
      body: { mailboxId, matterId }, cookie: asker,
    }) as { hold: { id: string } };
    const lift = await answers("POST", "/api/holds/:holdId/lift", {
      params: { holdId: placed.hold.id }, body: { reason: "done" }, cookie: asker,
    }) as { lift: { eligible: number } };
    expect(lift.lift.eligible).toBe(2);

    const paused = await answers("POST", "/api/domain-pauses", {
      body: { domain: "example.net", reason: "a reason" }, cookie: asker,
    }) as { pause: { eligible: number } };
    expect(paused.pause.eligible).toBe(2);
  });

  it("lifting a domain pause, once two people have approved it", async () => {
    const asker = await cookieFor(USER);
    /*
     * A distinct domain per test: `E_DOMAIN_PAUSE_PENDING` permits one open question per domain, because two
     * requests would ask two pairs of administrators about the same domain and whichever finished first
     * would stop it while the other still read as pending. An earlier test in this block pauses
     * `example.net`, and the refusal is what said so.
     */
    const requested = await answers("POST", "/api/domain-pauses", {
      body: { domain: "lifted.example", reason: "a reason" }, cookie: asker,
    }) as { pause: { pauseId: string; approvalId: string } };

    for (const person of [OTHER, THIRD]) {
      await answers("POST", "/api/approvals/:approvalId/decide", {
        params: { approvalId: requested.pause.approvalId },
        body: { decision: "approve" }, cookie: await cookieFor(person),
      });
    }
    await answers("POST", "/api/domain-pauses/:pauseId/lift", {
      params: { pauseId: requested.pause.pauseId }, body: { reason: "done" }, cookie: asker,
    });
  });

  it("running an approved export, which is paged", async () => {
    /*
     * `pagesDone` and `done` are what let a caller drive an export to completion across invocations, because
     * a bulk copy of a mailbox does not fit one subrequest budget. The manifest's digest and count are what
     * make it provable afterwards — the same reason the request froze its predicate.
     */
    const asker = await cookieFor(USER);
    const matterId = await matter(asker);
    const requested = await answers("POST", "/api/exports", {
      body: { matterId, mailboxId, maxMessages: 5 }, cookie: asker,
    }) as { export: { exportId: string; approvalId: string } };

    for (const person of [OTHER, THIRD]) {
      await answers("POST", "/api/approvals/:approvalId/decide", {
        params: { approvalId: requested.export.approvalId },
        body: { decision: "approve" }, cookie: await cookieFor(person),
      });
    }
    const run = await answers("POST", "/api/exports/:exportId/run", {
      params: { exportId: requested.export.exportId }, body: {}, cookie: asker,
    }) as { run: { done: boolean; manifest: { count: number } | null } };
    expect(run.run.done).toBe(true);
    expect(run.run.manifest?.count).toBe(0);
  });

  it("withdrawing a decision, and the shortfall it creates", async () => {
    /*
     * The reply carries the shortfall the withdrawal *created*, which is the point of returning anything:
     * taking a decision back can make a request unsatisfiable, and a caller told only the new state would
     * not know whether anybody can still complete it.
     */
    const asker = await cookieFor(USER);
    const matterId = await matter(asker);
    const requested = await answers("POST", "/api/supervised", {
      body: { subjectId: USER, mailboxId, scope: "metadata", durationSeconds: 3600, matterId },
      cookie: asker,
    }) as { supervised: { approvalId: string } };

    const decider = await cookieFor(OTHER);
    await answers("POST", "/api/approvals/:approvalId/decide", {
      params: { approvalId: requested.supervised.approvalId },
      body: { decision: "approve" }, cookie: decider,
    });
    const withdrawn = await answers("POST", "/api/approvals/:approvalId/withdraw", {
      params: { approvalId: requested.supervised.approvalId }, body: {}, cookie: decider,
    }) as { withdrawn: { approvalState: string; shortfall: { short: number } | null } };
    // One approver withdrew and cannot decide again, so two are needed and one remains.
    expect(withdrawn.withdrawn.approvalState).toBe("unsatisfiable");
    expect(withdrawn.withdrawn.shortfall?.short).toBe(1);
  });

  it("the holds list, with the two fields only it computes", async () => {
    const asker = await cookieFor(USER);
    const matterId = await matter(asker);
    const placed = await answers("POST", "/api/holds", {
      body: { mailboxId, matterId }, cookie: asker,
    }) as { hold: { id: string } };
    await answers("POST", "/api/holds/:holdId/lift", {
      params: { holdId: placed.hold.id }, body: { reason: "done" }, cookie: asker,
    });

    const listed = await answers("GET", "/api/holds", { cookie: asker }) as {
      holds: Array<{ mailboxExists: boolean; pendingLift: unknown }>;
    };
    expect(listed.holds).toHaveLength(1);
    // The two the placing route cannot answer, which is why `holdPlacedResponse` omits them.
    expect(listed.holds[0]!.mailboxExists).toBe(true);
    expect(listed.holds[0]!.pendingLift).not.toBeNull();
  });
});

describe("the routes that only exist once mail has landed", () => {
  /*
   * `test/fixtures/delivery.ts`, shared with `butler-run.test.ts` rather than copied. Two spellings of
   * *"what a delivery looks like"* would be one that stops matching what ingest writes, and the one nobody
   * updates is always the one being trusted.
   *
   * It is deliberately not the ingest path — it writes the rows ingest produces — which is the right
   * fidelity for describing **projections** over stored mail and the wrong one for a claim about ingest.
   */
  let mailboxId = "";
  let address = "";

  beforeEach(async () => {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    mailboxId = ctx.id("mbx");
    address = `${mailboxId}@acme.example`;
    const rows = [
      testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(mailboxId, ORG, "support", at),
      testEnv.CATALOG.prepare(
        "INSERT INTO addresses (id, org_id, mailbox_id, address, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("adr"), ORG, mailboxId, address, at),
    ];
    /*
     * `message.export` joins the list because `GET /api/sends/:sendId/submitted` requires it since #95 — the
     * outbound original-message download asks for the same relation the inbound `.eml` always did. It took
     * content access alone before, which is exactly why this fixture did not need it and why the divergence
     * survived four months: the test exercising the route could not have noticed the weaker requirement.
     */
    for (const relation of [
      "send.propose", "mailbox.content.read", "mailbox.metadata.read", "message.export",
    ]) {
      rows.push(testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, relation, mailboxId, at));
    }
    await testEnv.CATALOG.batch(rows);
  });

  it("GET /api/messages, with a message in it", async () => {
    await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });
    const read = await answers("GET", "/api/messages", { cookie: await cookie() }) as {
      messages: unknown[];
    };
    expect(read.messages).toHaveLength(1);
  });

  it("GET /api/cases, with a case in it", async () => {
    await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });
    /*
     * The mailbox is a **path segment** now. It was `?mailbox=` and the registry never declared it, so `path()`
     * could not build a usable URL and the caller had to append the query by hand — which the SDK and the MCP
     * tool cannot do, and is why `queue.read` was a capability an agent could hold and could not use.
     *
     * That is the difference this test now demonstrates rather than works around: `path()` alone produces a
     * URL that answers.
     */
    const held = await cookie();
    const spec = route("GET", "/api/mailboxes/:mailboxId/cases");
    const response = await SELF.fetch(`${ORIGIN}${path(spec, { mailboxId })}`, {
      headers: { cookie: held },
    });
    expect(response.status).toBe(200);
    const read = spec.response!.parse(await response.json()) as { cases: unknown[] };
    expect(read.cases).toHaveLength(1);
  });

  it("all four case acts, which answer four different shapes", async () => {
    /*
     * The union is the schema, and each key is what says which act happened. `claim` and `steal` answer
     * identically — stealing is claiming a case somebody else holds, and the difference is in the audit
     * trail rather than in what the caller gets back.
     */
    const held = await cookie();
    const first = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });
    const second = await seedDelivery(testEnv, createSystemCtx(), {
      orgId: ORG, mailboxId, address,
    }, { subject: "second" });

    const claimed = await answers("POST", "/api/cases/:caseId/:action", {
      params: { caseId: first.caseId, action: "claim" }, body: {}, cookie: held,
    }) as { claimed: boolean };
    expect(claimed.claimed).toBe(true);

    await answers("POST", "/api/cases/:caseId/:action", {
      params: { caseId: first.caseId, action: "steal" }, body: {}, cookie: held,
    });
    await answers("POST", "/api/cases/:caseId/:action", {
      params: { caseId: second.caseId, action: "claim" }, body: {}, cookie: held,
    });
    await answers("POST", "/api/cases/:caseId/:action", {
      params: { caseId: second.caseId, action: "release" }, body: {}, cookie: held,
    });
    await answers("POST", "/api/cases/:caseId/:action", {
      params: { caseId: first.caseId, action: "close" }, body: {}, cookie: held,
    });
  });

  it("merging two conversations, once one side is held", async () => {
    /*
     * A merge is refused while both cases are unclaimed — it would discard one side's history and the
     * earlier SLA start, which is the one a breach is computed from. So the fixture claims one first, which
     * is the state the refusal itself names as the way forward.
     */
    const held = await cookie();
    const into = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });
    const from = await seedDelivery(testEnv, createSystemCtx(), {
      orgId: ORG, mailboxId, address,
    }, { subject: "second" });
    /*
     * **Both** claimed, by the same person. The refusals walk you there: two unclaimed cases would discard
     * one side's history and the earlier SLA start; one claimed and one not would either unassign somebody
     * mid-reply or discard the unclaimed side. Each refusal names the resolution, which is how this fixture
     * was arrived at rather than guessed.
     */
    for (const caseId of [into.caseId, from.caseId]) {
      await answers("POST", "/api/cases/:caseId/:action", {
        params: { caseId, action: "claim" }, body: {}, cookie: held,
      });
    }

    await answers("POST", "/api/conversations/merge", {
      body: { from: from.conversationId, into: into.conversationId }, cookie: held,
    });
  });

  it("a message body, which takes the receipt id and not the message id", async () => {
    /*
     * **The route's segment is an `ir_` id.** `authorize` looks it up in `ingress_receipts`, so passing the
     * obvious `msg_` one answers 404 *"No such message, or you do not have access to it"* — which reads as
     * an authorization problem and is a wrong-kind-of-id problem. `GET /api/messages` returns both, `id`
     * being the receipt and `message_id` the message, which is easy to have backwards and impossible to
     * notice. Both are asserted here so the trap is documented by a failing alternative rather than a
     * comment.
     */
    const held = await cookie();
    const delivery = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });

    const wrong = await SELF.fetch(`${ORIGIN}/api/messages/${delivery.messageId}/body`, {
      headers: { cookie: held },
    });
    expect(wrong.status).toBe(404);

    const rendered = await answers("GET", "/api/messages/:receiptId/body", {
      params: { receiptId: delivery.receiptId }, cookie: held,
    }) as { state: string; text: string | null };
    expect(rendered.state).toBe("text-only");
    expect(rendered.text).toContain("Where is my invoice?");
  });

  it("releasing a send a policy held", async () => {
    /*
     * A published `hold` policy is what puts a seal into `policy_hold`, which is a different state from the
     * Butler gate above — `release` answers one and `release-hold` the other, and a send in the wrong one
     * refuses. Producing it through a real policy rather than an UPDATE is what makes that distinction real.
     */
    const held = await cookie();
    const delivery = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });
    const policy = await answers("POST", "/api/policies", {
      body: { name: "hold all", outcome: "hold", conditions: {}, stages: [] }, cookie: held,
    }) as { policy: { policyId: string } };
    await answers("POST", "/api/policies/:policyId/publish", {
      params: { policyId: policy.policy.policyId }, cookie: held,
    });

    const sealed = await answers("POST", "/api/sends", {
      body: {
        mailboxId, to: ["x@y.test"], subject: "a", body: "b",
        inReplyToMessageId: delivery.messageId,
      },
      cookie: held,
    }) as { id: string; stateReason: string | null };
    expect(sealed.stateReason).toBe("policy_hold");

    await answers("POST", "/api/sends/:sendId/release-hold", {
      params: { sendId: sealed.id }, body: {}, cookie: held,
    });
  });

  it("a dispatched send: its submitted bytes and the retry it earns", async () => {
    /*
     * The last state no earlier fixture could reach, and it takes a **stub transport** — the pattern
     * `breakers.test.ts` and `approvals.test.ts` already use. `dispatchDue` takes the adapter as a
     * parameter precisely so a test can decide what the world answers.
     *
     * The stub **refuses**, which is deliberate: `retry-effect` is offered only where non-acceptance is
     * recorded, so a stub that accepted would have produced a send with nothing to retry. ADR 40's whole
     * distinction is that a recorded refusal proves the message never left.
     */
    const held = await cookie();
    const delivery = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });
    const sealed = await answers("POST", "/api/sends", {
      body: {
        mailboxId, to: ["x@y.test"], subject: "a", body: "b",
        inReplyToMessageId: delivery.messageId,
      },
      cookie: held,
    }) as { id: string; releaseAt: string };

    const system = createSystemCtx();
    const past = Date.parse(sealed.releaseAt) + 60_000;
    const swept = await dispatchDue(
      testEnv,
      { now: () => past, id: (p) => system.id(p), random: (n) => system.random(n) },
      ORG, refusingTransport, 20,
    );
    /*
     * At least one, and **mine among them** — not exactly one. Earlier tests in this block leave sends that
     * are also due by now, and a sweep is org-wide by design: it hands over everything ready, which is the
     * behaviour a per-test count would be quietly asserting against.
     */
    expect(swept.map((one) => one.manifestId)).toContain(sealed.id);

    /*
     * `submitted` is **not JSON** — it answers the message itself, which is why it is in `NOT_JSON`. Checked
     * here anyway, because "the bytes are the bytes" is the claim the whole authored path exists to make and
     * a route that returned a description instead would satisfy no schema and no test.
     */
    const bytes = await SELF.fetch(`${ORIGIN}/api/sends/${sealed.id}/submitted`, {
      headers: { cookie: held },
    });
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toContain("From:");

    const retried = await answers("POST", "/api/sends/:sendId/retry", {
      params: { sendId: sealed.id }, body: { mode: "retry-effect" }, cookie: held,
    }) as { detail: string };
    // The sentence is the epistemic claim, and it is why this mode is the safe one.
    expect(retried.detail).toMatch(/proving it never left/);
  });

  it("POST /api/sends/dispatch, with nothing due", async () => {
    await answers("POST", "/api/sends/dispatch", { body: {}, cookie: await cookie() });
  });

  it("sealing a manifest, listing it, and cancelling it", async () => {
    /*
     * The seal answers at the **top level** rather than under a `send` key, unlike every other act here.
     * Worth keeping rather than tidying: this response *is* the sealed envelope — the policy outcome, the
     * approval it would need, the breaker that would stop it, the capability of the Node that would carry it
     * — and wrapping it would suggest there is something else in the reply.
     */
    const held = await cookie();
    const delivery = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });
    const sealed = await answers("POST", "/api/sends", {
      body: {
        mailboxId, to: ["x@y.test"], subject: "re", body: "hello",
        inReplyToMessageId: delivery.messageId,
      },
      cookie: held,
    }) as { id: string; state: string; draftRetained: boolean };
    expect(sealed.state).toBe("held");
    // Sealing consumes the draft; `draftRetained` is how a caller knows whether anything is left to edit.
    expect(sealed.draftRetained).toBe(false);

    /*
     * And the list, whose `sends` elements were `z.unknown()` until a manifest could be produced to check
     * them against. A list schema with unknown elements checks an envelope and nothing in it.
     */
    const listed = await answers("GET", "/api/sends", { cookie: held }) as {
      sends: Array<{ recipients: unknown[]; retry: { why: string } }>;
    };
    expect(listed.sends).toHaveLength(1);
    // Migration 0013's unit: one row per recipient, each with its own state.
    expect(listed.sends[0]!.recipients).toHaveLength(1);
    expect(listed.sends[0]!.retry.why).toBe("not_yet_attempted");

    await answers("POST", "/api/sends/:sendId/cancel", {
      params: { sendId: sealed.id }, body: {}, cookie: held,
    });
  });
});

describe("the account lifecycle, on a Node that has not been claimed", () => {
  /*
   * A separate `describe` with its own teardown, because these routes are defined by the Node **not** being
   * claimed — and every other test here starts from one that is. Sharing the fixture would have meant
   * testing the refusals rather than the acts.
   */
  beforeEach(async () => {
    for (const table of ["node_claim", "users", "relationship_tuples", "invitations"]) {
      await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it("POST /api/auth/refresh, and the replay flag it carries", async () => {
    /*
     * A refresh token is single-use, so presenting one twice is either a client retrying or a stolen token
     * being used — and this Node answers both by rotating the family and saying which. `replayed` is what
     * lets a caller tell a retry from a compromise, and a summary that dropped it would hide the second.
     */
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const person = ctx.id("usr");
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('c','x',?,?)")
        .bind(at, ORG),
      testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
        .bind(person, ORG, `${person}@local.invalid`, at),
    ]);
    const session = await issueSession(testEnv, ctx, { orgId: ORG, userId: person });
    const refreshed = await answers("POST", "/api/auth/refresh", {
      body: {}, cookie: `mailda_rt=${session.refreshToken}`,
    }) as { replayed: boolean };
    expect(refreshed.replayed).toBe(false);
  });

  it("POST /api/prepare, which is the migration endpoint and not what its name suggests", async () => {
    /*
     * It applies pending migrations. It does not mint a claim secret or prepare an account, which is what
     * the name reads as — the first attempt at this schema guessed the same way, and a generated client
     * whose author did would call it at the wrong moment.
     */
    const prepared = await answers("POST", "/api/prepare", { body: {} }) as { alreadyCurrent: boolean };
    expect(prepared.alreadyCurrent).toBe(true);
  });

  it("claiming, then inviting somebody who redeems", async () => {
    const secret = "install-secret-value";
    await testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES ('claim',?,NULL,NULL)",
    ).bind(await claimSecretHash(secret)).run();

    const claimed = await answers("POST", "/api/claim", {
      body: {
        organizationName: "Acme", email: "boss@local.invalid",
        password: "a-long-enough-password", secret,
      },
    }) as { organizationId: string };
    /*
     * No `userId` in the body, and that is the schema's claim as much as the route's: the caller *is* the
     * account just created and is signed in by the cookies, so naming the id would hand back what the
     * session already carries.
     */
    expect(claimed.organizationId).toMatch(/^org_/);

    /*
     * The invitation is seeded rather than minted through the route, and the reason is worth a line: minting
     * needs `org.admin`, and this test's whole point is the *unclaimed* lifecycle — reaching for an
     * administrator here would mean building the organization twice. The row written is the same shape
     * `inviteToOrganization` writes, including the hash, so what redemption verifies is unchanged.
     */
    const ctx = createSystemCtx();
    const invitationSecret = "an-invitation-secret";
    const now = ctx.now();
    await testEnv.CATALOG.prepare(
      `INSERT INTO invitations (id, org_id, email, secret_hash, invited_by, created_at, expires_at,
                                redeemed_at, redeemed_user_id)
       VALUES (?,?,?,?,?,?,?,NULL,NULL)`,
    ).bind(
      ctx.id("inv"), claimed.organizationId, "colleague@local.invalid",
      await claimSecretHash(invitationSecret), "usr_seed",
      new Date(now).toISOString(), new Date(now + 86_400_000).toISOString(),
    ).run();

    const joined = await answers("POST", "/api/invitations/redeem", {
      body: { secret: invitationSecret, password: "another-long-password" },
    }) as { joined: boolean; userId: string };
    expect(joined.joined).toBe(true);
    expect(joined.userId).toMatch(/^usr_/);
  });
});

describe("a Butler run, and the send it parks", () => {
  /*
   * The last group that needed a state no earlier fixture reached: a **real run**, driven through
   * `interpret` with an inline step runner, over a real delivery, by a Butler that proposes a send.
   *
   * Four things had to be true at once for the walk to get past its first node, and the Node refused
   * precisely until they were — which is the three-term ceiling working:
   *
   *   1. the Butler holds `send.propose` on the mailbox (its own tuple, not the asker's);
   *   2. the **sponsor** — whoever published the version — holds it too;
   *   3. the version's `capabilities` declare the mailbox by address;
   *   4. and that address is **lowercase**, because a ceiling lowercases what it declares and a ULID is
   *      uppercase. `${mailboxId}@…` refused with `capability_not_declared` until it was lowercased, which
   *      is a subtlety worth leaving written down rather than rediscovering.
   */
  const BUTLER_NODES = [
    {
      id: "reply", type: "draft", mailboxId: "${event.mailbox_id}", subject: "Re: ${event.subject}",
      body: "Thanks for your message.", inReplyTo: "${event.message_id}", as: "ack", next: "propose",
    },
    { id: "propose", type: "mail.send.propose", draft: "${steps.ack}", next: null },
  ];

  function inlineSteps(): RunSteps {
    return {
      do: async (_name, body) => await body(),
      sleep: async () => {},
      // The release arrives at once: this fixture is about the record a run leaves, not about waiting.
      waitForEvent: async () => ({ released: true }),
    };
  }

  async function aRun(): Promise<{ runId: string; butlerId: string; sendId: string }> {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const mailboxId = ctx.id("mbx");
    const address = `${mailboxId.toLowerCase()}@acme.example`;

    const rows = [
      testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
        .bind(mailboxId, ORG, "support", at),
      testEnv.CATALOG.prepare(
        "INSERT INTO addresses (id, org_id, mailbox_id, address, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("adr"), ORG, mailboxId, address, at),
    ];
    for (const relation of ["send.propose", "mailbox.content.read"]) {
      rows.push(testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, USER, relation, mailboxId, at));
    }
    await testEnv.CATALOG.batch(rows);

    const source = JSON.stringify({
      apiVersion: "mailda/v1", kind: "Butler", metadata: { name: "ack", owner: "team:support" },
      capabilities: [{ action: "send.propose", resource: `mailbox:${address}` }],
      trigger: { event: "mail.received", mailbox: address },
      entry: "reply", nodes: BUTLER_NODES,
    });
    const draft = await createButlerDraft(testEnv, ctx, ORG, USER, { name: "ack", source });
    const live = await publishButler(testEnv, ctx, ORG, USER, draft.butlerId);

    // The Butler's own tuples. Its authority is not its author's.
    for (const relation of ["send.propose", "mailbox.content.read"]) {
      await testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, draft.butlerId, relation, mailboxId, at).run();
    }

    const delivery = await seedDelivery(testEnv, createSystemCtx(), { orgId: ORG, mailboxId, address });
    const facts = await deliveryFacts(testEnv, ORG, delivery.messageId);
    const runId = `${live.versionId}-${delivery.messageId}`;
    const outcome = await interpret(testEnv, createSystemCtx(), {
      orgId: ORG, butlerId: draft.butlerId, butlerVersionId: live.versionId,
      trigger: { event: "mail.received", key: delivery.messageId, facts: facts! },
    }, inlineSteps(), runId);

    expect(outcome.state, JSON.stringify(outcome.effects)).toBe("finished");
    const proposed = outcome.effects.find((effect) => effect.nodeType === "mail.send.propose");
    return { runId, butlerId: draft.butlerId, sendId: proposed!.subject! };
  }

  it("the run, its inspection, and a replay", async () => {
    const held = await cookie();
    const { runId } = await aRun();

    const detail = await answers("GET", "/api/butler-runs/:runId", {
      params: { runId }, cookie: held,
    }) as { effects: unknown[] };
    expect(detail.effects).toHaveLength(2);

    /*
     * `notRecorded` is a sentence in the payload saying what the record cannot tell you: the pure nodes leave
     * no row, because this Node keeps one per **effect** rather than one per step. A reader who assumed
     * otherwise would draw conclusions from an absence, and the field exists so they cannot.
     */
    const inspected = await answers("GET", "/api/butler-runs/:runId/inspect", {
      params: { runId }, cookie: held,
    }) as { notRecorded: string; triggerFacts: Record<string, unknown> | null; reRun: { available: boolean } };
    expect(inspected.notRecorded).toMatch(/one row per effect/);
    // The input is inherited and the judgement re-asked — which is what makes a replay a replay.
    expect(inspected.triggerFacts?.message_id).toBeDefined();
    expect(inspected.reRun.available).toBe(true);

    const replayed = await answers("POST", "/api/butler-runs/:runId/replay", {
      params: { runId }, body: { mode: "re-run" }, cookie: held,
    }) as { runId: string; replayOf: string };
    // A replay is a **new** instance with its own budget, never a resumption of the old one.
    expect(replayed.runId).not.toBe(runId);
    expect(replayed.replayOf).toBe(runId);
  });

  it("releasing the send the run parked", async () => {
    /*
     * `resumed` is separate from `released` on purpose: a timed-out run leaves its manifest releasable, so a
     * send can be released long after the instance that proposed it has gone. Folding the two would make a
     * release of an orphaned send look like a failure.
     */
    const held = await cookie();
    const { sendId } = await aRun();
    const released = await answers("POST", "/api/sends/:sendId/release", {
      params: { sendId }, body: {}, cookie: held,
    }) as { released: boolean; runId: string | null };
    expect(released.released).toBe(true);
    expect(released.runId).not.toBeNull();
  });

  it("resuming a Butler a machine stopped", async () => {
    const held = await cookie();
    const { butlerId } = await aRun();
    const pause = await placeButlerPause(testEnv, createSystemCtx(), ORG, {
      butlerId, butlerName: "ack", reason: "loop_detected",
      detail: "placed by this test, with the shape describeLoopTrip produces",
      trippedBy: "msg_placeholder",
    });
    await answers("POST", "/api/butler-pauses/:pauseId/resume", {
      params: { pauseId: pause!.pauseId }, body: { reason: "the loop is fixed" }, cookie: held,
    });
  });
});

describe("the generated SDK drives a real Node (#85 step 3)", () => {
  /*
   * The tests in `packages/sdk` check the SDK against a **stub** — that its paths are built from the
   * contract, that a refusal becomes a `MaildaError`, that a wrong shape becomes a `ContractViolation`. What
   * they cannot check is that the contract they were generated from describes *this* Node.
   *
   * That is what this does: the generated client, against the real handler, with response validation on. A
   * schema that does not describe reality fails here as a `ContractViolation` — which is the same guarantee
   * the tranches above give, arriving through the surface a consumer will actually use.
   */
  it("reads and writes through the generated methods, with validation on", async () => {
    const held = await cookie();
    const client = createClient({
      origin: ORIGIN,
      headers: { cookie: held },
      // `SELF.fetch` rather than the global: the Node under test is this Worker, not a network address.
      fetch: ((url: string, init: RequestInit) => SELF.fetch(url, init)) as unknown as typeof globalThis.fetch,
    });

    const me = await client.getMe();
    expect(me.userId).toBe(USER);

    const created = await client.postButlers({
      name: "through the sdk", source: STARTER, sourceFormat: "json",
    });
    const published = await client.postButlersByButlerIdPublish({
      butlerId: created.butler.butlerId,
    });
    expect(published.published.version).toBe(1);

    const listed = await client.getButlers();
    expect(listed.butlers).toHaveLength(1);
    // The typed field is the point: this is `ButlerRow["live_version"]`, not `any`.
    expect(listed.butlers[0]!.live_version).toBe(1);
  });

  it("turns a refusal into a MaildaError carrying this Node's own code", async () => {
    /*
     * The four-part refusal survives the SDK boundary rather than becoming a status code. `code` is what a
     * caller branches on and `message` is what a person reads — which is the whole of AGENTS.md §3 reaching
     * a consumer that never sees the HTTP.
     */
    const client = createClient({
      origin: ORIGIN,
      headers: { cookie: await cookie() },
      fetch: ((url: string, init: RequestInit) => SELF.fetch(url, init)) as unknown as typeof globalThis.fetch,
    });

    await expect(client.postButlers({ name: "broken", source: "{not json", sourceFormat: "json" }))
      .rejects.toMatchObject({ name: "MaildaError", code: "E_BUTLER_SOURCE_NOT_JSON" });
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
    /*
     * The denominator excludes `NOT_JSON` — three routes that answer HTML, `message/rfc822` and an export's
     * bytes. A target that counts routes no schema can ever describe is one nobody can reach.
     */
    /*
     * 98 of 103 routes: four answer something other than JSON (`NOT_JSON`) and one answers a shape MCP
     * specifies rather than this contract (`EXTERNALLY_SPECIFIED`). Both are excluded from the denominator,
     * because a target counting routes no schema can describe is one nobody aims at.
     *
     * The 92nd and 93rd are `POST /api/recovery-codes/rotate` and `.../confirm` — the operator path that
     * `doctor` had been naming since #92 with nothing behind it. The 94th and 95th are
     * `GET /api/search/failed` and `POST /api/search/repair`, which is the same story: the receipt for
     * #107 named clearing a column by hand as the only repair, and now there is a door. The last three are
     * the agent credential (#109 L2) — mint, list and revoke, all `operator`, because an agent that could
     * mint agents escapes its own pinned ceiling in a single call.
     *
     * The 99th is `GET /api/agent-capabilities`: the vocabulary an agent's ceiling is chosen from, published
     * so the interface offering it does not carry a second copy. `operator`, like the three above it — a
     * machine reading the list of what machines may be granted is reading a map of how to escalate.
     *
     * The 100th is `GET /api/mailboxes/readable`: the catalogue `mail.read` needs, added because
     * `GET /api/mailboxes` is the work-queue rail — `mailboxQueues` lists mailboxes the caller holds
     * `send.propose` on — so a read-only agent could open messages and received an empty list.
     *
     * The 101st is `GET /api/people/:userId/mailboxes`, the mint surface's resource catalogue: every mailbox
     * with what a **named sponsor** holds on it. The form used the queue rail for that too, so an
     * administrator could only provision mailboxes they personally send from.
     *
     * The 102nd is `POST /api/recovery/conflicts/:restoreId/acknowledge`. `doctor` stayed `degraded` for ever
     * once a vault restore had collided with a live key — correctly, since nothing repairs a collision, and
     * uselessly, since a permanent alarm is one an operator learns to scroll past. This records that somebody
     * established what was lost; the finding stays and its severity drops, which is the difference between
     * acknowledged and healthy.
     */
    expect(coverage.total).toBe(102);
    /*
     * **Every describable route is described.** The floor is the whole set now, so this asserts equality
     * rather than a minimum: a route added without a schema fails here, which is what step 3 needs to be
     * true before an SDK can be generated from this at all.
     */
    expect(coverage.described).toBe(coverage.total);
    expect(coverage.missing).toEqual([]);
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

  });
});
