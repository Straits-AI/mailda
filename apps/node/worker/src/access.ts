import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
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
 * Five of the blueprint's eleven mailbox relations (`:697`), which is layering rather than divergence — but
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

/** Does this principal hold `org.admin` on their own organization? */
export async function isAdmin(env: Env, orgId: string, userId: string): Promise<boolean> {
  const row = await env.CATALOG.prepare(
    `SELECT 1 FROM relationship_tuples
      WHERE org_id = ? AND subject_id = ? AND object_type = 'organization'
        AND relation = 'org.admin' AND object_id = ? LIMIT 1`,
  )
    .bind(orgId, userId, orgId)
    .first();
  return row !== null;
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
