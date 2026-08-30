import { utf8 } from "@mailda/evidence";
import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";
import { ROUTES, type RouteSpec } from "@mailda/contract/routes";
import { notificationListResponse } from "@mailda/contract/schemas";

import { ACCESS_COOKIE, login } from "../src/auth/session.ts";
import { GRANTABLE } from "../src/access.ts";
import { hashPassword } from "../src/auth/password.ts";
import { putEvidence } from "../src/evidence-store.ts";

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
     * synthetic principal when `principalFor` returns null, so a stranger reads the approval queue.
     *
     * The receipt is the **corrected** run. The first version of that mutation named an identifier that is out
     * of scope at that point, so it threw and answered `500` — it survived as a crash rather than as a bypass,
     * and quoting it here would be a measurement that never established the property it was cited for. The
     * version that really answers `200` fails this test.
     *
     * `authority.ts` asserts as fact that *"every scoped route requires a principal, and every unauthenticated
     * route is unscoped"*. That sentence is the justification for keeping authentication and authority in one
     * field, and this is what makes it an assertion rather than a claim.
     */
    const scoped = (ROUTES as readonly RouteSpec[]).filter((spec) =>
      spec.authority !== undefined && spec.authority.scope !== "public"
      // `recovery` is deliberately reachable by a stranger when this Node cannot authenticate anybody. On the
      // healthy Node these fixtures build it must refuse like the rest, which is what makes it conditional
      // rather than public. `test/doctor.test.ts` drives the open case; `test/operator-routes.test.ts` drives
      // the closed one, which is the 401 this loop asserts.
      //
      // The header forty lines up carried this same wrong pointer, was corrected, and this copy was not — in
      // the same commit, in the file whose subject is stale claims. Both files were read before this edit.
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

describe("a mailbox-wide notice reaches the relation it names, and no other", () => {
  /*
   * `GET /api/notifications` is the third route this work re-declared, and the one whose declaration carries
   * the most weight: `{scope:"filtered", by:"relation", relations:["mailbox.content.read"]}` is the **entire**
   * basis of `notice.read`'s mint requirement, because `requiredRelations` reads it and `mintAgent` refuses a
   * grantless `notice.read` on its strength.
   *
   * Nothing compared that declaration to the handler. Dropping `AND t.relation = 'mailbox.content.read'` from
   * `notificationsFor` — so any tuple on a mailbox sees its notices — left **1,511 tests green**.
   *
   * The reason, stated correctly: `agents.test.ts` does drive the relation branch, through the sponsor term,
   * and it **grants the relation**. Nothing anywhere drove a caller holding a *lesser* one. An earlier draft
   * of this paragraph said every existing caller exercised the directly-addressed branch, which is checkable
   * in one grep and wrong — a false coverage claim, in a docstring about coverage, in the file whose subject
   * is stale coverage claims.
   *
   * What leaks is what the query's own comment names four lines above the gate: *"an agent reading these
   * unintersected would learn which mailboxes have matters open and what is due on them — the shape of the
   * work, without the mail."* A `mailbox.metadata.read` holder is exactly who §7's split exists to keep away
   * from that.
   *
   * So the pair below is sufficient **and** necessary, which is the shape `agent-capabilities.test.ts` cannot
   * supply on its own: it grants each capability its declared relations and proves them enough, never that a
   * lesser relation is not.
   */
  async function seedNotice(): Promise<string> {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const noticeId = ctx.id("ntf");
    await testEnv.CATALOG.prepare(
      `INSERT INTO notifications (id, org_id, kind, subject_id, user_id, mailbox_id, created_at, delivered_at)
       VALUES (?,?,?,?,NULL,?,?,?)`,
    ).bind(noticeId, ORG, "supervised_read", MAILBOX, MAILBOX, at, at).run();
    return noticeId;
  }

  async function relate(relation: string) {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,'mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, MEMBER, relation, MAILBOX, new Date(ctx.now()).toISOString()).run();
  }

  async function noticeIds(): Promise<string[]> {
    // `method` spelled out although GET is the default: `response-drivers-world` matches a driver by finding
    // the path and the method in one call, and an implicit GET has no method for it to find.
    const response = await SELF.fetch("https://node/api/notifications", {
      method: "GET",
      headers: { cookie: `${ACCESS_COOKIE}=${memberCookie}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // Parsed against the contract, so this doubles as the HTTP driver the response world was missing.
    notificationListResponse.parse(body);
    return (body as { notifications: { id: string }[] }).notifications.map((one) => one.id);
  }

  it("reaches a holder of the relation the route declares", async () => {
    const noticeId = await seedNotice();
    await relate("mailbox.content.read");
    expect(
      await noticeIds(),
      "the relation the declaration names does not actually reach the notice",
    ).toContain(noticeId);
  });

  it("does not reach a holder of a lesser relation on the same mailbox", async () => {
    /*
     * The necessary half. `mailbox.metadata.read` is a real relation on the same mailbox — so this is not
     * "somebody with nothing sees nothing", which any broken query satisfies. It is the specific relation the
     * §7 split exists to keep away from what a supervised-read notice discloses.
     */
    const noticeId = await seedNotice();
    await relate("mailbox.metadata.read");
    expect(
      await noticeIds(),
      "a metadata-only holder read a mailbox-wide notice, which names the mailbox and its matter",
    ).not.toContain(noticeId);
  });
});

describe("a mailbox route requires the relation it declares, not merely some relation", () => {
  /*
   * The **necessary** half of the `mailbox` scope, over the whole class rather than a sample of it.
   *
   * `test/agent-capabilities.test.ts` grants each capability exactly the relations it declares and proves them
   * *sufficient*. That cannot see a handler whose relation term is wrong, because a caller holding the
   * declared relations passes either way. And every negative test on these paths grants the caller **nothing**
   * — "shows a member with no relation on the mailbox nothing at all" — which passes with the relation term
   * deleted, since a caller with no tuples fails `subject_id IN (…)` regardless.
   *
   * Five gates were live holes under that shape — six mutations across them, since `readableMailboxes`
   * accounts for two — each leaving the whole suite green when its relation term was removed or widened:
   *
   * | gate | what it opened |
   * |:--|:--|
   * | `cases.ts` `mailboxQueues` | `GET /api/mailboxes` — the mailbox, its addresses, its queue counts |
   * | `authz-read.ts` `readableMailboxes` | listing mailboxes it may not read; and, the other way, emptying it |
   * | `index.ts` outbox query | `GET /api/sends` — subjects, recipients, the receiving server's words |
   * | `authz-read.ts` `mailboxesWithRelation` | any relation answered for any relation asked |
   * | `authz-read.ts` `mayRead` | **a `mailbox.metadata.read` holder reading message bodies** |
   *
   * The last is the one this scope exists for: `access.ts` sells that relation as *"See that mail exists —
   * senders, subjects, when. **Not the message itself.**"*
   *
   * ## Why the first version of this block missed two of them
   *
   * It was a sample. It tried **one** arbitrary lesser relation per route, so `GET /api/messages/:receiptId/raw`
   * was only ever probed with `send.propose` and never with `mailbox.metadata.read`, its §7 sibling. It took
   * `anyOf.slice(0, 1)`, so only the first alternative was ever proven sufficient — dropping
   * `mailbox.content.read` from `readableMailboxes` survived, which would have emptied the catalogue every
   * `mail.read` agent needs to discover mailbox ids. And its disclosure detector grepped for **ids**, so
   * `GET /api/messages/:receiptId/body` — whose response carries no identifier at all — could never register a
   * disclosure however it was gated.
   *
   * So: every grantable relation outside the declaration is tried, every `anyOf` alternative must be
   * sufficient on its own, every proper subset of an `allOf` must be insufficient, and the fixture's subject
   * and body carry markers the detector looks for alongside the ids.
   */
  const RECEIPT = "rcpt_PARTYRCPT00000000000000000";
  const SEND = "snd_PARTYSEND00000000000000000";
  const ADDRESS = "enquiries@parity.example";
  /*
   * Markers rather than ids, because the routes that carry the most are the ones that name nothing.
   * `messageBodyResponse` is `{state, html, text, blockedRemote, truncated, problem}` — no identifier — so an
   * id-only detector was structurally blind to the body route, which is gated by the one term that survived.
   */
  const SUBJECT_MARKER = "PARITYSUBJECTMARKER";
  const BODY_MARKER = "PARITYBODYMARKER";

  /** Everything only somebody entitled to this mailbox should ever see come back. */
  const SECRETS = [MAILBOX, RECEIPT, SEND, ADDRESS, SUBJECT_MARKER, BODY_MARKER];

  /**
   * Every mailbox relation this Node can grant, **derived** from `access.ts` rather than listed.
   *
   * It was a hand-written four, described in exactly these words, and the filter yields **seven**:
   * `approval.decide`, `ediscovery.export` and `supervised.read` were all missing. The second is not decorative — a mutation letting `ediscovery.export`
   * satisfy the single-message `.eml` gate survived all 1,529 tests, and that is the relation #65 added so
   * that taking a copy off the Node is granted and audited separately from reading it. Two similarly-named
   * export relations is precisely the confusion a list of four could not see.
   *
   * Derived, so an eighth cannot be silently uncovered. The same landmine as the hand-copied id lists this
   * suite keeps finding, one table to the left.
   *
   * The filter is `object === "mailbox"` and not also `conferredBy === "admin_grant"`, so `supervised.read`
   * comes with it — a relation this Node never writes as a tuple and `POST /api/access` refuses. Harmless and
   * deliberate: an extra impostor makes a stronger test and no declaration names it. What the derivation
   * genuinely cannot reach is authority conferred by something that is **not** a tuple — a supervised grant
   * lives in `supervised_grants`, so `onlyRelations` cannot simulate one. That path is held by
   * `supervised-read.test.ts`, and this file does not claim it.
   */
  const MAILBOX_RELATIONS = Object.entries(GRANTABLE)
    .filter(([, meta]) => (meta as { object: string }).object === "mailbox")
    .map(([relation]) => relation);

  async function seedMailboxContents() {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const raw = utf8([
      "From: someone@parity.example",
      `To: ${ADDRESS}`,
      `Subject: ${SUBJECT_MARKER}`,
      "Message-ID: <parity-1@parity.example>",
      "Date: Mon, 3 Aug 2026 12:00:00 +0000",
      "",
      BODY_MARKER,
    ].join("\r\n"));
    await putEvidence(testEnv as never, `${ORG}/raw/${RECEIPT}`, raw);
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        "INSERT OR IGNORE INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
      testEnv.CATALOG.prepare(
        `INSERT OR IGNORE INTO ingress_receipts (id, org_id, provider_event_id, envelope_from, envelope_to,
           raw_bytes, blob_key, blob_sha256, accepted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(RECEIPT, ORG, `evt_${RECEIPT}`, "someone@parity.example", ADDRESS, raw.byteLength,
        `${ORG}/raw/${RECEIPT}`, "0".repeat(64), at),
      testEnv.CATALOG.prepare(
        `INSERT OR IGNORE INTO send_manifests
           (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
            fidelity, body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
            sealed_at, release_at, state, state_at)
         VALUES (?,?,?,?,?,?,?,?,'authored',?,?,?,?,?,?,'sent',?)`,
      ).bind(SEND, ORG, MAILBOX, MEMBER, ADDRESS, JSON.stringify(["out@example.test"]), SUBJECT_MARKER,
        `<${SEND}@parity.example>`, `${ORG}/typed/${SEND}`, "0".repeat(64), `${ORG}/norm/${SEND}`,
        "0".repeat(64), at, at, at),
    ]);
  }

  async function onlyRelations(relations: readonly string[]) {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ?")
      .bind(ORG, MEMBER).run();
    for (const relation of relations) {
      await testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,'mailbox',?,?)`,
      ).bind(ctx.id("rt"), ORG, MEMBER, relation, MAILBOX, new Date(ctx.now()).toISOString()).run();
    }
  }

  /** Whether a response actually handed over something about this mailbox. */
  async function discloses(spec: RouteSpec): Promise<boolean> {
    const path = spec.path
      .replace(":mailboxId", MAILBOX).replace(":receiptId", RECEIPT).replace(":sendId", SEND)
      .replace(":draftId", "dft_PARTYDRAFT0000000000000000");
    const body = BODIES[`${spec.method} ${spec.path}`];
    const response = await SELF.fetch(`https://node${path}`, {
      method: spec.method,
      headers: {
        cookie: `${ACCESS_COOKIE}=${memberCookie}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status < 200 || response.status >= 300) return false;
    const text = await response.text();
    return SECRETS.some((secret) => text.includes(secret));
  }

  /**
   * Every relation set that should be enough, and every one that should not.
   *
   * `allOf` is enough exactly as declared, and **each proper subset is not** — that is what makes
   * `message.export` a requirement on `/raw` rather than decoration. `anyOf` means each alternative is enough
   * **on its own**, which is the half `.slice(0, 1)` skipped and where a live hole was.
   */
  function sets(spec: RouteSpec): { enough: string[][]; lesser: string[][] } {
    const authority = spec.authority as { allOf?: string[]; anyOf?: string[] };
    const allOf = authority.allOf ?? [];
    const anyOf = authority.anyOf ?? [];
    const satisfying = new Set([...allOf, ...anyOf]);

    const enough = allOf.length > 0 ? [allOf] : anyOf.map((one) => [one]);
    const outside = MAILBOX_RELATIONS.filter((one) => !satisfying.has(one));
    const lesser: string[][] = outside.map((one) => [one]);

    /*
     * A proper subset of an `allOf` is a lesser holding, **and so is that subset plus something else** — which
     * is the shape the interesting mistake takes. A handler that accepts a similarly-named relation in place
     * of the one it declares is satisfied by a caller holding "all but one of the declared, plus the
     * impostor": `[mailbox.content.read, ediscovery.export]` against a route needing
     * `[mailbox.content.read, message.export]`. Neither a single outside relation nor a bare subset grants
     * that combination, so a mutation swapping the two export relations survived both.
     */
    if (allOf.length > 1) {
      for (const drop of allOf) {
        const subset = allOf.filter((one) => one !== drop);
        lesser.push(subset);
        for (const impostor of outside) lesser.push([...subset, impostor]);
      }
    }
    return { enough, lesser };
  }

  const mailboxRoutes = (ROUTES as readonly RouteSpec[]).filter((spec) => spec.authority?.scope === "mailbox");

  for (const spec of mailboxRoutes) {
    const key = `${spec.method} ${spec.path}`;
    const { enough, lesser } = sets(spec);
    if (enough.length === 0 || lesser.length === 0) continue;

    it(`withholds ${key} from every relation short of what it declares`, async () => {
      await seedMailboxContents();

      // The control first, and **every** sufficient set: an `anyOf` route must disclose under each
      // alternative, or one of them is a promise the handler does not keep.
      const disclosing: string[][] = [];
      for (const set of enough) {
        await onlyRelations(set);
        if (await discloses(spec)) disclosing.push(set);
      }

      for (const set of lesser) {
        await onlyRelations(set);
        expect(
          await discloses(spec),
          `${key} declares ${enough.map((one) => one.join("+")).join(" or ")} and handed this mailbox's data `
          + `to a holder of ${set.join("+")}. A caller with *no* relation is refused by the subject test `
          + "alone, so only a lesser relation can show the relation term is doing anything",
        ).toBe(false);
      }

      /*
       * Reported rather than asserted. A route the fixtures cannot drive to a disclosure proves nothing above,
       * and an absence checked against an absence is how six gates stayed untested. `UNDISCLOSING` is the
       * named, shrinking list of those — and `has no stale entry` below stops it growing a dead one.
       */
      if (disclosing.length !== enough.length) {
        expect(
          UNDISCLOSING,
          `${key} disclosed nothing under ${
            enough.filter((one) => !disclosing.includes(one)).map((set) => set.join("+")).join(" or ")
          }, so the refusals above are vacuous. Build the fixture it needs, or name it here:`,
        ).toContain(key);
      }
    });
  }

  it("has no stale entry, so the exemption list cannot outlive its reason", async () => {
    /*
     * The guard `MUST_SUCCEED` got one commit ago, and this list was written without it in the next — so
     * `GET /api/messages/:receiptId/raw` sat here after its fixture began reaching a disclosure. The
     * `toContain` above only runs when a route fails to disclose, so a dead entry is invisible from inside
     * the loop. It needs its own assertion, in the other direction.
     */
    await seedMailboxContents();
    const stale: string[] = [];
    for (const spec of mailboxRoutes) {
      const key = `${spec.method} ${spec.path}`;
      if (!UNDISCLOSING.includes(key)) continue;
      const { enough } = sets(spec);
      for (const set of enough) {
        await onlyRelations(set);
        if (await discloses(spec)) stale.push(`${key} — discloses under ${set.join("+")}`);
      }
    }
    expect(
      stale,
      "these routes are exempted from the disclosure control and their fixtures do reach one, so the "
      + "exemption is hiding a check that would now work. Remove the entry:",
    ).toEqual([]);
  });
});

