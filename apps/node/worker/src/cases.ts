import type { Ctx } from "@mailda/runtime";

import { auditedBatch, recordDisclosure } from "./audit.ts";
import { mayReadMetadata, maySend, readableSubjects } from "./authz-read.ts";
import { buildSupervisedQuery } from "./supervised.ts";

/**
 * The case: the unit of work somebody claims, and the claim protocol around it.
 *
 * ## Contention is a conditional UPDATE, not a lock
 *
 * `UPDATE cases SET assignee = ? WHERE assignee IS NULL` — D1 is SQLite, the statement is atomic, and
 * `changes = 0` means somebody else won. No Durable Object, deliberately: a DO would buy serialised
 * ordering, which is what §12 invariant 5's monotonic change number needs and which "two people work one
 * queue without colliding" does not. It is the same shape already carrying the audit sequence, the
 * migration-ledger race and provider event ids — the conflict *is* the signal.
 *
 * **`changes = 0` is read back rather than reported as a bare false.** `cancelSend` set that precedent and
 * it is the part that is easy to skip: "somebody got there first" and "there was nothing to claim" are
 * different answers, and a person who lost a race is owed the name of whoever won it.
 *
 * ## Claiming and composing are one act
 *
 * Reply performs the claim and opens the composer together (#42). The guarantee lives in the compare-and-
 * swap, not in a separate gesture, so a second click bought deliberateness rather than safety on the most
 * repeated interaction in the product. `claim()` is therefore what the reply button calls.
 *
 * The cost, accepted with its remedy already in place: a case can be held by somebody who never typed.
 * `claimed_at` is displayed and never enforced — there is no timeout, because an expiry is a policy guess
 * while an age is a fact — and stealing is available to any colleague and audited.
 *
 * ## What is audited here, and what is deliberately not
 *
 * An ordinary claim and release are **not** audited. People claim all day; audit entries are never trimmed
 * and `audit-and-log-retention.md` sizes the table at a handful per message, so one entry per claim grows an
 * untrimmable table without bound. Claim history lives on the case.
 *
 * **Stealing is audited**, because taking work off a named colleague is an act somebody could be asked
 * about. That is the whole boundary: frequency and whether a person is answerable for it.
 */

export type CaseState = "open" | "claimed" | "closed";

export interface CaseRow {
  id: string;
  conversation_id: string;
  mailbox_id: string;
  state: CaseState;
  state_at: string;
  assignee: string | null;
  claimed_at: string | null;
  created_at: string;
}

/** Why a claim did not happen. Each is a different answer and the caller shows a different thing. */
export type ClaimRefusal =
  // No `forbidden`. §5C makes a case in a mailbox you cannot send as answer identically to one that does not
  // exist, so there is no third answer to represent — and the type checker rejected the variant as
  // unreachable when it was declared, which is the decision enforcing itself.
  | { kind: "not_found" }
  | { kind: "closed" }
  | { kind: "held"; by: string; since: string };

export type ClaimOutcome = { kind: "claimed"; case: CaseRow } | ClaimRefusal;

/**
 * Creates the case for a delivery, if the mailbox does not already have one for this conversation.
 *
 * Returned as statements rather than executed, so the caller commits them **in the same batch** as the
 * message and the mailbox item. A case that existed without its message, or a message filed with no case in
 * the queue it belongs to, are both states a reader would have to reconcile by hand.
 *
 * `INSERT OR IGNORE` against `cas_unique`, so a redelivery — or two deliveries racing — files one case. The
 * constraint is the concurrency control, not a check performed beforehand.
 */
export function caseForDelivery(
  env: Env,
  ctx: Ctx,
  orgId: string,
  conversationId: string,
  mailboxId: string,
  at: string,
): D1PreparedStatement {
  return env.CATALOG.prepare(
    `INSERT OR IGNORE INTO cases
       (id, org_id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at, created_at)
     VALUES (?,?,?,?, 'open', ?, NULL, NULL, ?)`,
  ).bind(ctx.id("cas"), orgId, conversationId, mailboxId, at, at);
}

