import { LOOKUP_ENTITIES } from "@mailda/butler-ast";

import type { MailboxRelation } from "../access.ts";
import { readableSubjects } from "../authz-read.ts";
import { ceilingAddresses } from "./ceiling.ts";
import { ButlerFault } from "./expr.ts";
import type { ButlerPrincipal } from "./principal.ts";

/**
 * Reading and acting as a Butler: **the three-term intersection, in two queries** (#50, #54, #51).
 *
 * ## The rule this file implements
 *
 *     effective(step) = pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor
 *
 * and #51 derived that it fits in **two** round trips rather than three, which is what keeps it inside
 * `authz.check.max_queries = 2`:
 *
 * 1. **The pinned ceiling is free.** It lives on the Butler version row, which the run has already loaded to
 *    get its AST (`ceiling.ts`). What it costs here is a sub-select resolving its declared addresses to
 *    mailbox ids, inside the statement that was going to be issued anyway.
 * 2. **The sponsor's teams: one query.** `readableSubjects`, shared with every human check rather than
 *    rewritten — the sponsor's subjects and the sponsor's own checks must agree about who they are, and the
 *    surest way to agree is the same function.
 * 3. **Both tuple terms in one query.** Which query depends on whether the mailbox is *named* by the step or
 *    *discovered* by it, and that is the one place this file has two shapes; see below.
 *
 * **The Butler needs no team query.** #51's decision 1: `team_members.user_id` holds users and a Butler's
 * subject is a `btl_`, so that read returns nothing by construction. It is a feature rather than a
 * limitation — a Butler inheriting a team's grants is exactly how a declared ceiling stops meaning anything,
 * because the ceiling would float with the team's grants.
 *
 * ## The OR-versus-AND subtlety, which is the thing to not "simplify" away
 *
 * An `IN` list over subjects answers *"does **any** of these hold it"*, which is an **OR**. The intersection
 * needs an **AND**: the Butler must hold it *and* the sponsor must hold it. Written as one flat
 * `subject_id IN (butler, sponsor, …sponsorTeams)` with a `LIMIT 1`, a Butler would hold whatever its
 * sponsor holds — the sponsor's row alone satisfies the predicate and the check answers yes.
 *
 * Two conversions, one per shape, and they are the same conversion:
 *
 * - **`effectiveOnMailbox` selects `DISTINCT subject_id` rather than `1`.** The query then returns *which*
 *   subjects hold the relation, and the AND is evaluated on the **result** — `holders.has(butler)` and
 *   `sponsors.some(s => holders.has(s))`. That is #51's own sentence, and the `DISTINCT` is load-bearing
 *   rather than tidy.
 * - **The folded reads use two `EXISTS` clauses joined by SQL's `AND`.** They cannot use the form above,
 *   because their mailbox is the query's *output*: you cannot ask which subjects hold a relation on a
 *   mailbox before you know which mailbox it is. The OR lives *inside* the sponsor's `EXISTS`, over the
 *   sponsor's own subjects, which is where an OR is correct; the AND is between the two clauses.
 *
 * Both shapes are one conversion of one rule, so `test/butler-capability.test.ts` asserts they **answer
 * alike** across grant and revocation of each term — the same discipline that already holds
 * `caseMailboxHeldBy` to `maySend`, and the reason two shapes are acceptable at all.
 *
 * **What the AND is *not* exact about, said here rather than found later.** Each term is a
 * `relation IN (…)`, so on a check naming the metadata/content pair the Butler may hold one relation and the
 * sponsor the other and both terms pass. That is bounded rather than tolerated: every read that names the
 * pair returns metadata-grade columns, which both actions authorize, and the checks that guard content and
 * the wire name **one** relation each — `mailbox.content.read` for a message, `send.propose` for every
 * effect — where the AND is exact. Splitting the pair would cost a second round trip for a distinction that
 * changes no disclosure. `docs/butler-capability-ceiling.md`, "What the ceiling does not reach".
 *
 * ## This is not a second authorization system, and the reason it is not is worth being exact about
 *
 * It reads the **same table**, the same `relation` names (typed as `MailboxRelation`, so a mistyped relation
 * is a compile error rather than a check that silently matches nothing), and the same tuple shape as
 * `hasAnyRelation` in `src/authz-read.ts`, and it resolves the sponsor's subjects with that file's own
 * function. What it adds is the two terms a human's check does not have, because a human has no ceiling and
 * sponsors nobody.
 *
 * The claim that the Butler term agrees with `hasAnyRelation` is a claim, so it is checked:
 * `test/butler-run.test.ts` grants a tuple to a Butler and asserts that this and
 * `maySend(actingAs(butler), …)` answer alike, and that revoking it stops both. A helper that drifted from
 * `hasAnyRelation` would be the failure `authz-read.ts`'s own header warns about — *"a second hand-written
 * variant would be a second thing for that receipt to stop describing"*.
 *
 * ## A `lookup` returns a **projection**, not a row
 *
 * `SELECT *` would put `blob_key`, `blob_sha256` and `body_key` into the run's state, where
 * `"${steps.m.blob_key}"` interpolates an internal storage key into a subject line and sends it. So each
 * entity declares the fields its expressions may name. That is also what makes the expression namespace
 * documentable: a Butler author can be told what `steps.<as>` carries, per entity, from one table.
 *
 * The projection is exhaustive over `LOOKUP_ENTITIES` **by construction** — a new entity in
 * `packages/butler-ast` with no entry here does not compile — which is the same enforcement `cost.ts` uses
 * for the cost table and `graph.ts` for the successor map.
 *
 * ## One relation set per entity, mirroring `authz-read.ts`'s table rather than inventing a rule
 *
 * | entity | relation | why |
 * |:--|:--|:--|
 * | `message` | `mailbox.content.read` | a message's subject and sender *are* content |
 * | `case`, `conversation`, `mailbox` | `metadata.read` **or** `content.read` | the queue's own rule: content is the stronger authority on both sides |
 * | `draft` | none — the author must be the Butler | `drafts.author_user_id` is the only reader a draft has (0012), and Layer 3 has not decided what sharing one means |
 */