/**
 * Mailbox routes whose fixtures do not reach a disclosure, so their refusals above prove nothing yet.
 *
 * Named rather than silently passing, and it can only shrink in both directions now: a route that stops
 * disclosing must be added, and one that starts must be removed, which `has no stale entry` enforces.
 */
const UNDISCLOSING: readonly string[] = [
  // Need a saved draft. `test/drafts.test.ts` builds them through the save path rather than by row.
  "GET /api/drafts",
  "PUT /api/drafts",
  "GET /api/drafts/:draftId",
  // Needs a case row on the mailbox; `test/queue-disclosure.test.ts` owns that fixture.
  "GET /api/mailboxes/:mailboxId/cases",
  /*
   * `sendCancelledResponse` is `{cancelled: true}` and strict, so it names nothing a detector could recognise
   * — no fixture can make this route register a disclosure. Its observable is the **effect**, asserted in its
   * own block below, which is the same treatment `POST /api/sends/dispatch` gets and for the same reason.
   */
  "POST /api/sends/:sendId/cancel",
  // Needs submitted bytes in R2 beside the manifest.
  "GET /api/sends/:sendId/submitted",
  /*
   * Acts whose answers name nothing, so no detector can see them. The two release routes and `PUT /api/drafts`
   * are asserted by **effect** in the block below; the two here are covered elsewhere by name:
   * `POST /api/sends` by `outbound.test.ts > reading a mailbox does not confer sending as it`, which is the
   * necessary-half assertion written by hand, and `retry` needs a failed send that `outbound.test.ts` builds.
   */
  "POST /api/sends",
  "POST /api/sends/:sendId/retry",
  "POST /api/sends/:sendId/release",
  "POST /api/sends/:sendId/release-hold",
  "DELETE /api/drafts/:draftId",
  /*
   * `dispatchResponse` is `{dispatched: […]}` and carries no manifest id, so the body cannot show whether the
   * sweep touched this mailbox. Its observable is the **effect**, asserted directly in the block below.
   */
  "POST /api/sends/dispatch",
];

