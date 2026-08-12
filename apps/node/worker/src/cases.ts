import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { maySend } from "./authz-read.ts";

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
  subject: string | null;
  from_addr: string | null;
  message_count: number;
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
 */
export async function queueFor(
  env: Env,
  orgId: string,
  userId: string,
  mailboxId: string,
): Promise<QueueEntry[]> {
  if (!(await maySend(env, { orgId, userId }, mailboxId))) return [];

  const { results } = await env.CATALOG.prepare(
    `SELECT c.id, c.conversation_id, c.mailbox_id, c.state, c.state_at, c.assignee, c.claimed_at,
            c.created_at,
            (SELECT m.subject FROM messages m
              WHERE m.org_id = c.org_id AND m.conversation_id = c.conversation_id
              ORDER BY m.sent_at DESC LIMIT 1) AS subject,
            (SELECT m.from_addr FROM messages m
              WHERE m.org_id = c.org_id AND m.conversation_id = c.conversation_id
              ORDER BY m.sent_at DESC LIMIT 1) AS from_addr,
            (SELECT COUNT(*) FROM messages m
              WHERE m.org_id = c.org_id AND m.conversation_id = c.conversation_id) AS message_count
       FROM cases c
      WHERE c.org_id = ? AND c.mailbox_id = ? AND c.state != 'closed'
      ORDER BY CASE WHEN c.assignee IS NULL THEN 0 ELSE 1 END, c.created_at`,
  )
    .bind(orgId, mailboxId)
    .all<QueueEntry>();
  return results;
}
