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
    "butler_versions", "butlers", "sending_transport", "invitations", "teams", "team_members",
    "matters", "holds", "policy_versions", "policies", "drafts", "addresses", "mailboxes",
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
      ).bind(ctx.id("adr"), ORG, mailboxId, `${mailboxId}@acme.example`, at),
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

  it("GET /api/butler-runs and /api/butler-pauses, which are empty and say so", async () => {
    /*
     * The two in this tranche whose **rows** are not exercised, stated rather than left to be assumed. A run
     * needs a delivery and a Workflow instance; a pause needs a breaker to trip. Both are covered by
     * `butler-run.test.ts` and `butler-pause.test.ts`, and neither is reproducible here cheaply — so what is
     * checked is the envelope, and the row schemas wait for a tranche that can produce one.
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
    expect(coverage.described).toBeGreaterThanOrEqual(55);
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
    expect(coverage.missing).toContain("GET /api/messages/:messageId/raw");
  });
});