describe("forcing the dispatch sweep reaches only mailboxes the caller may send from", () => {
  /*
   * `mailboxesWithRelation(who, "send.propose")` bounds this route, and the comment beside the call records
   * why: forcing the sweep releases held sends, *"so forcing the sweep ended other people's chance to stop
   * their own mail"*. Mutating that function to `AND (t.relation = ? OR 1)` — it answers any relation for any
   * relation asked — left **1,525 tests green**.
   *
   * The generic pair a few blocks up cannot cover it: `dispatchResponse` is `{dispatched: […]}` and names no
   * manifest, so there is nothing in the body to recognise. The observable is the effect on the manifest, so
   * that is what this asserts.
   */
  const HELD = "snd_PARTYSWEEP0000000000000000";

  async function heldSend() {
    const at = "2020-01-01T00:00:00.000Z";
    await testEnv.CATALOG.prepare(
      `INSERT OR IGNORE INTO send_manifests
         (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
          fidelity, body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
          sealed_at, release_at, state, state_at)
       VALUES (?,?,?,?,?,?,?,?,'authored',?,?,?,?,?,?,'held',?)`,
    ).bind(HELD, ORG, MAILBOX, MEMBER, "enquiries@parity.example", JSON.stringify(["out@example.test"]),
      "swept", `<${HELD}@parity.example>`, `${ORG}/typed/${HELD}`, "0".repeat(64), `${ORG}/norm/${HELD}`,
      "0".repeat(64), at, at, at).run();
  }

  async function stateOfHeld(): Promise<string> {
    const row = await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(HELD).first<{ state: string }>();
    return row?.state ?? "gone";
  }

  async function relate(relation: string) {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ?")
      .bind(ORG, MEMBER).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,'mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, MEMBER, relation, MAILBOX, new Date(ctx.now()).toISOString()).run();
  }

  async function sweep(): Promise<number> {
    const response = await SELF.fetch("https://node/api/sends/dispatch", {
      method: "POST",
      headers: { cookie: `${ACCESS_COOKIE}=${memberCookie}` },
    });
    return response.status;
  }

  it("leaves a held send alone for a caller holding only a lesser relation", async () => {
    await heldSend();
    await relate("mailbox.content.read");
    await sweep();
    expect(
      await stateOfHeld(),
      "a caller who may read the mailbox but not send from it forced somebody else's held mail out of hold",
    ).toBe("held");
  });

  it("reaches it for a holder of send.propose, so the refusal above is not a broken route", async () => {
    /*
     * The control, and the half that makes the assertion above mean something. Without it, a dispatch that
     * released nothing for anybody — a transport misconfiguration, a query that matches no row — would
     * satisfy the refusal perfectly.
     */
    await heldSend();
    await relate("send.propose");
    await sweep();
    expect(
      await stateOfHeld(),
      "send.propose did not reach the sweep either, so this route releases nothing for anybody",
    ).not.toBe("held");
  });
});