async function caseById(env: Env, orgId: string, caseId: string): Promise<CaseRow | null> {
  return await env.CATALOG.prepare(
    `SELECT id, conversation_id, mailbox_id, state, state_at, assignee, claimed_at, created_at
       FROM cases WHERE org_id = ? AND id = ? LIMIT 1`,
  )
    .bind(orgId, caseId)
    .first<CaseRow>();
}

/**
 * Takes an unclaimed case. This is what the reply button calls.
 *
 * Gated on `send.propose` (#39): the purpose of claiming is to reply, so the authority to claim and the
 * authority to reply are the same one. A claim somebody cannot act on is work held hostage; a send without a
 * claim defeats the mechanism entirely.
 */
export async function claim(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<ClaimOutcome> {
  const existing = await caseById(env, orgId, caseId);
  // §5C: a case that does not exist and one in a mailbox this caller cannot send as answer identically.
  if (existing === null) return { kind: "not_found" };
  if (!(await maySend(env, { orgId, userId }, existing.mailbox_id))) return { kind: "not_found" };
  if (existing.state === "closed") return { kind: "closed" };

  const at = new Date(ctx.now()).toISOString();
  const result = await env.CATALOG.prepare(
    `UPDATE cases SET assignee = ?, claimed_at = ?, state = 'claimed', state_at = ?
      WHERE org_id = ? AND id = ? AND assignee IS NULL AND state != 'closed'`,
  )
    .bind(userId, at, at, orgId, caseId)
    .run();

  if ((result.meta.changes ?? 0) > 0) {
    return { kind: "claimed", case: (await caseById(env, orgId, caseId))! };
  }

  // Lost the race, or it was already held. Re-read so the answer can name who holds it and since when —
  // `changes = 0` alone would leave a person guessing whether to wait, steal, or move on.
  const now = await caseById(env, orgId, caseId);
  if (now === null) return { kind: "not_found" };
  if (now.state === "closed") return { kind: "closed" };
  return { kind: "held", by: now.assignee ?? "(unknown)", since: now.claimed_at ?? now.state_at };
}

/**
 * Takes a case from whoever is holding it.
 *
 * This is the escape hatch the no-timeout design rests on: with nothing expiring, stealing is the only way a
 * held case returns. Restricting it to administrators recreates the blocked queue a timeout would have
 * prevented — Ana on holiday holding six cases, the only admin also away — and there is no third answer.
 *
 * So it is stated without softening: **claim-before-composing prevents accidents, not takeover.** A
 * colleague who wants your case can have it. What the design guarantees is that it cannot happen silently.
 * Hence the audit entry, which names who took it from whom.
 */
export async function steal(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<ClaimOutcome> {
  const existing = await caseById(env, orgId, caseId);
  if (existing === null) return { kind: "not_found" };
  if (!(await maySend(env, { orgId, userId }, existing.mailbox_id))) return { kind: "not_found" };
  if (existing.state === "closed") return { kind: "closed" };
  // Nothing to take. Reported as its own answer rather than silently succeeding, because "I stole this" and
  // "it was free" are different things to have done.
  if (existing.assignee === null) return { kind: "held", by: "(nobody)", since: existing.state_at };

  const at = new Date(ctx.now()).toISOString();
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "case.claim_taken",
      outcome: "ok",
      actorUserId: userId,
      subject: caseId,
      detail: { from: existing.assignee, heldSince: existing.claimed_at, mailboxId: existing.mailbox_id },
    },
    (entry) => [
      entry,
      env.CATALOG.prepare(
        // Conditional on the holder not having changed since it was read. Two people stealing at once must
        // not both succeed, and the loser must not silently overwrite the winner.
        `UPDATE cases SET assignee = ?, claimed_at = ?, state = 'claimed', state_at = ?
          WHERE org_id = ? AND id = ? AND assignee = ?`,
      ).bind(userId, at, at, orgId, caseId, existing.assignee),
    ],
    {
      sql: "SELECT 1 FROM cases WHERE org_id = ? AND id = ? AND assignee = ?",
      params: [orgId, caseId, existing.assignee],
    },
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    const now = await caseById(env, orgId, caseId);
    return now === null
      ? { kind: "not_found" }
      : { kind: "held", by: now.assignee ?? "(nobody)", since: now.claimed_at ?? now.state_at };
  }
  return { kind: "claimed", case: (await caseById(env, orgId, caseId))! };
}

