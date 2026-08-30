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
 * ## What this file covers, and what it does not
 *
 * Driven here: `organization` both ways, `member` both ways, `public` anonymously, the restrictive half of
 * `self-or-admin`, and every scoped route against a caller presenting nothing.
 *
 * `mailbox` routes are driven here too, but **only anonymously**. Their relation half belongs to
 * `test/agent-capabilities.test.ts`, which exercises each with exactly the relations it declares — and that
 * proves those relations *sufficient*, never *necessary*, so a `mailbox` route naming a relation no mint
 * confers would be silently withheld with nothing able to see it.
 *
 * Not driven here: the **open** case of `recovery`, where `GET /api/doctor` serves a stranger because this
 * Node cannot authenticate anybody. `test/doctor.test.ts` owns that one; the closed case — 401 on a healthy
 * Node — is in the anonymous loop below.
 *
 * This paragraph keeps being wrong, which is worth admitting in the file whose subject is stale claims. It
 * described a scope called `none` after this work deleted it; then said `mailbox` was not driven here after
 * the anonymous loop began driving all twelve; then pointed at `operator-routes.test.ts` for an open
 * `recovery` case that file does not contain.
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

/**
 * The status **and the refusal code**, because "not a success" is not proof of an authorization check.
 *
 * A route can refuse for reasons that have nothing to do with who is asking — a fixture it cannot find, a
 * body it will not accept, a conflict with something another principal just did. Counting any non-2xx as a
 * confirmed gate credits the declaration for a refusal it did not cause, which is the same class of error as
 * a test that passes because it asserts nothing.
 */