describe("cancelling somebody else's send needs the relation that authors one", () => {
  /*
   * `POST /api/sends/:sendId/cancel` is gated by `maySend` — `send.propose` on the mailbox — and its answer is
   * `{cancelled: true}`. `sendCancelledResponse` is `z.object({cancelled: z.literal(true)}).strict()`, so it
   * names nothing: no mailbox, no manifest, no subject. The disclosure detector a few blocks up greps the
   * response for the mailbox's ids and markers, and **no fixture can ever make that route register one**.
   *
   * So it sat permanently in `UNDISCLOSING`, and a mutation letting a `mailbox.content.read` holder cancel
   * anybody's send passed all 1,529 tests. Markers fix reads; an act needs its **effect** asserted, which is
   * what `POST /api/sends/dispatch` already does two blocks down.
   *
   * The handler's own comment beside the gate is worth reading here: *"Today the two relations are granted
   * together at claim, so this choice is unobservable; it becomes observable the moment Layer 3 grants them
   * apart."* Layer 3 is built.
   */
  const SENDABLE = "snd_PARTYCANCEL000000000000000";

  async function heldSend() {
    const at = "2020-01-01T00:00:00.000Z";
    await testEnv.CATALOG.prepare("DELETE FROM send_manifests WHERE id = ?").bind(SENDABLE).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests
         (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
          fidelity, body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
          sealed_at, release_at, state, state_at)
       VALUES (?,?,?,?,?,?,?,?,'authored',?,?,?,?,?,?,'held',?)`,
    ).bind(SENDABLE, ORG, MAILBOX, ADMIN, "enquiries@parity.example",
      JSON.stringify(["out@example.test"]), "cancel me", `<${SENDABLE}@parity.example>`,
      `${ORG}/typed/${SENDABLE}`, "0".repeat(64), `${ORG}/norm/${SENDABLE}`, "0".repeat(64),
      at, "2999-01-01T00:00:00.000Z", at).run();
  }

  async function stateOf(): Promise<string> {
    const row = await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(SENDABLE).first<{ state: string }>();
    return row?.state ?? "gone";
  }

  async function relate(relation: string) {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ?")
      .bind(ORG, MEMBER).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,'mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, MEMBER, relation, MAILBOX, new Date(ctx.now()).toISOString()).run();
  }

  async function cancel(): Promise<number> {
    const response = await SELF.fetch(`https://node/api/sends/${SENDABLE}/cancel`, {
      method: "POST",
      headers: { cookie: `${ACCESS_COOKIE}=${memberCookie}` },
    });
    return response.status;
  }

  it("refuses a holder of mailbox.content.read, who may read the outbox and not write to it", async () => {
    await heldSend();
    await relate("mailbox.content.read");
    await cancel();
    expect(
      await stateOf(),
      "somebody who may only read this mailbox stopped another person's mail from going",
    ).toBe("held");
  });

  it("permits a holder of send.propose, so the refusal above is not a broken route", async () => {
    /*
     * The control, and the half that matters: without it a cancel that failed for everybody — a wrong id, a
     * state the route will not act on — would satisfy the refusal perfectly.
     */
    await heldSend();
    await relate("send.propose");
    expect(await cancel(), "send.propose could not cancel either, so this route cancels nothing").toBe(200);
    expect(await stateOf(), "the send was not actually cancelled").not.toBe("held");
  });
});