/** Metadata or content, which is the pair the queue's own reads accept. */
const READABLE: readonly MailboxRelation[] = ["mailbox.metadata.read", "mailbox.content.read"];

/** What one `lookup` may put into a run's state, per entity. Closed, and closed by the compiler. */
const PROJECTION: { [K in (typeof LOOKUP_ENTITIES)[number]]: readonly string[] } = {
  message: [
    "id", "subject", "from_addr", "sent_at", "received_at", "rfc_message_id", "conversation_id",
    // The honest half of §24: a message whose headers could not be read is still a message, and a Butler
    // deciding what to do with one is entitled to know that its subject may be empty for that reason.
    "parse_error",
  ],
  conversation: ["id", "root_rfc_id", "grouped_by", "merged_into", "created_at"],
  case: ["id", "conversation_id", "mailbox_id", "state", "state_at", "assignee", "claimed_at", "created_at"],
  mailbox: ["id", "name", "created_at"],
  draft: [
    "id", "mailbox_id", "in_reply_to_message_id", "to_addresses", "cc_addresses", "bcc_addresses",
    "subject", "body_bytes", "updated_at",
  ],
};

/**
 * The SQL that bounds each entity to what this Butler may read, with all three terms folded in.
 *
 * One statement and one subrequest — the second of the two the check costs, the first being the sponsor's
 * subjects, which every entry here takes as a parameter rather than resolving for itself.
 */
