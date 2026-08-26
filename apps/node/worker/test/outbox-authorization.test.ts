import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx } from "@mailda/runtime";

import { sealManifest } from "../src/outbound/manifest.ts";
import { dispatchDue } from "../src/outbound/dispatch.ts";
import { ACCESS_COOKIE, login } from "../src/auth/session.ts";
import { hashPassword } from "../src/auth/password.ts";

/**
 * #45: the outbox was bounded by organization and nothing else.
 *
 * `listMessages` has always bounded the inbound list by the mailboxes a caller holds
 * `mailbox.content.read` on. Three outbound paths did not:
 *
 *   GET  /api/sends               subjects, recipients, and the receiving server's words about an address
 *   GET  /api/sends/:id/submitted the submitted bytes — the message itself, not a row about it
 *   POST /api/sends/:id/cancel    a **write**: stop a send from a mailbox you have no relation to
 *
 * Invisible because a Node has one user, so org-scope and mailbox-scope returned identical rows. It becomes
 * live the moment a second member exists, which is the layer being designed.
 *
 * These tests are written from the perspective of that second member — authenticated, in the organization,
 * holding no relation on the mailbox. Every one of them fails against the code as shipped.
 */

const testEnv = env as unknown as Env;
const ORG = "org_outbox_authz";
const MAILBOX = "mbx_theirs";
const ADDRESS = "support@acme.example";
const OWNER = "usr_owner";
const STRANGER = "usr_stranger";
const PASSWORD = "fixture-password-not-a-real-secret";

async function sessionFor(userId: string): Promise<string> {
  const ctx = createSystemCtx();
  const outcome = await login(testEnv, ctx, ORG, `${userId}@acme.example`, PASSWORD);
  if (outcome.status !== "signed_in") throw new Error(`could not sign in ${userId}: ${outcome.status}`);
  return outcome.session.accessToken;
}

function as(token: string): RequestInit {
  return { headers: { cookie: `${ACCESS_COOKIE}=${token}` } };
}

let manifestId: string;

beforeEach(async () => {
  for (const table of ["send_manifests", "send_recipients", "send_counters", "relationship_tuples",
                       "addresses", "mailboxes", "users", "node_claim", "login_attempts", "sessions",
                       "refresh_tokens"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const ctx = createSystemCtx();
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(PASSWORD);

  await testEnv.CATALOG.batch([
    testEnv.CATALOG.prepare(
      "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,?,?)",
    ).bind("clm_authz", "unused", at, ORG),
    testEnv.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(MAILBOX, ORG, "Support", at),
    testEnv.CATALOG.prepare(
      "INSERT INTO addresses (id, org_id, address, mailbox_id, created_at) VALUES (?,?,?,?,?)",
    ).bind(ctx.id("addr"), ORG, ADDRESS, MAILBOX, at),
  ]);

  for (const userId of [OWNER, STRANGER]) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations, password_updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, ORG, `${userId}@acme.example`, at, verifier.encoded, verifier.effectiveIterations, at).run();
  }

  // Only the owner holds anything. The stranger is a real, authenticated member of the same organization
  // with no relation on this mailbox — which is exactly the principal the old query could not distinguish.
  for (const relation of ["mailbox.content.read", "send.propose"]) {
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), ORG, OWNER, relation, "mailbox", MAILBOX, at).run();
  }

  const sealed = await sealManifest(testEnv, ctx, ORG, {
    mailboxId: MAILBOX,
    authorUserId: OWNER,
    to: ["customer@example.net"],
    subject: "Demurrage on MSKU4471203",
    bodyTyped: "Charges stop today.",
    fidelity: "authored",
  });
  manifestId = sealed.id;
});

describe("the outbox list is bounded by mailbox, not by organization (#45)", () => {
  it("shows the owner their own send", async () => {
    const response = await SELF.fetch("https://node/api/sends", as(await sessionFor(OWNER)));
    const body = await response.json() as { sends: Array<{ id: string }> };
    expect(response.status).toBe(200);
    expect(body.sends.map((s) => s.id)).toContain(manifestId);
  });

  it("shows a member with no relation on the mailbox nothing at all", async () => {
    const response = await SELF.fetch("https://node/api/sends", as(await sessionFor(STRANGER)));
    const body = await response.json() as { sends: unknown[] };
    // Not a redacted row, not a count: absent. A subject line and a recipient address are the disclosure.
    expect(response.status).toBe(200);
    expect(body.sends).toEqual([]);
  });
});

