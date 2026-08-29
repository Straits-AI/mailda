import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { ACCESS_COOKIE, issueSession } from "../src/auth/session.ts";
import { authenticationProbe, runDoctor } from "../src/doctor.ts";

/**
 * Five organization-wide routes that asked for a session and needed an administrator.
 *
 * ## What "authenticated" was being read as
 *
 * Each of these handlers called `principalFor` and stopped. That is a real check — it refuses the internet —
 * and it is not an authorization decision: every colleague on a shared Node holds a session, and a shared Node
 * is the entire premise of the product. So the door these routes were behind was *"works here"*.
 *
 * | route | what an ordinary member could do |
 * |:--|:--|
 * | `POST /api/maintenance/reconcile?collect=1` | trigger the **only call in the product that destroys content bytes** |
 * | `POST /api/maintenance/reseal` | re-wrap every credential in the organization |
 * | `POST /api/auth/rotate-signing-key` | walk the verification window until everyone's session dies |
 * | `GET /api/audit` | read every actor, subject, grant and matter across the organization |
 * | `GET /api/logs` | read the error detail and request ids of everybody else's work |
 *
 * Two of those had a comment nearby describing the authority they were supposed to require. `rotate-signing-key`
 * called itself owner-authenticated; the audit route's own file says the trail is wider than any mailbox grant
 * and should not be implied by an ordinary read token. **A statement in a comment is not a check**, and this
 * repository has now met that sentence often enough for it to be the first thing to look for.
 *
 * ## Why every case has a positive control
 *
 * A refusal is easy to produce by accident — a broken route refuses everybody. Each case here proves the
 * administrator gets through as well, so a 403 means the check and not a mistake.
 */

const testEnv = env as unknown as Env;
const ORIGIN = "https://node.example";
const ORG = "org_operator";
const ADMIN = "usr_PERATRADMN0000000000000000";
const MEMBER = "usr_PERATRMEMBER00000000000000";
const AGENT = "agt_PERATRAGENT000000000000000";

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId, new Date(ctx.now()).toISOString())
    .run();
}

async function cookieFor(userId: string): Promise<string> {
  const session = await issueSession(testEnv, createSystemCtx(), { orgId: ORG, userId });
  return `${ACCESS_COOKIE}=${session.accessToken}`;
}