const READS: {
  [K in (typeof LOOKUP_ENTITIES)[number]]:
    (butler: ButlerPrincipal, sponsors: readonly string[], entityId: string) =>
      { sql: string; params: unknown[] };
} = {
  message: (butler, sponsors, entityId) => {
    // The path `sealManifest` already uses to decide whether a reply may thread onto a parent:
    // `ingress_receipts.envelope_to` → `addresses` → the mailbox the message was delivered into. `messages`
    // carries no mailbox column, so this join is the only thing that says where a message actually landed —
    // and organization membership is emphatically not the same question.
    const bound = effectiveOn("a.mailbox_id", ["mailbox.content.read"], butler, sponsors);
    return {
      sql: `SELECT ${PROJECTION.message.map((field) => `m.${field}`).join(", ")}
              FROM messages m
              JOIN ingress_receipts r ON r.org_id = m.org_id AND r.id = m.ingress_receipt_id
              JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
             WHERE m.org_id = ? AND m.id = ? AND ${bound.sql}
             LIMIT 1`,
      params: [butler.orgId, entityId, ...bound.params],
    };
  },
  conversation: (butler, sponsors, entityId) => {
    // A conversation spans mailboxes, so the bound is *some* case on it sitting in a mailbox this Butler may
    // read. Not "any case in the org": that would make a conversation id a way to learn the grouping of mail
    // in mailboxes the Butler holds nothing on.
    const bound = effectiveOn("k.mailbox_id", READABLE, butler, sponsors);
    return {
      sql: `SELECT ${PROJECTION.conversation.map((field) => `c.${field}`).join(", ")}
              FROM conversations c
             WHERE c.org_id = ? AND c.id = ?
               AND EXISTS (SELECT 1 FROM cases k
                            WHERE k.org_id = c.org_id AND k.conversation_id = c.id
                              AND ${bound.sql})
             LIMIT 1`,
      params: [butler.orgId, entityId, ...bound.params],
    };
  },
  case: (butler, sponsors, entityId) => {
    const bound = effectiveOn("k.mailbox_id", READABLE, butler, sponsors);
    return {
      sql: `SELECT ${PROJECTION.case.map((field) => `k.${field}`).join(", ")}
              FROM cases k
             WHERE k.org_id = ? AND k.id = ? AND ${bound.sql}
             LIMIT 1`,
      params: [butler.orgId, entityId, ...bound.params],
    };
  },
  mailbox: (butler, sponsors, entityId) => {
    const bound = effectiveOn("b.id", READABLE, butler, sponsors);
    return {
      sql: `SELECT ${PROJECTION.mailbox.map((field) => `b.${field}`).join(", ")}
              FROM mailboxes b
             WHERE b.org_id = ? AND b.id = ? AND ${bound.sql}
             LIMIT 1`,
      params: [butler.orgId, entityId, ...bound.params],
    };
  },
  draft: (butler, _sponsors, entityId) => ({
    // No tuple check, and no mailbox join. A draft is readable by its author and by nobody else (0012), so
    // for a Butler that means **its own** drafts — the ones a `draft` node in some run of this Butler wrote.
    // Reading another author's unfinished writing is not a thing this Node lets anybody do.
    sql: `SELECT ${PROJECTION.draft.join(", ")}
            FROM drafts WHERE org_id = ? AND id = ? AND author_user_id = ? LIMIT 1`,
    params: [butler.orgId, entityId, butler.butlerId],
  }),
};

/** Relation names, inlined. They are typed constants from a closed set, never a caller's string. */
function relationList(relations: readonly MailboxRelation[]): string {
  return relations.map((relation) => `'${relation}'`).join(", ");
}

/**
 * The three-term intersection as a SQL fragment, for a read whose mailbox is the query's **output**.
 *
 * `lookup`, `case.assign` and `case.close` name an entity id and not a mailbox — the mailbox comes out of a
 * join — so `effectiveOnMailbox` below cannot be used: there is nothing to ask it about until the row is
 * found. Folding the three terms into that same statement is what keeps the check at two queries rather than
 * three, and it is the technique `hasAnyRelation` uses for its supervised arm, for the same reason.
 *
 * The three terms, in the order they appear:
 *
 * 1. **The ceiling**, as a sub-select over `addresses`. The version's frozen `capabilities:` name addresses,
 *    and `addresses` is UNIQUE on `(org_id, address)`, so this is one index seek per declared address and no
 *    round trip at all. Resolving them ahead of time was the alternative and it costs a subrequest, because
 *    the AST is what names them and the AST is read by the statement that would have had to carry it.
 * 2. **The Butler's own tuples**, one subject.
 * 3. **The sponsor's tuples**, over the sponsor and every team they belong to.
 *
 * **Two `EXISTS` clauses and not one, which is #51's subtlety in this shape.** A single
 * `subject_id IN (butler, sponsor, …teams)` answers *"does any of these hold it"* — an OR — and would give a
 * Butler whatever its sponsor holds. The OR belongs **inside** term 3, over the sponsor's own subjects,
 * where it is what the sponsor term means; the AND is between the terms. `effectiveOnMailbox` reaches the
 * same conversion the other way, by selecting `DISTINCT subject_id` and evaluating the AND on the result.
 *
 * A caller must not reach this with an empty ceiling: an empty `IN ()` is a syntax error, and every caller
 * short-circuits on it with `capability_not_declared` before issuing anything. That is the restrictive
 * outcome, so the impossible case fails closed rather than being defended here.
 */
