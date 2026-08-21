import { BUDGETS } from "@mailda/budgets";
import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { isAdmin } from "./access.ts";
import { claimSecretHash } from "./claim-secret.ts";
import { CallerError, conflict, notFound, unprocessable } from "./errors.ts";
import { hashPassword, passwordProblem } from "./auth/password.ts";
import { issueSession, type IssuedSession } from "./auth/session.ts";

/**
 * Inviting a second person (#83).
 *
 * ## The gap this closes
 *
 * A Node had exactly one account — the one `claimNode` created — and nothing else wrote to `users`. Layer 3
 * is *share*: cases, assignment, reply-collision, dual control, separation of duty. Every one of those needs
 * two people. It also made several shipped refusals the **only** reachable branch: a domain pause needs two
 * other administrators, a supervised read two other approvers, a hold lift two distinct ones — so on a
 * one-person Node they always refuse, and the governance they protect was never exercised by anybody.
 *
 * ## The mechanism is `node_claim`'s, on purpose
 *
 * An administrator mints a secret; the invited person redeems it by choosing their own password. Only the
 * **hash** is stored, so a lost invitation is re-minted rather than recovered, and `claimSecretHash` is
 * shared with the claim path rather than reimplemented — a second hash would mean an invitation nothing can
 * ever match.
 *
 * The property that matters is that **the administrator never learns the password**. The obvious alternative
 * — an administrator sets one and tells them — makes that administrator a permanent holder of every
 * colleague's credential, which is worse than the gap it fills. `set-password` is already the deliberate
 * operator escape hatch for a lockout, and it is loud about running outside the audit trail.
 *
 * ## What an invitation carries, and what it deliberately does not
 *
 * It carries an **address and nothing else**. No relations, no mailbox, no role. Somebody who redeems one is
 * a member of the organization holding exactly nothing, and an administrator grants access afterwards on
 * `/people` — where the consequence of each relation is written next to it. Pre-loading grants onto an
 * invitation would mean authority arriving with an account nobody had looked at yet, and would put the same
 * decision in two places.
 */

/** The address is the identity here, and `users.email` is stored lower-cased, so both sides agree. */
function normalise(email: string): string {
  return email.trim().toLowerCase();
}

export interface MintedInvitation {
  invitationId: string;
  email: string;
  expiresAt: string;
  /**
   * The secret, **returned once and never stored**.
   *
   * The row holds its hash, so this value exists exactly as long as it takes the caller to hand it over.
   * There is no endpoint that can produce it again, which is the point rather than a limitation: a secret a
   * database read can return is a secret a database read hands over.
   */
  secret: string;
  /** The invitation this one replaced, when re-minting withdrew an outstanding link. */
  replacedId: string | null;
}

/**
 * Mints an invitation, withdrawing any outstanding one for the same address.
 *
 * ## Why re-minting withdraws rather than adds
 *
 * `inv_one_open_per_email` refuses a second open invitation for one address, and this deletes the old row in
 * the same batch rather than letting the insert collide. Two live bearer credentials for one membership is a
 * state where revoking the one you remembered leaves the other working — and an administrator who re-mints
 * because the first link went astray is *specifically* trying to invalidate it.
 *
 * The withdrawn row is deleted rather than marked, and that is the one place this file loses history. The
 * alternative is a `withdrawn_at` column and a partial index that has to exclude it, for a row that records
 * "somebody was invited and then invited again" — which the two `access.invited` entries in the trail already
 * say, with who and when. The audit chain is the record; the table is the live set.
 */
