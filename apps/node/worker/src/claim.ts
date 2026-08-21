import { ID_PREFIXES, type Ctx } from "@mailda/runtime";

import { claimSecretHash } from "./claim-secret.ts";

import { hashPassword, passwordProblem } from "./auth/password.ts";
import { issueSession, type IssuedSession } from "./auth/session.ts";

/**
 * Node claim and session issue (§5A).
 *
 * A freshly deployed Node is unclaimed: it has no organization, no owner, and it rejects
 * inbound mail rather than accepting something it cannot attribute. Claiming it consumes a
 * one-time secret produced at install, creates the first owner, and issues a session.
 *
 * Claim is also where the owner sets a **password**, and that is not incidental. The first
 * version of this flow issued exactly one session against a one-time secret and stored no
 * verifier — so the owner had precisely one way into their own Node, and losing that cookie
 * meant losing the Node. An install path that produces an account nobody can sign into again is
 * not an install path.
 *
 * What this deliberately does **not** do yet: register a passkey. §5A step 2 requires one, and
 * it is additive to this flow rather than a replacement for it — claim-then-session is the
 * permanent shape, and passkey registration slots into the claim step. Recording that
 * distinction because `AGENTS.md` forbids stopgaps, and this is an unfinished flow rather than
 * a temporary one.
 */


export interface ClaimOutcome {
  status: "claimed" | "already_claimed" | "bad_secret" | "not_installed" | "weak_password";
  orgId?: string;
  userId?: string;
  session?: IssuedSession;
  /** Set when status is weak_password: the four-part explanation, ready to show. */
  problem?: string;
}

/**
 * Consumes the one-time secret. Comparison is against a stored hash, and the claim row is
 * updated conditionally on still being unclaimed — so two concurrent attempts cannot both
 * succeed, without needing a transaction D1 does not offer (#10).
 */
export async function claimNode(
  env: Env,
  ctx: Ctx,
  secret: string,
  ownerEmail: string,
  password: string,
  organizationName: string,
): Promise<ClaimOutcome> {
  const claim = await env.CATALOG.prepare(
    "SELECT id, secret_hash, claimed_at FROM node_claim LIMIT 1",
  ).first<{ id: string; secret_hash: string; claimed_at: string | null }>();

  if (claim === null) {
    return { status: "not_installed" };
  }
  if (claim.claimed_at !== null) {
    return { status: "already_claimed" };
  }
  if ((await claimSecretHash(secret)) !== claim.secret_hash) {
    return { status: "bad_secret" };
  }

  // Checked before the secret is consumed. A one-time secret spent on a rejected password would
  // leave the Node permanently unclaimable — the failure mode is unrecoverable, so the
  // validation goes in front of the irreversible step.
  const problem = passwordProblem(password);
  if (problem !== null) {
    return { status: "weak_password", problem };
  }

  const orgId = ctx.id("org");
  const userId = ctx.id(ID_PREFIXES.user);
  const mailboxId = ctx.id(ID_PREFIXES.mailbox);
  const at = new Date(ctx.now()).toISOString();
  const verifier = await hashPassword(password);

  // One batch: the claim, the organization's first objects and the owner's read grant. Either
  // the Node is claimed and usable, or nothing happened (#5, §22).
  const results = await env.CATALOG.batch([
    // Conditional on still being unclaimed — this is what makes the race safe.
    env.CATALOG.prepare("UPDATE node_claim SET claimed_at = ?, org_id = ? WHERE id = ? AND claimed_at IS NULL")
      .bind(at, orgId, claim.id),
    // `password_salt` is deliberately not written: the salt travels inside the encoded verifier
    // now, so the column is dead. Dropping it is a separate contract step (#10), and leaving it
    // unmentioned would make it look load-bearing.
    env.CATALOG.prepare(
      `INSERT INTO users (id, org_id, email, created_at, password_hash, password_iterations, password_updated_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      userId, orgId, ownerEmail.toLowerCase(), at,
      verifier.encoded, verifier.effectiveIterations, at,
    ),
    env.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(mailboxId, orgId, organizationName, at),
    // The owner's live relationships. §7 evaluates these per request; they are never in a token.
    //
    // Reading and sending are granted separately even though the owner gets both here, because they are
    // different authorities: a shared mailbox several people read is exactly the kind whose outbound
    // identity should be held by fewer of them. Granting `send.propose` in the *same batch* as the check
    // that requires it is not tidiness — a check shipped without its grant denies the Node's own owner
    // and leaves a freshly claimed Node unable to send at all.
    env.CATALOG.prepare(
      `INSERT INTO relationship_tuples
         (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), orgId, userId, "mailbox.content.read", "mailbox", mailboxId, at),
    env.CATALOG.prepare(
      `INSERT INTO relationship_tuples
         (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), orgId, userId, "send.propose", "mailbox", mailboxId, at),
    // `message.export` (#65). Granted here for the same reason `send.propose` is: Layer 1's proof is that
    // the original `.eml` is exportable, and `GET /api/messages/:id/raw` now requires this relation — so a
    // Node whose owner did not hold it would be one that could receive mail and not produce the copy the
    // layer is proven by. Existing Nodes get it from migration 0025's backfill; this is the same grant for
    // a Node that never had a `mailbox.content.read` row to backfill from.
    //
    // Separate from the read grant above rather than folded into it, because the whole value of the
    // relation is that an administrator can revoke one without the other.
    env.CATALOG.prepare(
      `INSERT INTO relationship_tuples
         (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), orgId, userId, "message.export", "mailbox", mailboxId, at),
  ]);

  // If the conditional update changed nothing, someone else claimed it between our read and
  // our write. The rest of the batch committed against an org that never became the Node's,
  // which is harmless — but we must not report success.
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return { status: "already_claimed" };
  }

  // After the claim commits, not inside the batch: issuing a session generates a signing key on
  // first use, and a key is not something to mint speculatively inside a transaction that may
  // yet be found to have lost a race.
  return { status: "claimed", orgId, userId, session: await issueSession(env, ctx, { orgId, userId }) };
}

/**
 * Records the install-time secret. Never exposed over HTTP.
 *
 * Its documented caller was `mailda deploy`, which did not exist — so for four layers the secret a
 * `POST /api/claim` verifies was written by nothing, and the only caller of this function was its own test
 * (#80). `mailda claim-secret` writes it now, through `scripts/seed-claim-secret.mjs`, which shares this
 * file's hashing rather than reimplementing it.
 */
export async function seedClaimSecret(env: Env, ctx: Ctx, secret: string): Promise<void> {
  await env.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,NULL,NULL)",
  )
    .bind(ctx.id("clm"), await claimSecretHash(secret))
    .run();
}