describe("the submitted bytes are bounded by mailbox (#45)", () => {
  it("answers a stranger exactly as it answers an unknown id", async () => {
    const token = await sessionFor(STRANGER);
    const mine = await SELF.fetch(
      `https://node/api/sends/${manifestId}/submitted`, as(token));
    const absent = await SELF.fetch(
      "https://node/api/sends/snd_does_not_exist/submitted", as(token));

    // §5C: identical. If they differed, the difference would report which ids exist.
    expect(mine.status).toBe(absent.status);
    expect(await mine.json()).toEqual(await absent.json());
    expect(mine.status).toBe(404);
  });
});

describe("taking a copy off the Node needs message.export, both directions (#95)", () => {
  /*
   * **The asymmetry this closes.** `GET /api/sends/:sendId/submitted` took `mayRead` — content access —
   * while `GET /api/messages/:id/raw` takes `message.export` *and* `mailbox.content.read`. So the owner
   * below, who holds content read and not `message.export`, was refused the inbound copy and served the
   * outbound one: same mailbox, same kind of bytes, same person, opposite answers.
   *
   * The fixture is what makes this readable: `beforeEach` grants the owner `mailbox.content.read` and
   * `send.propose` and deliberately **not** `message.export`, which is the shape of an ordinary member of a
   * shared mailbox. #65 made export separately revocable exactly so that shape exists.
   */
  it("refuses the submitted bytes to a reader who may not export", async () => {
    const response = await SELF.fetch(
      `https://node/api/sends/${manifestId}/submitted`, as(await sessionFor(OWNER)));
    // §5C: the same 404 a stranger gets. "You may not export this" must not be distinguishable from
    // "there is no such send", or the difference reports which ids exist.
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "not_found", message: "No such send, or you do not have access to it.",
    });
  });

  it("answers 401 with no session, rather than a 404 or a crash", async () => {
    /*
     * Found by `scripts/mutants.mjs`: removing the `who === null` guard left every test passing, because
     * nothing asked this route for the unauthenticated case. Without the guard the next line dereferences a
     * null principal and the caller gets a 500 — a bug report instead of "sign in", which is the difference
     * `errors.ts` exists to keep.
     *
     * `refreshable` matters too: the client contract is that every 401 says whether a refresh is worth
     * trying, and a client that cannot tell either retries forever or signs somebody out recoverably.
     */
    const response = await SELF.fetch(`https://node/api/sends/${manifestId}/submitted`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthenticated", refreshable: true });
  });

  it("serves them once the relation is granted, so the refusal is about the relation", async () => {
    /*
     * The other direction, and it is what stops the test above passing for the wrong reason — a 404 caused
     * by a broken fixture, a missing manifest or a typo in the id would look identical.
     */
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'message.export','mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, OWNER, MAILBOX, new Date(ctx.now()).toISOString()).run();

    const response = await SELF.fetch(
      `https://node/api/sends/${manifestId}/submitted`, as(await sessionFor(OWNER)));
    // 409 rather than 200: this send is still `held`, so there are no submitted bytes yet. What matters is
    // that it is past the authorization and answering about the *send* rather than about access.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "no_submitted_bytes" });
  });

  it("records the export before the bytes move, naming the direction", async () => {
    /*
     * #65's guarantee: taking a copy off the Node is recorded. One action covers both routes now, so the
     * entry carries `direction` — an auditor reading `message.exported` should not have to infer which kind
     * of bytes moved from whether the subject looks like a receipt id.
     */
    const ctx = createSystemCtx();
    await testEnv.CATALOG.prepare(
      `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,'message.export','mailbox',?,?)`,
    ).bind(ctx.id("rt"), ORG, OWNER, MAILBOX, new Date(ctx.now()).toISOString()).run();
    await testEnv.CATALOG.prepare("DELETE FROM audit_entries WHERE org_id = ?").bind(ORG).run();

    await SELF.fetch(`https://node/api/sends/${manifestId}/submitted`, as(await sessionFor(OWNER)));

    const entry = await testEnv.CATALOG.prepare(
      "SELECT action, subject, detail FROM audit_entries WHERE org_id = ? AND action = 'message.exported'",
    ).bind(ORG).first<{ action: string; subject: string; detail: string }>();
    expect(entry, "no message.exported entry for an outbound copy").not.toBeNull();
    expect(entry!.subject).toBe(manifestId);
    expect(entry!.detail).toContain('"direction":"outbound"');
  });
});

