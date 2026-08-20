import type { Ctx } from "@mailda/runtime";
import type { MailboxRelation } from "./access.ts";
import { verifyAccessToken } from "./auth/jwt.ts";
import { ACCESS_COOKIE, cookieValue } from "./auth/session.ts";
import {
  liveGrantMailboxes, liveGrantOnMailbox, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA,
  type SupervisedScope,
} from "./supervised.ts";

/**
 * Read authorization for Layer 1 (§7).
 *
 * Every request re-evaluates the live relationship. §7 forbids trusting a token for ACL
 * state, so the session gives us a principal and nothing more — the relationship is looked
 * up server-side on every call, using the index whose column order #11 measured
 * (`org_id, subject_id, object_type, relation, object_id`; getting it wrong made every
 * check scan the organisation).
 *
 * ## Two structures answer "who can read this mailbox", and which paths accept each
 *
 * A **standing relation** is a `relationship_tuples` row, held by a person or by a team, with no end. A
 * **supervised grant** (#63) is a `supervised_grants` row: one person, one mailbox, one scope, a matter or
 * none, and a hard deadline, granted only by two people who are not the reader. They are different things and
 * §7 wants them distinguishable, so they are two tables — and every read path here decides deliberately which
 * of the two it accepts:
 *
 * | Path | Standing relation | Supervised grant | Why |
 * |:--|:--|:--|:--|
 * | `mayRead` | `mailbox.content.read` | scope `content` | Reading the bytes is what a supervised read is for. |
 * | `mayReadMetadata` | `metadata.read` or `content.read` | scope `metadata` or `content` | Content is the stronger authority on both sides. |
 * | `listMessages` | `mailbox.content.read` | scope `metadata` or `content` | An investigation starts with a query; a grant that could not list would be a grant nobody could use. |
 * | `holdsStandingRead` | `mailbox.content.read` | **no** | The gate in front of `mergeConversations`. Reading is not restructuring. |
 * | `maySend` | `send.propose` | **no** | Reading somebody's mail is not authority to write as them. |
 * | `mailboxesWithRelation` | the named relation | **no** | Only ever asked about `send.propose`, and a supervised grant is not a relation this returns. |
 *
 * Two of those rows are the ones worth arguing about.
 *
 * **`holdsStandingRead` exists so that `supervised.read` cannot merge conversations.** `mergeConversations`
 * gates on being able to read every mailbox the two conversations touch, and merging is irreversible
 * restructuring of somebody else's queue. A supervised reader passing that gate would be a *read* grant
 * authorizing a *write*, which is the "grants too much" failure — worse than the "grants nothing" one this
 * repository keeps hitting, because nothing would report it.
 *
 * **`mayReadMetadata`'s only call site is gated on `send.propose` first**, so a supervised grant does not by
 * itself put a mailbox in anybody's queue. That is deliberate — a supervised reader is not a member of the
 * queue and should not appear to be working it — and it means the supervised arm of that function is
 * unreachable through `queueFor` today. It is there anyway, because the alternative is two functions
 * disagreeing about whether one person may see one mailbox's subject lines, and the one that would be wrong is
 * whichever a later caller happened to pick. `listMessages` is where the metadata scope is reachable.
 *
 * ## The cost of the supervised arm, and why it is a `UNION ALL` rather than a second query
 *
 * `authz.check.max_queries = 2` is a measured tripwire (`docs/receipts/authz-check-rows-read.md`). A second
 * round trip to look for a grant would break it on every check, so the grant lookup is folded into the same
 * statement as the tuple lookup and short-circuits on `LIMIT 1`. `sgr_live` is **partial** on
 * `granted_at IS NOT NULL`, so on a Node where nobody holds supervised access the extra arm seeks an empty
 * index. Measured both ways in `test/authz.measure.test.ts`, because "by construction" is what the full-table
 * scan #11 found also looked like.
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
 * Does this principal hold **any** of these relations on this mailbox, directly or through a team?
 *
 * The one query shape for every relation, rather than a copy per verb. #11 measured *this* shape — two
 * queries, 7 rows read, flat under 4x organisation growth (`authz-check-rows-read.md`) — and a second
 * hand-written variant would be a second thing for that receipt to stop describing.
 *
 * The set form exists because one surface genuinely satisfies on either of two relations: the queue's
 * message-derived columns need `mailbox.metadata.read` **or** `mailbox.content.read`, and a caller holding
 * the stronger one being told they lack the weaker would be a rule nobody could defend. It is a widened
 * `relation IN (…)` rather than two calls, so a two-relation check still costs the same two round trips —
 * measured as `check.two_relations` in `authz.measure.test.ts` and inside the same budget.
 *
 * This is **not** relation implication. Nothing here says content.read *confers* metadata.read; one call site
 * names both relations it accepts. A general implication graph is the delegation that `access.ts` refused, and
 * for the same reason: it turns "who can reach this mailbox" from a list into a traversal.
 *
 * Authority is re-read on every call and nothing is cached, which is what makes revocation take effect
 * immediately (§7, §28). That matters most on the send path, where the gap between deciding and acting
 * is a hold window rather than a request.
 */