beforeEach(async () => {
  for (const table of ["relationship_tuples", "users", "node_claim"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table} WHERE 1=1`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind(ctx.id("clm"), "x", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(ADMIN, ORG, "admin@operator.example", at),
    testEnv.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(MEMBER, ORG, "member@operator.example", at),
  ]);
  await tuple(ADMIN, "org.admin", "organization", ORG);
});

/** Every route that now needs `org.admin`, with the request that reaches it. */
const OPERATOR_ROUTES = [
  { method: "POST", path: "/api/maintenance/reseal", why: "re-wraps every credential in the organization" },
  {
    method: "POST",
    path: "/api/maintenance/reconcile",
    why: "reads the evidence inventory, and with collect=1 destroys content bytes",
  },
  {
    method: "POST",
    path: "/api/maintenance/reconcile?collect=1",
    why: "the only call in the product that destroys content bytes",
  },
  {
    method: "POST",
    path: "/api/auth/rotate-signing-key",
    why: "walks the verification window until sessions signed by retired keys stop verifying",
  },
  { method: "GET", path: "/api/audit", why: "every actor, subject, grant and matter in the organization" },
  { method: "POST", path: "/api/audit/verify", why: "where the chain broke, about a trail they may not read" },
  { method: "GET", path: "/api/logs", why: "error detail and request ids from everybody else's work" },
] as const;

describe("organization-wide routes need an administrator, not a session", () => {
  for (const one of OPERATOR_ROUTES) {
    it(`refuses an ordinary member on ${one.method} ${one.path}`, async () => {
      const response = await SELF.fetch(`${ORIGIN}${one.path}`, {
        method: one.method,
        headers: { cookie: await cookieFor(MEMBER) },
      });
      expect(
        response.status,
        `a colleague with an ordinary session could ${one.why}`,
      ).toBe(403);
      const body = await response.json<{ error: string }>();
      expect(body.error, "the refusal does not name the authority that is missing")
        .toBe("E_NOT_AN_ADMINISTRATOR");
    });

    it(`admits an administrator on ${one.method} ${one.path}`, async () => {
      /*
       * The positive control, and it is not ceremony: a route broken in any way refuses everybody, so the
       * assertion above passes for a Node that answers 403 to its own operator. Anything but 401/403 means the
       * check let the right person through — the body's shape is `contract-responses.test.ts`'s business.
       */
      const response = await SELF.fetch(`${ORIGIN}${one.path}`, {
        method: one.method,
        headers: { cookie: await cookieFor(ADMIN) },
      });
      expect(
        [401, 403].includes(response.status),
        `an administrator was refused ${one.method} ${one.path} with ${response.status}`,
      ).toBe(false);
    });
  }

  it("refuses an unauthenticated caller before it asks about authority", async () => {
    // The order matters for §5C: an anonymous caller learns "sign in", not "you are not an administrator",
    // which would confirm the route exists to somebody who has shown nothing.
    const response = await SELF.fetch(`${ORIGIN}/api/audit`);
    expect(response.status).toBe(401);
  });
});

describe("administrator means one thing, whichever module asks", () => {
  /*
   * `adminsOf` has always expanded a team-held `org.admin` to that team's members — approval eligibility asks
   * *who are the administrators*, and a grant to a team obviously meant its people. `isAdmin` asked only for a
   * direct tuple. So the same person was an administrator for dual-control eligibility and not one for any
   * administrator route, with `grant()` conferring the relation on a team either way.
   *
   * That is not a missing feature; it is one word meaning two things depending on the caller, across agent
   * sponsorship, policy and access administration, legal holds, Butler administration and the People screen.
   */
  it("admits somebody whose org.admin comes through a team", async () => {
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const team = "tm_PERATRTEAM000000000000000";
    await testEnv.CATALOG.prepare(
      "INSERT INTO team_members (id, org_id, team_id, user_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("tmm"), ORG, team, MEMBER, at).run();
    await tuple(team, "org.admin", "organization", ORG);

    const response = await SELF.fetch(`${ORIGIN}/api/audit`, { headers: { cookie: await cookieFor(MEMBER) } });
    expect(
      response.status,
      "a team-held org.admin counted for approval eligibility and not for an administrator route",
    ).toBe(200);
  });

  it("still refuses somebody in a team that holds nothing", async () => {
    // The control. Resolving team membership must not make every team member an administrator — only the
    // members of a team the relation was actually granted to.
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      "INSERT INTO team_members (id, org_id, team_id, user_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("tmm"), ORG, "tm_PERATRPLAIN00000000000000", MEMBER, new Date(ctx.now()).toISOString())
      .run();

    const response = await SELF.fetch(`${ORIGIN}/api/audit`, { headers: { cookie: await cookieFor(MEMBER) } });
    expect(response.status).toBe(403);
  });

  it("does not let a team widen a machine", async () => {
    /*
     * The first version of this said the team arm could not reach a machine because `team_members.user_id`
     * holds users "by construction". That is a convention and not a constraint — nothing in the schema stops
     * a row naming a machine — and writing the test proved the claim false immediately. A delegated principal
     * reaching `org.admin` through a team row would step straight around the sponsor bound.
     *
     * The sponsor **is** an administrator here, so the delegation term is satisfied and the only question
     * left is whether the team arm applies to the agent. It must not.
     */
    const ctx = createSystemCtx();
    const at = new Date(ctx.now()).toISOString();
    const team = "tm_PERATRMACHINE000000000000";
    await testEnv.CATALOG.batch([
      testEnv.CATALOG.prepare(
        `INSERT INTO agents (id, org_id, name, sponsor_user_id, created_by, token_hash, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(AGENT, ORG, "teamed", ADMIN, ADMIN, "x", at, "2099-01-01T00:00:00.000Z"),
      testEnv.CATALOG.prepare(
        "INSERT INTO team_members (id, org_id, team_id, user_id, created_at) VALUES (?,?,?,?,?)",
      ).bind(ctx.id("tmm"), ORG, team, AGENT, at),
    ]);
    await tuple(team, "org.admin", "organization", ORG);

    const { isAdmin } = await import("../src/access.ts");
    expect(
      await isAdmin(testEnv, ORG, AGENT),
      "an agent became an administrator through a team, escaping the sponsor bound",
    ).toBe(false);

    /*
     * The control, and it is the one that makes the assertion above mean something: the same agent holding
     * the relation **directly**, with an administrator sponsor, is an administrator. So the `false` above is
     * the team arm being withheld from machines, not the agent path being broken.
     */
    await tuple(AGENT, "org.admin", "organization", ORG);
    expect(await isAdmin(testEnv, ORG, AGENT)).toBe(true);
  });
});

