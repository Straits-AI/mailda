import type { Principal } from "../authz-read.ts";

/**
 * What a Butler *is* to every part of Layer 5 that takes a principal (#50, §16, §23).
 *
 * A Butler is the first **non-human** caller of `maySend`, `sealManifest`, `evaluate`'s `actor` condition,
 * `planApproval`'s actor exclusion and `auditedBatch`. Every one of those takes an id and several make
 * decisions about *who* may do something, so this has to be settled before a step that needs one is
 * written — and getting it wrong in the permissive direction means a Butler doing something no human could
 * authorise.
 *
 * ## The answer: a Butler acts as **itself**, and the subject is the Butler rather than a version of it
 *
 * `principal.userId` is the `btl_<ulid>` from `butlers.id`. Not a person, not the publisher, not the Node.
 *
 * ### Why not the publisher
 *
 * The obvious alternative is *"the administrator who published this version"*, and it fails on four
 * counts, in the order they decided it:
 *
 * 1. **It grants everything that person can do, for ever.** A published version is immutable and a tuple is
 *    not: an admin who holds `send.propose` on every mailbox would be lending all of it to a program, and
 *    §16's own guarantee — *"new grants do not silently expand a published Butler"* — would be false the
 *    moment anybody granted that person anything.
 * 2. **It puts a person's name on mail they never composed and never saw.** AGENTS.md §4: a name must not
 *    overclaim. `send.sealed` with `actor_user_id = usr_ana` is a statement that Ana sealed it.
 * 3. **It excludes a real human from a gate they never asked for.** `approversOf` excludes the actor from
 *    deciding their own request (§18 separation of duty). With the publisher as actor, publishing a Butler
 *    silently removes that person from the approver pool for every send it ever proposes. With the Butler as
 *    actor, every human decider stays eligible — which is what a Butler's proposal *wants*.
 * 4. **A policy could not tell a Butler's send from that person's own.** #60's `actor` condition compares
 *    `actorUserId`, so *"anything a Butler proposes requires approval"* is expressible only if the Butler is
 *    the actor. That single rule is the governance lever this whole layer needs, and it costs nothing.
 *
 * ### Why not the Node
 *
 * `audit_entries.actor_kind` already has a `node` value for *"an alarm, a sweeper"*, and a Butler is not
 * that. The Node acts on its own behalf with no program behind it; a Butler is a specific, versioned,
 * published program somebody wrote, and collapsing the two would make *"which Butler did this"*
 * unanswerable — the exact question §23 exists to answer.
 *
 * ### Why the Butler and not the Butler **version**
 *
 * Authority attaches to the `btl_`, attribution names the `btv_`. Two reasons, and they point the same way:
 *
 * - A tuple granted to a version id would silently lapse on the next publish, so every publication would
 *   break every Butler until somebody re-granted it. Authority is about the program-as-a-thing.
 * - `audit_by_actor` is indexed on `(org_id, actor_user_id, at)`, so a Butler id as the actor makes *"every
 *   effect this Butler has ever had"* one index scan across its whole version history.
 *
 * **Which *version* did it is answered by the run record, and not by the audit entry — said exactly, because
 * the loose version of this sentence was wrong.** No audit entry carries a `btv_` anywhere in its `detail`:
 * every entry a Butler causes is written by a Layer 5 function that takes an `actorUserId` and knows nothing
 * about Butlers, which is the same property that makes `actor_kind` derivable and is the whole reason not to
 * thread a per-call-site field through `sealManifest`. The path a reader actually has is two joins on indexes
 * that exist for it: `audit_entries.subject` is the manifest id, `butler_run_effects.subject` is the same id
 * (`bre_by_subject`), and its `run_id` names a `butler_runs` row carrying both `butler_id` and `version_id`.
 * `test/butler-run.test.ts` walks exactly that path, so this claim is enforced rather than asserted.
 *
 * ## What this buys, and what it costs
 *
 * It buys **fail-closed by default**: `relationship_tuples` has no row for a `btl_` until an administrator
 * writes one, and `hasAnyRelation` re-reads tuples on every call, so a published Butler can do nothing at
 * all until it is granted something, and revoking stops it on the next node. A Butler is exactly as
 * powerful as the list of tuples naming it — which is the property §7 already gives people.
 *
 * It costs the schema **nothing**, and that was checked rather than assumed. `relationship_tuples` has no
 * `subject_type` column by design (`0001_init.sql`: *"identifiers are typed-prefix ULIDs, so a separate
 * column would be duplicate state that can disagree with the id"*), and `access.ts`'s `grant` validates the
 * *object* and never the subject. So a Butler as a tuple subject works with no migration — which
 * `packages/butler-ast/src/ast.ts` predicted in as many words when it registered the prefixes.
 *
 * ## The one wasted query, named rather than hidden
 *
 * `hasAnyRelation` resolves a principal's subjects as *"themselves, plus every team they belong to"*, which
 * costs a `team_members` read. `team_members.user_id` holds users, so for a Butler that read returns nothing
 * — one subrequest per check that can never match. It is left in place rather than special-cased: the
 * alternative is a second authorization path for non-human principals, and a second path is how the two
 * come to disagree about what somebody holds. `butler-run-cost.md` records the figure it costs.
 *
 * ## §16's six ownership kinds are still not built, and this is not them
 *
 * `metadata.owner` stays an opaque string (#49: three of the six kinds name objects that do not exist). This
 * is the *runtime* identity — who the effects are attributed to and whose tuples are checked — which is a
 * different question from who owns the program. When teams and service identities exist, `owner` becomes an
 * enum and this stays the Butler.
 */
export interface ButlerPrincipal {
  readonly orgId: string;
  /** `butlers.id` — the authorization subject and the audit actor. */
  readonly butlerId: string;
  /** `butler_versions.id` — what ran, recorded beside every effect but never the subject of a tuple. */
  readonly versionId: string;
  /** The Butler's name, so a refusal can say which program was refused. */
  readonly name: string;
}

/**
 * The Butler as the shape every Layer 5 read path already takes.
 *
 * A function rather than a spread at each call site, so the decision *"the subject is the `btl_`"* is made
 * once. Every caller that passes `actingAs(butler)` is reading tuples granted to the Butler; anything that
 * passed a version id would have to say so in its own words, and nothing does.
 */
export function actingAs(butler: ButlerPrincipal): Principal {
  return { orgId: butler.orgId, userId: butler.butlerId };
}

/**
 * The `actor_kind` a Butler's audit entries carry.
 *
 * A fourth kind beside `user`, `node` and `installer` rather than reusing one of them. `actor_user_id` holds
 * a `btl_` for these entries, and the column's name is one this migration cannot change — so `actor_kind` is
 * what stops that being an overclaim: the pair says *"the actor is a Butler, and here is which one"*, which
 * is exactly the axis 0008 put the column there for.
 */
export const BUTLER_ACTOR_KIND = "butler" as const;
