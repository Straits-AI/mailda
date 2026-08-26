import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { hashPassword } from "../src/auth/password.ts";
import { login } from "../src/auth/session.ts";

/**
 * The policy object **through the HTTP surface** (#60).
 *
 * `test/policy.test.ts` calls the functions. This file goes through the routes, because four claims in this
 * change are claims about what a *caller* is told, and a function-level test cannot check any of them:
 *
 *   - a policy can be authored at all. #60's own governing principle is that a rule nothing can express is a
 *     rule that silently never fires, and the whole policy plane is that failure one level up if no channel
 *     can write one. This asserts the plane is reachable rather than assuming it.
 *   - `org.admin` is the only principal who may write or publish one, and a member without it gets **404 on
 *     the read** rather than 403 — because a 403 on the rule set tells a caller it exists and is worth asking
 *     about, which is the oracle §5C exists to close.
 *   - a no-op publish answers **409 with the Node's four-part message**. That refusal is the whole of #49's
 *     versioning discipline, and it is a statement about a response body.
 *   - a published `deny` reaches the send path: `POST /api/sends` **succeeds** and reports `state:
 *     "withheld"`. Which is the end-to-end claim of this ticket, and the one nobody would notice breaking —
 *     the request returns 200 either way.
 */

const testEnv = env as unknown as Env;
const ORG = "org_policy_routes";
const MAILBOX = "mbx_policy_routes";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_polroutes_admin";
const ANA = "usr_polroutes_ana";
const PASSWORD = "fixture-password-not-a-real-secret";

