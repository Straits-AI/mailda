import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { ROUTES, type RouteSpec } from "@mailda/contract/routes";

import { ACCESS_COOKIE, login } from "../src/auth/session.ts";
import { hashPassword } from "../src/auth/password.ts";

/**
 * What a route **declares** it requires, driven against a principal who does not have it.
 *
 * ## The gap this closes
 *
 * `packages/contract/src/authority.ts` moved each route's requirement next to the route, and everything
 * downstream derives from it: `machineProvisionable()`, `requiresOf()`, the capability vocabulary, the
 * generated clients, the MCP catalogue. That was the right move and it created a new way to be wrong —
 * **the declaration is hand-written, and nothing compared it to the handler.**
 *
 * `test/agent-capabilities.test.ts` drives every *offered* capability, which cannot catch this. Over-declaring
 * a route's authority makes it **withheld** from machines, and a withheld route is never driven by anything.
 * The error is silent in exactly the direction the existing suite cannot look.
 *
 * Four were wrong, all in that direction, and each handler says so in its own comment:
 *
 * | route | declared | what the handler does |
 * |:--|:--|:--|
 * | `GET /api/approvals` | `org.admin` | *"needs no admin"* — scoped to mailboxes holding `approval.decide` |
 * | `GET /api/matters` | `org.admin` | admin sees all, anyone else sees the ones they opened |
 * | `POST /api/matters` | `org.admin` | any authenticated member may open one |
 * | `GET /api/teams` | `org.admin` | *"readable by any member, and that is a decision"* |
 *
 * ## What this asserts, and why it is a pair
 *
 * For every route declaring `organization`, an authenticated member holding **no relations at all** must not
 * receive a success. On its own that assertion passes for a bad reason: a route that 404s on a fixture the
 * test never built refuses the member too, and proves nothing.
 *
 * So each route is driven **twice** — once as an administrator, once as the member — and the pair is what is
 * classified. Only `admin succeeds, member does not` confirms a declaration. `admin also fails` means the
 * route was never really exercised, and those are listed by name rather than counted as passes.
 *
 * The mirror runs too: a route declaring `member`, `filtered` or `self-or-admin` must actually **answer** an
 * ordinary member. That direction needs a success rather than the absence of a 403, because §5C makes half
 * this Node's admin gate answer `404` exactly as an absent thing does — the first version accepted "not 403"
 * and a mutation declaring the admin-only `GET /api/people` as `member` sailed through it.
 *
 * ## What this file does not cover
 *
 * `mailbox`-scoped routes, which `test/agent-capabilities.test.ts` drives with exactly the relations they
 * declare, and `none`, which `test/contract-responses.test.ts` reaches unauthenticated. Stated rather than
 * left as an absence: this file is about the two scopes whose declarations nothing else compares to a handler.
 */

const testEnv = env as unknown as {
  CATALOG: D1Database;
};

const ORG = "org_PARTY000000000000000000000";
const ADMIN = "usr_PARTYADMN00000000000000000";
const MEMBER = "usr_PARTYMEMBER000000000000000";
const MAILBOX = "mbx_PARTYMBX000000000000000000";
const PASSWORD = "fixture-password-not-a-real-secret";

/** A Butler this Node will parse. Copied in shape from `contract-responses.test.ts`, which drives the same route. */
const STARTER = JSON.stringify({
  apiVersion: "mailda/v1",
  kind: "Butler",
  metadata: { name: "parity", owner: "team:support" },
  capabilities: [],
  trigger: { event: "mail.received", mailbox: "support@example.com" },
  entry: "halt",
  nodes: [{ id: "halt", type: "stop", reason: "nothing yet" }],
});

/**
 * Lowercase, and that is the fix rather than a style choice: `login` normalises the address before looking it
 * up, so a fixture address derived from a ULID answered `invalid_credentials` for a reason that had nothing to
 * do with authority.
 */
function emailFor(userId: string): string {
  return `${userId === ADMIN ? "admin" : "member"}@parity.example`;
}

let adminCookie = "";
let memberCookie = "";

beforeEach(async () => {
  for (
    const table of ["relationship_tuples", "users", "node_claim", "mailboxes", "sessions", "refresh_tokens",
      "login_attempts", "teams", "matters", "policies", "butlers"]
  ) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table} WHERE 1=1`).run().catch(() => undefined);
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind(ctx.id("clm"), "x", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Enquiries", at),
    ...[ADMIN, MEMBER].map((userId) =>
      testEnv.CATALOG.prepare(
        `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
           password_updated_at) VALUES (?,?,?,?,?,?,?)`,
      ).bind(userId, ORG, emailFor(userId), at, verifier.encoded, verifier.effectiveIterations, at)
    ),
  ]);

  /*
   * The administrator, and **nothing for the member**. A member with a mailbox relation would satisfy some of
   * these routes for a legitimate reason and blur what the refusal means. The question this file asks is
   * narrow: does `org.admin` actually gate the route that says it does.
   */
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,'org.admin','organization',?,?)`,
  ).bind(ctx.id("rt"), ORG, ADMIN, ORG, at).run();

  adminCookie = await sessionFor(ADMIN);
  memberCookie = await sessionFor(MEMBER);
});