/**
 * Puts a case back. Only its holder may, which is what makes stealing the mechanism for everything else.
 *
 * Unaudited, like claiming: it is the same act in reverse and at the same frequency.
 */
export async function release(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<{ released: boolean; reason?: string }> {
  const at = new Date(ctx.now()).toISOString();
  const result = await env.CATALOG.prepare(
    `UPDATE cases SET assignee = NULL, claimed_at = NULL, state = 'open', state_at = ?
      WHERE org_id = ? AND id = ? AND assignee = ?`,
  )
    .bind(at, orgId, caseId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0
    ? { released: true }
    : { released: false, reason: "You are not holding this case." };
}

/**
 * Closes a case, and closing implies releasing.
 *
 * Left open by #40 as "one act or two". One: a closed case with an assignee would show in somebody's "what
 * am I working on" forever, and nothing needs a holder for work that is finished.
 */
export async function close(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<{ closed: boolean; reason?: string }> {
  const at = new Date(ctx.now()).toISOString();
  const result = await env.CATALOG.prepare(
    `UPDATE cases SET state = 'closed', state_at = ?, assignee = NULL, claimed_at = NULL
      WHERE org_id = ? AND id = ? AND assignee = ? AND state != 'closed'`,
  )
    .bind(at, orgId, caseId, userId)
    .run();
  return (result.meta.changes ?? 0) > 0
    ? { closed: true }
    : { closed: false, reason: "Only the person holding a case may close it." };
}

export interface QueueEntry extends CaseRow {
  /**
   * NULL when there is no message, **or** when the caller may not see it — and those are different answers,
   * which is why `content_restricted` exists rather than leaving a reader to infer one from a null. §5C's
   * whole point: absent and forbidden must not render identically, and a subject can legitimately be empty.
   */
  subject: string | null;
  from_addr: string | null;
  /**
   * How many messages are on the case. Not restricted, deliberately: the caller already knows this case
   * exists — they hold `send.propose` and can claim it — and a count of items within it discloses nothing
   * about their content. §7's rule is that counters must not leak *that restricted content exists*, and the
   * existence of the case is not what is being withheld here; its subject line is.
   */
  message_count: number;
  /**
   * True when this row's message-derived columns were withheld rather than absent.
   *
   * Sent to the client so the queue can render §7's "restricted-content placeholder" instead of guessing.
   * A flag on the row rather than one on the response, because it is per case in principle — nothing today
   * varies it within a mailbox, and a per-response flag would have to be widened by whoever adds per-case
   * relations rather than merely used.
   */
  content_restricted: boolean;
  /**
   * Who holds it, as a person rather than an identifier.
   *
   * The first version returned `assignee` alone and the queue rendered `usr_01KZ…` in the "held by" column.
   * Somebody deciding whether to take a case cannot weigh that. Disclosing a colleague's address to another
   * member of the same queue is not a §5C question — they already share the mailbox — but it *is* a
   * disclosure, which is why it is bounded to the queue's own members by the check above.
   */
  assignee_email: string | null;
  /**
   * The clock (#41). NULL throughout when the mailbox promises nothing, which is the shipped default.
   *
   * Carried into the queue because a breach recorded and never shown is the silence this whole codebase
   * exists to remove — the sweep writes `response_breached_at` and, until this, nothing displayed it.
   */
  response_due_at: string | null;
  first_response_at: string | null;
  response_breached_at: string | null;
}

/**
 * One mailbox's queue: unclaimed first, then oldest.
 *
 * Bounded by the caller's relation on **that** mailbox, checked before the read rather than filtered after
 * — and it answers empty rather than forbidden for a mailbox they cannot see, because §5C keeps an absent
 * thing and an invisible one alike.
 *
 * A case reveals **nothing about sibling cases** on the same conversation in other mailboxes (#44). Not the
 * content, not the assignee, not that they exist. §5C names existence and counts as gated, and the one place
 * this codebase deliberately breaks the identical-answer rule rests on prior knowledge of the object, which
 * a reader of another mailbox does not have.
 *
 * ## Two relations, two different things
 *
 * `send.propose` decides whether there is a queue here at all, because the queue exists to be worked. It does
 * **not** decide whether the subject line and the sender address are shown: those come from `messages`, and
 * §7 forbids case metadata from carrying content that was not separately authorized. That rule was being
 * broken — this function selected both columns behind the send gate alone, so anybody who could reply read
 * every subject line in the mailbox. `mailbox.metadata.read` (or `mailbox.content.read`) now gates them, and
 * the columns are **replaced with NULL in the SQL** rather than read and discarded: a row the caller may not
 * see should not be in the result set for a later change to start returning.
 */
export async function queueFor(
  env: Env,
  /*
   * The clock, and it is here for `mayReadMetadata` (#63): a supervised grant expires, so the question
   * "may this person see these subject lines" now has an instant in it. Threaded rather than read from
   * `Date.now()` inside, because §27's deterministic replay is that seam and lint bans the bare call.
   */
  ctx: Ctx,
  orgId: string,
  userId: string,
  mailboxId: string,
): Promise<QueueEntry[]> {
  const who = { orgId, userId };
  /*
   * `send.propose` first, and that ordering is what keeps a supervised reader out of somebody's queue: a
   * grant satisfies the metadata check below but never this one, so a mailbox nobody has given them
   * `send.propose` on returns an empty queue however wide their grant is. A supervised reader is not a
   * member working this queue, and should not appear to be one.
   */
  if (!(await maySend(env, who, mailboxId))) return [];
  /*
   * The metadata check now says **how** it was satisfied, because a supervised grant owes §7 a record and a
   * standing relation does not (#63 part B). It cannot record for itself: the cases it is about to disclose do
   * not exist yet at the moment of the check, and an entry that could not name them would understate what was
   * seen — which is the whole reason a query entry carries ids. So the record is written below, once the rows
   * are in hand, and `recordDisclosure` throws rather than swallowing, so a queue this Node cannot record is a
   * queue it does not return.
   */
  const metadata = await mayReadMetadata(env, ctx, who, mailboxId);
  const maySeeContent = metadata.allowed;

  // One template with one substitution, so the two variants cannot drift into selecting different case
  // columns. The literal NULLs keep the result shape identical, which is what lets the row type stay one type.
  const messageColumns = maySeeContent
    ? `(SELECT m.subject FROM messages m
         WHERE m.org_id = c.org_id AND m.conversation_id = c.conversation_id
         ORDER BY m.sent_at DESC LIMIT 1) AS subject,
       (SELECT m.from_addr FROM messages m
         WHERE m.org_id = c.org_id AND m.conversation_id = c.conversation_id
         ORDER BY m.sent_at DESC LIMIT 1) AS from_addr`
    : `NULL AS subject, NULL AS from_addr`;

  const { results } = await env.CATALOG.prepare(
    `SELECT c.id, c.conversation_id, c.mailbox_id, c.state, c.state_at, c.assignee, c.claimed_at,
            c.created_at,
            ${messageColumns},
            (SELECT COUNT(*) FROM messages m
              WHERE m.org_id = c.org_id AND m.conversation_id = c.conversation_id) AS message_count,
            (SELECT u.email FROM users u WHERE u.id = c.assignee) AS assignee_email,
            c.response_due_at, c.first_response_at, c.response_breached_at
       FROM cases c
      WHERE c.org_id = ? AND c.mailbox_id = ? AND c.state != 'closed'
      ORDER BY CASE WHEN c.assignee IS NULL THEN 0 ELSE 1 END, c.created_at`,
  )
    .bind(orgId, mailboxId)
    .all<Omit<QueueEntry, "content_restricted">>();

  // A supervised reader saw these subject lines and senders, so §7 wants the ids. The case ids are what this
  // listing returned, so they are what the entry names — the same `buildSupervisedQuery` the message listing
  // uses, so one act cannot be recorded two ways.
  if (metadata.grantId !== null) {
    await recordDisclosure(env, ctx, orgId, buildSupervisedQuery(
      metadata.grantId, userId, mailboxId, results.map((row) => row.id),
    ));
  }

  // Set here rather than selected as a SQL literal, because it is a fact about the caller and not about the
  // row, and putting it in the query would make it look like something the database decided.
  return results.map((row) => ({ ...row, content_restricted: !maySeeContent }));
}

export interface MailboxQueue {
  id: string;
  name: string;
  /** NULL means this mailbox promises nothing, which is what a fresh Node ships with. */
  first_response_minutes: number | null;
  /**
   * Every address routed to this mailbox, oldest first, comma-separated.
   *
   * Carried so the composer can *offer* the From choice rather than a caller discovering by refusal that a
   * mailbox has several. `sealManifest` refuses an unnamed sender on a multi-address mailbox, and a refusal
   * with no way to comply is a dead end — this is the way to comply.
   *
   * Disclosing them here is bounded by the same relation the queue is: the caller already holds
   * `send.propose` on this mailbox, so these are the addresses they may send as.
   */
  addresses: string;
  /** Cases past their target and unanswered — the number that should make somebody act. */
  breached: number;
  /** Unclaimed, open cases — the number the rail exists to carry. */
  unclaimed: number;
  /** Claimed by anybody, including the caller. Distinguished because "in progress" is not "waiting". */
  claimed: number;
  /** Claimed by the caller. What "am I holding anything here" needs, without a second request. */
  mine: number;
}

/**
 * The mailboxes this person may work, with their queue depths.
 *
 * The rail was chosen over route tabs on exactly this: a persistent list of mailboxes carrying per-item
 * counts. It has carried one hardcoded row since it was built, because nothing could tell it what mailboxes
 * exist — this is that.
 *
 * Bounded by `send.propose`, matching `queueFor`: the rail lists queues you can *work*, and a count of
 * unclaimed work in a mailbox you cannot claim from would be an invitation to nothing. A mailbox somebody
 * can only read is absent rather than shown at zero, because §5C makes "no such queue" and "a queue you may
 * not work" answer alike, and a zero is a count — which Blueprint:358 gates before returning.
 *
 * One query, not one per mailbox. The counts are correlated subqueries over `cas_queue`, so the rail costs a
 * single round trip however many mailboxes a person holds.
 */
export async function mailboxQueues(env: Env, orgId: string, userId: string): Promise<MailboxQueue[]> {
  const subjects = await readableSubjects(env, { orgId, userId });
  const placeholders = subjects.map(() => "?").join(", ");

  const { results } = await env.CATALOG.prepare(
    `SELECT m.id, m.name, m.first_response_minutes,
            (SELECT GROUP_CONCAT(a.address) FROM (
               SELECT address FROM addresses
                WHERE org_id = m.org_id AND mailbox_id = m.id ORDER BY created_at
             ) a) AS addresses,
            (SELECT COUNT(*) FROM cases c
              WHERE c.org_id = m.org_id AND c.mailbox_id = m.id
                AND c.response_breached_at IS NOT NULL AND c.first_response_at IS NULL
                AND c.state != 'closed') AS breached,
            (SELECT COUNT(*) FROM cases c
              WHERE c.org_id = m.org_id AND c.mailbox_id = m.id
                AND c.state = 'open' AND c.assignee IS NULL) AS unclaimed,
            (SELECT COUNT(*) FROM cases c
              WHERE c.org_id = m.org_id AND c.mailbox_id = m.id
                AND c.state = 'claimed') AS claimed,
            (SELECT COUNT(*) FROM cases c
              WHERE c.org_id = m.org_id AND c.mailbox_id = m.id
                AND c.assignee = ?) AS mine
       FROM mailboxes m
      WHERE m.org_id = ?
        AND m.id IN (
          SELECT object_id FROM relationship_tuples
           WHERE org_id = ? AND subject_id IN (${placeholders})
             AND object_type = 'mailbox' AND relation = 'send.propose'
        )
      ORDER BY m.name`,
  )
    .bind(userId, orgId, orgId, ...subjects)
    .all<MailboxQueue>();
  return results;
}
