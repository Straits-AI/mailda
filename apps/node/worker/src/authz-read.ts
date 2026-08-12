import type { Ctx } from "@mailda/runtime";
import { verifyAccessToken } from "./auth/jwt.ts";
import { ACCESS_COOKIE, cookieValue } from "./auth/session.ts";

/**
 * Read authorization for Layer 1 (§7).
 *
 * Every request re-evaluates the live relationship. §7 forbids trusting a token for ACL
 * state, so the session gives us a principal and nothing more — the relationship is looked
 * up server-side on every call, using the index whose column order #11 measured
 * (`org_id, subject_id, object_type, relation, object_id`; getting it wrong made every
 * check scan the organisation).
 */

export interface Principal {
  orgId: string;
  userId: string;
}

/**
 * Resolves a request to a principal, or null.
 *
 * The identity comes from the ES256 access token — a bearer header if one is present, otherwise
 * the HttpOnly cookie, because the same endpoints serve both the browser and a CLI.
 *
 * This **replaced** an opaque `sessions` row lookup rather than being added beside it. Two live
 * authentication mechanisms is the shape where one gets hardened and the other quietly becomes
 * the way in, and there is no version of that which is not a landmine. The `sessions` table is
 * consequently unused; #10's expand/contract makes dropping it a separate, later step, and it
 * is recorded as dead rather than left looking load-bearing.
 *
 * §7 is satisfied by what the token does *not* carry: no relations, no mailbox list. Authority
 * is re-read from `relationship_tuples` below on every single request, so removing a grant takes
 * effect on the next call regardless of what any outstanding token says.
 */
export async function principalFor(env: Env, ctx: Ctx, request: Request): Promise<Principal | null> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : null;
  const token = bearer ?? cookieValue(request, ACCESS_COOKIE);
  if (token === null || token === "") return null;

  const verified = await verifyAccessToken(env, token, ctx.now());
  if (!verified.ok) return null;
  return { orgId: verified.claims.org, userId: verified.claims.sub };
}

/**
 * May this principal read this mailbox? Direct grant or via a team, in two queries — the
 * shape #11 measured at 7 rows read and flat under 4x organisation growth.
 */
/**
 * Does this principal hold `relation` on this mailbox, directly or through a team?
 *
 * The one query shape for every relation, rather than a copy per verb. #11 measured *this* shape — two
 * queries, 7 rows read, flat under 4x organisation growth (`authz-check-rows-read.md`) — and a second
 * hand-written variant would be a second thing for that receipt to stop describing.
 *
 * Authority is re-read on every call and nothing is cached, which is what makes revocation take effect
 * immediately (§7, §28). That matters most on the send path, where the gap between deciding and acting
 * is a hold window rather than a request.
 */
async function hasRelation(
  env: Env,
  who: Principal,
  relation: string,
  mailboxId: string,
): Promise<boolean> {
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
        AND object_type = 'mailbox' AND relation = ? AND object_id = ?
      LIMIT 1`,
  )
    .bind(who.orgId, ...subjects, relation, mailboxId)
    .first();

  return tuple !== null;
}

/**
 * The subjects a principal authorizes as: themselves, plus every team they belong to.
 *
 * Extracted because it was written out by hand in two places — `hasRelation` and `listMessages` — and #45
 * happened in a third place that did not write it out at all. A read bounded by mailbox has to agree with
 * `hasRelation` about who the caller *is*, and the surest way to agree is to share the function rather
 * than the shape.
 */
export async function readableSubjects(env: Env, who: Principal): Promise<string[]> {
  const teams = await env.CATALOG.prepare(
    "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(who.orgId, who.userId)
    .all<{ team_id: string }>();
  return [who.userId, ...teams.results.map((row) => row.team_id)];
}

/**
 * Every mailbox on which this principal holds `relation`.
 *
 * The set form of `hasRelation`, for the paths that act on many mailboxes at once rather than checking one.
 * Same subjects, same tuple shape, so a sweep bounded by this and a check made by `hasRelation` cannot
 * disagree about what somebody holds.
 */
export async function mailboxesWithRelation(
  env: Env,
  who: Principal,
  relation: string,
): Promise<string[]> {
  const subjects = await readableSubjects(env, who);
  const placeholders = subjects.map(() => "?").join(", ");
  const { results } = await env.CATALOG.prepare(
    `SELECT DISTINCT object_id FROM relationship_tuples
      WHERE org_id = ? AND subject_id IN (${placeholders})
        AND object_type = 'mailbox' AND relation = ?`,
  )
    .bind(who.orgId, ...subjects, relation)
    .all<{ object_id: string }>();
  return results.map((row) => row.object_id);
}

export async function mayRead(env: Env, who: Principal, mailboxId: string): Promise<boolean> {
  return hasRelation(env, who, "mailbox.content.read", mailboxId);
}

/**
 * May this principal send *as* this mailbox?
 *
 * Layer 2's first named requirement, and it was absent: `sealManifest` verified only that the mailbox
 * belonged to the organisation, so any authenticated member could send as any mailbox — including one
 * they cannot read. Reading and sending are different authorities and this is a distinct relation, not
 * a synonym for `mailbox.content.read`: a shared invoices mailbox that several people read is exactly
 * the kind whose outbound identity should be held by fewer of them.
 *
 * Bound to the mailbox rather than to a sender address, because ADR 36 already makes `From` the mailbox
 * and `send_manifests.mailbox_id` is what a check has in hand. The blueprint's §29 sketch scopes it as
 * `sender:enquiries@example.com`; that finer grain is deferred knowingly rather than diverged from
 * silently — recorded here so the next reader finds the discrepancy explained.
 */
export async function maySend(env: Env, who: Principal, mailboxId: string): Promise<boolean> {
  return hasRelation(env, who, "send.propose", mailboxId);
}

type Authorized = { ok: true; blobKey: string } | { ok: false; response: Response };

/**
 * Authorizes a raw-evidence read.
 *
 * §5C requires that a denial never reveal whether the resource exists. An unauthorized
 * message and an absent one both return 404 with the same body, deliberately — the
 * distinction is visible in audit, never to the caller.
 */
export async function authorize(env: Env, ctx: Ctx, request: Request, receiptId: string): Promise<Authorized> {
  const notFound = {
    ok: false as const,
    response: Response.json(
      { error: "not_found", message: "No such message, or you do not have access to it." },
      { status: 404 },
    ),
  };

  const who = await principalFor(env, ctx, request);
  if (who === null) {
    return {
      ok: false,
      // refreshable: the caller may hold a live refresh token. Saying "signed out" here would
      // sign people out for an expired access token, which is the normal case, not a failure.
      response: Response.json(
        { error: "unauthenticated", message: "Sign in to read messages.", refreshable: true },
        { status: 401, headers: { "x-mailda-refreshable": "true" } },
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
export async function listMessages(env: Env, ctx: Ctx, request: Request): Promise<Response> {
  const who = await principalFor(env, ctx, request);
  if (who === null) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to read messages.", refreshable: true },
      { status: 401, headers: { "x-mailda-refreshable": "true" } },
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
    `SELECT r.id, r.envelope_from, r.envelope_to, r.raw_bytes, r.accepted_at,
            a.mailbox_id, m.id AS message_id, m.subject, m.from_addr, m.parse_error
       FROM ingress_receipts r
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
       LEFT JOIN messages m ON m.ingress_receipt_id = r.id
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
