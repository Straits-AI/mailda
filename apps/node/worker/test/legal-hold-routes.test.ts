import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { hashPassword } from "../src/auth/password.ts";
import { login } from "../src/auth/session.ts";
import { placeHold } from "../src/holds.ts";
import { saveDraft } from "../src/drafts.ts";

/**
 * The legal hold **through the HTTP surface** (#64).
 *
 * `test/legal-hold.test.ts` calls the functions. This file goes through the routes, because three claims in
 * this change are claims about what a *caller* is told, and a function-level test cannot check any of them:
 *
 *   - `POST /api/holds` is the only way to place one, and `org.admin` is the only principal who may.
 *   - `DELETE /api/drafts/:id` answers **409 with the Node's four-part message**. `index.ts` records the
 *     decision not to catch it there — "somebody pressing discard is owed the reason" — and that is a
 *     statement about a response body, so it is asserted against one.
 *   - `POST /api/sends` **succeeds** from a held mailbox and reports `draftRetained: true`. That was
 *     documented in `application-shell.md` and `evidence-lifecycle.md` with nothing checking it, which is the
 *     claim-without-a-check shape AGENTS.md treats as a defect. A send that started failing under a hold, or
 *     a field that quietly stopped being sent, would have been invisible.
 */

const testEnv = env as unknown as Env;
const ORG = "org_hold_routes";
const HELD_MAILBOX = "mbx_routes_held";
const ADDRESS = "support@acme.example";
const ADMIN = "usr_routes_admin";
const ANA = "usr_routes_ana";
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
  for (const table of ["holds", "drafts", "send_manifests", "send_recipients", "send_counters",
                       "relationship_tuples", "addresses", "mailboxes", "users", "node_claim",
                       "login_attempts", "sessions", "refresh_tokens", "audit_entries"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare("INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)")
      .bind("clm_routes", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(HELD_MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, HELD_MAILBOX, at),
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
      ).bind(ctx.id("rt"), ORG, userId, relation, "mailbox", HELD_MAILBOX, at).run();
    }
  }

  // Only the administrator holds org.admin. Ana is a real, authenticated member without it.
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, ADMIN, "org.admin", "organization", ORG, at).run();
});

const composition = {
  mailboxId: HELD_MAILBOX,
  to: ["customer@example.net"],
  subject: "Demurrage on MSKU4471203",
  body: "Charges stop today.",
};

describe("POST /api/holds is the only way to place one", () => {
  it("places a hold for an administrator", async () => {
    const response = await SELF.fetch(
      "https://node/api/holds",
      as(await sessionFor(ADMIN), { mailboxId: HELD_MAILBOX, matterId: "mat_acme", fromDate: "2026-08-01" }),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { hold: { id: string; mailboxId: string; toDate: string | null } };
    expect(body.hold.mailboxId).toBe(HELD_MAILBOX);
    // An absent bound stays absent through the route rather than being invented as "today".
    expect(body.hold.toDate).toBeNull();
  });

  it("refuses a member who does not hold org.admin, and places nothing", async () => {
    const response = await SELF.fetch(
      "https://node/api/holds",
      as(await sessionFor(ANA), { mailboxId: HELD_MAILBOX }),
    );
    expect(response.status).toBe(403);
    expect((await response.json() as { error: string }).error).toBe("E_NOT_AN_ADMINISTRATOR");
    const row = await testEnv.CATALOG.prepare("SELECT id FROM holds WHERE org_id = ?").bind(ORG).first();
    expect(row).toBeNull();
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await SELF.fetch("https://node/api/holds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mailboxId: HELD_MAILBOX }),
    });
    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/drafts/:id answers the refusal rather than swallowing it", () => {
  it("returns 409 and the Node's four-part message, naming the hold", async () => {
    const ctx = createSystemCtx();
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    const hold = await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const response = await SELF.fetch(`https://node/api/drafts/${saved.id}`, {
      method: "DELETE",
      headers: { cookie: `mailda_at=${await sessionFor(ANA)}` },
    });

    // 409, not 403 and not `{ deleted: false }`: the request is well-formed and it is the state that does
    // not permit it. `{ deleted: false }` would say the draft is still there without saying why.
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("E_LEGAL_HOLD");
    expect(body.message).toContain(hold.id);
    expect(body.message).toContain("fix");
    expect(body.message).toContain("#61");

    const row = await testEnv.CATALOG.prepare("SELECT id FROM drafts WHERE id = ?").bind(saved.id).first();
    expect(row, "the row a refused deletion must leave alone").not.toBeNull();
  });
});

describe("POST /api/sends from a held mailbox sends, and says the draft was kept", () => {
  it("reports draftRetained and leaves the draft in place", async () => {
    const ctx = createSystemCtx();
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);
    await placeHold(testEnv, ctx, ORG, ADMIN, { mailboxId: HELD_MAILBOX });

    const response = await SELF.fetch(
      "https://node/api/sends",
      as(await sessionFor(ANA), { ...composition, draftId: saved.id }),
    );

    // The send must not fail: the manifest is sealed and the message is leaving. Answering 409 here would
    // tell somebody their send failed when it did not.
    expect(response.status).toBe(200);
    const body = await response.json() as { id: string; draftRetained: boolean };
    expect(body.id).toMatch(/^snd_/);
    expect(body.draftRetained, "the field the docs promise a caller").toBe(true);

    const row = await testEnv.CATALOG.prepare("SELECT id FROM drafts WHERE id = ?").bind(saved.id).first();
    expect(row, "preserved on purpose, which is why the caller is told").not.toBeNull();

    // The attempt is in the trail even though the send succeeded, which is what makes the reported field a
    // convenience rather than the only record of it.
    const blocked = await testEnv.CATALOG.prepare(
      "SELECT subject FROM audit_entries WHERE org_id = ? AND action = 'hold.blocked'",
    ).bind(ORG).all<{ subject: string }>();
    expect(blocked.results.map((entry) => entry.subject)).toEqual([saved.id]);
  });

  it("reports draftRetained false and retires the draft when no hold covers it", async () => {
    // The other half, so `draftRetained: true` is the hold and not a field that is always true.
    const ctx = createSystemCtx();
    const saved = await saveDraft(testEnv, ctx, ORG, ANA, null, composition);

    const response = await SELF.fetch(
      "https://node/api/sends",
      as(await sessionFor(ANA), { ...composition, draftId: saved.id }),
    );
    expect(response.status).toBe(200);
    expect((await response.json() as { draftRetained: boolean }).draftRetained).toBe(false);

    const row = await testEnv.CATALOG.prepare("SELECT id FROM drafts WHERE id = ?").bind(saved.id).first();
    expect(row).toBeNull();
  });
});