async function sessionFor(userId: string): Promise<string> {
  const ctx = createSystemCtx();
  const outcome = await login(testEnv, ctx, ORG, `${userId}@acme.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

/**
 * A request as somebody, with the verb stated.
 *
 * **The method used to be hard-coded to `POST` here, and that is how #85's defect survived.** Every call in
 * this file went out as POST, so the suite could not express the verb the interface actually uses — and the
 * interface sends `PUT /api/policies/:id/draft` against a handler that answered only POST. Editing a policy
 * draft returned 404 `not_found` for as long as the route existed, on a governance surface, with fourteen
 * green tests over it.
 *
 * A helper that fixes the method cannot detect a method divergence. So it is a parameter, defaulted to POST
 * for the calls that genuinely are POST, and `put()` below exists so the draft calls say what they are.
 */
function as(token: string, body?: unknown, method: "POST" | "PUT" | "DELETE" = "POST"): RequestInit {
  return {
    method,
    headers: { cookie: `mailda_at=${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** Replacing a draft is a PUT, the same as `/api/butlers/:id/draft`, and the same as what the UI sends. */
function put(token: string, body?: unknown): RequestInit {
  return as(token, body, "PUT");
}

beforeEach(async () => {
  for (const table of ["policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "policy_stages", "relationship_tuples", "team_members", "teams",
                       "addresses", "mailboxes", "users", "node_claim",
                       "login_attempts", "sessions", "refresh_tokens", "audit_entries", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_polroutes", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
  ]);

  for (const userId of [ADMIN, ANA]) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
         password_updated_at) VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at)
      .run();
    for (const relation of ["mailbox.content.read", "send.propose"]) {
      await testEnv.CATALOG.prepare(
        `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(ctx.id("rt"), ORG, userId, relation, "mailbox", MAILBOX, at).run();
    }
  }

  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, ADMIN, "org.admin", "organization", ORG, at).run();

  // #61: publishing a `require_approval` policy is refused unless somebody holds `approval.decide` on a mailbox
  // it applies to. ADMIN is the approver here and ANA is the author, which is also the shape the seal needs —
  // an author is never eligible to approve their own send.
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,'approval.decide','mailbox',?,?)`,
  ).bind(ctx.id("rt"), ORG, ADMIN, MAILBOX, at).run();
});

describe("the policy plane is reachable, and only by an administrator", () => {
  it("creates, edits and publishes a policy for an administrator", async () => {
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "external mail needs approval",
      outcome: "require_approval",
      conditions: { recipientExternal: true },
    }));
    expect(created.status).toBe(200);
    const { policy } = await created.json() as { policy: { policyId: string; versionId: string } };

    const publishedResponse = await SELF.fetch(
      `https://node/api/policies/${policy.policyId}/publish`, as(token),
    );
    expect(publishedResponse.status).toBe(200);
    const published = await publishedResponse.json() as { published: { version: number } };
    expect(published.published.version).toBe(1);

    // An edit produces a draft; the published version is never touched.
    const edited = await SELF.fetch(`https://node/api/policies/${policy.policyId}/draft`, put(token, {
      outcome: "deny", conditions: { recipientExternal: true },
    }));
    expect(edited.status).toBe(200);
    const second = await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    expect((await second.json() as { published: { version: number } }).published.version).toBe(2);
  });

  it("refuses a condition name the five-column world does not have, naming the five that exist", async () => {
    /*
     * **This test asserted the opposite until #93, and the behaviour it asserted was the defect.**
     *
     * `dataClass` is a dimension §18 lists and #60 named **absent**, and the old assertion was that it was
     * silently *ignored*: `conditionsFrom` reads five named fields, so it reached no column and the policy
     * was created with whatever else the body carried. That was described as making the condition "inert",
     * which is true of `dataClass` in isolation and catastrophically false of the general case — because the
     * same code path turns `{"mailbox_id": …}` into `{}`, and `{}` is five NULLs, and five NULLs is a policy
     * matching **every send in the organization**. An `allow` narrowing a gate widened it, a `deny` stopped
     * all outbound mail, and the caller was told the policy was created because it was.
     *
     * So the field is refused now, at the boundary, before anything is written — and the refusal names the
     * five that exist, because a caller who has to read the schema to find their typo has been given a
     * puzzle rather than an error.
     */
    const token = await sessionFor(ADMIN);
    const refused = await SELF.fetch("https://node/api/policies", as(token, {
      name: "by data class",
      outcome: "deny",
      conditions: { dataClass: "confidential", mailboxId: MAILBOX },
    }));
    expect(refused.status).toBe(422);
    const body = await refused.json() as { error: string; message: string };
    expect(body.error).toBe("E_POLICY_CONDITION_UNKNOWN");
    expect(body.message).toContain("conditions.dataClass");
    // The five, from the schema rather than from a list in the message — so a sixth condition cannot leave
    // the error naming five.
    expect(body.message).toContain(
      "mailboxId, actorUserId, recipientExternal, isReply, orgDailyVolumeMin",
    );
    // And nothing was written: a refusal that had already created the policy would be the worse half of the
    // defect surviving the fix.
    expect(await testEnv.CATALOG.prepare("SELECT id FROM policies WHERE org_id = ?").bind(ORG).first())
      .toBeNull();
  });

  it("names the near miss, because case is the whole of the observed mistake", async () => {
    // `mailbox_id` for `mailboxId` is the spelling #93 was reported against — a client written in a
    // snake-case language. Normalised comparison rather than edit distance: "within two edits" is a
    // threshold with no measurement behind it, and case and punctuation are the entire near miss.
    const token = await sessionFor(ADMIN);
    const refused = await SELF.fetch("https://node/api/policies", as(token, {
      name: "snake", outcome: "deny", conditions: { mailbox_id: MAILBOX },
    }));
    expect(refused.status).toBe(422);
    expect((await refused.json() as { message: string }).message).toContain("did you mean mailboxId?");
  });

  it("refuses a misspelling of `conditions` itself, which is the same defect one level out", async () => {
    /*
     * The one that would have been left open by fixing only the condition bag: `conditons` reaches
     * `conditionsFrom(undefined)`, which returns `{}`, which is the unconditional rule again. A `deny` here
     * stops all outbound mail for the organization.
     *
     * This is why the policy request body is strict at the top level too, and why "requests tolerate unknown
     * keys for forward compatibility" does not apply to it: every field of a policy body changes which sends
     * the rule catches, so there is no field this Node can ignore harmlessly.
     */
    const token = await sessionFor(ADMIN);
    const refused = await SELF.fetch("https://node/api/policies", as(token, {
      name: "typo", outcome: "deny", conditons: { mailboxId: MAILBOX },
    }));
    expect(refused.status).toBe(422);
    const body = await refused.json() as { error: string; message: string };
    expect(body.error).toBe("E_POLICY_FIELD_UNKNOWN");
    expect(body.message).toContain("did you mean conditions?");
  });

  it("refuses an unknown field on a stage, because a dropped team is separation of duty removed", async () => {
    // `{"count":1,"teem":"tm_…"}` silently dropped is not a stage with less detail: it is §18's separation of
    // *duty* replaced by any single approver, in a rule whose author believed they had written the opposite.
    // The stage schema is a union — a bare number is sugar for an unconstrained stage — so this also covers
    // the boundary reading an unrecognised key out of the one union branch that matched everything else.
    const token = await sessionFor(ADMIN);
    const refused = await SELF.fetch("https://node/api/policies", as(token, {
      name: "duty", outcome: "require_approval", conditions: { mailboxId: MAILBOX },
      stages: [{ count: 1, teem: "tm_finance" }],
    }));
    expect(refused.status).toBe(422);
    const body = await refused.json() as { error: string; message: string };
    expect(body.error).toBe("E_POLICY_STAGE_FIELD_UNKNOWN");
    expect(body.message).toContain("stages.0.teem");
    expect(body.message).toContain("count, team, teamId");
  });

  it("coerces the conditions it does have, so a form's strings are not refused as unusable", async () => {
    // What `conditionsFrom` contributes, and what the last assertion guards, is **coercion**: JSON from a
    // form or a loosely-typed client carries `"10"`, and `validate` demands an integer. Without the named
    // read the volume floor is refused as `E_BAD_POLICY_VOLUME` — a well-formed rule rejected with a message
    // about its own value being unusable, which is the worst kind of refusal to debug.
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "by volume",
      outcome: "deny",
      conditions: { mailboxId: MAILBOX, orgDailyVolumeMin: "10" },
    }));
    expect(created.status).toBe(200);
    const { policy } = await created.json() as { policy: { versionId: string } };

    const row = await testEnv.CATALOG.prepare(
      `SELECT when_mailbox_id, when_recipient_external, when_org_daily_volume_min
         FROM policy_versions WHERE id = ?`,
    ).bind(policy.versionId).first<{
      when_mailbox_id: string | null; when_recipient_external: number | null;
      when_org_daily_volume_min: number | null;
    }>();
    // The conditions named were stored; the four columns nobody named stayed NULL, which is what makes a
    // rule narrow rather than universal.
    expect(row?.when_mailbox_id).toBe(MAILBOX);
    expect(row?.when_recipient_external).toBeNull();
    // And the floor is a number in the column, not the string the caller sent.
    expect(row?.when_org_daily_volume_min).toBe(10);
  });

  it("refuses a member who does not hold org.admin, and writes nothing", async () => {
    const response = await SELF.fetch("https://node/api/policies", as(await sessionFor(ANA), {
      name: "sneaky", outcome: "allow",
    }));
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe("E_NOT_AN_ADMINISTRATOR");
    const row = await testEnv.CATALOG.prepare("SELECT id FROM policies WHERE org_id = ?").bind(ORG).first();
    expect(row).toBeNull();
  });

  it("answers the read with 404 rather than 403 for a member without org.admin", async () => {
    // Not a cosmetic difference. The conditions name mailbox ids and user ids, so the live rule set is a map
    // of who sends where — and a 403 would confirm the map exists to somebody who may not read it. §5C keeps
    // an invisible thing and an absent one answering alike, which is the same rule the outbox's cancel and
    // submitted-bytes routes already follow.
    const response = await SELF.fetch("https://node/api/policies", {
      headers: { cookie: `mailda_at=${await sessionFor(ANA)}` },
    });
    expect(response.status).toBe(404);
    expect((await response.json() as { error: string }).error).toBe("not_found");
  });

  it("refuses an unauthenticated caller on both the write and the read", async () => {
    const written = await SELF.fetch("https://node/api/policies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "anon", outcome: "deny" }),
    });
    expect(written.status).toBe(401);
    expect((await SELF.fetch("https://node/api/policies")).status).toBe(401);
  });

  it("lists what is live, what is drafted and what has been superseded", async () => {
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "gate", outcome: "hold", conditions: { mailboxId: MAILBOX },
    }));
    const { policy } = await created.json() as { policy: { policyId: string } };
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/draft`, put(token, { outcome: "deny" }));
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/draft`, put(token, { outcome: "allow" }));

    const listed = await SELF.fetch("https://node/api/policies", {
      headers: { cookie: `mailda_at=${token}` },
    });
    const { policies } = await listed.json() as {
      policies: Array<{ state: string; version: number | null; outcome: string }>;
    };
    // The draft first, then versions newest first: the two questions a reader has are "what is live" and
    // "what is about to be", and both should be at the top rather than at the end of the history.
    expect(policies.map((row) => [row.state, row.version])).toEqual([
      ["draft", null], ["published", 2], ["superseded", 1],
    ]);
  });
});

