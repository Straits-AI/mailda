import { ID_PREFIXES, idPattern, type Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { sponsorOf } from "./delegation.ts";
import { CallerError, notFound, unprocessable } from "./errors.ts";

/**
 * Granting and revoking relations (#39).
 *
 * Until this existed there was no administrator and no path by which anybody granted anything to anybody —
 * and `drafts.ts` had been telling people to *"ask an administrator to grant send.propose on this mailbox"*,
 * which was advice to seek out a person the system had no concept of.
 *
 * ## One authorization system, so admin is not special-cased
 *
 * "Administrator" is a relation on the **organization** object, exactly as `send.propose` is one on a
 * mailbox. `hasRelation` already reads it, so nothing here branches on a role: an admin is somebody who holds
 * `org.admin`, checked the same way as everything else. A roles table would have been friendlier to
 * administer and would have introduced a second representation of the same truth, with a drift class where
 * the role says one thing and the tuples another.
 *
 * ## Admins may grant `org.admin`
 *
 * Deliberately, so one person leaving cannot leave a Node unadministrable. The alternative — a single
 * permanent owner — turns a departure into a support case with no remedy inside the product.
 *
 * ## No delegation
 *
 * Holding a relation does not confer granting it. Delegation was the alternative and it loses on what it does
 * to two questions currently answerable by a list: *who can reach this mailbox* becomes a graph traversal,
 * and *what happens when Ana leaves* becomes a decision about whether revocation cascades. Both would be
 * answers owed permanently. Relaxing to delegation later is additive; withdrawing it once people rely on it
 * is not.
 */

/** The two kinds of object a relation can be held on. */
type ObjectType = "mailbox" | "organization";

/**
 * **How** a relation is conferred, which is the field #63 added and the reason this registry stopped being a
 * map from relation to object type.
 *
 *   admin_grant       one `org.admin`, one call, immediate, `access.granted`. `grant` below.
 *   supervised_grant  a time-boxed grant carrying a matter, a scope, an expiry and **two** approvals. It is
 *                     not a tuple at all and this file cannot mint one — `src/supervised.ts` does, through
 *                     #61's approval machinery.
 *
 * Declaring it here rather than keeping a second list is what makes the refusal in `isGrantable` say which
 * door to use instead of "not grantable". A relation that exists and cannot be reached is how somebody ends
 * up granting themselves `mailbox.content.read` because the front door looked shut.
 */
type ConferredBy = "admin_grant" | "supervised_grant";

/**
 * Every relation this Node confers, the object type each belongs to, and how it is conferred. A relation not
 * named here cannot be conferred by any path.
 *
 * Seven of the blueprint's eleven mailbox relations (`:697`), which is layering rather than divergence — but
 * `mailbox.metadata.read` was **not** a deferral, it was a hole. The queue is gated on `send.propose` and
 * returns subject lines and sender addresses, so until it existed a responder read the metadata of every
 * message in the mailbox with no relation permitting it. See `mayReadMetadata`.
 *
 * The bar a relation has to clear to appear here is that **something reads it**. `approval.decide` cleared it
 * the day #61 landed and not before: it is named in §18, in §21's *"`approval.decide` is the sole decision
 * permission"*, and in #60's argument for ordering the two gates — and until an approval existed for somebody
 * to decide, granting it would have been a relation that conferred nothing, which is the mirror image of the
 * hole `mailbox.metadata.read` was. A grantable relation nothing checks and a checked relation nobody can hold
 * are the same defect from opposite ends.
 *
 * **The past tense in that sentence was premature, and the correction is `RELATIONS_FOR_METADATA` below.**
 * The queue was taught this relation; the message listing was not, for four months. There is a third state
 * between "nothing checks it" and "something checks it" — *some* things check it — and it is the hardest of
 * the three to see, because whichever surface you look at first works.
 *
 * `as const satisfies` rather than a type annotation, so `keyof` is the five literal keys and not `string`. A
 * `Record<string, …>` annotation would have made every helper below accept any string it was handed, and the
 * failure mode is a typo that grants nothing and reports success.
 */
const GRANTABLE = {
  // Subject lines and sender addresses. Weaker than content.read on purpose: somebody triaging or working a
  // queue needs to know what arrived and from whom, which is not the same as reading it.
  "mailbox.metadata.read": { object: "mailbox", conferredBy: "admin_grant" },
  "mailbox.content.read": { object: "mailbox", conferredBy: "admin_grant" },
  "send.propose": { object: "mailbox", conferredBy: "admin_grant" },
  /**
   * Deciding an approval on this mailbox's outbound mail (#61, §18, §21).
   *
   * On the **mailbox**, not on the manifest or the case: an approver is somebody trusted with what leaves an
   * identity, and a per-send grant would have to be minted by the same act that requests the approval, which
   * is the delegation this file refuses. §21's *"approval assignment does not grant whole-mailbox access"*
   * still holds, and it holds because this relation is not a read relation — holding it lets somebody decide,
   * and it does not let them open the mailbox. Whether an approver can read the bytes they are deciding on is
   * §18's approval-evidence-snapshot question, which is not built and is named absent in `src/approvals.ts`.
   *
   * Not implied by `org.admin` and not implied by `send.propose`. The first would make every administrator an
   * approver, defeating separation of duty in the one organization shape where it matters least — a small one,
   * where the administrator is also the author. The second would make every author an approver of their own
   * mailbox, which is self-approval reached through a relation instead of directly.
   */
  "approval.decide": { object: "mailbox", conferredBy: "admin_grant" },
  /**
   * Reading a mailbox you hold **no standing relation to**, under supervision (#63, §7, Layer 5).
   *
   * Declared here and conferred nowhere in this file, which is the whole point. It is the sanctioned path to
   * somebody else's mail, and what makes it sanctioned is everything a tuple cannot carry: the matter it is
   * for, how much of the mailbox, when it stops, and two people who are not the reader agreeing to all three.
   * `relationship_tuples` has no expiry column — checked, not assumed — and giving it one would put a time
   * comparison into every authorization check in the product for the benefit of one relation
   * (`authz-check-rows-read.md`). So a supervised grant is a row in `supervised_grants` and this name is what
   * the read path calls the authority that row confers.
   *
   * **Three things read this entry**, which is the bar the paragraph above sets:
   *
   *   - `isGrantable` refuses it and, because the entry says *how* it is conferred, the refusal names the door
   *     that works. An administrator who is told "not grantable" grants themselves `mailbox.content.read`
   *     instead; one who is told about `POST /api/supervised` has been offered the front door.
   *   - `assertObject` gives `src/supervised.ts` the same "that mailbox does not exist" refusal a grant gets,
   *     from this entry's `object` — reached through `SUPERVISED_RELATION` below, so the module that mints
   *     grants goes through this registry rather than restating the object type.
   *   - `MailboxRelation` is derived from every entry whose `object` is `mailbox`, and `src/authz-read.ts`
   *     types its checks with it. So this entry is what makes a supervised read nameable in an authorization
   *     check at all. Which checks accept it — and why `maySend` and the merge gate do not — is that file's
   *     table, because it is a fact about read paths rather than about this registry.
   */
  "supervised.read": { object: "mailbox", conferredBy: "supervised_grant" },
  /**
   * Taking one message's original `.eml` off this Node (#65, blueprint:698).
   *
   * Separate from `mailbox.content.read` because they are different acts on the same bytes: reading a
   * message renders it inside the product, and exporting it produces a complete RFC822 copy that leaves.
   * Until #65 there was no relation for the second one, so *"has anybody taken a copy of this message off
   * the Node"* was unanswerable — the route produced the copy on the strength of the read relation and
   * recorded nothing.
   *
   * **Backfilled rather than introduced empty**, and that is the one thing about this entry that needed a
   * decision. `migrations/0025_ediscovery_export.sql` grants it to every subject already holding
   * `mailbox.content.read` on the same mailbox, and `claimNode` grants it to a new Node's owner, because
   * Layer 1's own proof is *"original `.eml` exportable"* and a check shipped without its grant would break
   * that on every existing install. What the relation buys is that it is now separately **revocable**: an
   * administrator can withdraw the ability to take copies away while leaving the ability to read.
   */
  "message.export": { object: "mailbox", conferredBy: "admin_grant" },
  /**
   * Asking for a bulk eDiscovery export of a mailbox (#65, blueprint:709, §7, §22).
   *
   * Deliberately **not** backfilled and not granted at claim: nothing could do this before, so nobody is
   * losing an ability, and an export is the act §7 has the most to say about. Holding it lets somebody
   * *ask*; what authorizes the copy is two other people holding `approval.decide` on the same mailbox
   * agreeing to a canonical predicate hash and a hard `max_messages` (`src/exports.ts`).
   *
   * On the **mailbox**, like `approval.decide` and for the same reason: an export is a copy of one
   * mailbox's mail, so the people who decide it are the people trusted with that mailbox. An
   * organization-scoped export permission would let one grant authorize copying every mailbox in the Node.
   *
   * It is also re-read **per page** by a running export rather than once at approval, which is what makes
   * §7's *"revocation terminates export jobs"* enforceable rather than asserted.
   */
  "ediscovery.export": { object: "mailbox", conferredBy: "admin_grant" },
  "org.admin": { object: "organization", conferredBy: "admin_grant" },
} as const satisfies Record<string, { object: ObjectType; conferredBy: ConferredBy }>;

/** Every relation this Node confers, however it is conferred. */
export type Relation = keyof typeof GRANTABLE;

/**
 * The relations `grant` and `revoke` accept: the ones an administrator confers directly.
 *
 * Derived from the registry rather than listed again, in the shape `StandaloneAction` uses in
 * `src/audit.ts`. A second list would be a second place for `supervised.read` to be admin-grantable by
 * accident, and the accident is a relation whose name says supervised and whose grant had no supervision.
 */
export type Grantable = {
  [K in Relation]: (typeof GRANTABLE)[K]["conferredBy"] extends "admin_grant" ? K : never;
}[Relation];

/**
 * The relations an authorization check on a **mailbox** may name, supervised reading included.
 *
 * `src/authz-read.ts` used `readonly string[]` here, which is the failure this repository names in its own
 * house rules: a mistyped relation compiled, matched no tuple, and denied silently. Derived so it cannot.
 */
export type MailboxRelation = {
  [K in Relation]: (typeof GRANTABLE)[K]["object"] extends "mailbox" ? K : never;
}[Relation];

/** The one relation no tuple carries. Named once, so nothing spells it twice. */
export const SUPERVISED_RELATION = "supervised.read" as const satisfies Relation;

/**
 * Every standing relation that permits reading a message's **metadata** — subject, sender, size, when.
 *
 * `mailbox.content.read` is here because it is strictly stronger: somebody who may read the bytes may
 * certainly know a message arrived. So this is the pair, and `mailbox.metadata.read` alone is the interesting
 * member — it is the relation the access UI sells as *"See that mail exists — senders, subjects, when. Not
 * the message itself."*
 *
 * ## Why this is a constant rather than a list written where it is needed
 *
 * It was written in two places and needed in three, and the third is how the hole survived. `mayReadMetadata`
 * had the pair and gated the queue on it. `butler/authority.ts` had the pair. **`messagePageQuery`'s
 * standing-relation arm read `AND relation = 'mailbox.content.read'`** — one relation, spelled once, inside a
 * SQL string where no type could reach it — while its own header claimed *"the columns returned are subject
 * line, sender address and size, which is what `mailbox.metadata.read` covers"*.
 *
 * So a person granted exactly the relation the interface describes could open the queue and saw an inbox
 * indistinguishable from an empty mailbox. Not a refusal they could report — mail that was not there.
 *
 * The comment above about `mailbox.metadata.read` being a hole that *"was"* is what makes this worth a
 * paragraph: the relation was added to close a real leak in the queue, that half was finished, and the past
 * tense was written before the listing had been taught the same thing. A relation that grants *some* of what
 * it says is harder to notice than one that grants nothing, because the surface you check first works.
 *
 * `satisfies readonly MailboxRelation[]` so a renamed relation is a type error at every site rather than a
 * predicate that matches no tuple and denies quietly — the failure `MailboxRelation` itself exists to stop.
 */
export const RELATIONS_FOR_METADATA = [
  "mailbox.metadata.read", "mailbox.content.read",
] as const satisfies readonly MailboxRelation[];

/**
 * Every standing relation that permits searching a message's **body** (#107 L2).
 *
 * One relation, and the omission is the point: **`mailbox.metadata.read` is not here.** That relation is sold
 * as *"See that mail exists — senders, subjects, when. Not the message itself."* Telling somebody the word
 * *demurrage* occurs in message X discloses the message itself, a word at a time — and a determined caller
 * with a dictionary and a metadata relation could reconstruct a great deal of it. The row that comes back
 * carries only metadata, which is exactly what makes the leak easy to miss: the *response* is within the
 * relation and the *question answered* is not.
 *
 * So this is a separate constant from `RELATIONS_FOR_METADATA` rather than a subset expression like
 * `.filter(…)`. A filter would compute one list from the other and couple them: adding a third read relation
 * to the metadata list would silently decide whether it can search bodies too, and that decision belongs to
 * whoever adds it. Two lists mean two deliberate edits.
 *
 * `messagePageQuery` uses both in one statement, per mailbox — so a reader holding `content.read` on one
 * mailbox and `metadata.read` on another searches bodies in the first and subjects in the second, which is
 * the only answer that neither over-grants nor refuses the whole search.
 */
export const BODY_SEARCH_RELATIONS = [
  "mailbox.content.read",
] as const satisfies readonly MailboxRelation[];

export function isGrantable(relation: string): relation is Grantable {
  return Object.hasOwn(GRANTABLE, relation)
    && GRANTABLE[relation as Relation].conferredBy === "admin_grant";
}

/**
 * A relation this Node knows about but which `grant` will not confer, or null.
 *
 * Exists so the route can tell an administrator *which door works* instead of a flat "not grantable". Returns
 * the relation itself rather than a boolean because the caller puts it in the message.
 */
export function conferredBySupervision(relation: string): Relation | null {
  return Object.hasOwn(GRANTABLE, relation)
    && GRANTABLE[relation as Relation].conferredBy === "supervised_grant"
    ? (relation as Relation)
    : null;
}

/**
 * Does this principal hold `org.admin` on their own organization?
 *
 * ## The sponsor term, enforced here rather than at thirty call sites
 *
 * An agent (#109) may hold no more authority than the human who sponsored it continues to hold. Every other
 * relation family evaluates that intersection in `authz-read.ts`, which takes a `Principal` and can see the
 * delegator. This function takes a bare identifier, and thirty callers pass `who.userId` into it — so an agent
 * granted `org.admin` was an administrator, whatever its sponsor was, and two of the routes an agent may hold
 * (`POST /api/butlers`, `POST /api/policies`) are gated on exactly this call. An agent would have created
 * standing automation for an organization on the authority of a sponsor who could not.
 *
 * Widening the signature to a `Principal` was the first instinct and is the worse fix: thirty call sites is
 * thirty chances to pass the wrong thing, and the ones in `index.ts` would keep compiling either way. The
 * subject already carries what is needed — a typed-prefix ULID (#6) — so the check can recognize an agent
 * itself and resolve the sponsor. One place, no signature, and no caller can forget.
 *
 * The derivation itself lives in `delegation.ts`, which every other relation family also reads — so the four
 * families the audit named (mailbox read, send/propose, export, organization-admin) evaluate one rule rather
 * than four copies of it. `sponsorOf` returns before preparing a statement for a `usr_…` subject, so a human
 * administrator pays a regular-expression test and nothing else.
 */
export async function isAdmin(env: Env, orgId: string, userId: string): Promise<boolean> {
  /*
   * Direct **or through a team**, which is the rule every other relation in this Node follows and the one
   * `org.admin` did not.
   *
   * `adminsOf` in `deciders.ts` has always expanded a team-held `org.admin` to that team's members, because
   * approval eligibility asks "who are the administrators" and a grant to a team obviously meant its members.
   * This function asked only for a direct tuple. So the same person was an administrator for dual-control
   * eligibility and not one for any administrator route — "administrator" meaning two different things
   * depending on which module asked, with `grant()` happily conferring the relation on a team either way.
   *
   * Aligned on the wider reading rather than the narrower, because that is the reading `grant()` already
   * permits and `adminsOf` already acts on: an administrator who granted `org.admin` to a team meant those
   * people to be administrators, and the surprise was that half the product disagreed.
   *
   * The team arm is **only consulted for a person**, and the first draft of this said it did not need to be:
   * `team_members.user_id` holds users, so an `agt_` matches nothing there "by construction". That is a
   * convention, not a constraint — nothing in the schema stops a row being written with a machine's
   * identifier, and the test that asserts it proved the claim false the moment it existed. A delegated
   * principal reaching `org.admin` through a team row would step straight around the sponsor bound.
   *
   * So the prefix decides, the way it decides everywhere else in this delegation layer.
   */
  const holds = async (subjectId: string) => await env.CATALOG.prepare(
    `SELECT 1 FROM relationship_tuples
      WHERE org_id = ? AND object_type = 'organization' AND relation = 'org.admin' AND object_id = ?
        AND (subject_id = ?
             OR (? = 1 AND subject_id IN (SELECT team_id FROM team_members
                                           WHERE org_id = ? AND user_id = ?)))
      LIMIT 1`,
  )
    .bind(orgId, orgId, subjectId, idPattern(ID_PREFIXES.user).test(subjectId) ? 1 : 0, orgId, subjectId)
    .first() !== null;

  if (!(await holds(userId))) return false;

  /*
   * The sponsor term. `sponsorOf` returns `null` for a human — which is nearly every caller, and costs one
   * regular-expression test — and `undefined` for an agent whose sponsor cannot be established, which is
   * refused rather than waved through.
   *
   * `sponsorOf` rather than `sponsorTerm`: `org.admin` needs the sponsor **alone**. A team subject holding
   * `org.admin` is not a shape `grant` produces, so the team arm would widen this for nothing.
   */
  const sponsor = await sponsorOf(env, orgId, userId);
  if (sponsor === null) return true;
  return sponsor !== undefined && await holds(sponsor);
}

/**
 * Exported, so `holds.ts` refuses a non-admin with **this** message rather than a second one that says
 * nearly the same thing. Two refusals for one relation is how the wording drifts, and the wording is the
 * part a person acts on.
 */
export async function assertAdmin(env: Env, orgId: string, userId: string): Promise<void> {
  if (await isAdmin(env, orgId, userId)) return;
  // 403 naming the missing relation, not a 404. §5C hides whether a *thing* exists; the caller's own lack of
  // authority is not a thing whose existence needs hiding, and naming it is the answer that says what to do.
  // Same reasoning `drafts.ts` records for its own 403.
  throw new CallerError("E_NOT_AN_ADMINISTRATOR", 403, {
    what: "you are not an administrator of this organization",
    // Names the relation rather than the act, because three acts now share this refusal: granting a
    // relation, revoking one, and placing a legal hold (#64).
    why: "this act requires org.admin, which is itself a relation on the organization (#39)",
    fix: "ask somebody who holds org.admin to grant it to you",
  });
}

/**
 * Checks the object exists and belongs to this organization.
 *
 * A grant on a nonexistent mailbox is a tuple nothing will ever match — silently useless rather than wrong,
 * which is exactly the kind of thing somebody discovers weeks later while wondering why access "did not
 * work". Refused here instead.
 *
 * Exported for `src/supervised.ts`, which needs the identical refusal: a supervised grant on a mailbox that
 * is not there would run a three-person ceremony and authorize nothing. Sharing the function rather than the
 * shape, for the reason `assertAdmin` is shared — two refusals for one condition is how the wording drifts,
 * and the wording is the part a person acts on. It takes a `Relation` rather than a `Grantable` because the
 * relation it is asked about is the one this file will not grant.
 */
export async function assertObject(
  env: Env,
  orgId: string,
  relation: Relation,
  objectId: string,
): Promise<void> {
  if (GRANTABLE[relation].object === "organization") {
    if (objectId !== orgId) {
      throw unprocessable("E_WRONG_ORGANIZATION", {
        what: `${relation} must be granted on this Node's own organization`,
        why: "a Node is claimed by exactly one organization (§12 invariant 1)",
        fix: `grant it on ${orgId}`,
      });
    }
    return;
  }
  const mailbox = await env.CATALOG.prepare(
    "SELECT 1 FROM mailboxes WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, objectId).first();
  if (mailbox === null) {
    throw notFound("E_NO_MAILBOX", {
      what: `mailbox ${objectId} does not exist`,
      why: "a relation on a mailbox that is not there would never match anything, and would look like access that silently does not work",
      fix: "check the mailbox id",
    });
  }
}

export interface GrantOutcome {
  granted: boolean;
  /** False when the tuple already existed — the derived key made it a no-op, not an error (#9). */
  alreadyHeld: boolean;
}

/**
 * Grants a relation. Idempotent, and audited in the same transaction as the tuple.
 *
 * `rt_unique` makes a replayed grant retry-safe, so `INSERT OR IGNORE` distinguishes "granted" from "already
 * granted" without a read-then-write race — #9's shape reached from a request rather than a migration.
 *
 * The audit entry is **gated on the insert actually happening**, so replaying a grant does not append a
 * second entry claiming a second act. `AuditGate` runs the entry's insert conditionally on a predicate, and
 * the entry has to precede the statement that changes it.
 */
export async function grant(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: { subjectId: string; relation: Grantable; objectId: string },
): Promise<GrantOutcome> {
  await assertAdmin(env, orgId, actorUserId);
  await assertObject(env, orgId, input.relation, input.objectId);

  const at = new Date(ctx.now()).toISOString();
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "access.granted",
      outcome: "ok",
      actorUserId,
      subject: input.subjectId,
      detail: { relation: input.relation, objectType: GRANTABLE[input.relation].object, objectId: input.objectId },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `INSERT OR IGNORE INTO relationship_tuples
           (id, org_id, subject_id, relation, object_type, object_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(ctx.id("rt"), orgId, input.subjectId, input.relation, GRANTABLE[input.relation].object,
        input.objectId, at),
    ],
    {
      sql: `SELECT 1 WHERE NOT EXISTS (
              SELECT 1 FROM relationship_tuples
               WHERE org_id = ? AND subject_id = ? AND object_type = ? AND relation = ? AND object_id = ?)`,
      params: [orgId, input.subjectId, GRANTABLE[input.relation].object, input.relation, input.objectId],
    },
  );

  const inserted = (results[1]?.meta.changes ?? 0) > 0;
  return { granted: true, alreadyHeld: !inserted };
}

/**
 * Revokes a relation.
 *
 * §7 and §28 require withdrawn authority to stop working immediately, and it does: nothing caches a
 * relation, `hasRelation` re-reads on every call, and the send path re-checks before hand-over — which is
 * what makes revoking mid-hold-window produce `withheld` rather than a delivered message.
 *
 * **A revoked claim is left alone**, and that is a decision rather than an omission. Releasing it would look
 * tidier and would also silently discard whatever the holder had in progress, at a moment they are not
 * watching. The case keeps its assignee and becomes visibly stuck — its age is on the screen and any
 * colleague may steal it, which is the mechanism that already exists for exactly this. Recorded on the map
 * as fog because "released or merely stale" was left open there.
 */
export async function revoke(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  input: { subjectId: string; relation: Grantable; objectId: string },
): Promise<{ revoked: boolean }> {
  await assertAdmin(env, orgId, actorUserId);

  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "access.revoked",
      outcome: "ok",
      actorUserId,
      subject: input.subjectId,
      detail: { relation: input.relation, objectType: GRANTABLE[input.relation].object, objectId: input.objectId },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        `DELETE FROM relationship_tuples
          WHERE org_id = ? AND subject_id = ? AND object_type = ? AND relation = ? AND object_id = ?`,
      ).bind(orgId, input.subjectId, GRANTABLE[input.relation].object, input.relation, input.objectId),
    ],
    {
      sql: `SELECT 1 FROM relationship_tuples
             WHERE org_id = ? AND subject_id = ? AND object_type = ? AND relation = ? AND object_id = ?`,
      params: [orgId, input.subjectId, GRANTABLE[input.relation].object, input.relation, input.objectId],
    },
  );

  return { revoked: (results[1]?.meta.changes ?? 0) > 0 };
}

/** What somebody holds, for an administrator deciding what to change. */
export async function relationsOf(
  env: Env,
  orgId: string,
  subjectId: string,
): Promise<Array<{ relation: string; objectType: string; objectId: string; createdAt: string }>> {
  const { results } = await env.CATALOG.prepare(
    `SELECT relation, object_type, object_id, created_at FROM relationship_tuples
      WHERE org_id = ? AND subject_id = ? ORDER BY object_type, relation, object_id`,
  )
    .bind(orgId, subjectId)
    .all<{ relation: string; object_type: string; object_id: string; created_at: string }>();
  return results.map((row) => ({
    relation: row.relation,
    objectType: row.object_type,
    objectId: row.object_id,
    createdAt: row.created_at,
  }));
}