describe("doctor decides before it works, and shows an ordinary member less", () => {
  /*
   * Two properties, and the same root: `discloses: "data"` classified every finding that names holds, matters,
   * mailboxes, send manifests, agent names, Butler triggers and domain pauses — and that classification only
   * ever decided what a **locked-out** operator saw. Anybody signed in got the whole organization's
   * condition, and `health.read` handed an agent the same.
   */
  it("refuses an anonymous caller on a claimed Node", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/doctor`);
    expect(response.status).toBe(401);
  });

  it("has an authentication probe far narrower than the diagnostic", async () => {
    /*
     * The 401 above used to be decided by running the **entire** diagnostic and discarding it, so every
     * anonymous request to a healthy Node paid for an organization-wide sweep of D1, R2 and the vault. CI
     * proves that sweep is bounded; bounded is not free and is not authorized.
     *
     * **The ordering is not observable from the response**, and this says so rather than implying a test
     * holds it: `runDoctor` catches per check, so a handler that swept first and refused afterwards answers
     * 401 too. Four candidate discriminators were tried and none distinguished the two — dropping
     * `mailboxes`, `legal_holds`, `matters`, `send_manifests`. What *is* checkable is the substance: the
     * probe asks the two questions the 401 turns on and nothing else, so using it cannot cost what the sweep
     * costs.
     */
    const probe = await authenticationProbe(testEnv, createSystemCtx());
    const full = await runDoctor(testEnv, createSystemCtx());
    expect(probe.map((one) => one.check).sort(), "the probe asks something other than the two key checks")
      .toEqual(["credential_key", "signing_key"]);
    expect(
      full.findings.length,
      "the full diagnostic is no larger than the probe, so there was nothing to avoid",
    ).toBeGreaterThan(probe.length * 4);
  });

  it("gives an ordinary member the reduced report", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/doctor`, {
      headers: { cookie: await cookieFor(MEMBER) },
    });
    expect(response.status).toBe(200);
    const report = await response.json<{ findings: { check: string; discloses: string }[] }>();
    expect(
      report.findings.every((one) => one.discloses === "infrastructure"),
      "a colleague was shown findings that name this organization's holds, matters and mailboxes",
    ).toBe(true);
    expect(report.findings.map((one) => one.check)).toContain("report_reduced");
  });

  it("gives an administrator the whole thing", async () => {
    /*
     * The control, and it is what stops the fix above being "show nobody anything". An operator needs the
     * organization-wide view — it is the screen they open when something has gone wrong.
     */
    const response = await SELF.fetch(`${ORIGIN}/api/doctor`, {
      headers: { cookie: await cookieFor(ADMIN) },
    });
    expect(response.status).toBe(200);
    const report = await response.json<{ findings: { check: string; discloses: string }[] }>();
    expect(
      report.findings.some((one) => one.discloses === "data"),
      "an administrator was shown the reduced report",
    ).toBe(true);
    expect(report.findings.map((one) => one.check)).not.toContain("report_reduced");
  });
});