describe("approval stages travel through the API (#61)", () => {
  it("stores the counts a caller sent, coerced, and refuses a publish nobody could satisfy", async () => {
    // `stagesFrom` is the only reader of this field, and without a test through the route it would be code
    // nothing exercises — the same reason `conditionsFrom` has one. Coercion matters for the same reason it
    // matters there: JSON from a form carries "2", and `normaliseStages` demands an integer.
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "two then one",
      outcome: "require_approval",
      conditions: { mailboxId: MAILBOX },
      stages: [2, "1"],
    }));
    expect(created.status).toBe(200);
    const { policy } = await created.json() as { policy: { policyId: string; versionId: string } };

    const rows = await testEnv.CATALOG.prepare(
      "SELECT ordinal, required_count FROM policy_stages WHERE policy_version_id = ? ORDER BY ordinal",
    ).bind(policy.versionId).all<{ ordinal: number; required_count: number }>();
    expect(rows.results).toEqual([{ ordinal: 1, required_count: 2 }, { ordinal: 2, required_count: 1 }]);

    // Three distinct approvers would be needed and only ADMIN holds the relation, so publication is refused
    // with the four-part message rather than storing a rule that parks every send it matches.
    const response = await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_APPROVAL_UNSATISFIABLE");
    expect(body.message).toContain("stage 1 needs 2 distinct approver");
    expect(body.message).toContain("fix");
  });
});