async function sessionFor(userId: string): Promise<string> {
  const outcome = await login(testEnv as never, createSystemCtx(), ORG, emailFor(userId), PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

async function drive(spec: RouteSpec, cookie: string, ids: Record<string, string>): Promise<number> {
  const path = spec.path.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `${name}-does-not-exist`);
  const body = BODIES[`${spec.method} ${spec.path}`];
  const response = await SELF.fetch(`https://node${path}`, {
    method: spec.method,
    headers: {
      cookie: `${ACCESS_COOKIE}=${cookie}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.status;
}

/** The minimum body each writing route needs to get past its own shape validation and reach its authority check. */
const BODIES: Record<string, unknown> = {
  // `type` is an enum — `MATTER_TYPES` in src/matters.ts. An invented one is refused, not defaulted.
  "POST /api/matters": { type: "security_incident", description: "parity fixture" },
  "POST /api/policies": { name: "parity", outcome: "hold", conditions: {}, stages: [] },
  "PUT /api/policies/:policyId/draft": { outcome: "hold", conditions: {}, stages: [] },
  "POST /api/butlers": { name: "parity", source: STARTER, sourceFormat: "json" },
  "PUT /api/butlers/:butlerId/draft": { source: STARTER, sourceFormat: "json" },
  // `facts` is refused when absent — a dry run needs the given, or it reports a walk over nothing.
  "POST /api/butlers/:butlerId/simulate": { facts: {} },
};

/**
 * Routes an administrator could not drive to a success here, so the member's refusal proves nothing about
 * them.
 *
 * An exact list rather than a tolerated remainder: every entry is a route whose declared authority is
 * currently unverified, and the list can only shrink. Building a fixture removes an entry; adding an
 * `organization` route with no fixture adds one, loudly, rather than passing as a refusal that was really a
 * 404.
 */
const NOT_EXERCISED: readonly string[] = [
  /*
   * Both need a Butler run that has actually happened, which `test/butler-run.test.ts` builds by walking one.
   * A run cannot be inserted as a row and mean anything: the inspect route reads the recorded walk.
   *
   * `GET /api/exports` and `GET /api/transport` were on this list on the first draft, on the assumption that
   * they needed an approval ceremony and deploy-time credentials. Both are driven fine — they answer an
   * administrator with an empty list. Guessing what a route needs is what this file exists to stop, and it
   * caught me doing it twice.
   */
  "GET /api/butler-runs/:runId",
  "GET /api/butler-runs/:runId/inspect",
];

describe("a route that declares org.admin is actually gated by org.admin", () => {
  it("refuses an ordinary member on every organization-declared route", async () => {
    const declared = (ROUTES as readonly RouteSpec[])
      .filter((spec) => spec.authority?.scope === "organization");

    /*
     * Real ids, harvested by driving the create routes as the administrator. A well-formed id referring to
     * nothing makes the handler 404 before it reaches its authority check, which is how a route ends up
     * "passing" this file without being tested at all.
     */
    const ids: Record<string, string> = { userId: MEMBER, teamId: "", policyId: "", butlerId: "", runId: "" };
    const harvestFailed: string[] = [];
    const created = async (method: string, path: string, body: unknown, key: string) => {
      const response = await SELF.fetch(`https://node${path}`, {
        method,
        headers: { cookie: `${ACCESS_COOKIE}=${adminCookie}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // Reported rather than swallowed. A silent "" here becomes a bogus path segment, every route using it
        // 404s for both principals, and they land in `unexercised` looking like a missing fixture rather than
        // like the create call that actually failed.
        harvestFailed.push(`${method} ${path} → ${response.status} ${(await response.text()).slice(0, 120)}`);
        return "";
      }
      /*
       * `id` or `<thing>Id`, because both shapes are in use: `POST /api/teams` answers `{team:{id}}` and
       * `POST /api/butlers` answers `{butler:{butlerId}}`. Reading only the first silently produced an empty
       * id, a bogus path segment, and two routes reported as missing a fixture that had just been built.
       */
      const nested = ((await response.json()) as Record<string, Record<string, string>>)[key] ?? {};
      const found = nested["id"] ?? nested[`${key}Id`] ?? "";
      // A 200 whose shape this did not expect is the same failure wearing a success: the id comes back empty,
      // the path segment is bogus, and the route lands in `unexercised` blaming a fixture that was built.
      if (found === "") harvestFailed.push(`${method} ${path} → 200 but no \`${key}.id\` in the response`);
      return found;
    };
    ids["teamId"] = await created("POST", "/api/teams", { name: "Parity" }, "team");
    ids["policyId"] = await created("POST", "/api/policies", BODIES["POST /api/policies"], "policy");
    ids["butlerId"] = await created("POST", "/api/butlers", BODIES["POST /api/butlers"], "butler");
    expect(harvestFailed, "could not build the fixtures this suite drives with").toEqual([]);

    const falselyDeclared: string[] = [];
    const unexercised: string[] = [];
    let confirmed = 0;
    for (const spec of declared) {
      const key = `${spec.method} ${spec.path}`;
      const asAdmin = await drive(spec, adminCookie, ids);
      const asMember = await drive(spec, memberCookie, ids);

      if (asAdmin >= 200 && asAdmin < 300) {
        // The pair that decides it. The administrator reached the handler, so the member's answer is about
        // authority rather than about a fixture.
        if (asMember >= 200 && asMember < 300) {
          falselyDeclared.push(`${key} — declares org.admin, but an ordinary member got ${asMember}`);
        } else {
          confirmed += 1;
        }
      } else if (asMember === 403 || (asMember === 404 && asAdmin !== 404)) {
        confirmed += 1;
      } else {
        /*
         * The administrator did not succeed. The member may still have been demonstrably refused: 403 is the
         * plain no, and **404 is also one** — §5C makes a read somebody may not do answer exactly as an absent
         * thing does, which `POST /api/butlers/:butlerId/simulate` states in its own comment. A 404 only
         * counts when the administrator got something else, or the two are agreeing that nothing is there.
         *
         * Anything else means both principals were stopped by the same missing fixture, and this route was
         * not tested at all.
         */
        unexercised.push(`${key} — admin got ${asAdmin}, member got ${asMember}`);
      }
    }

    expect(
      falselyDeclared,
      "these routes declare `organization` in packages/contract/src/routes.ts but do not enforce it. The "
      + "declaration is what machineProvisionable(), the capability vocabulary and the MCP catalogue derive "
      + "from, so a false one withholds machine authority that the handler would actually allow:",
    ).toEqual([]);

    expect(
      unexercised.map((one) => one.split(" — ")[0]).sort(),
      "these organization-declared routes could not be driven to a success as an administrator, so the "
      + "member's refusal does not prove the gate exists. Build the fixture, or add the route to "
      + "NOT_EXERCISED with what it would need:",
    ).toEqual([...NOT_EXERCISED].sort());

    /*
     * The positive control, measured from the same drive rather than asserted about a route I picked.
     *
     * The first version named `GET /api/access` as "genuinely admin-only" — and it is not. Its handler
     * defaults the subject to the caller, because *"knowing what you hold is not privileged"*, so it answered
     * the member 200 and the control failed. That was the check working: I had guessed a route's authority
     * from its name, which is the whole reason this file exists.
     *
     * Both assertions above are satisfied by an empty drive — `toEqual([])` against nothing, and an exact list
     * that would be empty too. This is what says the drive happened and the member was genuinely refused, so a
     * fixture that quietly over-granted the member would show here rather than as a suite full of passes.
     */
    expect(confirmed, "no organization-declared route was confirmed — is the member over-granted, or did the "
      + "drive not run?").toBeGreaterThan(10);
  });

  it("answers an ordinary member on every route declared reachable without administration", async () => {
    /*
     * The other direction, and it is not optional. Moving five routes off `organization` fixes the lie in one
     * direction and creates the mirror of it: a route declared `member` or `filtered` that actually demands
     * `org.admin` would offer machine authority the handler refuses — the precise defect that cost nine
     * capabilities their place in the vocabulary, arriving from the opposite side.
     *
     * `self-or-admin` is included because its whole claim is that the *default* subject needs no
     * administration.
     */
    const reachable = (ROUTES as readonly RouteSpec[]).filter((spec) =>
      spec.authority?.scope === "member" || spec.authority?.scope === "filtered"
      || spec.authority?.scope === "self-or-admin"
    );

    const refused: string[] = [];
    for (const spec of reachable) {
      const status = await drive(spec, memberCookie, { userId: MEMBER, mailboxId: MAILBOX });
      /*
       * The member must actually be **answered**, not merely spared a 403.
       *
       * The first version of this counted only 403 as disproof, and a mutation proved it toothless: declaring
       * the admin-only `GET /api/people` as `member` survived, because §5C makes an unauthorised read answer
       * `404` exactly as an absent thing does. Half the admin gate in this Node is spelled that way, so
       * "not 403" is nearly no assertion at all.
       */
      if (status < 200 || status >= 300) refused.push(`${spec.method} ${spec.path} → ${status}`);
    }

    expect(
      refused,
      "these routes declare that an ordinary member may reach them, and the Node did not answer one. The "
      + "declaration is what the capability vocabulary and the MCP catalogue offer from, so an over-generous "
      + "one hands out a credential that fails on its own promise:",
    ).toEqual([]);

    expect(reachable.length, "no member-reachable routes declared — has a scope been renamed?")
      .toBeGreaterThan(3);
  });

  it("declares enough organization routes for the check above to have a subject", async () => {
    // Structural, and separate because it must fail even if the drive throws: a renamed scope would empty the
    // filter above and every assertion in it would pass against nothing.
    const declared = (ROUTES as readonly RouteSpec[])
      .filter((spec) => spec.authority?.scope === "organization");
    expect(declared.length, "no organization-declared routes found — has the scope been renamed?")
      .toBeGreaterThan(15);
  });
});
