import { LOOKUP_ENTITIES } from "@mailda/butler-ast";

import type { MailboxRelation } from "../access.ts";
import { ButlerFault } from "./expr.ts";
import type { ButlerPrincipal } from "./principal.ts";

/**
 * Reading storage as a Butler: one query per read, bounded by the Butler's own tuples (#50, #54).
 *
 * ## This is not a second authorization system, and the reason it is not is worth being exact about
 *
 * It reads the **same table**, the same `relation` names (typed as `MailboxRelation`, so a mistyped relation
 * is a compile error rather than a check that silently matches nothing), and the same tuple shape as
 * `hasAnyRelation` in `src/authz-read.ts`. What it does not do is resolve *team* membership, and that is not
 * a shortcut: `team_members.user_id` holds users, a Butler's subject is a `btl_`, so for a Butler that read
 * returns nothing by construction. Paying a subrequest for a query that cannot match is the whole reason
 * this exists as a separate shape, and `docs/receipts/butler-run-cost.md` records what it saves.
 *
 * The claim that the two agree is a claim, so it is checked: `test/butler-run.test.ts` grants a tuple to a
 * Butler and asserts that this and `maySend(actingAs(butler), …)` answer alike, and that revoking it stops
 * both. A helper that drifted from `hasAnyRelation` would be the failure `authz-read.ts`'s own header warns
 * about — *"a second hand-written variant would be a second thing for that receipt to stop describing"* —
 * so it is tested against the original rather than argued into safety.
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

/** The SQL that bounds each entity to what this Butler may read. One statement, one subrequest. */
const READS: {
  [K in (typeof LOOKUP_ENTITIES)[number]]:
    (butler: ButlerPrincipal, entityId: string) => { sql: string; params: unknown[] };
} = {
  message: (butler, entityId) => ({
    // The path `sealManifest` already uses to decide whether a reply may thread onto a parent:
    // `ingress_receipts.envelope_to` → `addresses` → the mailbox the message was delivered into. `messages`
    // carries no mailbox column, so this join is the only thing that says where a message actually landed —
    // and organization membership is emphatically not the same question.
    sql: `SELECT ${PROJECTION.message.map((field) => `m.${field}`).join(", ")}
            FROM messages m
            JOIN ingress_receipts r ON r.org_id = m.org_id AND r.id = m.ingress_receipt_id
            JOIN addresses a ON a.org_id = r.org_id AND a.address = r.envelope_to
           WHERE m.org_id = ? AND m.id = ?
             AND ${heldOn("a.mailbox_id", ["mailbox.content.read"])}
           LIMIT 1`,
    params: [butler.orgId, entityId, butler.orgId, butler.butlerId],
  }),
  conversation: (butler, entityId) => ({
    // A conversation spans mailboxes, so the bound is *some* case on it sitting in a mailbox this Butler may
    // read. Not "any case in the org": that would make a conversation id a way to learn the grouping of mail
    // in mailboxes the Butler holds nothing on.
    sql: `SELECT ${PROJECTION.conversation.map((field) => `c.${field}`).join(", ")}
            FROM conversations c
           WHERE c.org_id = ? AND c.id = ?
             AND EXISTS (SELECT 1 FROM cases k
                          WHERE k.org_id = c.org_id AND k.conversation_id = c.id
                            AND ${heldOn("k.mailbox_id", READABLE)})
           LIMIT 1`,
    params: [butler.orgId, entityId, butler.orgId, butler.butlerId],
  }),
  case: (butler, entityId) => ({
    sql: `SELECT ${PROJECTION.case.map((field) => `k.${field}`).join(", ")}
            FROM cases k
           WHERE k.org_id = ? AND k.id = ? AND ${heldOn("k.mailbox_id", READABLE)}
           LIMIT 1`,
    params: [butler.orgId, entityId, butler.orgId, butler.butlerId],
  }),
  mailbox: (butler, entityId) => ({
    sql: `SELECT ${PROJECTION.mailbox.map((field) => `b.${field}`).join(", ")}
            FROM mailboxes b
           WHERE b.org_id = ? AND b.id = ? AND ${heldOn("b.id", READABLE)}
           LIMIT 1`,
    params: [butler.orgId, entityId, butler.orgId, butler.butlerId],
  }),
  draft: (butler, entityId) => ({
    // No tuple check, and no mailbox join. A draft is readable by its author and by nobody else (0012), so
    // for a Butler that means **its own** drafts — the ones a `draft` node in some run of this Butler wrote.
    // Reading another author's unfinished writing is not a thing this Node lets anybody do.
    sql: `SELECT ${PROJECTION.draft.join(", ")}
            FROM drafts WHERE org_id = ? AND id = ? AND author_user_id = ? LIMIT 1`,
    params: [butler.orgId, entityId, butler.butlerId],
  }),
};

/**
 * `EXISTS` over the tuple table for one mailbox column.
 *
 * Written as a fragment rather than a second query because `authz.check.max_queries = 2` is what a
 * *human's* check costs and a Butler's is one: folding it into the statement is the same technique
 * `hasAnyRelation` uses for its supervised arm, for the same reason — a second round trip on every read.
 */
function heldOn(column: string, relations: readonly MailboxRelation[]): string {
  return `EXISTS (SELECT 1 FROM relationship_tuples
                   WHERE org_id = ? AND subject_id = ? AND object_type = 'mailbox'
                     AND relation IN (${relations.map((relation) => `'${relation}'`).join(", ")})
                     AND object_id = ${column})`;
}

/**
 * One row, projected, or `null` when it does not exist **or** this Butler may not read it.
 *
 * §5C's rule reached from the non-human side: absent and forbidden answer identically, so a Butler cannot be
 * used as an oracle for which ids exist in mailboxes it holds nothing on. The run records `not_readable`
 * either way, which is honest — the engine genuinely does not know which of the two it was.
 */
export async function readEntity(
  env: Env,
  butler: ButlerPrincipal,
  entity: (typeof LOOKUP_ENTITIES)[number],
  entityId: string,
): Promise<Record<string, unknown> | null> {
  // Each entry binds in the order its own SQL asks for, rather than every statement having to agree on one
  // parameter order — the `message` read interleaves the id between two organization ids, and forcing a
  // shared order on five different joins is how a bind lands in the wrong placeholder.
  const read = READS[entity](butler, entityId);
  const row = await env.CATALOG.prepare(read.sql).bind(...read.params).first<Record<string, unknown>>();
  return row ?? null;
}

/**
 * The mailbox a case is in, but only when this Butler holds `relation` on it. One query.
 *
 * Both `case.assign` and `case.close` need this before they call what a human calls, and they need it in
 * **one** subrequest: `cases.ts`'s `claim` checks the *assignee's* authority, not the caller's, so without
 * this a Butler holding nothing anywhere could assign any case in the organization to anybody who may work
 * it. Reading the case and then asking `maySend` separately is three queries against a
 * `butler.step_cost_max_case_assign` of 8 with `claim` already spending 5 — which is why this is one
 * statement rather than two calls.
 *
 * Returns `null` for a case that does not exist and for one this Butler may not act on, alike.
 */
export async function caseMailboxHeldBy(
  env: Env,
  butler: ButlerPrincipal,
  caseId: string,
  relation: MailboxRelation,
): Promise<{ mailboxId: string; state: string; assignee: string | null } | null> {
  const row = await env.CATALOG.prepare(
    `SELECT mailbox_id, state, assignee FROM cases
      WHERE org_id = ? AND id = ? AND ${heldOn("mailbox_id", [relation])} LIMIT 1`,
  ).bind(butler.orgId, caseId, butler.orgId, butler.butlerId)
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
