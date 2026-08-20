import type { Ctx } from "@mailda/runtime";

import { auditedBatch } from "./audit.ts";
import { holdsStandingRead } from "./authz-read.ts";
import { assertNotHeld } from "./holds.ts";
import { notFound, unprocessable } from "./errors.ts";

/**
 * Merging two conversations (#43).
 *
 * ## This is a refusal policy, not a merge algorithm
 *
 * Twelve pair-states can occur when merging conversation A into B, given a case is
 * `UNIQUE (conversation_id, mailbox_id)`. **Two are safe to automate.** The other ten mean a single-winner
 * merge either destroys data or asserts something false, and the deciding class is false compliance: two
 * running SLA clocks means either resetting a breach that happened or importing one that did not. AGENTS.md's
 * rule that an unverified number is worse than a blank applies to compliance state too — the failure of
 * merge-by-picking is not lost text, it is a system reporting something untrue about work it owes a customer.
 *
 * So this merges the two safe states and **refuses everything else, naming the obstruction**. A refusal a
 * person can act on beats a merge that quietly picked.
 *
 * ## All-or-nothing across every mailbox
 *
 * The pair-states occur simultaneously and differently per mailbox, so a per-mailbox rule would permit a
 * *partially merged* conversation — which contradicts a conversation being one thing, org-scoped. One
 * contested pair therefore refuses the whole merge. `batch()` being one transaction makes that free to
 * implement; the cost is the refusal message, which has to name which mailbox and which two cases.
 *
 * ## Merging cannot leak content
 *
 * The instinctive fear is that merging support@'s conversation into billing@'s exposes one mailbox's mail to
 * the other's readers. It cannot: access is evaluated per delivery (§12 invariant 3) and messages stay
 * attached to their deliveries. Merging groups; it does not grant.
 *
 * Authorization therefore goes through the **cases**, not the conversation — there is no conversation-level
 * authorization primitive, and inventing one would create an org-scoped read authority nothing else has.
 * `mailbox.content.read` on every mailbox either conversation touches: you cannot merge what you cannot see,
 * not because merging leaks but because a merge whose consequences you cannot see is one you cannot be
 * accountable for.
 */

/** Why a merge did not happen. Each names something a person can go and fix. */
export interface MergeRefusal {
  merged: false;
  reason: string;
  /** The mailbox whose case pair blocked it, when one did. */
  mailboxId?: string;
}

export interface MergeSuccess {
  merged: true;
  /** The surviving conversation. */
  into: string;
  messagesMoved: number;
  casesMerged: number;
}

export type MergeOutcome = MergeSuccess | MergeRefusal;

interface CasePair {
  mailboxId: string;
  /** `createdAt` is here for the legal hold: it is the instant the hold's window is tested against. */
  source: { id: string; state: string; assignee: string | null; createdAt: string } | null;
  target: { id: string; state: string; assignee: string | null; createdAt: string } | null;
}

/**
 * The two auto-mergeable pair-states, and nothing else.
 *
 * **(b) only one side has a case in this mailbox, or neither does** — nothing to reconcile, so the source's
 * case (if any) simply becomes the target's.
 * **(f) both claimed by the same person** — the holder is unchanged, so no claim is lost and nobody is
 * silently unassigned.
 *
 * Everything else returns a reason. The ones worth naming in the message are the ones where a person has a
 * decision to make rather than a bug to report.
 */
function pairObstruction(pair: CasePair): string | null {
  const { source, target } = pair;
  if (source === null || target === null) return null;

  if (source.state === "closed" || target.state === "closed") {
    // Picking `closed` hides live work; picking `open` reopens a case already reported as closed.
    return "one of the two cases is closed, and merging would either hide live work or silently reopen "
      + "something already reported finished";
  }
  if (source.assignee === null && target.assignee === null) {
    // (c). Safe-looking and not safe: the loser's history goes, and with it the earlier clock start.
    return "both cases are unclaimed, so merging would discard one side's history — and the earlier SLA "
      + "start, which is the one a breach is computed from";
  }
  if (source.assignee !== null && target.assignee !== null && source.assignee !== target.assignee) {
    // (e). No non-destructive single-winner outcome exists.
    return `the two cases are held by different people (${source.assignee} and ${target.assignee}); one of `
      + "them would lose a case they are working on without being asked";
  }
  if (source.assignee !== target.assignee) {
    // (d). One claimed, one not.
    return "one of the two cases is claimed and the other is not, so merging would either unassign somebody "
      + "mid-reply or discard the unclaimed side's history";
  }
  // (f): both held by the same person.
  return null;
}