describe("a no-op publish is refused with the reason", () => {
  it("answers 409 and the four-part message naming the version it matches", async () => {
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "gate", outcome: "hold", conditions: { mailboxId: MAILBOX },
    }));
    const { policy } = await created.json() as { policy: { policyId: string } };
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    // An edit that writes exactly what is already live.
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/draft`, put(token, {
      outcome: "hold", conditions: { mailboxId: MAILBOX },
    }));

    const response = await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    // 409, not 403 and not `{ published: false }`: the request is well-formed and it is the state that does
    // not permit it.
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_POLICY_UNCHANGED");
    expect(body.message).toContain("identical to published version 1");
    expect(body.message).toContain("fix");
  });
});

describe("a published deny reaches the send path", () => {
  it("seals the send and reports withheld, rather than failing the request", async () => {
    const adminToken = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(adminToken, {
      name: "no mail from support", outcome: "deny", conditions: { mailboxId: MAILBOX },
    }));
    const { policy } = await created.json() as { policy: { policyId: string } };
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(adminToken));

    const response = await SELF.fetch("https://node/api/sends", as(await sessionFor(ANA), {
      mailboxId: MAILBOX, to: ["customer@example.net"], subject: "Hello", body: "Body.",
    }));

    // 200, and the state carries the refusal. A denied policy is not a malformed request: the manifest was
    // sealed, the record exists, and §12's account of "what did we send" stays complete. Answering 4xx would
    // lose the manifest and leave the author with nothing to point at.
    expect(response.status).toBe(200);
    const body = await response.json() as {
      id: string; state: string; stateReason: string; policyOutcome: string; policyVersionIds: string[];
    };
    expect(body.state).toBe("withheld");
    expect(body.stateReason).toBe("policy_denied");
    expect(body.policyOutcome).toBe("deny");
    expect(body.policyVersionIds).toHaveLength(1);
  });

  it("shows the reason on the outbox row, so the state can be explained as well as read", async () => {
    const adminToken = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(adminToken, {
      name: "approve external", outcome: "require_approval", conditions: { recipientExternal: true },
    }));
    const { policy } = await created.json() as { policy: { policyId: string } };
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(adminToken));

    const anaToken = await sessionFor(ANA);
    await SELF.fetch("https://node/api/sends", as(anaToken, {
      mailboxId: MAILBOX, to: ["customer@example.net"], subject: "Hello", body: "Body.",
    }));

    const listed = await SELF.fetch("https://node/api/sends", {
      headers: { cookie: `mailda_at=${anaToken}` },
    });
    const { sends } = await listed.json() as {
      sends: Array<{ state: string; state_reason: string | null; policy_outcome: string | null }>;
    };
    // Both columns travel with the row. Without `state_reason` the outbox would render `awaiting` and be
    // unable to say which gate — which is the blur #62's state-plus-reason convention exists to prevent.
    expect(sends[0]!.state).toBe("awaiting");
    expect(sends[0]!.state_reason).toBe("policy_approval_required");
    expect(sends[0]!.policy_outcome).toBe("require_approval");
  });
});

describe("teams and team-scoped stages travel through the API (#73)", () => {
  /**
   * The membership plane through the routes, for the reason the policy plane has this file at all: a
   * subsystem no channel can reach is the same failure as a condition backed by no data, one level up. Four
   * claims here are claims about what a *caller* is told and a function-level test cannot check any of them.
   */
  function del(token: string, body: unknown): RequestInit {
    return {
      method: "DELETE",
      headers: { cookie: `mailda_at=${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  it("creates a team, moves a person in and out, and lists it with its size", async () => {
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/teams", as(token, { name: "Legal" }));
    expect(created.status).toBe(200);
    const { team } = await created.json() as { team: { id: string; name: string } };
    expect(team.name).toBe("Legal");

    const added = await SELF.fetch(`https://node/api/teams/${team.id}/members`, as(token, { userId: ANA }));
    expect(added.status).toBe(200);
    expect((await added.json() as { membership: { members: number } }).membership.members).toBe(1);

    const listed = await SELF.fetch("https://node/api/teams", {
      headers: { cookie: `mailda_at=${token}` },
    });
    expect((await listed.json() as { teams: Array<{ name: string; memberCount: number }> }).teams)
      .toEqual([expect.objectContaining({ name: "Legal", memberCount: 1 })]);

    const renamed = await SELF.fetch(`https://node/api/teams/${team.id}/rename`, as(token, { name: "Counsel" }));
    expect((await renamed.json() as { team: { name: string } }).team.name).toBe("Counsel");

    const one = await SELF.fetch(`https://node/api/teams/${team.id}`, {
      headers: { cookie: `mailda_at=${token}` },
    });
    expect(await one.json() as unknown).toEqual({
      team: expect.objectContaining({ name: "Counsel" }), members: [ANA],
    });

    const removed = await SELF.fetch(`https://node/api/teams/${team.id}/members`, del(token, { userId: ANA }));
    expect((await removed.json() as { membership: { members: number } }).membership.members).toBe(0);
  });

  it("refuses a non-administrator on every writing act, and on the roster", async () => {
    const admin = await sessionFor(ADMIN);
    const { team } = await (await SELF.fetch("https://node/api/teams", as(admin, { name: "Legal" })))
      .json() as { team: { id: string } };
    await SELF.fetch(`https://node/api/teams/${team.id}/members`, as(admin, { userId: ADMIN }));

    const ana = await sessionFor(ANA);
    for (const [path, init] of [
      ["https://node/api/teams", as(ana, { name: "Shadow finance" })],
      [`https://node/api/teams/${team.id}/rename`, as(ana, { name: "Mine now" })],
      [`https://node/api/teams/${team.id}/members`, as(ana, { userId: ANA })],
      [`https://node/api/teams/${team.id}/members`, del(ana, { userId: ANA })],
      /*
       * The **roster**, which is a read and is refused all the same. A team's members are exactly the people
       * every tuple that team holds reaches, so *"who is in Legal"* answers *"who can decide an approval on
       * that mailbox"* — the map `GET /api/access?subject=…` already refuses a non-administrator, read from
       * the subject's end. Asserted here because it is the one place in this plane where a read and a write
       * take the same relation for two different reasons, and a route comment claiming it would not be a
       * check.
       */
      [`https://node/api/teams/${team.id}`, { headers: { cookie: `mailda_at=${ana}` } }],
    ] as const) {
      const response = await SELF.fetch(path, init);
      expect(response.status, path).toBe(403);
      expect((await response.json() as { error: string }).error).toBe("E_NOT_AN_ADMINISTRATOR");
    }
    // The **listing** is open to any member, and that is the deliberate exception: a team is a name and a
    // headcount there, which is what an author reading a shortfall naming team Legal has to resolve. The two
    // assertions belong in one test because the claim is the line between them, not either half alone.
    const listed = await SELF.fetch("https://node/api/teams", { headers: { cookie: `mailda_at=${ana}` } });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { teams: Array<{ memberCount: number }> }).teams)
      .toEqual([expect.objectContaining({ name: "Legal", memberCount: 1 })]);
  });

  it("accepts a team on a stage, keeps a bare number meaning the same thing, and stores both", async () => {
    // `stagesFrom` accepts `2` and `{count, team}` and normalises them to one stored form. Without a test
    // through the route the object arm would be code nothing exercises — the reason this file exists.
    const token = await sessionFor(ADMIN);
    const { team } = await (await SELF.fetch("https://node/api/teams", as(token, { name: "Legal" })))
      .json() as { team: { id: string } };
    await SELF.fetch(`https://node/api/teams/${team.id}/members`, as(token, { userId: ADMIN }));

    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "legal then anyone",
      outcome: "require_approval",
      conditions: { mailboxId: MAILBOX },
      stages: [{ count: "1", team: team.id }, 1],
    }));
    expect(created.status).toBe(200);
    const { policy } = await created.json() as { policy: { policyId: string; versionId: string } };

    const rows = await testEnv.CATALOG.prepare(
      "SELECT ordinal, required_count, team_id FROM policy_stages WHERE policy_version_id = ? ORDER BY ordinal",
    ).bind(policy.versionId).all<{ ordinal: number; required_count: number; team_id: string | null }>();
    expect(rows.results).toEqual([
      { ordinal: 1, required_count: 1, team_id: team.id },
      { ordinal: 2, required_count: 1, team_id: null },
    ]);

    // Two distinct people are needed and only ADMIN holds `approval.decide`, so publication refuses — and the
    // message names the team, which is the part somebody acts on.
    const response = await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_APPROVAL_UNSATISFIABLE");
    expect(body.message).toContain("stage 2 needs 1 distinct approver");
  });

  it("refuses a stage naming a team that does not exist, and says so as a not-found", async () => {
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "ghost reviews",
      outcome: "require_approval",
      conditions: { mailboxId: MAILBOX },
      stages: [{ count: 1, team: "tm_ghost" }],
    }));
    expect(created.status).toBe(200);
    const { policy } = await created.json() as { policy: { policyId: string } };

    // The check a `teams` row makes possible: authoring is allowed — #60 keeps the draft so it can be fixed
    // rather than retyped — and **publication** is where the team has to exist.
    const response = await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_NO_SUCH_TEAM");
    expect(body.message).toContain("tm_ghost");
    expect(body.message).toContain("fix");
  });
});

