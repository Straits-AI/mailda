import type { Ctx } from "@mailda/runtime";


/**
 * Node claim and session issue (§5A).
 *
 * A freshly deployed Node is unclaimed: it has no organization, no owner, and it rejects
 * inbound mail rather than accepting something it cannot attribute. Claiming it consumes a
 * one-time secret produced at install, creates the first owner, and issues a session.
 *
 * What this deliberately does **not** do yet: register a passkey. §5A step 2 requires one,
 * and it is additive to this flow rather than a replacement for it — claim-then-session is
 * the permanent shape, and passkey registration slots into the claim step. Recording that
 * distinction because `AGENTS.md` forbids stopgaps, and this is an unfinished flow rather
 * than a temporary one.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 12;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** URL-safe token. Uses ctx so §27 replay is deterministic (#6). */
function tokenFrom(ctx: Ctx): string {
  return [...ctx.random(32)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ClaimOutcome {
  status: "claimed" | "already_claimed" | "bad_secret" | "not_installed";
  orgId?: string;
  userId?: string;
  sessionToken?: string;
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
  if ((await sha256Hex(secret)) !== claim.secret_hash) {
    return { status: "bad_secret" };
  }

  const orgId = ctx.id("org");
  const userId = ctx.id("usr");
  const mailboxId = ctx.id("mbx");
  const token = tokenFrom(ctx);
  const at = new Date(ctx.now()).toISOString();
  const expires = new Date(ctx.now() + SESSION_TTL_SECONDS * 1000).toISOString();

  // One batch: the claim, the organization's first objects, the owner's read grant and the
  // session. Either the Node is claimed and usable, or nothing happened (#5, §22).
  const results = await env.CATALOG.batch([
    // Conditional on still being unclaimed — this is what makes the race safe.
    env.CATALOG.prepare("UPDATE node_claim SET claimed_at = ?, org_id = ? WHERE id = ? AND claimed_at IS NULL")
      .bind(at, orgId, claim.id),
    env.CATALOG.prepare("INSERT INTO users (id, org_id, email, created_at) VALUES (?,?,?,?)")
      .bind(userId, orgId, ownerEmail.toLowerCase(), at),
    env.CATALOG.prepare("INSERT INTO mailboxes (id, org_id, name, created_at) VALUES (?,?,?,?)")
      .bind(mailboxId, orgId, organizationName, at),
    // The owner's live relationship. §7 evaluates this per request; it is never in a token.
    env.CATALOG.prepare(
      `INSERT INTO relationship_tuples
         (id, org_id, subject_id, relation, object_type, object_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(ctx.id("rt"), orgId, userId, "mailbox.content.read", "mailbox", mailboxId, at),
    env.CATALOG.prepare(
      "INSERT INTO sessions (id, org_id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?,?)",
    ).bind(ctx.id("ses"), orgId, userId, await sha256Hex(token), expires, at),
  ]);

  // If the conditional update changed nothing, someone else claimed it between our read and
  // our write. The rest of the batch committed against an org that never became the Node's,
  // which is harmless — but we must not report success.
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return { status: "already_claimed" };
  }

  return { status: "claimed", orgId, userId, sessionToken: token };
}

/** The Set-Cookie a claimed session needs. HttpOnly and SameSite=Lax, so a cross-site POST cannot use it. */
export function sessionCookie(token: string): string {
  return [
    `mailda_session=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join("; ");
}

/** Records the install-time secret. Called by `mailda deploy`, never exposed over HTTP. */
export async function seedClaimSecret(env: Env, ctx: Ctx, secret: string): Promise<void> {
  await env.CATALOG.prepare(
    "INSERT INTO node_claim (id, secret_hash, claimed_at, org_id) VALUES (?,?,NULL,NULL)",
  )
    .bind(ctx.id("clm"), await sha256Hex(secret))
    .run();
}
