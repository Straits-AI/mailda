import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createSystemCtx, type Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import { CallerError } from "../src/errors.ts";
import { inviteToOrganization, openInvitations, redeemInvitation } from "../src/invitations.ts";

/**
 * Inviting a second person (#83).
 *
 * A Node had exactly one account and nothing could make another, so Layer 3's whole premise — cases,
 * assignment, dual control, separation of duty — had one person to exercise it. This is a **credential
 * path**, so most of what is below is about the refusals: an invitation is a bearer secret that creates a
 * principal, and the ways it must not work matter more than the way it does.
 */

const testEnv = env as unknown as Env;
const ORG = "org_invite";
const ADMIN = "usr_invite_admin";
const MEMBER = "usr_invite_member";
const AUGUST_21 = Date.parse("2026-08-21T09:00:00.000Z");

function atTime(millis: number): Ctx {
  const system = createSystemCtx();
  return { now: () => millis, id: (p) => system.id(p), random: (n) => system.random(n) };
}

async function tuple(subjectId: string, relation: string, objectType: string, objectId: string) {
  const ctx = createSystemCtx();
  await testEnv.CATALOG.prepare(
    `INSERT INTO relationship_tuples (id, org_id, subject_id, relation, object_type, object_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(ctx.id("rt"), ORG, subjectId, relation, objectType, objectId, new Date(ctx.now()).toISOString()).run();
}

async function userRow(email: string) {
  return testEnv.CATALOG.prepare("SELECT id, email FROM users WHERE org_id = ? AND email = ?")
    .bind(ORG, email).first<{ id: string; email: string }>();
}

beforeEach(async () => {
  for (const table of ["invitations", "relationship_tuples", "users", "sessions", "refresh_tokens",
                       "audit_entries", "outbox"]) {
    await testEnv.CATALOG.prepare(`DELETE FROM ${table}`).run();
  }
  const at = new Date(AUGUST_21).toISOString();
  for (const [id, email] of [[ADMIN, "admin@acme.example"], [MEMBER, "member@acme.example"]]) {
    await testEnv.CATALOG.prepare(
      "INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)",
    ).bind(id, ORG, email, at).run();
  }
  await tuple(ADMIN, "org.admin", "organization", ORG);
});

describe("an administrator invites, and only an administrator", () => {
  it("mints a secret it never stores, and returns it once", async () => {
    const minted = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "New.Person@Acme.Example");

    // Lower-cased on the way in, because `users.email` is and the two are compared to decide whether an
    // account already exists.
    expect(minted.email).toBe("new.person@acme.example");
    expect(minted.secret.length).toBeGreaterThanOrEqual(32);

    const row = await testEnv.CATALOG.prepare(
      "SELECT secret_hash, expires_at, redeemed_at FROM invitations WHERE id = ?",
    ).bind(minted.invitationId).first<{ secret_hash: string; expires_at: string; redeemed_at: null }>();
    // The secret itself is nowhere in the row. A secret a database read can return is one a database read
    // hands over, which is the whole reason only the hash is kept.
    expect(row?.secret_hash).not.toBe(minted.secret);
    expect(row?.secret_hash).toHaveLength(64);
    expect(row?.redeemed_at).toBeNull();
    expect(Date.parse(row!.expires_at) - AUGUST_21)
      .toBe(BUDGETS["auth.invitation_expiry_seconds"] * 1000);
  });

  it("refuses somebody who is not an administrator", async () => {
    await expect(inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, MEMBER, "x@acme.example"))
      .rejects.toThrow(/E_NOT_AN_ADMINISTRATOR/);
    expect(await openInvitations(testEnv, atTime(AUGUST_21), ORG)).toEqual([]);
  });

  it("refuses an address that already has an account", async () => {
    await expect(inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "member@acme.example"))
      .rejects.toThrow(/E_ALREADY_A_MEMBER/);
  });

  it("withdraws an outstanding invitation when a second is minted for the same address", async () => {
    /*
     * Two live bearer credentials for one membership is a state where revoking the one you remembered leaves
     * the other working — and an administrator re-minting because the first link went astray is specifically
     * trying to invalidate it.
     */
    const first = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "new@acme.example");
    const second = await inviteToOrganization(testEnv, atTime(AUGUST_21 + 1000), ORG, ADMIN, "new@acme.example");
    expect(second.replacedId).toBe(first.invitationId);

    const open = await openInvitations(testEnv, atTime(AUGUST_21 + 1000), ORG);
    expect(open.map((row) => row.id)).toEqual([second.invitationId]);

    // And the old secret is dead, not merely superseded.
    await expect(redeemInvitation(testEnv, atTime(AUGUST_21 + 2000), first.secret, "a-long-enough-passphrase"))
      .rejects.toThrow(/E_INVITATION_UNUSABLE/);
  });
});

describe("redeeming an invitation", () => {
  it("creates the account, signs them in, and holds nothing", async () => {
    const minted = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "new@acme.example");
    const joined = await redeemInvitation(
      testEnv, atTime(AUGUST_21 + 5000), minted.secret, "a-long-enough-passphrase",
    );

    expect(joined.email).toBe("new@acme.example");
    expect((await userRow("new@acme.example"))?.id).toBe(joined.userId);
    expect(joined.session.accessToken.length).toBeGreaterThan(0);

    /*
     * **They hold nothing.** An invitation carries an address and no relations, so an administrator grants
     * access afterwards where the consequence of each relation is written next to it. Authority arriving
     * with an account nobody had looked at yet is the thing this asserts against.
     */
    const held = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM relationship_tuples WHERE org_id = ? AND subject_id = ?",
    ).bind(ORG, joined.userId).first<{ n: number }>();
    expect(held).toEqual({ n: 0 });

    // Redeemed, and the row says by whom — the only place "this account exists because that administrator
    // invited this address" is recorded.
    const row = await testEnv.CATALOG.prepare(
      "SELECT redeemed_at, redeemed_user_id FROM invitations WHERE id = ?",
    ).bind(minted.invitationId).first<{ redeemed_at: string; redeemed_user_id: string }>();
    expect(row?.redeemed_user_id).toBe(joined.userId);
    expect(row?.redeemed_at).toBe(new Date(AUGUST_21 + 5000).toISOString());
  });

  it("cannot be redeemed twice", async () => {
    const minted = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "new@acme.example");
    await redeemInvitation(testEnv, atTime(AUGUST_21 + 1000), minted.secret, "a-long-enough-passphrase");

    await expect(redeemInvitation(testEnv, atTime(AUGUST_21 + 2000), minted.secret, "another-long-passphrase"))
      .rejects.toThrow(/E_INVITATION_UNUSABLE/);
    // And no second account was made on the way to failing.
    const count = await testEnv.CATALOG.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id = ?")
      .bind(ORG).first<{ n: number }>();
    expect(count).toEqual({ n: 3 });
  });

  /**
   * Two people paste the same link at the same moment.
   *
   * The sequential "cannot be redeemed twice" test above is satisfied by the **read** — `redeemed_at` is
   * already set by the time the second attempt looks — so it passes with the compare-and-swap removed, which
   * is how this test came to exist. Under concurrency both attempts pass that read, and the only thing
   * standing between them and two accounts for one invitation is `WHERE redeemed_at IS NULL`.
   *
   * The conflict is the signal, which is the pattern the case queue, the claim and the audit sequence use.
   */
  it("gives the account to exactly one of two simultaneous redemptions", async () => {
    const minted = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "new@acme.example");

    const both = await Promise.allSettled([
      redeemInvitation(testEnv, atTime(AUGUST_21 + 1000), minted.secret, "a-long-enough-passphrase"),
      redeemInvitation(testEnv, atTime(AUGUST_21 + 1000), minted.secret, "a-different-long-passphrase"),
    ]);

    expect(both.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const lost = both.filter((outcome) => outcome.status === "rejected");
    expect(lost).toHaveLength(1);
    /*
     * **The loser gets the ordinary refusal, not a database error.**
     *
     * This is the assertion the test was missing on its first pass, and it found a real defect: `users_email`
     * is `UNIQUE (org_id, email)`, so the losing INSERT violates it and D1 rejects the transaction — which
     * reached the caller as a raw constraint error and a 500. Every other way of failing this endpoint gives
     * one careful sentence; losing a race gave a stack trace.
     */
    expect(String((lost[0] as PromiseRejectedResult).reason?.message))
      .toMatch(/E_INVITATION_UNUSABLE/);

    /*
     * One account, and it is the winner's. The batch is one transaction, so the loser's `INSERT INTO users`
     * is rolled back with its failed UPDATE — the alternative is two accounts and an invitation row claiming
     * to explain both.
     */
    const accounts = await testEnv.CATALOG.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND email = ?",
    ).bind(ORG, "new@acme.example").first<{ n: number }>();
    expect(accounts).toEqual({ n: 1 });

    const winner = both.find((outcome) => outcome.status === "fulfilled");
    const row = await testEnv.CATALOG.prepare(
      "SELECT redeemed_user_id FROM invitations WHERE id = ?",
    ).bind(minted.invitationId).first<{ redeemed_user_id: string }>();
    expect(row?.redeemed_user_id)
      .toBe((winner as PromiseFulfilledResult<{ userId: string }>).value.userId);
  });

  it("stops working when it expires", async () => {
    const minted = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "new@acme.example");
    const after = AUGUST_21 + BUDGETS["auth.invitation_expiry_seconds"] * 1000 + 1;
    await expect(redeemInvitation(testEnv, atTime(after), minted.secret, "a-long-enough-passphrase"))
      .rejects.toThrow(/E_INVITATION_UNUSABLE/);
    expect(await userRow("new@acme.example")).toBeNull();
  });

  /**
   * The refusals are indistinguishable, and that is the security property.
   *
   * A redemption endpoint that told "no such invitation" apart from "that one expired" is an oracle for
   * guessing secrets, and the expiry case would additionally confirm that somebody at this organization was
   * invited. Asserted on the **message**, not just the code, because the code is only half of what a caller
   * reads.
   */
  it("says the same thing however it fails", async () => {
    const minted = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "new@acme.example");
    const expired = AUGUST_21 + BUDGETS["auth.invitation_expiry_seconds"] * 1000 + 1;

    const messages: string[] = [];
    for (const [secret, at] of [
      ["a-secret-that-was-never-minted", AUGUST_21 + 1000],
      [minted.secret, expired],
    ] as const) {
      await redeemInvitation(testEnv, atTime(at), secret, "a-long-enough-passphrase")
        .catch((error: CallerError) => { messages.push(error.message); });
    }
    expect(messages).toHaveLength(2);
    // Byte-identical, which is the whole property: the caller cannot tell the cases apart.
    expect(messages[0]).toBe(messages[1]);
    /*
     * It *lists* all three possibilities without saying which — that is deliberate and is what makes it
     * useless as an oracle. What it must never carry is the address, which would confirm that this person
     * was invited here even when the secret was fabricated.
     */
    expect(messages[0]).not.toContain("new@acme.example");
  });

  it("refuses a weak password without saying whether the secret was good", async () => {
    /*
     * Answered before the invitation is looked up, so the refusal is about the password either way. Both a
     * real secret and a fabricated one must produce the same complaint.
     */
    const minted = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "new@acme.example");
    const real = await redeemInvitation(testEnv, atTime(AUGUST_21 + 1000), minted.secret, "short")
      .catch((error: CallerError) => error.message);
    const fake = await redeemInvitation(testEnv, atTime(AUGUST_21 + 1000), "not-a-secret", "short")
      .catch((error: CallerError) => error.message);
    expect(real).toMatch(/E_WEAK_PASSWORD/);
    expect(real).toBe(fake);
    // The invitation is untouched: a rejected password must not consume it.
    expect(await openInvitations(testEnv, atTime(AUGUST_21 + 1000), ORG)).toHaveLength(1);
  });
});

describe("the trail names both halves", () => {
  it("records who invited and who joined, as separate acts", async () => {
    const minted = await inviteToOrganization(testEnv, atTime(AUGUST_21), ORG, ADMIN, "new@acme.example");
    const joined = await redeemInvitation(
      testEnv, atTime(AUGUST_21 + 1000), minted.secret, "a-long-enough-passphrase",
    );

    const { results } = await testEnv.CATALOG.prepare(
      "SELECT action, actor_user_id, subject FROM audit_entries WHERE org_id = ? ORDER BY seq",
    ).bind(ORG).all<{ action: string; actor_user_id: string; subject: string }>();

    /*
     * Two entries with **different actors**, which is the point of two actions. Folding them into one would
     * make "who let them in" unanswerable separately from "when did they arrive" — and the gap between the
     * two is exactly the window a leaked invitation lives in.
     */
    expect(results).toEqual([
      { action: "access.invited", actor_user_id: ADMIN, subject: minted.invitationId },
      { action: "access.joined", actor_user_id: joined.userId, subject: joined.userId },
    ]);
  });
});