describe("the verb the interface sends is the verb this Node answers (#85)", () => {
  /**
   * The regression guard for a defect that shipped and stayed.
   *
   * `src/client/app/api.ts` sends `PUT /api/policies/:id/draft`; the handler answered only POST, so the
   * request fell through to the 404 at the foot of `fetch` and an administrator editing a policy was told
   * `not_found`. Confirmed against a running Node before it was fixed — PUT 404, POST 200 — rather than
   * inferred from the source.
   *
   * Asserted from **both sides** on purpose. The positive alone would pass again if somebody widened the
   * guard to accept either verb, which is the tempting fix and the wrong one: two verbs for one act is the
   * drift `packages/contract` exists to stop, and `/api/butlers/:id/draft` has been PUT all along.
   */
  it("answers PUT and refuses POST, which is the mismatch that shipped", async () => {
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "verb check", outcome: "hold", conditions: {}, stages: [],
    }));
    const { policy } = await created.json() as { policy: { policyId: string } };

    const put_ = await SELF.fetch(
      `https://node/api/policies/${policy.policyId}/draft`, put(token, { outcome: "deny" }),
    );
    expect(put_.status).toBe(200);

    const post = await SELF.fetch(
      `https://node/api/policies/${policy.policyId}/draft`, as(token, { outcome: "deny" }),
    );
    expect(post.status).toBe(404);
  });
});