describe("cancelling is bounded by send.propose (#45)", () => {
  it("does not let a stranger stop somebody else's send", async () => {
    const response = await SELF.fetch(
      `https://node/api/sends/${manifestId}/cancel`,
      { method: "POST", ...as(await sessionFor(STRANGER)) },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ cancelled: false, reason: "no such send" });

    // The write must not have happened. This is the assertion that matters: the others are disclosure,
    // this one is somebody else's mail not going out.
    const row = await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(manifestId).first<{ state: string }>();
    expect(row?.state).toBe("held");
  });

  it("answers a stranger exactly as it answers an unknown id", async () => {
    const token = await sessionFor(STRANGER);
    const theirs = await SELF.fetch(`https://node/api/sends/${manifestId}/cancel`, { method: "POST", ...as(token) });
    const absent = await SELF.fetch("https://node/api/sends/snd_nope/cancel", { method: "POST", ...as(token) });
    expect(theirs.status).toBe(absent.status);
    expect(await theirs.json()).toEqual(await absent.json());
  });

  it("still lets the owner stop their own send", async () => {
    const response = await SELF.fetch(
      `https://node/api/sends/${manifestId}/cancel`,
      { method: "POST", ...as(await sessionFor(OWNER)) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cancelled: true });
  });
});

describe("dispatching is bounded by send.propose (#45)", () => {
  /** Past its hold window, so it is due — and still `held`, so still cancellable. */
  async function makeDue() {
    await testEnv.CATALOG.prepare("UPDATE send_manifests SET release_at = ? WHERE id = ?")
      .bind("2020-01-01T00:00:00.000Z", manifestId)
      .run();
  }

  it("dispatches nothing for a member who holds no mailbox, and says nothing about what exists", async () => {
    await makeDue();
    const response = await SELF.fetch(
      "https://node/api/sends/dispatch",
      { method: "POST", ...as(await sessionFor(STRANGER)) },
    );
    expect(response.status).toBe(200);
    // Empty, and indistinguishable from "nothing was due" — the result named every manifest it touched,
    // so org-wide leaked ids and states across mailboxes as well as acting on them.
    expect(await response.json()).toEqual({ dispatched: [] });
  });

  it("leaves the send held, so its owner keeps the chance to stop it", async () => {
    await makeDue();
    await SELF.fetch("https://node/api/sends/dispatch", { method: "POST", ...as(await sessionFor(STRANGER)) });

    // The assertion that matters. A held send past its release_at is still cancellable; forcing the sweep
    // would have ended that window on behalf of somebody with no relation to the mailbox.
    const row = await testEnv.CATALOG.prepare("SELECT state FROM send_manifests WHERE id = ?")
      .bind(manifestId).first<{ state: string }>();
    expect(row?.state).toBe("held");
  });

  it("still sweeps everything for the sweeper, which has no principal to bound it", async () => {
    await makeDue();
    // `mailboxIds` undefined — the OutboxSweeper alarm's call. A send it skipped would never leave at all,
    // so the unbounded form has to keep working.
    const swept = await dispatchDue(
      testEnv, createSystemCtx(), ORG,
      { name: "fake", async capability() {
          return { canSend: true, arbitraryRecipients: true, verifiedAt: null, detail: "fake" };
        }, async submit() { return { kind: "handed_over", transportMessageId: "<swept@acme.example>" }; } },
    );
    expect(swept.map((r) => r.manifestId)).toContain(manifestId);
  });

  it("treats an empty mailbox list as nothing, never as everything", async () => {
    await makeDue();
    // The dangerous default: if [] widened to "no restriction", a caller holding nothing would sweep the
    // whole organization — the exact bug, reintroduced by a falsy check.
    const swept = await dispatchDue(testEnv, createSystemCtx(), ORG, undefined, 20, []);
    expect(swept).toEqual([]);
  });
});
