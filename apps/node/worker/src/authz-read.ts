import { BUDGETS } from "@mailda/budgets";
import { MESSAGE_PAGE_PARAMS } from "@mailda/contract/routes";
import { ID_PREFIXES, idPattern, type Ctx } from "@mailda/runtime";
import { RELATIONS_FOR_METADATA, type MailboxRelation } from "./access.ts";
import type { ReadOnlyEnv } from "./read-only.ts";
import { recordDisclosure } from "./audit.ts";
import { unprocessable } from "./errors.ts";
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
 * | `listMessages` | `metadata.read` or `content.read` | scope `metadata` or `content` | An investigation starts with a query; a grant that could not list would be a grant nobody could use. The standing arm read `content.read` alone for four months while this table said otherwise — `RELATIONS_FOR_METADATA`. |
 * | `holdsStandingRead` | `mailbox.content.read` | **no** | The gate in front of `mergeConversations`. Reading is not restructuring. |
 * | `maySend` | `send.propose` | **no** | Reading somebody's mail is not authority to write as them. |
 * | `mailboxesWithRelation` | the named relation | **no** | Only ever asked about `send.propose`, and a supervised grant is not a relation this returns. |
 * | `authorizeExport` | `message.export` **and** `mailbox.content.read` | scope `content` | Taking a copy off the Node is a second act on the same bytes; an investigator who could read but not export would be told to screenshot. |
 * | `mayExportBulk` | `ediscovery.export` | **no** | One approval pair must not supply the standing to ask for a second (§21). |
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
export async function readableSubjects(env: ReadOnlyEnv, who: Principal): Promise<string[]> {
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
  return hasAnyRelation(env, who, RELATIONS_FOR_METADATA, mailboxId, {
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

/**
 * May this principal ask for a **bulk eDiscovery export** of this mailbox (#65, blueprint:709)?
 *
 * Tuples only — **no supervised arm**, and this is the one place in this file where that needs an argument
 * rather than an observation. A supervised grant is §7's answer to *"I need to look at a mailbox I hold
 * nothing on"*, time-boxed and matter-bound, and it is already the ceremony. Letting it also confer the
 * authority to *request* a bulk copy would mean one approval pair silently supplying the standing to ask for
 * a second — approval laundering, one relation along, which is the shape §21 forbids when it says approval
 * assignment does not grant ambient access. So an export is asked for by somebody an administrator granted
 * `ediscovery.export` to, and authorized by two more people who are not them.
 *
 * **Called on every page of a running export, not once at approval.** That is what makes §7's *"revocation
 * terminates export jobs"* a mechanism rather than a sentence: revoking the relation stops the next page and
 * the next download, because nothing about the run is cached.
 */
export async function mayExportBulk(
  env: Env,
  who: Principal,
  mailboxId: string,
): Promise<boolean> {
  return (await hasAnyRelation(env, who, ["ediscovery.export"], mailboxId, null)).allowed;
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
 * Authorizes the **single-message export**: `GET /api/messages/:id/raw`, the original `.eml` (#65, §7).
 *
 * ## The door this closes, and why it was the reachable one
 *
 * That route produced a complete RFC822 copy with `content-disposition: attachment` on the strength of
 * `mailbox.content.read` alone, and **recorded nothing**. So *"has anybody taken a copy of this message off
 * the Node"* — the exact question §7 exists to make answerable — had no answer, while the bulk export the
 * same ticket builds is ceremony-heavy and rare. The small door was the one anybody could walk through.
 *
 * ## Two authorities, checked in this order, and the order is the point
 *
 *   1. `message.export` on the mailbox — a standing relation, **or** a supervised grant of scope `content`.
 *      The supervised arm is not a courtesy: #63's whole point is that a time-boxed grant is the sanctioned
 *      path to somebody else's mail, and a grant that could read a body but not produce the original would
 *      be an investigator told to screenshot it.
 *   2. `mayRead`, which is where a supervised grant's `supervised.attachment` entry is appended.
 *
 * Reversed, the supervised entry would be written for a read that the export check then refused — a
 * disclosure in the trail that did not happen, which is worse than a missing one because it is *wrong*
 * rather than absent.
 *
 * ## The record is inside the authority, for `mayRead`'s reason
 *
 * `message.exported` is appended **before** the blob key is returned, and `recordDisclosure` throws, so a
 * Node that cannot write its trail does not hand over the copy. It is emitted for **every** download, not
 * only supervised ones: `supervised.attachment` answers *who was let in*, keyed on the grant, and this
 * answers *what left*, keyed on the receipt. A holder of the ordinary relation produces exactly one entry
 * and previously produced none.
 *
 * ## What this changes for ordinary users, said plainly rather than smoothed over
 *
 * The route now requires a relation that did not exist yesterday. Every install already deployed keeps
 * working because `migrations/0025_ediscovery_export.sql` grants `message.export` to every subject holding
 * `mailbox.content.read` on the same mailbox, and `claimNode` grants it to a new Node's owner — Layer 1's
 * proof is *"original `.eml` exportable"*, and shipping the check without the grant would have broken that
 * everywhere. What genuinely changes: an administrator can now revoke exporting without revoking reading,
 * and every download appears in the trail. Neither was expressible before.
 *
 * **The sibling door is still open and is named rather than half-closed**: `GET /api/sends/:id/submitted`
 * streams the submitted bytes of an outbound message, which is also a complete `.eml`, and it is not
 * governed by this. #65 ruled on the inbound route and the outbound one needs its own decision about what
 * the entry's subject is — a manifest is not a receipt. `docs/ediscovery-export.md` carries it under
 * "Still not built".
 */
export async function authorizeExport(
  env: Env,
  ctx: Ctx,
  request: Request,
  receiptId: string,
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

  // §5C keeps "you may not export this" and "there is no such message" answering alike, exactly as the read
  // path does: the id itself discloses that a message exists in a mailbox the caller may hold nothing on.
  const exportable = await hasAnyRelation(env, who, ["message.export"], row.mailbox_id, {
    scopes: SCOPES_FOR_CONTENT,
    at: new Date(ctx.now()).toISOString(),
  });
  if (!exportable.allowed) return notFound;

  if (!(await mayRead(env, ctx, who, row.mailbox_id,
    { action: "supervised.attachment", subject: receiptId }))) return notFound;

  // Throws if it cannot append, so the caller never reaches the bytes. Same contract as `mayRead`'s own
  // entry, reached from the other side: this one is owed whichever authority answered.
  await recordDisclosure(env, ctx, who.orgId, [{
    action: "message.exported",
    outcome: "ok",
    actorUserId: who.userId,
    // The receipt: an auditor asking "who has taken a copy of *this message*" filters on one subject, which
    // is the question the entry exists for. The grant, when one answered, is on the sibling
    // `supervised.attachment` entry — two entries, two questions, neither pretending to answer the other.
    subject: receiptId,
    detail: {
      receiptId,
      mailboxId: row.mailbox_id,
      // Which authority answered, so the trail can distinguish an ordinary copy from a supervised one
      // without joining to `supervised_grants`. Null means a standing relation.
      grantId: exportable.grantId,
    },
  }]);

  return { ok: true, blobKey: row.blob_key };
}

/**
 * Authorizes the **outbound** original-message download: `GET /api/sends/:sendId/submitted` (#95, #16).
 *
 * ## Why this lives here rather than in the route
 *
 * There are exactly two endpoints in this product that stream a whole RFC 5322 message off the Node —
 * inbound `.eml` and these submitted bytes — and until #95 they authorized **differently**. The inbound one
 * came through `authorizeExport` above: `message.export` plus `mailbox.content.read`, with a
 * `message.exported` entry written before the blob key was returned. The outbound one took `mayRead` alone,
 * under a comment claiming it took *"the same action rather than a weaker one"*.
 *
 * So somebody holding content read and not `message.export` was refused the inbound copy and served the
 * outbound one: same mailbox, same kind of bytes, same person, opposite answers. #65 exists to make *"who
 * has taken a copy off this Node"* answerable, and it was answerable in one direction.
 *
 * The two decisions are siblings in one file now, because the way that divergence survived was that nothing
 * put them next to each other. `test/node/original-bytes-world.test.ts` is the other half — it enumerates
 * the routes that stream original bytes and requires each to come through one of these two functions, so a
 * third such route cannot authorize itself a third way.
 *
 * ## Why symmetry rather than the other defensible answer
 *
 * The argument for keeping them different is that downloading a message *you sent* reveals nothing you did
 * not already have — you composed it. **That fails on a shared mailbox, which is the entire product.**
 * `mailbox.content.read` is held per mailbox and not per author, so it lets somebody download the messages
 * their colleagues sent from it. The act is bytes leaving the Node, and the direction does not change what
 * the act is.
 */
export async function authorizeSendExport(
  env: Env,
  ctx: Ctx,
  request: Request,
  sendId: string,
): Promise<{ ok: true; row: { submitted_key: string | null; fidelity: string } } | { ok: false; response: Response }> {
  const notFound = {
    ok: false as const,
    response: Response.json(
      { error: "not_found", message: "No such send, or you do not have access to it." },
      { status: 404 },
    ),
  };

  const who = await principalFor(env, ctx, request);
  if (who === null) {
    return {
      ok: false,
      response: Response.json(
        { error: "unauthenticated", message: "Sign in to read messages.", refreshable: true },
        { status: 401, headers: { "x-mailda-refreshable": "true" } },
      ),
    };
  }

  const row = await env.CATALOG.prepare(
    "SELECT submitted_key, fidelity, mailbox_id FROM send_manifests WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(who.orgId, sendId)
    .first<{ submitted_key: string | null; fidelity: string; mailbox_id: string }>();
  if (row === null) return notFound;

  // §5C: "you may not export this" and "there is no such send" answer alike, exactly as the inbound path
  // does — the id itself would otherwise disclose that a send exists in a mailbox the caller holds nothing on.
  const exportable = await hasAnyRelation(env, who, ["message.export"], row.mailbox_id, {
    scopes: SCOPES_FOR_CONTENT,
    at: new Date(ctx.now()).toISOString(),
  });
  if (!exportable.allowed) return notFound;

  if (!(await mayRead(env, ctx, who, row.mailbox_id,
    { action: "supervised.attachment", subject: sendId }))) return notFound;

  /*
   * Appended **before** the caller reaches the bytes, and `recordDisclosure` throws rather than swallowing —
   * so a Node that cannot write its trail does not hand the message over. Failing closed is the only
   * direction that makes the record mean anything, and it is the inbound path's contract unchanged.
   */
  await recordDisclosure(env, ctx, who.orgId, [{
    action: "message.exported",
    outcome: "ok",
    actorUserId: who.userId,
    // The manifest id, so "who took a copy of this send" is one filter — the outbound counterpart of the
    // inbound entry's receipt id.
    subject: sendId,
    detail: {
      sendId,
      mailboxId: row.mailbox_id,
      // Which direction the bytes went, because one action now covers both and an auditor reading
      // `message.exported` should not have to infer it from whether the subject looks like a receipt.
      direction: "outbound",
      grantId: exportable.grantId,
    },
  }]);

  return { ok: true, row: { submitted_key: row.submitted_key, fidelity: row.fidelity } };
}

/* ---- one page of the inbox (#91) --------------------------------------------------------------- */

/**
 * Where a page starts and what it is bounded to. **A position and a mailbox, and deliberately nothing else.**
 *
 * `after` is an `(accepted_at, id)` pair. It carries **position only**, and that is the whole
 * design rather than a detail of the encoding: §7 re-evaluates the live relationship on every call, and a
 * reader's scope moves between page one and page two — a supervised grant expires, a team membership is
 * revoked, a mailbox relation is removed. A cursor that carried the *resolved mailbox set* would be a
 * decision about visibility taken on page one and honoured on page two, which is exactly the cached
 * authorization ADR 11 forbids and would disclose rows the reader may no longer see. So the cursor names a
 * place in the ordering and every page re-runs the authorization from the tuples and grants that are live
 * when it runs. That is the more expensive answer and it is the only one that cannot leak.
 *
 * Because it carries no authority, it needs **no signature and no server-side state**. A caller who forges
 * one moves their own position in an ordering they are re-authorized against; the worst they can reach is a
 * page of their own mail starting somewhere odd. Signing it would protect a secret it does not hold, and a
 * stored cursor would be a row per reader per scroll. It is parsed as untrusted input — see `messagePageRequest` —
 * because a *malformed* one must be refused rather than dropped, not because a well-formed one is trusted.
 */
export interface MessagePage {
  /** Resume strictly after this position, or null for the newest page. */
  after: { at: string; id: string } | null;
  /** Bound the page to one mailbox, or null for every mailbox this reader may read. */
  mailboxId: string | null;
}

/**
 * The `(accepted_at, id)` pair, as the one string a client carries.
 *
 * A space between them, so it survives a query string as one value and splits back into two unambiguously —
 * neither an ISO-8601 instant nor a typed-prefix ULID can contain one.
 *
 * **It is a pair on the wire and a pair in the SQL, and that is a correction rather than a style.**
 * `exports.ts` compares the same two columns as `accepted_at || ' ' || id`, which is correct — a space sorts
 * below every character either field can hold — and it is *not* an index constraint SQLite can use, because
 * the left-hand side is an expression rather than a column. Measured, not reasoned: with the concatenated
 * form, page eleven of the inbox read 717 rows against page one's 207 and page twenty read 1,176, breaching
 * `authz.list.max_rows_read` at a hundred rows a page. That is the same cost curve as `OFFSET`, arrived at
 * by a different route, in the change made to avoid it. The figures and the plans are in
 * `docs/receipts/message-page-size.md`.
 */
function cursorOf(row: { accepted_at: string; id: string }): string {
  return `${row.accepted_at} ${row.id}`;
}

/**
 * The exact shape `cursorOf` emits, and nothing else.
 *
 * `accepted_at` is written by `new Date(ctx.now()).toISOString()` in `ingress.ts`, which is fixed-width UTC
 * with milliseconds. So the format is knowable, and the cursor's own refusal already promises that it must
 * be *"exactly what `next_cursor` returned"* — this is what makes that sentence true.
 *
 * **The first version validated the instant with `Date.parse`**, which is far weaker than it looks:
 * `Date.parse("2027")` and `Date.parse("2026-08")` are both finite, so a client that truncated the cursor
 * got a *silent wrong answer* rather than a refusal. `accepted_at` is compared as a **string** in the keyset
 * predicate, and `'2027'` sorts after every `'2026-…'` value, so a truncated cursor asks for a position it
 * has never been given and gets a page from somewhere else. Refusing the shape is the only way to keep the
 * position and the row order talking about the same thing.
 *
 * The id is checked for shape rather than existence, which is deliberate: a cursor naming a receipt this
 * caller may not read must answer the same as one naming a receipt that does not exist (§5C), and it
 * already does — the keyset predicate simply finds nothing at that position.
 */
const CURSOR_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_ID = idPattern(ID_PREFIXES.ingressReceipt);

/**
 * Reads a page request off the URL, refusing a cursor it cannot understand.
 *
 * **A malformed cursor is refused rather than ignored**, and the alternative is the reason: dropping it
 * would answer the newest page to somebody who asked for an older one — a *"you have reached the end"* or a
 * *"here is your inbox again"* that is indistinguishable from the truth. AGENTS.md's never-swallow rule is
 * usually about a `catch`; this is the same failure in a `??`. The refusal names the shape and the way back,
 * because the caller that produced it is usually a client that mangled a value it was handed.
 *
 * The mailbox is **not** shape-checked, deliberately. It is a filter value compared inside the authorized
 * set, so an id that names nothing — or names a mailbox this reader may not read — answers an empty page,
 * which is what §5C already does for a message: *"no such thing, or not for you"* are one answer. Validating
 * it would need an identifier pattern written by hand, which `test/node/id-prefix-world.test.ts` forbids, and
 * would buy a distinction the authorization model refuses to draw anyway.
 */
export function messagePageRequest(url: URL): MessagePage {
  const raw = url.searchParams.get(MESSAGE_PAGE_PARAMS.cursor);
  const mailboxId = url.searchParams.get(MESSAGE_PAGE_PARAMS.mailbox);
  if (raw === null) return { after: null, mailboxId };

  const parts = raw.split(" ");
  const instant = parts[0] ?? "";
  const id = parts[1] ?? "";
  if (parts.length !== 2 || !CURSOR_INSTANT.test(instant) || !CURSOR_ID.test(id)) {
    throw unprocessable("E_PAGE_CURSOR_MALFORMED", {
      what: `${MESSAGE_PAGE_PARAMS.cursor}=${JSON.stringify(raw)} is not a position in this listing`,
      why: "A cursor is the `accepted_at` instant and the receipt id of the last row of the previous page, "
        + "separated by one space — exactly what `next_cursor` returned. It is refused rather than ignored "
        + "because answering the newest page to a request for an older one is indistinguishable from having "
        + "reached the end of the mail.",
      fix: `Send the \`next_cursor\` from the previous page verbatim, or omit ${MESSAGE_PAGE_PARAMS.cursor} to start `
        + "from the newest message.",
    });
  }
  return { after: { at: instant, id }, mailboxId };
}

/**
 * One page of the listing, as SQL — **exported so the measurement measures the shipped statement.**
 *
 * `docs/receipts/message-page-size.md` sizes `messages.page_size` from the rows this reads, and
 * `test/message-page.measure.test.ts` calls this builder rather than restating the query. That is not
 * fastidiousness: `authz.measure.test.ts` hand-copies the statements it prices, and its receipt now carries
 * the consequence — it says of *this* listing that it *"is not separately priced here"*, describing a query
 * nothing measured. A copy of a query is a second thing for a receipt to stop describing.
 *
 * Keyset, not `OFFSET`: mail arrives while somebody is reading, so an offset that counted rows from the top
 * would skip a message and repeat another every time one landed. The cursor names a row, so a page that
 * resumes after it is stable under arrivals — the newest mail appears on page one where it belongs, and
 * nothing between the pages moves.
 *
 * The cursor and mailbox predicates are **added rather than always present as `(? IS NULL OR …)`**, which is
 * the shape `exports.ts` uses for its optional predicates and reads better than assembling a `WHERE`. It
 * costs the seek: a disjunction whose first branch does not mention the column is not a range constraint, so
 * the optional form plans as a scan even when a cursor *is* present. `test/explain.test.ts` prints that plan
 * beside this one — `(org_id=?)` against `(org_id=? AND accepted_at<?)` — rather than leaving it as a claim.
 */
export function messagePageQuery(args: {
  orgId: string;
  subjects: readonly string[];
  /** This reader's live grants, from `liveGrantsBySubject` — the only source of a grant id here (§7). */
  supervised: { sql: string; params: unknown[] };
  page: MessagePage;
  /** How many rows to ask for. `listMessages` asks for the page plus one probe row — see `next_cursor`. */
  limit: number;
}): { sql: string; params: unknown[] } {
  const subjectPlaceholders = args.subjects.map(() => "?").join(", ");
  /*
   * **Bound, not interpolated, and derived rather than spelled.** This predicate read
   * `relation = 'mailbox.content.read'` for four months while the header below claimed the columns were what
   * `mailbox.metadata.read` covers — so somebody holding exactly the relation the access UI describes as
   * *"See that mail exists"* got an empty inbox, which is indistinguishable from having no mail.
   *
   * The list comes from `RELATIONS_FOR_METADATA` so a renamed relation is a type error rather than a
   * predicate that matches no tuple. A literal inside a SQL string is the one place in this file that no type
   * could reach, which is exactly where the hole was.
   */
  const metadataRelationPlaceholders = RELATIONS_FOR_METADATA.map(() => "?").join(", ");
  const filters: string[] = [];
  const filterParams: unknown[] = [];
  if (args.page.mailboxId !== null) {
    filters.push("AND a.mailbox_id = ?");
    filterParams.push(args.page.mailboxId);
  }
  if (args.page.after !== null) {
    /*
     * Two predicates for one comparison, and the split is what makes the index work.
     *
     * `accepted_at <= ?` is a **column against a value**, so it is a range constraint the planner can use to
     * seek into `ir_org_accepted` and scan downwards from the cursor. The second line then decides the tie:
     * strictly older, or the same instant and a lower id. Together they are exactly `(accepted_at, id) <
     * (at, id)`, which is `ORDER BY accepted_at DESC, id DESC` read from where the last page stopped.
     *
     * The obvious one-line spelling — `(accepted_at || ' ' || id) < ?` — is correct and unusable: an
     * expression on the left is not a constraint, so the scan starts at the newest row every time and page
     * twenty costs twenty pages. See `cursorOf` for the measurement that caught it.
     */
    filters.push("AND r.accepted_at <= ?");
    filters.push("AND (r.accepted_at < ? OR r.id < ?)");
    filterParams.push(args.page.after.at, args.page.after.at, args.page.after.id);
  }

  return {
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
    sql: `SELECT r.id, r.envelope_from, r.envelope_to, r.raw_bytes, r.accepted_at,
            a.mailbox_id, m.id AS message_id, m.subject, m.from_addr, m.parse_error,
            m.conversation_id, sg.grant_id AS supervised_grant_id,
            (SELECT c.id FROM cases c
              WHERE c.org_id = r.org_id AND c.conversation_id = m.conversation_id
                AND c.mailbox_id = a.mailbox_id LIMIT 1) AS case_id
       FROM ingress_receipts r
       JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
       LEFT JOIN messages m ON m.ingress_receipt_id = r.id
       LEFT JOIN (${args.supervised.sql}) sg ON sg.mailbox_id = a.mailbox_id
      WHERE r.org_id = ?
        ${filters.join("\n        ")}
        AND (sg.grant_id IS NOT NULL
             OR a.mailbox_id IN (
               SELECT object_id FROM relationship_tuples
                WHERE org_id = ? AND subject_id IN (${subjectPlaceholders})
                  AND object_type = 'mailbox' AND relation IN (${metadataRelationPlaceholders})
             ))
      ORDER BY r.accepted_at DESC, r.id DESC
      LIMIT ?`,
    // `id DESC` beside the timestamp is the tie-break the cursor needs to be total. One delivery to two
    // addresses of the same mailbox arrives as two receipts sharing a millisecond, and an ordering that left
    // their relative position to the planner would let a page boundary fall between them differently on the
    // two queries that span it — dropping one and repeating the other.
    params: [
      ...args.supervised.params, args.orgId, ...filterParams, args.orgId, ...args.subjects,
      ...RELATIONS_FOR_METADATA, args.limit,
    ],
  };
}

/**
 * Messages the caller may actually see, newest first, one page at a time. §5 requires authorization before
 * any listing.
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
 *
 * ## One page is one act, and that is why the record is written per page (#91, §7)
 *
 * This used to return `LIMIT 50` with no cursor, so the fifty-first message was not slow to reach — it was
 * unreachable, by any parameter a caller could pass. It now returns `messages.page_size` rows and a
 * `next_cursor`, and each page is a separate request that re-runs the whole authorization.
 *
 * §7 records **acts**, and each page is one: a reader who pages three times has seen three sets of subject
 * lines, at three instants, under whatever grants were live at each. So three `supervised.query` entries,
 * each naming the ids *that page* returned. The alternative — one entry per traversal — would have to
 * accumulate state across requests, and the entry it eventually wrote would name an instant at which some of
 * those ids may no longer have been disclosable. Paging back over the same ground records again, which is
 * correct: the mail was shown again.
 *
 * The page number is deliberately **not** in the entry. Two pages of one traversal carry disjoint id lists,
 * so a reader of the trail can already tell them apart, and a `page` field would spend bytes from
 * `audit.max_detail_bytes` — the budget the id list is competing for — on something the ids already say.
 *
 * The stated weakening above gets slightly wider and stays the same shape: a page that matched nothing
 * records nothing, so paging past the end of a scope records the last fruitful page and not the empty one
 * after it.
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
  // Thrown, not returned: `index.ts` renders a `CallerError` as its four-part refusal, and a second spelling
  // of that shape here would be a second thing to keep in step. Parsed before the query so a bad cursor costs
  // one round trip rather than a page.
  const page = messagePageRequest(new URL(request.url));
  const supervised = liveGrantsBySubject(
    who.orgId, who.userId, new Date(ctx.now()).toISOString(), SCOPES_FOR_METADATA,
  );

  const size = BUDGETS["messages.page_size"];
  // Authorization is inside the query, not a filter applied afterwards — §5 forbids
  // returning counts or snippets for anything the caller cannot see. Re-run in full on every page: the
  // subjects, the grants and the tuple sub-select are all read at this instant, so a revocation between two
  // pages takes effect on the second one. That is what the cursor carrying position only buys.
  const query = messagePageQuery({
    orgId: who.orgId,
    subjects,
    supervised,
    page,
    // One row past the page, and it is never returned. It is the difference between `next_cursor` meaning
    // "there is at least one more row you may read" and "this page was full, so there might be" — and the
    // second is the one that renders a control leading to an empty page. Costs one row read.
    limit: size + 1,
  });
  const rows = await env.CATALOG.prepare(query.sql)
    .bind(...query.params)
    .all<{ id: string; accepted_at: string; mailbox_id: string; supervised_grant_id: string | null }>();

  const more = rows.results.length > size;
  const listed = more ? rows.results.slice(0, size) : rows.results;

  /*
   * The record, before the response exists.
   *
   * Grouped by grant rather than by row: §7 records **acts**, and this listing is one act. A reader holding
   * two live grants produces two entries, which is what makes the trail answer "what was seen under grant G"
   * — the question the notice and the investigation both ask.
   *
   * Built from `listed` rather than from `rows`, because the probe row is not disclosed: it is read to answer
   * whether a next page exists and never leaves this function. Recording it would put an id in the trail that
   * nobody saw, which is the same dishonesty as omitting one, in the other direction.
   */
  const byGrant = new Map<string, { mailboxId: string; ids: string[] }>();
  for (const row of listed) {
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
    messages: listed.map(({ supervised_grant_id: _grant, ...row }) => row),
    /*
     * Null means **nothing older is visible to this reader at this instant**, which is a narrower claim than
     * "this is all the mail". A row this reader may not see is not counted, and a grant expiring a second
     * from now would change the answer — so the field is a position to resume from rather than a statement
     * about the archive. The interface renders it as a control that exists or does not, never as a count.
     */
    next_cursor: more ? cursorOf(listed[listed.length - 1]!) : null,
  });
}
