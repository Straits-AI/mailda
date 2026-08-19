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

function as(token: string, body?: unknown): RequestInit {
  return {
    method: "POST",
    headers: { cookie: `mailda_at=${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

beforeEach(async () => {
  for (const table of ["policy_versions", "policies", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "addresses", "mailboxes", "users", "node_claim",
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
    const edited = await SELF.fetch(`https://node/api/policies/${policy.policyId}/draft`, as(token, {
      outcome: "deny", conditions: { recipientExternal: true },
    }));
    expect(edited.status).toBe(200);
    const second = await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    expect((await second.json() as { published: { version: number } }).published.version).toBe(2);
  });

  it("ignores a condition name the five-column world does not have, and coerces the ones it has", async () => {
    // `dataClass` is a dimension §18 lists and #60 named **absent**. Accepting it would publish a rule an
    // administrator believed was narrow and which in fact matches every send — the exact failure mode #60's
    // "a condition backed by no data" principle is about, arriving through the API rather than the schema.
    //
    // **Which mechanism actually makes it inert, said plainly, because the answer is not `conditionsFrom`.**
    // The five-column INSERT is: `draftInsert` reads five named fields, so an extra key on the object reaches
    // no column whether the route named the five reads or spread the body. Replacing `conditionsFrom` with
    // `{ ...body.conditions }` leaves the two assertions below passing, which was measured by doing it — so
    // they document the behaviour and the schema guards it.
    //
    // What `conditionsFrom` *does* contribute, and what the last two assertions guard, is **coercion**: JSON
    // from a form or a loosely-typed client carries `"10"`, and `validate` demands an integer. Without the
    // named read the volume floor is refused as `E_BAD_POLICY_VOLUME` — a well-formed rule rejected with a
    // message about its own value being unusable, which is the worst kind of refusal to debug.
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "by data class",
      outcome: "deny",
      conditions: { dataClass: "confidential", mailboxId: MAILBOX, orgDailyVolumeMin: "10" },
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
    // The condition that exists was stored; the one that does not left no trace anywhere.
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
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/draft`, as(token, { outcome: "deny" }));
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/draft`, as(token, { outcome: "allow" }));

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

describe("a no-op publish is refused with the reason", () => {
  it("answers 409 and the four-part message naming the version it matches", async () => {
    const token = await sessionFor(ADMIN);
    const created = await SELF.fetch("https://node/api/policies", as(token, {
      name: "gate", outcome: "hold", conditions: { mailboxId: MAILBOX },
    }));
    const { policy } = await created.json() as { policy: { policyId: string } };
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/publish`, as(token));
    // An edit that writes exactly what is already live.
    await SELF.fetch(`https://node/api/policies/${policy.policyId}/draft`, as(token, {
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