describe("acts on a send need send.propose, and their answers name nothing", () => {
  /*
   * Three `send.propose` gates lived one call deeper than `index.ts`, so none of them was declared and the
   * necessary-half loop never saw them. Each left the whole suite green when widened to accept
   * `mailbox.content.read`:
   *
   * - `releaseButlerSend` — #50's gate, which exists precisely because *no person had seen the send*, cleared
   *   by somebody who may only read the mailbox.
   * - `releasePolicyHold` — releasing past #61, which its own docstring calls *"a governance bypass with a
   *   benign-looking name"*.
   * - `saveDraft` — composing a draft **as** a mailbox the author may not send from (ADR 36).
   *
   * `test/node/mailbox-gate-world.test.ts` now fails the build for an undeclared mailbox-gated route, so the
   * class cannot recur. These are the assertions the declaration then needs, and they are written against the
   * **effect** rather than the body for the reason `cancel` and `dispatch` are: both release routes answer
   * `{released}` with `200` or `409` and name no mailbox, so no disclosure detector can ever see them.
   */
  const HELD = "snd_PARTYACTS00000000000000000";

  async function heldSend(state: string, reason: string | null) {
    const at = "2020-01-01T00:00:00.000Z";
    await testEnv.CATALOG.prepare("DELETE FROM send_manifests WHERE id = ?").bind(HELD).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO send_manifests
         (id, org_id, mailbox_id, author_user_id, envelope_from, envelope_to, subject, rfc_message_id,
          fidelity, body_typed_key, body_typed_sha256, body_normalized_key, body_normalized_sha256,
          sealed_at, release_at, state, state_at, state_reason)
       VALUES (?,?,?,?,?,?,?,?,'authored',?,?,?,?,?,?,?,?,?)`,
    ).bind(HELD, ORG, MAILBOX, ADMIN, "enquiries@parity.example",
      JSON.stringify(["out@example.test"]), "act on me", `<${HELD}@parity.example>`,
      `${ORG}/typed/${HELD}`, "0".repeat(64), `${ORG}/norm/${HELD}`, "0".repeat(64),
      at, "2999-01-01T00:00:00.000Z", state, at, reason).run();
  }

  async function relate(relation: string) {
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare("DELETE FROM relationship_tuples WHERE org_id = ? AND subject_id = ?")
      .bind(ORG, MEMBER).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,'mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, MEMBER, relation, MAILBOX, new Date(ctx.now()).toISOString()).run();
  }

  async function act(path: string): Promise<boolean> {
    const response = await SELF.fetch(`https://node/api/sends/${HELD}/${path}`, {
      method: "POST",
      headers: { cookie: `${ACCESS_COOKIE}=${memberCookie}` },
    });
    // `{released}` with 200 or 409 — the status *is* the effect, and it is all these routes disclose.
    return response.status === 200 && ((await response.json()) as { released?: boolean }).released === true;
  }

  /*
   * `awaiting` + the exact `state_reason` the release is conditional on — `releasePolicyHold` updates
   * `WHERE state = 'awaiting' AND state_reason = 'policy_hold'`, so a `held` fixture releases for nobody and
   * both refusals below would have passed against a route doing nothing. The control caught precisely that.
   */
  for (const [path, state, reason] of [
    ["release", "awaiting", "butler_release_required"],
    ["release-hold", "awaiting", "policy_hold"],
  ] as const) {
    it(`refuses ${path} to a holder of mailbox.content.read`, async () => {
      await heldSend(state, reason);
      await relate("mailbox.content.read");
      expect(
        await act(path),
        `somebody who may only read this mailbox cleared its ${reason} gate — the gate exists because a `
        + "person had not decided yet, and a reader is not that person",
      ).toBe(false);
    });
  }

  /*
   * **A control per route, not one covering both.**
   *
   * The first version had only `release-hold`, and the `release` refusal beside it was passing against a
   * fixture that released for nobody: widening `releaseButlerSend` to accept `mailbox.content.read` survived.
   * That is the exact vacuity a control exists to catch, sitting in the same block as a control.
   *
   * The cause is that each conditional `UPDATE` names its own `state_reason` — `policy_hold` for the policy
   * gate, `butler_release_required` for #50's — and a fixture carrying the wrong one is indistinguishable
   * from a working gate. One control cannot speak for two predicates.
   */
  for (const [path, reason] of [
    ["release", "butler_release_required"],
    ["release-hold", "policy_hold"],
  ] as const) {
    it(`permits ${path} to a holder of send.propose, so its refusal is not a broken route`, async () => {
      await heldSend("awaiting", reason);
      await relate("send.propose");
      expect(
        await act(path),
        `send.propose could not ${path} either, so that route releases nothing for anybody and the refusal `
        + "above proves nothing",
      ).toBe(true);
    });
  }

  it("refuses saving a draft as a mailbox the author may not send from", async () => {
    /*
     * ADR 36: a draft is addressed **from** a mailbox, so holding one requires `send.propose` on it —
     * `assertMaySend`'s own words. Widening that to `mailbox.content.read` passed 1,531 tests.
     */
    await relate("mailbox.content.read");
    const response = await SELF.fetch("https://node/api/drafts", {
      method: "PUT",
      headers: { cookie: `${ACCESS_COOKIE}=${memberCookie}`, "content-type": "application/json" },
      body: JSON.stringify({ mailboxId: MAILBOX, to: ["out@example.test"], subject: "x", body: "y" }),
    });
    expect(response.status, "a reader composed a draft as a mailbox they cannot send from").not.toBe(200);

    // The control: the relation the route declares does save one.
    await relate("send.propose");
    const allowed = await SELF.fetch("https://node/api/drafts", {
      method: "PUT",
      headers: { cookie: `${ACCESS_COOKIE}=${memberCookie}`, "content-type": "application/json" },
      body: JSON.stringify({ mailboxId: MAILBOX, to: ["out@example.test"], subject: "x", body: "y" }),
    });
    expect(allowed.status, "send.propose could not save a draft either").toBe(200);
  });
});