async function hasAnyRelation(
  env: Env,
  who: Principal,
  relations: readonly MailboxRelation[],
  mailboxId: string,
  /**
   * The supervised scopes that also satisfy this check, or `null` for a check no grant may satisfy.
   *
   * `null` is not "none by default": every caller states one, so a new read path has to decide rather than
   * inherit. When it is `null` the statement below is **byte for byte** the one #11 measured, which is what
   * keeps `maySend` and the merge gate exactly as expensive as they were.
   */
  supervised: { scopes: readonly SupervisedScope[]; at: string } | null,
): Promise<boolean> {
  const teams = await env.CATALOG.prepare(
    "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(who.orgId, who.userId)
    .all<{ team_id: string }>();

  const subjects = [who.userId, ...teams.results.map((r) => r.team_id)];
  const placeholders = subjects.map(() => "?").join(", ");
  const relationPlaceholders = relations.map(() => "?").join(", ");

  const standing = `SELECT 1 FROM relationship_tuples
      WHERE org_id = ? AND subject_id IN (${placeholders})
        AND object_type = 'mailbox' AND relation IN (${relationPlaceholders}) AND object_id = ?`;
  const standingParams = [who.orgId, ...subjects, ...relations, mailboxId];

  // One statement, two arms, `LIMIT 1` over the compound — so a caller holding the standing relation stops at
  // the first arm and a supervised reader is answered without a second round trip.
  const grant = supervised === null
    ? null
    : liveGrantOnMailbox(who.orgId, who.userId, mailboxId, supervised.at, supervised.scopes);

  const tuple = await env.CATALOG.prepare(
    grant === null ? `${standing} LIMIT 1` : `${standing} UNION ALL ${grant.sql} LIMIT 1`,
  )
    .bind(...standingParams, ...(grant === null ? [] : grant.params))
    .first();

  return tuple !== null;
}

/**
 * The subjects a principal authorizes as: themselves, plus every team they belong to.
 *
 * Extracted because it was written out by hand in two places — `hasAnyRelation` and `listMessages` — and #45
 * happened in a third place that did not write it out at all. A read bounded by mailbox has to agree with
 * `hasAnyRelation` about who the caller *is*, and the surest way to agree is to share the function rather
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
 * The many-objects form, for the paths that act on every mailbox at once rather than checking one. Same
 * subjects, same tuple shape, so a sweep bounded by this and a check made by `hasAnyRelation` cannot
 * disagree about what somebody holds.
 *
 * **Tuples only, and no supervised arm**, which is decided rather than overlooked: its one caller asks for
 * `send.propose` to bound a dispatch sweep, and no supervised grant ever confers that. An arm here would
 * answer a question nobody asks. If a caller ever needs *"which mailboxes may this person read"*, the honest
 * shape is a different function that takes the clock — because a grant expires and a tuple does not, and a
 * list with no instant in it could not say which answer it was giving.
 *
 * `MailboxRelation` rather than `string`, so a mistyped relation is a compile error. It used to be `string`,
 * which is the exact hazard this repository's house rules name: a typo compiled, matched no tuple, and
 * silently bounded a sweep to nothing.
 */
export async function mailboxesWithRelation(
  env: Env,
  who: Principal,
  relation: MailboxRelation,
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

/**
 * May this principal read the **content** of mail in this mailbox — a standing relation, or a live supervised
 * grant wide enough to reach the bytes?
 *
 * `ctx` rather than an instant, deliberately. A caller handed an `at` parameter can pass the wrong one, and the
 * wrong one here is a message's own timestamp — which would make an expired grant work for ever on old mail
 * and fail on new. The instant is taken from the clock inside, so there is nothing to get wrong.
 */
export async function mayRead(
  env: Env,
  ctx: Ctx,
  who: Principal,
  mailboxId: string,
): Promise<boolean> {
  return hasAnyRelation(env, who, ["mailbox.content.read"], mailboxId, {
    scopes: SCOPES_FOR_CONTENT,
    at: new Date(ctx.now()).toISOString(),
  });
}

/**
 * Does this principal hold the **standing** content relation on this mailbox — no supervised grant counted?
 *
 * The one read gate a supervised grant deliberately does not satisfy, and it has exactly one caller:
 * `mergeConversations`, which uses "can you read every mailbox these conversations touch" as the test for
 * whether merging them is something you could be accountable for. Merging is irreversible restructuring of
 * other people's queues, and a *read* grant that authorized a *write* would be the widening this relation must
 * not be. Named as a separate function rather than a boolean argument to `mayRead`, so the difference is
 * visible at the call site and in this list.
 */
export async function holdsStandingRead(
  env: Env,
  who: Principal,
  mailboxId: string,
): Promise<boolean> {
  return hasAnyRelation(env, who, ["mailbox.content.read"], mailboxId, null);
}

/**
 * May this principal see the **metadata** of mail in this mailbox — subject lines, sender addresses?
 *
 * The relation this implements is `mailbox.metadata.read`, from the blueprint's own permission catalogue
 * (`:697`), and it existed nowhere in this codebase until now: one mention, in a test seed, granted by
 * nothing. Its absence was not harmless. The queue is gated on `send.propose` and returns
 * `messages.subject` and `messages.from_addr`, so **anybody who could reply read every subject line and
 * sender address in the mailbox**, with no relation saying so and nothing recording it. Reproduced before
 * it was fixed: `send.propose` alone returned `"Redundancy list, confidential"` from `hr@customer.example`.
 *
 * §7 is explicit that this is not allowed — a case relation "never implies `message.read`", and
 * participants and snippets "are individually authorized from their source delivery". The fix implements
 * the contract rather than amending it.
 *
 * Satisfied by either relation. `mailbox.content.read` is strictly the stronger authority — you cannot read
 * a body without seeing its subject — so requiring the weaker one *as well* would be a rule with no
 * defence, and the pair is named here rather than expressed as an implication (see `hasAnyRelation`).
 *
 * A supervised grant of **either** scope satisfies it, by the same asymmetry on the other structure. Its only
 * call site is gated on `send.propose` first, so this does not put a supervised reader's mailbox in their
 * queue — see this module's header for why the arm is here regardless.
 */
export async function mayReadMetadata(
  env: Env,
  ctx: Ctx,
  who: Principal,
  mailboxId: string,
): Promise<boolean> {
  return hasAnyRelation(env, who, ["mailbox.metadata.read", "mailbox.content.read"], mailboxId, {
    scopes: SCOPES_FOR_METADATA,
    at: new Date(ctx.now()).toISOString(),
  });
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
  // No supervised arm, and it is the clearest of the six decisions: §7's supervised access is a **read**.
  // Being allowed to examine somebody's mail for a matter is not authority to write as them, and a grant that
  // conferred it would let an investigator send from the mailbox they are investigating.
  return hasAnyRelation(env, who, ["send.propose"], mailboxId, null);
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
  // The one raw-evidence read in the product, and it is authorized **per request** — which is what makes a
  // supervised grant's expiry a hard stop with no mechanism behind it. Nothing presigns and nothing streams,
  // so there is no capability that outlives this call for an expiry to have to revoke (§7's enumeration came
  // back empty). `test/supervised-read.test.ts` proves the stop through this function.
  if (!(await mayRead(env, ctx, who, row.mailbox_id))) return notFound;
  return { ok: true, blobKey: row.blob_key };
}

/**
 * Messages the caller may actually see. §5 requires authorization before any listing.
 *
 * **This is where a supervised grant becomes usable**, and the reason is what §7 asks for: it lists *query*
 * first among the supervised acts, and a grant that could not list would only let somebody open a message
 * whose receipt id they already knew — useless for an investigation and therefore a relation that grants
 * nothing, which is the failure this repository keeps finding. Either scope satisfies it: the columns returned
 * are subject line, sender address and size, which is what `mailbox.metadata.read` covers.
 *
 * The supervised arm is a `UNION` inside the same mailbox sub-select, so this is still two queries and stays
 * inside `authz.list.max_rows_read`. `UNION` rather than `UNION ALL` here, unlike the single-mailbox check:
 * the result feeds an `IN`, and a mailbox somebody holds both a relation and a grant on would otherwise appear
 * twice for the planner to de-duplicate anyway.
 *
 * **What this listing does not yet do is record itself.** §7 requires a `supervised.query` entry naming the ids
 * it returned, and #63 part B owns it — see `src/audit.ts`, where the three actions are named and deliberately
 * not declared. So a supervised reader listing a mailbox today leaves the grant in the trail and the query
 * outside it. That is a real gap in §7's contract, stated here because this is the function it is about.
 */
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
  const supervised = liveGrantMailboxes(
    who.orgId, who.userId, new Date(ctx.now()).toISOString(), SCOPES_FOR_METADATA,
  );

  // Authorization is inside the query, not a filter applied afterwards — §5 forbids
  // returning counts or snippets for anything the caller cannot see.
  const rows = await env.CATALOG.prepare(
    // `case_id` travels with the message so the reply button can claim in one act (#42). Without it the
    // interface would have to fetch a queue to find the case for the message it is already showing, and
    // "claim then compose" would be two round trips wearing one gesture.
    //
    // Correlated on the delivery's own mailbox, so it is the case in *this* queue — a conversation reaching
    // two mailboxes has a case in each, and the one that matters is the one belonging to the mailbox this
    // reader is looking at.
    `SELECT r.id, r.envelope_from, r.envelope_to, r.raw_bytes, r.accepted_at,
            a.mailbox_id, m.id AS message_id, m.subject, m.from_addr, m.parse_error,
            m.conversation_id,
            (SELECT c.id FROM cases c
              WHERE c.org_id = r.org_id AND c.conversation_id = m.conversation_id
                AND c.mailbox_id = a.mailbox_id LIMIT 1) AS case_id
       FROM ingress_receipts r
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
       LEFT JOIN messages m ON m.ingress_receipt_id = r.id
      WHERE r.org_id = ?
        AND a.mailbox_id IN (
          SELECT object_id FROM relationship_tuples
           WHERE org_id = ? AND subject_id IN (${placeholders})
             AND object_type = 'mailbox' AND relation = 'mailbox.content.read'
          UNION
          ${supervised.sql}
        )
      ORDER BY r.accepted_at DESC
      LIMIT 50`,
  )
    .bind(who.orgId, who.orgId, ...subjects, ...supervised.params)
    .all();

  return Response.json({ messages: rows.results });
}