/**
 * Merges `sourceId` into `targetId`.
 *
 * Order matters to a reader: the source is the one that stops existing as a separate conversation, and its
 * row is **kept** with `merged_into` set rather than deleted — merge is an audited act, and the trail must
 * not disagree with the data about whether there used to be two.
 */
export async function mergeConversations(
  env: Env,
  ctx: Ctx,
  orgId: string,
  userId: string,
  sourceId: string,
  targetId: string,
): Promise<MergeOutcome> {
  if (sourceId === targetId) {
    throw unprocessable("E_MERGE_INTO_SELF", {
      what: "a conversation cannot be merged into itself",
      why: "the operation would repoint every message at the row it already points at, and record an act that did not happen",
      fix: "name two different conversations",
    });
  }

  const rows = await env.CATALOG.prepare(
    `SELECT id, merged_into FROM conversations WHERE org_id = ? AND id IN (?, ?)`,
  ).bind(orgId, sourceId, targetId).all<{ id: string; merged_into: string | null }>();

  const source = rows.results.find((row) => row.id === sourceId);
  const target = rows.results.find((row) => row.id === targetId);
  // §5C: absent and invisible answer alike, and a conversation is only ever reached through a case somebody
  // holds — so a caller who cannot see either is told the same thing as one naming a conversation that never
  // existed.
  if (source === undefined || target === undefined) {
    throw notFound("E_NO_CONVERSATION", {
      what: `conversation ${source === undefined ? sourceId : targetId} does not exist`,
      why: "a conversation is reached through the cases on it, so this is also the answer when you hold none of them",
      fix: "check the conversation id",
    });
  }
  if (source.merged_into !== null || target.merged_into !== null) {
    return {
      merged: false,
      reason: "one of these conversations has already been merged away. Merge into the surviving one.",
    };
  }

  // Every mailbox either conversation touches, and the caller must be able to see all of them.
  const { results: touched } = await env.CATALOG.prepare(
    `SELECT DISTINCT mailbox_id FROM cases WHERE org_id = ? AND conversation_id IN (?, ?)`,
  ).bind(orgId, sourceId, targetId).all<{ mailbox_id: string }>();

  for (const { mailbox_id } of touched) {
    /*
     * The **standing** relation, never a supervised grant (#63).
     *
     * Merging is irreversible restructuring of other people's queues, and this gate reads as a visibility
     * test only because seeing is the minimum a person needs to be accountable for it. A time-boxed read
     * granted for a matter is authority to *examine* a mailbox, not to reshape its cases — a read relation
     * that authorized a write would be the widening `authz-read.ts` names as worse than granting nothing.
     */
    if (!(await holdsStandingRead(env, { orgId, userId }, mailbox_id))) {
      // Deliberately not naming which mailbox: that would disclose the existence of a queue this caller has
      // no relation to, which is the §5C rule #44 settled.
      return {
        merged: false,
        reason: "these conversations reach a mailbox you cannot read. Merging what you cannot see is not "
          + "something you could be accountable for.",
      };
    }
  }

  // The pairs, one per mailbox, evaluated together — because a partially merged conversation is not a thing.
  const pairs: CasePair[] = [];
  for (const { mailbox_id } of touched) {
    const { results } = await env.CATALOG.prepare(
      `SELECT id, conversation_id, state, assignee, created_at FROM cases
        WHERE org_id = ? AND mailbox_id = ? AND conversation_id IN (?, ?)`,
    ).bind(orgId, mailbox_id, sourceId, targetId)
      .all<{
        id: string; conversation_id: string; state: string; assignee: string | null; created_at: string;
      }>();
    const of = (conversationId: string): CasePair["source"] => {
      const row = results.find((r) => r.conversation_id === conversationId);
      return row === undefined
        ? null
        : { id: row.id, state: row.state, assignee: row.assignee, createdAt: row.created_at };
    };
    pairs.push({ mailboxId: mailbox_id, source: of(sourceId), target: of(targetId) });
  }

  for (const pair of pairs) {
    const obstruction = pairObstruction(pair);
    if (obstruction !== null) {
      // Named, and all-or-nothing: nothing has been written, and the message says where to look.
      return {
        merged: false,
        mailboxId: pair.mailboxId,
        reason: `Refused, and nothing was changed: in one mailbox, ${obstruction}. Resolve that case pair `
          + "first — close, release or take one of them — and merge again.",
      };
    }
  }

  /**
   * The legal hold, before a single statement is built (#64).
   *
   * `DELETE FROM cases` is one of the two D1 sites #64 classified as **content-carrying**, and it is the
   * judgement call of the two. The merged messages survive; what the delete destroys is the source case's
   * *history* — who held it, when it was first responded to, whether its target was met. That is exactly
   * the class of fact an investigation asks about, so it is held.
   *
   * Only the pairs where **both** sides have a case reach the delete; where only the source has one it is
   * repointed, which destroys nothing and is therefore not the hold's business. Refusing here refuses the
   * whole merge, which is the all-or-nothing rule this function already has for a contested pair: a
   * partially merged conversation is not a thing, and a hold on one mailbox must not produce one.
   *
   * `created_at` is the instant tested, being when the case came into existence. It throws rather than
   * returning a `MergeRefusal` because a hold is not a case pair a person can resolve by closing or
   * releasing something — the refusal names a different remedy, and `E_LEGAL_HOLD` carries it.
   */
  for (const pair of pairs) {
    if (pair.source === null || pair.target === null) continue;
    await assertNotHeld(env, ctx, orgId, userId, {
      kind: "case",
      id: pair.source.id,
      mailboxId: pair.mailboxId,
      at: pair.source.createdAt,
    });
  }

  const at = new Date(ctx.now()).toISOString();
  const statements: D1PreparedStatement[] = [];

  // Where only the source has a case, it becomes the target's. Where both do, they are held by the same
  // person, so the target's survives and the source's is dropped — no claim changes hands, which is what
  // made this pair safe.
  let casesMerged = 0;
  for (const pair of pairs) {
    if (pair.source === null) continue;
    casesMerged += 1;
    if (pair.target === null) {
      statements.push(
        env.CATALOG.prepare(
          "UPDATE cases SET conversation_id = ?, state_at = ? WHERE org_id = ? AND id = ?",
        ).bind(targetId, at, orgId, pair.source.id),
      );
    } else {
      statements.push(
        env.CATALOG.prepare("DELETE FROM cases WHERE org_id = ? AND id = ?").bind(orgId, pair.source.id),
      );
    }
  }

  // Its index is captured rather than inferred. The first version summed every statement's `changes` and
  // called the total "messages moved", which would have counted case deletions and conversation updates as
  // messages — a wrong number reported as a fact, which is the thing this codebase treats as a defect rather
  // than a rounding error.
  const messagesStatementIndex = statements.length;
  statements.push(
    env.CATALOG.prepare(
      "UPDATE messages SET conversation_id = ? WHERE org_id = ? AND conversation_id = ?",
    ).bind(targetId, orgId, sourceId),
    // Kept, not deleted, and `grouped_by` becomes `manual` on the survivor: a person decided these were one
    // thing, and a later reader should be able to tell that from the row rather than from the audit trail
    // alone.
    env.CATALOG.prepare(
      "UPDATE conversations SET merged_into = ? WHERE org_id = ? AND id = ?",
    ).bind(targetId, orgId, sourceId),
    env.CATALOG.prepare(
      "UPDATE conversations SET grouped_by = 'manual' WHERE org_id = ? AND id = ?",
    ).bind(orgId, targetId),
  );

  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "conversation.merged",
      outcome: "ok",
      actorUserId: userId,
      subject: targetId,
      detail: { from: sourceId, mailboxes: touched.map((t) => t.mailbox_id), casesMerged },
    },
    (entry) => [entry, ...statements],
    {
      // Gated on the source still being unmerged, so a replayed merge appends no second entry claiming a
      // second act. It precedes the statements, because they are what make the predicate false.
      sql: "SELECT 1 FROM conversations WHERE org_id = ? AND id = ? AND merged_into IS NULL",
      params: [orgId, sourceId],
    },
  );

  // `results[0]` is the audit entry, so the statements are offset by one.
  const moved = results[messagesStatementIndex + 1]?.meta?.changes ?? 0;

  return { merged: true, into: targetId, messagesMoved: moved, casesMerged };
}