function effectiveOn(
  column: string,
  relations: readonly MailboxRelation[],
  butler: ButlerPrincipal,
  sponsors: readonly string[],
): { sql: string; params: unknown[] } {
  const addresses = ceilingAddresses(butler.ceiling, relations);
  const held = (subjects: string) => `EXISTS (SELECT 1 FROM relationship_tuples
                   WHERE org_id = ? AND subject_id IN (${subjects}) AND object_type = 'mailbox'
                     AND relation IN (${relationList(relations)})
                     AND object_id = ${column})`;
  return {
    sql: `${column} IN (SELECT a2.mailbox_id FROM addresses a2
                         WHERE a2.org_id = ? AND a2.address IN (${addresses.map(() => "?").join(", ")}))
            AND ${held("?")}
            AND ${held(sponsors.map(() => "?").join(", "))}`,
    params: [
      butler.orgId, ...addresses,
      butler.orgId, butler.butlerId,
      butler.orgId, ...sponsors,
    ],
  };
}

/**
 * The sponsor's subjects: themselves, plus every team they belong to. **One query — #51's first.**
 *
 * `readableSubjects` rather than a statement written here, and that is the whole of why this function is two
 * lines. The sponsor term caps a Butler against *what the sponsor can do*, so it has to agree with what the
 * sponsor's own checks say they can do — and `authz-read.ts` already learned that agreeing by writing the
 * same shape twice does not work (#45 happened in a third place that did not write it out at all). Sharing
 * the function is the only version of "they agree" that cannot drift.
 *
 * The Butler needs no equivalent, and that is #51's decision 1 rather than an omission:
 * `team_members.user_id` holds users, a Butler's subject is a `btl_`, so the read returns nothing by
 * construction. A Butler inheriting a team's grants is how a declared ceiling stops meaning anything.
 */
async function sponsorSubjects(env: Env, butler: ButlerPrincipal): Promise<string[]> {
  return await readableSubjects(env, {
    orgId: butler.orgId, userId: butler.ceiling.sponsorUserId,
  });
}

/**
 * Why a step was refused, when the engine can tell. **Three reasons, because §5C requires three.**
 *
 * *"You never declared it"*, *"you declared it and nobody granted it to this Butler"* and *"it was granted
 * and the sponsor no longer holds it"* are three different sentences with three different remedies — edit
 * and republish, ask an administrator, or find out what happened to the sponsor — and collapsing them into
 * "not permitted" is the same failure as collapsing empty with forbidden.
 *
 * The third names the sponsor, because it is the one that will confuse people: nothing about the Butler
 * changed.
 */
export type Effective =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: EffectiveRefusal };

export type EffectiveRefusal = "capability_not_declared" | "butler_not_granted" | "sponsor_lacks_it";

/**
 * The three-term intersection for a step that **names** its mailbox: `draft` and `mail.send.propose`.
 *
 * Two queries, which is #51's derivation implemented rather than re-derived. The ceiling is free and is
 * asked first, in memory, so a Butler that never declared the action pays **no** round trip and gets the
 * reason that says so.
 *
 * ## `SELECT DISTINCT subject_id` rather than `SELECT 1`, and that is the load-bearing line
 *
 * An `IN` list over subjects answers *"does any of these hold it"*, which is an **OR**; the intersection
 * needs an **AND**. Selecting the subjects rather than a constant is what converts one into the other — the
 * query returns *which* subjects hold the relation, and the AND is evaluated below on the result. Written as
 * `SELECT 1 … LIMIT 1` this would be a check a Butler passes on its sponsor's tuple alone, which is the
 * defect of "a Butler holds whatever its sponsor holds" with nothing to notice it.
 *
 * The sponsor's side stays an OR on purpose, and that asymmetry is the rule rather than an accident: the
 * Butler must hold it **as itself** (it has no team expansion, by #51's decision 1), while the sponsor may
 * hold it directly or through any team, exactly as they would for their own reads.
 */