export async function inviteToOrganization(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  email: string,
): Promise<MintedInvitation> {
  if (!(await isAdmin(env, orgId, actorUserId))) {
    throw new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
      what: `${actorUserId} is not an administrator of this organization`,
      why: "an invitation lets somebody become a principal in this organization, so minting one is the same "
        + "authority as granting a relation",
      fix: "ask somebody who holds org.admin",
    });
  }

  const address = normalise(email);
  // Not a regex. `sealManifest` refuses a malformed address at the point it would be used, and a second
  // opinion here would be a stricter or looser rule than the one that matters.
  if (address === "" || !address.includes("@")) {
    throw unprocessable("E_INVITATION_NO_ADDRESS", {
      what: `${JSON.stringify(email)} is not an address to invite`,
      why: "the address is the identity: it is what the invitation is for and what the account will be "
        + "signed in as",
      fix: "send {\"email\":\"somebody@example.com\"}",
    });
  }

  const existing = await env.CATALOG.prepare(
    "SELECT id FROM users WHERE org_id = ? AND email = ? LIMIT 1",
  ).bind(orgId, address).first<{ id: string }>();
  if (existing !== null) {
    throw conflict("E_ALREADY_A_MEMBER", {
      what: `${address} already has an account on this Node`,
      why: "an invitation creates an account, so a second one for an address that has one would either fail "
        + "at redemption or make a duplicate — and a duplicate is two identities one person answers to",
      fix: "grant them access on the people screen, or use `mailda set-password` if they cannot sign in",
    });
  }

  const open = await env.CATALOG.prepare(
    "SELECT id FROM invitations WHERE org_id = ? AND email = ? AND redeemed_at IS NULL LIMIT 1",
  ).bind(orgId, address).first<{ id: string }>();

  const at = new Date(ctx.now()).toISOString();
  const expiresAt = new Date(ctx.now() + BUDGETS["auth.invitation_expiry_seconds"] * 1000).toISOString();
  const id = ctx.id("inv");
  // 32 bytes of entropy as hex, from `ctx.random` so a test can make it deterministic. Long enough that
  // the channel it travels through is the only thing protecting it.
  const secret = [...ctx.random(32)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // Hashed here rather than inside the statement builder: that callback is synchronous, and reaching for
  // `await` in it is the mistake the compiler catches once and a reader would not.
  const secretHash = await claimSecretHash(secret);

  await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "access.invited", outcome: "ok", subject: id, actorUserId,
      detail: { email: address, expiresAt, replaced: open?.id ?? null },
    },
    (entry) => [
      entry,
      // Before the insert, so `inv_one_open_per_email` cannot reject the new row on the way in. One batch, so
      // a failure leaves neither the withdrawal nor the replacement.
      ...(open === null
        ? []
        : [env.CATALOG.prepare("DELETE FROM invitations WHERE org_id = ? AND id = ?").bind(orgId, open.id)]),
      env.CATALOG.prepare(
        `INSERT INTO invitations (id, org_id, email, secret_hash, invited_by, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(id, orgId, address, secretHash, actorUserId, at, expiresAt),
    ],
  );

  return { invitationId: id, email: address, expiresAt, secret, replacedId: open?.id ?? null };
}

export interface JoinedOrganization {
  userId: string;
  email: string;
  session: IssuedSession;
}

/**
 * Redeems an invitation: creates the account, sets the password, and signs the person in.
 *
 * ## One refusal for every failure, and it says nothing
 *
 * A wrong secret, an expired one, an already-redeemed one and one for an address that has since been given an
 * account all answer identically. This is `claimNode`'s rule and §5C's: a redemption endpoint that
 * distinguished "no such invitation" from "that one expired" is an oracle for guessing secrets, and the
 * expiry case would additionally confirm that somebody at this organization was invited.
 *
 * The **caller** gets nothing; the Node's operational log gets the distinction, because an administrator
 * asking "why did their link not work" is a real question with a real answer.
 *
 * ## The password is the person's own
 *
 * `passwordProblem` is the same gate the claim uses, so a colleague's password is held to the rule the first
 * administrator's was. And the account and its verifier are written by one statement: an account that exists
 * with no password is one nobody can sign into and nothing can distinguish from a lockout.
 */
export async function redeemInvitation(
  env: Env,
  ctx: Ctx,
  secret: string,
  password: string,
): Promise<JoinedOrganization> {
  const refuse = () => notFound("E_INVITATION_UNUSABLE", {
    what: "that invitation cannot be used",
    why: "it does not exist, it has already been redeemed, or it has expired. Which one is deliberately not "
      + "said: distinguishing them would let somebody guess at secrets and would confirm who was invited",
    fix: "ask the administrator who invited you to send a new one — minting a fresh invitation withdraws "
      + "the old link",
  });

  const problem = passwordProblem(password);
  if (problem !== null) {
    /*
     * Answered **before** the invitation is looked up, so a weak password does not reveal whether the secret
     * was good — the refusal is about the password either way.
     *
     * `passwordProblem`'s own sentence is carried through as the `why`, rather than reworded here: the rule
     * about what makes a password usable is stated where the rule lives, and a second wording of it would be
     * a second thing to keep in step.
     */
    throw unprocessable("E_WEAK_PASSWORD", {
      what: "that password is not usable",
      why: problem,
      fix: "choose a longer passphrase; there are no character-class requirements",
    });
  }

  const invitation = await env.CATALOG.prepare(
    `SELECT id, org_id, email, expires_at, redeemed_at FROM invitations WHERE secret_hash = ? LIMIT 1`,
  ).bind(await claimSecretHash(secret)).first<{
    id: string; org_id: string; email: string; expires_at: string; redeemed_at: string | null;
  }>();

  if (invitation === null || invitation.redeemed_at !== null) throw refuse();
  if (Date.parse(invitation.expires_at) <= ctx.now()) throw refuse();

  const taken = await env.CATALOG.prepare(
    "SELECT id FROM users WHERE org_id = ? AND email = ? LIMIT 1",
  ).bind(invitation.org_id, invitation.email).first<{ id: string }>();
  if (taken !== null) throw refuse();

  const at = new Date(ctx.now()).toISOString();
  const userId = ctx.id("usr");
  const verifier = await hashPassword(password);

  /*
   * The batch can fail two ways that both mean "somebody else got there first", and both have to arrive at
   * the same refusal a caller already gets.
   *
   * `users_email` is `UNIQUE (org_id, email)`, and **that index is what actually enforces one account** — the
   * losing INSERT violates it and D1 rejects the whole transaction. Without funnelling that here, the loser
   * of a race got a raw constraint error and a 500, which is a worse answer than the one this endpoint
   * carefully gives everybody else.
   *
   * The `redeemed_at IS NULL` guard below is kept and is **not independently observable**: given the unique
   * index, no test can distinguish its presence. It stays because it is the same statement at no extra cost
   * and it is the clause that would matter if the account key were ever scoped differently — but it is
   * recorded as belt rather than braces, the way the `MAX(version)` decision in `butlers.ts` is, instead of
   * being described as the mechanism.
   */
  const written = await auditedBatch<never>(
    env, ctx, invitation.org_id,
    {
      action: "access.joined", outcome: "ok", subject: userId, actorUserId: userId,
      detail: { email: invitation.email, invitation: invitation.id },
    },
    (entry) => [
      entry,
      /*
       * The account. `password_salt` is deliberately not written, for the reason `claimNode` gives: the salt
       * travels inside the encoded verifier now, so the column is dead and mentioning it would make it look
       * load-bearing.
       */
      env.CATALOG.prepare(
        `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations,
           password_updated_at) VALUES (?,?,?,?,?,?,?)`,
      ).bind(userId, invitation.org_id, invitation.email, at,
        verifier.encoded, verifier.effectiveIterations, at),
      /*
       * Redemption is a **compare-and-swap**, not an update.
       *
       * `redeemed_at IS NULL` is the whole of the once-only guarantee: two people pasting the same link at
       * the same moment both pass the read above, and the second loses here — with the account insert rolled
       * back in the same transaction, rather than two accounts existing and one invitation claiming to
       * explain both. The conflict is the signal, which is the pattern the claim, the case queue and the
       * audit sequence already use.
       */
      env.CATALOG.prepare(
        `UPDATE invitations SET redeemed_at = ?, redeemed_user_id = ?
          WHERE org_id = ? AND id = ? AND redeemed_at IS NULL`,
      ).bind(at, userId, invitation.org_id, invitation.id),
    ],
  ).catch((error: unknown) => {
    // A UNIQUE violation here is the race, not a fault. Anything else is, and is rethrown so a real problem
    // is not silently reported as an unusable invitation.
    if (error instanceof Error && /UNIQUE/i.test(error.message)) return null;
    throw error;
  });
  if (written === null) throw refuse();
  const { results } = written;

  // The batch is one transaction, so a lost race means the UPDATE matched nothing and the INSERT above it is
  // gone with it. Answering the same refusal as every other failure keeps the endpoint silent.
  if ((results[2]?.meta.changes ?? 0) === 0) throw refuse();

  return {
    userId,
    email: invitation.email,
    session: await issueSession(env, ctx, { orgId: invitation.org_id, userId }),
  };
}

export interface OpenInvitation {
  id: string;
  email: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  /** True once the clock has passed it. The row survives, so an administrator can see what went stale. */
  expired: boolean;
}

/** The outstanding invitations. Never the secrets — the table does not hold them. */
export async function openInvitations(env: Env, ctx: Ctx, orgId: string): Promise<OpenInvitation[]> {
  const { results } = await env.CATALOG.prepare(
    `SELECT id, email, invited_by, created_at, expires_at FROM invitations
      WHERE org_id = ? AND redeemed_at IS NULL ORDER BY created_at DESC`,
  ).bind(orgId).all<{
    id: string; email: string; invited_by: string; created_at: string; expires_at: string;
  }>();
  const now = ctx.now();
  return results.map((row) => ({
    id: row.id,
    email: row.email,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    expired: Date.parse(row.expires_at) <= now,
  }));
}
