import type { Ctx } from "@mailda/runtime";
import type { MailboxRelation } from "./access.ts";
import { recordDisclosure } from "./audit.ts";
import { verifyAccessToken } from "./auth/jwt.ts";
import { ACCESS_COOKIE, cookieValue } from "./auth/session.ts";
import {
  buildSupervisedQuery, liveGrantsBySubject, liveGrantOnMailbox, SCOPES_FOR_CONTENT, SCOPES_FOR_METADATA,
  supervisedActEvent, type SupervisedAct, type SupervisedScope,
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
 * queue and should not appear to be working it.
 *
 * Part A called the supervised arm of that function *unreachable* on that basis, and **that was one relation
 * too strong**: `send.propose` and `mailbox.content.read` are separate relations, so a drafter who may propose
 * sends from a mailbox they may not read is expressible, and for that person a grant is exactly what puts
 * subject lines on the screen. So the arm is live, it owes a record, and `mayReadMetadata` returns the grant
 * rather than a boolean so its caller can write one. Corrected here rather than left standing, because "this
 * cannot happen" is the sentence that stops anybody checking.
 *
 * ## The cost of the supervised arm, and why it is a `UNION ALL` rather than a second query
 *
 * `authz.check.max_queries = 2` is a measured tripwire (`docs/receipts/authz-check-rows-read.md`). A second
 * round trip to look for a grant would break it on every check, so the grant lookup is folded into the same
 * statement as the tuple lookup and short-circuits on `LIMIT 1`. `sgr_live` is **partial** on
 * `granted_at IS NOT NULL`, so on a Node where nobody holds supervised access the extra arm seeks an empty
 * index. Measured both ways in `test/authz.measure.test.ts`, because "by construction" is what the full-table
 * scan #11 found also looked like.
 *
 * ## Recording lives inside the decision, and that is the point of the extra parameter (#63 part B)
 *
 * §7 requires a record of every supervised query, result opened and attachment read, and a supervised read
 * that is not recorded is the whole defect the mechanism exists to prevent. So the record is not a call a
 * caller makes afterwards — it is **a parameter a caller cannot omit**. `mayRead` takes a `SupervisedAct`,
 * appends the entry inside itself when it is a *grant* that authorized, and only then returns `true`. A read
 * path added next year gets both or neither, enforced by the compiler rather than by review.
 *
 * Two consequences worth naming, because each is a decision:
 *
 * - **A standing relation records nothing.** `UNION ALL … LIMIT 1` stops at the tuple arm, so somebody who
 *   holds the ordinary relation never reaches the grant arm and never produces a supervised entry. That is
 *   correct — they are not reading under supervision — and it is also free.
 * - **The append can refuse the read.** `recordDisclosure` throws where `audit` would swallow, so a Node that
 *   cannot write its trail does not hand over the bytes. Failing closed is the only direction that makes the
 *   record mean anything.
 *
 * `listMessages` cannot use that shape, and the reason is real rather than a shortcut: its authorization
 * precedes its result, so an entry written at the check would be written blind and could not name the ids §7
 * asks for. It records after the rows come back, and what keeps that structural is that the grant ids come
 * only from `liveGrantsBySubject` — one builder, whose callers `test/node/matter-and-scope-world.test.ts`
 * requires to emit `supervised.query` before they return.
 */

export interface Principal {
  orgId: string;
  userId: string;
}

/**
 * The answer to *"may this principal read this"*, and **how** — because the two answers owe different things.
 *
 * A boolean was enough while nothing had to be recorded. §7's per-act record is owed by a supervised read and
 * not by an ordinary one, so the check has to say which authority answered; a `true` that could not
 * distinguish them would make every read path guess, and the guess that hides is the one that decides an
 * unrecorded supervised read was ordinary.
 *
 * `grantId` is null on both a refusal and a standing relation, which is why `allowed` is a separate field
 * rather than being read off the id. Two facts, two fields.
 */
export interface Authority {
  allowed: boolean;
  /** The grant that answered, or null when a standing relation did — or when nothing did. */
  grantId: string | null;
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
): Promise<Authority> {
  const teams = await env.CATALOG.prepare(
    "SELECT team_id FROM team_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(who.orgId, who.userId)
    .all<{ team_id: string }>();

  const subjects = [who.userId, ...teams.results.map((r) => r.team_id)];
  const placeholders = subjects.map(() => "?").join(", ");
  const relationPlaceholders = relations.map(() => "?").join(", ");

  // `NULL AS grant_id` rather than `1`, so both arms have one column of the same name and the row that comes
  // back says **which** arm answered. A standing relation is not a grant, and the difference decides whether
  // an entry is owed — conflating them would either record an ordinary read as supervised or fail to record a
  // supervised one, and only the second is a defect that hides.
  const standing = `SELECT NULL AS grant_id FROM relationship_tuples
      WHERE org_id = ? AND subject_id IN (${placeholders})
        AND object_type = 'mailbox' AND relation IN (${relationPlaceholders}) AND object_id = ?`;
  const standingParams = [who.orgId, ...subjects, ...relations, mailboxId];

  // One statement, two arms, `LIMIT 1` over the compound — so a caller holding the standing relation stops at
  // the first arm and a supervised reader is answered without a second round trip.
  const grant = supervised === null
    ? null
    : liveGrantOnMailbox(who.orgId, who.userId, mailboxId, supervised.at, supervised.scopes);

  const row = await env.CATALOG.prepare(
    grant === null ? `${standing} LIMIT 1` : `${standing} UNION ALL ${grant.sql} LIMIT 1`,
  )
    .bind(...standingParams, ...(grant === null ? [] : grant.params))
    .first<{ grant_id: string | null }>();

  if (row === null) return { allowed: false, grantId: null };
  return { allowed: true, grantId: row.grant_id };
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
  /**
   * What is about to be disclosed if this answers yes. **Not optional, and that is the mechanism.**
   *
   * §7 requires every supervised result opened and attachment read to be recorded, and the only way to make
   * that structural rather than remembered is to put the record where the authorization decision is made. A
   * caller cannot obtain this authority without naming the act, because the parameter is required; and when
   * a grant is what authorized, the entry is appended **before** this returns `true`.
   */
  act: SupervisedAct,
): Promise<boolean> {
  const authority = await hasAnyRelation(env, who, ["mailbox.content.read"], mailboxId, {
    scopes: SCOPES_FOR_CONTENT,
    at: new Date(ctx.now()).toISOString(),
  });
  if (!authority.allowed) return false;
  // Null means a standing relation answered: an ordinary read of a mailbox this person holds, which §7 does
  // not ask to be recorded per act and `audit-and-log-retention.md` sizes on the assumption it is not.
  if (authority.grantId === null) return true;
  // Throws if it cannot append, so the caller never reaches the bytes. See `recordDisclosure`.
  await recordDisclosure(env, ctx, who.orgId,
    [supervisedActEvent(act, authority.grantId, who.userId, mailboxId)]);
  return true;
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
  return (await hasAnyRelation(env, who, ["mailbox.content.read"], mailboxId, null)).allowed;
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
 * queue — but it is **not** unreachable, which part A said and which is worth correcting here: a person
 * holding `send.propose` and no read relation is expressible (a drafter on a mailbox they may not read), and
 * a supervised grant is what would then show them subject lines.
 *
 * **So this returns the grant, and the caller owes an entry.** It cannot record for itself the way `mayRead`
 * does: this authorizes a *listing*, and the rows it discloses do not exist yet at the moment of the check, so
 * an entry written here would say a supervised reader saw a queue and be unable to say which cases — which is
 * the understatement §7's ids requirement exists to refuse. `queueFor` records after its rows come back.
 */
export async function mayReadMetadata(
  env: Env,
  ctx: Ctx,
  who: Principal,
  mailboxId: string,
): Promise<Authority> {
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
  return (await hasAnyRelation(env, who, ["send.propose"], mailboxId, null)).allowed;
}

type Authorized = { ok: true; blobKey: string } | { ok: false; response: Response };

/**
 * Authorizes a raw-evidence read.
 *
 * §5C requires that a denial never reveal whether the resource exists. An unauthorized
 * message and an absent one both return 404 with the same body, deliberately — the
 * distinction is visible in audit, never to the caller.
 */
export async function authorize(
  env: Env,
  ctx: Ctx,
  request: Request,
  receiptId: string,
  /**
   * Which supervised act this read is, if a grant is what authorizes it.
   *
   * Two routes reach this function and they disclose different amounts: `/body` renders one message's text
   * (`supervised.opened`) and `/raw` streams the original `.eml`, which carries **every attachment**
   * (`supervised.attachment`). One action for both would make §7's *attachment read* unanswerable from the
   * trail, so the route names which it is — required, for `mayRead`'s reason.
   */
  action: SupervisedAct["action"],
): Promise<Authorized> {
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
  if (!(await mayRead(env, ctx, who, row.mailbox_id, { action, subject: receiptId }))) return notFound;
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
 * The supervised arm is a `LEFT JOIN` on to a derived table of this person's live grants, and the mailbox
 * predicate accepts either arm — a standing relation, or a grant. Still **two queries**, which is what keeps
 * this inside `authz.list.max_rows_read`, and the join is what part B needed: an `IN (…)` could say a mailbox
 * was reachable and could not say **which grant** made it so, and an entry that cannot name its grant cannot
 * be filtered by the access it belongs to.
 *
 * ## The query records itself, and what the entry says (#63 part B, §7)
 *
 * §7 lists *query* first among the acts that must be recorded, and #63 settled that a query entry carries
 * **the ids it returned** rather than only a count: a result list renders subject and sender, so "a query
 * matched 40 things" understates what a person saw by forty subjects. One entry per grant per query, split
 * into continuation entries if the id list would not fit `audit.max_detail_bytes` — never truncated, because
 * a truncated list records a prefix and understates the exposure.
 *
 * **The entry is appended before the response is built**, and `recordDisclosure` throws, so a listing this
 * Node cannot record is a listing it does not return.
 *
 * **A row is attributed to a grant whenever a live grant covers its mailbox**, without asking whether a
 * standing relation would also have sufficed. That over-records the person who holds both — and the direction
 * is chosen: an unrecorded supervised query is the defect §7 exists to prevent, and a redundant entry about a
 * reader who could have read anyway is a line in a trail. Testing the tuple side per row would cost a second
 * seek on every row of every listing, for that.
 *
 * **A listing that matched nothing records nothing, and that is a stated weakening rather than an oversight.**
 * The grant is learned from the rows, so with no rows there is no grant to attribute. Nothing was disclosed,
 * so no exposure goes unrecorded; what goes unrecorded is the *attempt*, and a notice's `acts.queries`
 * therefore counts fruitful queries rather than all of them. Closing it means asking which grants are live on
 * every listing whether or not one answered — a second query on the hot read path, for a record of having seen
 * nothing. `docs/supervised-access.md` names it under "Still not built".
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
  const supervised = liveGrantsBySubject(
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
    //
    // `sg.grant_id` is the supervised half of the authorization **and** the attribution the record needs, from
    // one join rather than from a second question. It is stripped from the response below: the row shape is a
    // client contract (`MessageRow`), and an undeclared column is a field somebody starts depending on.
    `SELECT r.id, r.envelope_from, r.envelope_to, r.raw_bytes, r.accepted_at,
            a.mailbox_id, m.id AS message_id, m.subject, m.from_addr, m.parse_error,
            m.conversation_id, sg.grant_id AS supervised_grant_id,
            (SELECT c.id FROM cases c
              WHERE c.org_id = r.org_id AND c.conversation_id = m.conversation_id
                AND c.mailbox_id = a.mailbox_id LIMIT 1) AS case_id
       FROM ingress_receipts r
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
       LEFT JOIN messages m ON m.ingress_receipt_id = r.id
       LEFT JOIN (${supervised.sql}) sg ON sg.mailbox_id = a.mailbox_id
      WHERE r.org_id = ?
        AND (sg.grant_id IS NOT NULL
             OR a.mailbox_id IN (
               SELECT object_id FROM relationship_tuples
                WHERE org_id = ? AND subject_id IN (${placeholders})
                  AND object_type = 'mailbox' AND relation = 'mailbox.content.read'
             ))
      ORDER BY r.accepted_at DESC
      LIMIT 50`,
  )
    .bind(...supervised.params, who.orgId, who.orgId, ...subjects)
    .all<{ id: string; mailbox_id: string; supervised_grant_id: string | null }>();

  /*
   * The record, before the response exists.
   *
   * Grouped by grant rather than by row: §7 records **acts**, and this listing is one act. A reader holding
   * two live grants produces two entries, which is what makes the trail answer "what was seen under grant G"
   * — the question the notice and the investigation both ask.
   */
  const byGrant = new Map<string, { mailboxId: string; ids: string[] }>();
  for (const row of rows.results) {
    if (row.supervised_grant_id === null) continue;
    const seen = byGrant.get(row.supervised_grant_id)
      ?? { mailboxId: row.mailbox_id, ids: [] };
    seen.ids.push(row.id);
    byGrant.set(row.supervised_grant_id, seen);
  }
  if (byGrant.size > 0) {
    await recordDisclosure(env, ctx, who.orgId, [...byGrant].flatMap(
      ([grantId, seen]) => buildSupervisedQuery(grantId, who.userId, seen.mailboxId, seen.ids),
    ));
  }

  return Response.json({
    messages: rows.results.map(({ supervised_grant_id: _grant, ...row }) => row),
  });
}