export async function effectiveOnMailbox(
  env: Env,
  butler: ButlerPrincipal,
  mailboxId: string,
  relations: readonly MailboxRelation[],
): Promise<Effective> {
  const addresses = ceilingAddresses(butler.ceiling, relations);
  // No query at all when nothing was declared. The ceiling is frozen data the run already holds, so this is
  // the one term that can answer without asking the database anything.
  if (addresses.length === 0) return { allowed: false, reason: "capability_not_declared" };

  const sponsors = await sponsorSubjects(env, butler);
  const subjects = [butler.butlerId, ...sponsors];

  /*
   * One statement, two arms, in the shape `hasAnyRelation` uses for its supervised arm — and here the second
   * arm is the **ceiling**, so all three terms come back from one round trip. `#ceiling` cannot collide with
   * a subject id: every subject in this system is a typed-prefix ULID (#6) and none of the prefixes is `#`.
   *
   * The ceiling arm is a lookup by `(org_id, mailbox_id)` on `addresses` rather than by address, because the
   * caller has the mailbox id and the ceiling has the addresses — the join goes the other way round from the
   * folded form above, and lands on the same fact. `DISTINCT` rather than `LIMIT 1`, for two reasons: SQLite
   * refuses a `LIMIT` on a non-final arm of a compound, and several declared addresses can route to one
   * mailbox — which is the very asymmetry #59 was filed about — so collapsing them is what makes this arm
   * one row rather than one per address.
   */
  const { results } = await env.CATALOG.prepare(
    `SELECT DISTINCT '#ceiling' AS holder
       FROM addresses
      WHERE org_id = ?1 AND mailbox_id = ?2 AND address IN (${addresses.map(() => "?").join(", ")})
     UNION ALL
     SELECT DISTINCT subject_id AS holder
       FROM relationship_tuples
      WHERE org_id = ?1 AND object_type = 'mailbox' AND object_id = ?2
        AND relation IN (${relationList(relations)})
        AND subject_id IN (${subjects.map(() => "?").join(", ")})`,
  ).bind(butler.orgId, mailboxId, ...addresses, ...subjects).all<{ holder: string }>();

  const holders = new Set(results.map((row) => row.holder));

  // The AND, evaluated on the result. Three terms, three memberships, and the order is the order the
  // reasons are useful in: what you declared, what you were granted, what your sponsor still holds.
  if (!holders.has("#ceiling")) return { allowed: false, reason: "capability_not_declared" };
  if (!holders.has(butler.butlerId)) return { allowed: false, reason: "butler_not_granted" };
  if (!sponsors.some((subject) => holders.has(subject))) {
    return { allowed: false, reason: "sponsor_lacks_it" };
  }
  return { allowed: true };
}

/**
 * Which relations a `lookup` of each entity is bounded by — the same table the header sets out, as data.
 *
 * A **total map** over `LOOKUP_ENTITIES` rather than a value each `READS` entry keeps privately, because two
 * things now need the same answer: the statement, and the ceiling short-circuit above it. Two copies of
 * *"a message read takes content.read"* is one copy that goes stale, and the stale one would be the check.
 */
const BOUNDED_BY: { [K in (typeof LOOKUP_ENTITIES)[number]]: readonly MailboxRelation[] } = {
  message: ["mailbox.content.read"],
  conversation: READABLE,
  case: READABLE,
  mailbox: READABLE,
  /** None. A draft is bounded by authorship (0012), so no ceiling entry gates it — see `READS.draft`. */
  draft: [],
};

