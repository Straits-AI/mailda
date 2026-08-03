
/**
 * Read authorization for Layer 1 (§7).
 *
 * Every request re-evaluates the live relationship. §7 forbids trusting a token for ACL
 * state, so the session gives us a principal and nothing more — the relationship is looked
 * up server-side on every call, using the index whose column order #11 measured
 * (`org_id, subject_id, object_type, relation, object_id`; getting it wrong made every
 * check scan the organisation).
 */

const SESSION_COOKIE = "mailda_session";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Principal {
  orgId: string;
  userId: string;
}

/** Resolves a session cookie to a principal, or null. Expiry is checked here, not cached. */
export async function principalFor(env: Env, request: Request): Promise<Principal | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE}=([A-Za-z0-9_-]+)`).exec(cookie);
  if (!match) return null;

  const row = await env.CATALOG.prepare(
    "SELECT org_id, user_id, expires_at FROM sessions WHERE token_hash = ? LIMIT 1",
  )
    .bind(await sha256Hex(match[1]!))
    .first<{ org_id: string; user_id: string; expires_at: string }>();

  if (row === null) return null;
  // §7: revocation must take effect on the next request, so expiry is evaluated live.
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return { orgId: row.org_id, userId: row.user_id };
}

/**
 * May this principal read this mailbox? Direct grant or via a team, in two queries — the
 * shape #11 measured at 7 rows read and flat under 4x organisation growth.
 */
export async function mayRead(env: Env, who: Principal, mailboxId: string): Promise<boolean> {
  const teams = await env.CATALOG.prepare(
    "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(who.orgId, who.userId)
    .all<{ team_id: string }>();

  const subjects = [who.userId, ...teams.results.map((r) => r.team_id)];
  const placeholders = subjects.map(() => "?").join(", ");

  const tuple = await env.CATALOG.prepare(
    `SELECT 1 FROM relationship_tuples
      WHERE org_id = ? AND subject_id IN (${placeholders})
        AND object_type = 'mailbox' AND relation = 'mailbox.content.read' AND object_id = ?
      LIMIT 1`,
  )
    .bind(who.orgId, ...subjects, mailboxId)
    .first();

  return tuple !== null;
}

type Authorized = { ok: true; blobKey: string } | { ok: false; response: Response };

/**
 * Authorizes a raw-evidence read.
 *
 * §5C requires that a denial never reveal whether the resource exists. An unauthorized
 * message and an absent one both return 404 with the same body, deliberately — the
 * distinction is visible in audit, never to the caller.
 */
export async function authorize(env: Env, request: Request, receiptId: string): Promise<Authorized> {
  const notFound = {
    ok: false as const,
    response: Response.json(
      { error: "not_found", message: "No such message, or you do not have access to it." },
      { status: 404 },
    ),
  };

  const who = await principalFor(env, request);
  if (who === null) {
    return {
      ok: false,
      response: Response.json(
        { error: "unauthenticated", message: "Sign in to read messages." },
        { status: 401 },
      ),
    };
  }

  const row = await env.CATALOG.prepare(
    `SELECT r.blob_key, a.mailbox_id
       FROM ingress_receipts r
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
      WHERE r.org_id = ? AND r.id = ? LIMIT 1`,
  )
    .bind(who.orgId, receiptId)
    .first<{ blob_key: string; mailbox_id: string }>();

  if (row === null) return notFound;
  if (!(await mayRead(env, who, row.mailbox_id))) return notFound;
  return { ok: true, blobKey: row.blob_key };
}

/** Messages the caller may actually see. §5 requires authorization before any listing. */
export async function listMessages(env: Env, request: Request): Promise<Response> {
  const who = await principalFor(env, request);
  if (who === null) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to read messages." },
      { status: 401 },
    );
  }

  const teams = await env.CATALOG.prepare(
    "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(who.orgId, who.userId)
    .all<{ team_id: string }>();

  const subjects = [who.userId, ...teams.results.map((r) => r.team_id)];
  const placeholders = subjects.map(() => "?").join(", ");

  // Authorization is inside the query, not a filter applied afterwards — §5 forbids
  // returning counts or snippets for anything the caller cannot see.
  const rows = await env.CATALOG.prepare(
    `SELECT r.id, r.envelope_from, r.envelope_to, r.raw_bytes, r.accepted_at
       FROM ingress_receipts r
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
      WHERE r.org_id = ?
        AND a.mailbox_id IN (
          SELECT object_id FROM relationship_tuples
           WHERE org_id = ? AND subject_id IN (${placeholders})
             AND object_type = 'mailbox' AND relation = 'mailbox.content.read'
        )
      ORDER BY r.accepted_at DESC
      LIMIT 50`,
  )
    .bind(who.orgId, who.orgId, ...subjects)
    .all();

  return Response.json({ messages: rows.results });
}