async function drive(
  spec: RouteSpec, cookie: string, ids: Record<string, string>,
): Promise<{ status: number; error: string }> {
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
  const text = await response.text();
  let error = "";
  try {
    error = (JSON.parse(text) as { error?: string }).error ?? "";
  } catch {
    // A non-JSON body is not a refusal shape, so there is no code to read. The status still speaks.
  }
  return { status: response.status, error };
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
    /*
     * ## The member goes first, and the refusal has to be an authorization refusal
     *
     * Two corrections, both about counting a refusal that authority did not cause.
     *
     * **Order.** The administrator used to be driven first, and several of these routes *write* — a matter
     * opened, a policy drafted. The member then met a world the administrator had just changed and could be
     * refused `409` for a conflict, `422` for a second act that is invalid, or `404` for a fixture the first
     * call transformed. Every one of those was counted as a confirmed gate. Driving the member against the
     * state the administrator has not touched yet removes the whole class.
     *
     * Said plainly, because it would be easy to imply otherwise: **no test fails if this order is reverted.**
     * Every organization-declared route today gates before it writes, so the hazard is latent rather than
     * live, and a mutation swapping the two lines survives. It is a guard against the next mutating route,
     * not a fix for a current failure. The *shape* rule below is the half that is mutation-proven.
     *
     * **Shape.** "Not a success" is not proof either. Only two answers demonstrate an authorization check:
     * `403` naming `E_NOT_AN_ADMINISTRATOR`, and the §5C `404` that makes an unauthorised read answer exactly
     * as an absent thing does — which several handlers use deliberately and state in their own comments.
     * Anything else means the route stopped short for a reason of its own, and it is reported as unexercised
     * rather than credited.
     */
    for (const spec of declared) {
      const key = `${spec.method} ${spec.path}`;
      const asMember = await drive(spec, memberCookie, ids);
      const asAdmin = await drive(spec, adminCookie, ids);

      /*
       * `403 E_NOT_AN_ADMINISTRATOR` is unambiguous. The §5C `404` is the dominant idiom here — eighteen
       * handlers refuse a non-administrator by answering exactly as an absent thing does, and most of them
       * run `isAdmin` *before* any lookup, so the 404 really is the gate.
       *
       * A response cannot show that ordering, though. If the administrator gets the same `404`, both
       * principals were stopped by the same absence and the member's answer proves nothing — so it only
       * counts when the administrator's answer differs. That keeps the rule grounded in what was observed
       * rather than in what reading the handler told me.
       */
      const refusedForAuthority = (asMember.status === 403 && asMember.error === "E_NOT_AN_ADMINISTRATOR")
        || (asMember.status === 404 && asMember.error === "not_found"
          && !(asAdmin.status === 404 && asAdmin.error === "not_found"));

      if (asMember.status >= 200 && asMember.status < 300) {
        if (asAdmin.status >= 200 && asAdmin.status < 300) {
          falselyDeclared.push(`${key} — declares org.admin, but an ordinary member got ${asMember.status}`);
        } else {
          // The member succeeded where the administrator did not, which is not a story about authority at
          // all — it is a fixture the administrator's own earlier calls disturbed.
          unexercised.push(`${key} — member got ${asMember.status}, admin got ${asAdmin.status}`);
        }
      } else if (refusedForAuthority) {
        confirmed += 1;
      } else {
        unexercised.push(
          `${key} — member got ${asMember.status} ${asMember.error || "(no code)"}, which is not an `
          + "authorization refusal",
        );
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
      const { status } = await drive(spec, memberCookie, { userId: MEMBER, mailboxId: MAILBOX });
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

  it("answers a stranger on every public route, and refuses one everywhere else", async () => {
    /*
     * The scope that was wrong, and it was wrong *because* nothing drove it.
     *
     * `none` meant "reaches nothing scoped" and was applied both to `GET /health`, which answers a stranger,
     * and to `GET /api/me`, whose handler calls `principalFor` and answers 401 without one. Five routes were
     * declared that way while requiring a principal. The handler stayed stricter than the declaration, so
     * nothing leaked — and the registry still said something false, which is the whole subject of this file.
     *
     * It survived because the suite drove `organization`, `member`, `filtered` and `self-or-admin`. A scope
     * with no driver is a claim nobody checks, which is the same lesson `response-drivers-world` records
     * about schemas.
     */
    const all = ROUTES as readonly RouteSpec[];
    const anonymous = async (spec: RouteSpec) => {
      const path = spec.path.replace(/:(\w+)/g, (_, name: string) => `${name}-does-not-exist`);
      return (await SELF.fetch(`https://node${path}`, { method: spec.method })).status;
    };

    const refusedPublic: string[] = [];
    for (const spec of all.filter((one) => one.authority?.scope === "public")) {
      const status = await anonymous(spec);
      if (status === 401) refusedPublic.push(`${spec.method} ${spec.path} → 401`);
    }
    expect(
      refusedPublic,
      "these routes declare they need no sign-in and the Node refused an anonymous caller:",
    ).toEqual([]);

    const admittedUnauthenticated: string[] = [];
    for (const spec of all.filter((one) => one.authority?.scope === "member")) {
      const status = await anonymous(spec);
      // 401 is the answer. Anything else that is not a success means the route stopped short for its own
      // reasons — a missing fixture — which does not disprove the declaration.
      if (status >= 200 && status < 300) admittedUnauthenticated.push(`${spec.method} ${spec.path} → ${status}`);
    }
    expect(
      admittedUnauthenticated,
      "these routes declare that a signed-in member reaches them, and the Node answered a stranger. Either "
      + "the handler is missing its principal check, or the route is public and should say so:",
    ).toEqual([]);

    // Both controls, so neither list is empty for want of a subject.
    expect(all.filter((one) => one.authority?.scope === "public").length, "no public routes declared")
      .toBeGreaterThan(1);
    expect(all.filter((one) => one.authority?.scope === "member").length, "no member routes declared")
      .toBeGreaterThan(3);
  });

  it("refuses a stranger on every scoped route, whatever the scope", async () => {
    /*
     * The direction that was missing, and it was missing for four scopes at once.
     *
     * The suite drove `member` anonymously and stopped there, so `filtered`, `self-or-admin`, `recovery` and
     * `export` had no anonymous driver at all. A verified mutation: making `GET /api/approvals` fall back to a
     * synthetic principal when `principalFor` returns null — a stranger reading the approval queue — passed
     * all 1,507 tests.
     *
     * `authority.ts` asserts as fact that *"every scoped route requires a principal, and every unauthenticated
     * route is unscoped"*. That sentence is the justification for keeping authentication and authority in one
     * field, and this is what makes it an assertion rather than a claim.
     */
    const scoped = (ROUTES as readonly RouteSpec[]).filter((spec) =>
      spec.authority !== undefined && spec.authority.scope !== "public"
      // `recovery` is deliberately reachable by a stranger when this Node cannot authenticate anybody. On the
      // healthy Node these fixtures build it must refuse like the rest, which is what makes it conditional
      // rather than public — and `test/operator-routes.test.ts` drives the open case.
    );

    /*
     * **Real ids, and `401` exactly.** The first version substituted `${name}-does-not-exist` and accepted any
     * non-2xx, and both halves were wrong in the same direction.
     *
     * `GET /api/mailboxes/:mailboxId/cases` and `GET /api/people/:userId/mailboxes` are matched by regexes
     * built from `idPattern`, so a placeholder never matches, the router 404s before the handler is entered,
     * and the assertion could not fail whatever the handler did with the principal. A verified mutation —
     * dropping the `principalFor` refusal from the case queue, so a stranger reads any mailbox's queue —
     * passed all 1,510 tests.
     *
     * This file warns about exactly that hazard two hundred lines above, where the administrator loop
     * harvests real ids for the same reason. Walking into it here is why the rule is now `401` and anything
     * else is reported by name: a 404 that means "no such route" and a 404 that means "you may not" are
     * indistinguishable from outside, so only the status that unambiguously means *authenticate* counts.
     */
    const anonymousIds: Record<string, string> = { mailboxId: MAILBOX, userId: MEMBER };
    const wrong: string[] = [];
    for (const spec of scoped) {
      const path = spec.path.replace(
        /:(\w+)/g,
        (_, name: string) => anonymousIds[name] ?? `${name}-does-not-exist`,
      );
      const body = BODIES[`${spec.method} ${spec.path}`];
      const response = await SELF.fetch(`https://node${path}`, {
        method: spec.method,
        ...(body === undefined ? {} : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      if (response.status !== 401) wrong.push(`${spec.method} ${spec.path} → ${response.status}`);
    }

    expect(
      wrong,
      "these routes declare an authority scope and did not answer 401 to a caller who presented nothing. A "
      + "scoped route requires a principal — that is the sentence authority.ts rests its one-field design on "
      + "— and anything other than 401 means the request did not reach the check:",
    ).toEqual([]);

    // The control: every scope in the union must be represented, or this passes over the one that is wrong.
    expect(new Set(scoped.map((spec) => spec.authority!.scope)).size, "not every scope was driven")
      .toBeGreaterThanOrEqual(5);
  });

  it("refuses a member somebody else's access map, which is the restrictive half of self-or-admin", async () => {
    /*
     * The half no test drove, and the reason this suite had to grow.
     *
     * `GET /api/access` was `organization` before this work and covered by the administrator loop above. It is
     * `self-or-admin` now — correct, because its handler says *"knowing what you hold is not privileged"* —
     * and moving it out of that loop left only the permissive branch exercised. A verified mutation:
     * `if (false && subjectId !== who.userId && !(await isAdmin(…)))`, which lets any signed-in member read
     * anybody's relation set, **passed all 1,507 tests**.
     *
     * That is the organization access map, and §5C's own example of what a listing must not hand out. It is
     * also inside `identity.read`, which is offered to machines — so the bypass reached agents too.
     */
    const own = await drive(
      { method: "GET", path: "/api/access", summary: "" } as RouteSpec, memberCookie, {},
    );
    expect(own.status, "a member could not read their own relations, which needs no administrator").toBe(200);

    const somebodyElse = await SELF.fetch(`https://node/api/access?subject=${ADMIN}`, {
      headers: { cookie: `${ACCESS_COOKIE}=${memberCookie}` },
    });
    expect(
      somebodyElse.status,
      "an ordinary member read somebody else's relation set — the organization access map",
    ).toBe(404);
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