/**
 * One row, projected, or `null` when it does not exist **or** this Butler may not read it. **Two queries.**
 *
 * §5C's rule reached from the non-human side: absent and forbidden answer identically, so a Butler cannot be
 * used as an oracle for which ids exist in mailboxes it holds nothing on. The run records `not_readable`
 * either way, which is honest — the engine genuinely does not know which of the two it was.
 *
 * **And that is also why this returns a row rather than an `Effective`.** A read whose mailbox is discovered
 * by the query cannot separate *"the ceiling does not name that mailbox"* from *"no tuple grants it"*
 * without a second question, and asking it would both cost a round trip and answer the question §5C wants
 * left unanswered. The three reasons are available where the step **names** its mailbox
 * (`effectiveOnMailbox`), which is exactly the case where the author already knows which mailbox they meant.
 */
export async function readEntity(
  env: Env,
  butler: ButlerPrincipal,
  entity: (typeof LOOKUP_ENTITIES)[number],
  entityId: string,
): Promise<Record<string, unknown> | null> {
  const relations = BOUNDED_BY[entity];
  // Nothing declared, nothing readable — and no query, which is what makes the ceiling the cheapest term.
  // A `draft` read takes no relation at all, so it skips this and is bounded by authorship instead.
  if (relations.length > 0 && ceilingAddresses(butler.ceiling, relations).length === 0) return null;

  const sponsors = relations.length === 0 ? [] : await sponsorSubjects(env, butler);

  // Each entry binds in the order its own SQL asks for, rather than every statement having to agree on one
  // parameter order — the `message` read interleaves the id between two organization ids, and forcing a
  // shared order on five different joins is how a bind lands in the wrong placeholder.
  const read = READS[entity](butler, sponsors, entityId);
  const row = await env.CATALOG.prepare(read.sql).bind(...read.params).first<Record<string, unknown>>();
  return row ?? null;
}

/**
 * The mailbox a case is in, but only when the **whole intersection** admits `relation` on it. Two queries.
 *
 * Both `case.assign` and `case.close` need this before they call what a human calls, and they need it
 * cheaply: `cases.ts`'s `claim` checks the *assignee's* authority, not the caller's, so without this a
 * Butler holding nothing anywhere could assign any case in the organization to anybody who may work it.
 * Reading the case, then asking the ceiling, then asking two sets of tuples would be four round trips
 * against a `butler.run_cost_max_case_assign` of 10 with `claim` already spending 5. Folded, it is the
 * sponsor's subjects and then one statement — the two #51 derived.
 *
 * Returns `null` for a case that does not exist and for one this Butler may not act on, alike — §5C, and
 * the same reason `readEntity` returns a row rather than an `Effective`.
 */
export async function caseMailboxHeldBy(
  env: Env,
  butler: ButlerPrincipal,
  caseId: string,
  relation: MailboxRelation,
): Promise<{ mailboxId: string; state: string; assignee: string | null } | null> {
  // The ceiling first, in memory and for free, so a Butler that never declared this action costs nothing.
  if (ceilingAddresses(butler.ceiling, [relation]).length === 0) return null;
  const sponsors = await sponsorSubjects(env, butler);
  const bound = effectiveOn("mailbox_id", [relation], butler, sponsors);
  const row = await env.CATALOG.prepare(
    `SELECT mailbox_id, state, assignee FROM cases
      WHERE org_id = ? AND id = ? AND ${bound.sql} LIMIT 1`,
  ).bind(butler.orgId, caseId, ...bound.params)
    .first<{ mailbox_id: string; state: string; assignee: string | null }>();
  return row === null
    ? null
    : { mailboxId: row.mailbox_id, state: row.state, assignee: row.assignee };
}

/** What `steps.<as>` carries after a lookup, for the engine's documentation and for a refusal. */
export function projectionOf(entity: (typeof LOOKUP_ENTITIES)[number]): readonly string[] {
  return PROJECTION[entity];
}

/** A `lookup` whose `entityId` expression produced something that is not an id. */
export function notAnId(node: string, entity: string, value: unknown): ButlerFault {
  return new ButlerFault("E_BUTLER_LOOKUP_NOT_AN_ID", {
    what: `lookup of a ${entity} was given ${value === null ? "null" : typeof value} rather than an id`,
    why: "an entity is read by id from a closed set of tables, and a non-string cannot be one",
    fix: `make ${JSON.stringify("entityId")} resolve to a string`,
  }, node);
}