describe("closing a matter is the opener's or an administrator's, and nobody else's", () => {
  /*
   * The gate outside every loop, and the class the `mailbox` work does not reach: an **ownership-or-admin**
   * gate inside a domain function, on an undeclared route.
   *
   * `if (false && matter.openedBy !== actorUserId && !(await isAdmin(…)))` — so any authenticated member
   * closes anybody's matter — left all 1,541 tests green.
   *
   * It matters more than most refusals because closing is one-way (`matters.ts` has `openMatter` and
   * `closeMatter` and no reopen — *"a resumed investigation needs a new matter"*) and because §7 hangs the
   * employee-notification obligation on the close. Closing somebody's investigation early tells the person
   * under investigation before the investigator intended, and nothing can put it back.
   *
   * **Deliberately not declared in the registry.** The gate is "the opener, or an administrator", and no
   * current scope says that: `filtered/ownership` describes a *result* being narrowed with no refusal to
   * test, and `self-or-admin` sits in the mirror check that requires an ordinary member to be answered —
   * which this route correctly refuses with a §5C 404. Forcing either would make a declaration that reads
   * true and asserts something false, which is the defect this whole branch is about. The pair below holds
   * the gate directly instead, and `mailbox-gate-world.test.ts` does not claim to cover this class.
   */
  const MATTER = "mat_PARTYMATTER000000000000000";

  async function matterOpenedBy(userId: string) {
    const at = new Date(createSystemCtx().now()).toISOString();
    await testEnv.CATALOG.prepare("DELETE FROM matters WHERE id = ?").bind(MATTER).run();
    await testEnv.CATALOG.prepare(
      `INSERT INTO matters (id, org_id, type, description, opened_by, opened_at)
       VALUES (?,?,'security_incident','parity fixture',?,?)`,
    ).bind(MATTER, ORG, userId, at).run();
  }

  async function closedAt(): Promise<string | null> {
    const row = await testEnv.CATALOG.prepare("SELECT closed_at FROM matters WHERE id = ?")
      .bind(MATTER).first<{ closed_at: string | null }>();
    return row?.closed_at ?? null;
  }

  async function close(cookie: string): Promise<number> {
    const response = await SELF.fetch(`https://node/api/matters/${MATTER}/close`, {
      method: "POST",
      headers: { cookie: `${ACCESS_COOKIE}=${cookie}` },
    });
    return response.status;
  }

  it("refuses a member who neither opened it nor administers the organization", async () => {
    await matterOpenedBy(ADMIN);
    await close(memberCookie);
    expect(
      await closedAt(),
      "somebody who did not open this matter closed it — one-way, and §7's notice to the person under "
      + "investigation becomes due on the close",
    ).toBeNull();
  });

  it("permits the person who opened it", async () => {
    // The control, and it must be the *opener* rather than the administrator: an admin-only control would
    // pass against a gate that had collapsed to `isAdmin`, which is half of what this refusal protects.
    await matterOpenedBy(MEMBER);
    expect(await close(memberCookie), "the opener could not close their own matter").toBe(200);
    expect(await closedAt(), "the close did not happen").not.toBeNull();
  });

  it("permits an administrator who did not open it", async () => {
    // The other half of the disjunction. Without it the refusal above is satisfied by a gate that had
    // collapsed to `openedBy` alone, which would strand every matter whose opener has left.
    await matterOpenedBy(MEMBER);
    expect(await close(adminCookie), "an administrator could not close somebody else's matter").toBe(200);
    expect(await closedAt()).not.toBeNull();
  });
});
