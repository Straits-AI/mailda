import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import type { NotificationKind } from "./notifications.ts";

/**
 * Delivering the notices that have fallen due, and deciding what each one says (#63 part B, #61).
 *
 * ## Why this is a separate file from `src/notifications.ts`
 *
 * Not a taxonomy: `test/node/doctor-meter-honesty.test.ts`. `doctor` imports `noticeState` to count what is
 * overdue, and that guard requires **every file `doctor.ts` imports** to contain no `batch()` and no prepared
 * statement bound to a name — because `doctor`'s own cost meter counts `prepare` rather than execution, and its
 * measured figure is only right while those two things hold on that path.
 *
 * The delivering scan needs both. So the split follows `src/deciders.ts`, which exists for exactly this reason
 * one ticket earlier: `decidersByMailbox` was moved out of `approvals.ts` rather than widening the guard,
 * because a guard with an exception in it is a guard somebody stops reading.
 *
 * It happens to be the right seam anyway, which is the test of whether a constraint-driven split is a good
 * one: **owing a notice and delivering it are different concerns**, and only the second has a batch, a budget
 * and a decision about disclosure in it.
 */

/** How many notices one cron tick delivers. Receipt: `docs/receipts/supervised-notice-scan.md`. */
const SCAN_BATCH = BUDGETS["notify.scan_batch"];

interface DueRow {
  id: string;
  kind: NotificationKind;
  subject_id: string;
  mailbox_id: string | null;
}

/** What one supervised read amounted to, as the notice says it. */
export interface SupervisedNoticeBody {
  grantId: string;
  mailboxId: string;
  mailboxName: string | null;
  readerId: string;
  readerEmail: string | null;
  scope: string;
  grantedAt: string | null;
  expiresAt: string;
  matterId: string | null;
  matterType: string | null;
  matterClosedAt: string | null;
  /** What was actually done under the grant, counted from the trail. */
  acts: { queries: number; listed: number; opened: number; attachments: number };
}

/**
 * The cron scan: deliver every notice that has fallen due, and freeze what it says.
 *
 * ## A scan, and never "fire once per notice"
 *
 * Same reasoning `sweepResponseClocks` records one file over, and it is the reason cron was chosen over an
 * alarm at all: cron documents **no retry**, so anything here has to be repaired by the next minute's run
 * rather than depending on this one. A query over due rows is; a cursor is not. Running it twice changes
 * nothing — the `UPDATE` carries `delivered_at IS NULL` — and skipping a run costs a minute against an
 * obligation measured in days.
 *
 * ## Why the scan has a real job rather than flipping a flag
 *
 * The feed could compute `due_at <= now` itself and this could not exist. Two things make it earn its place.
 *
 * **`delivered_at` is a fact about the Node, not about whether anybody looked.** The person whose mail was
 * read may never sign in again — `departure_handover` is one of the matter types — and a notice that only
 * exists while its recipient is looking at it is not a notice. It is also the only column that makes
 * *overdue* computable, which is what `doctor` counts.
 *
 * **The body is frozen here.** A notice must say the same thing for ever, and reading the feed must not
 * re-aggregate an audit trail that is never trimmed. So the counts are computed once, at delivery, and
 * written down.
 *
 * Bounded per run at `notify.scan_batch`, because an unbounded pass over a Node that has been unswept is one
 * query whose cost nobody chose. Anything left over is picked up next minute, which is the property that makes
 * a bound safe here and would not be safe for a fire-once design.
 */
export async function deliverDueNotifications(
  env: Env,
  ctx: Ctx,
  orgId: string,
): Promise<{ delivered: number; batchWasFull: boolean }> {
  const now = new Date(ctx.now()).toISOString();
  const { results } = await env.CATALOG.prepare(
    `SELECT id, kind, subject_id, mailbox_id FROM notifications
      WHERE org_id = ? AND delivered_at IS NULL AND due_at IS NOT NULL AND due_at <= ?
      ORDER BY due_at LIMIT ?`,
  ).bind(orgId, now, SCAN_BATCH).all<DueRow>();

  if (results.length === 0) return { delivered: 0, batchWasFull: false };

  const statements: D1PreparedStatement[] = [];
  for (const row of results) {
    const body = row.kind === "supervised_read"
      ? await supervisedNoticeBody(env, orgId, row.subject_id)
      : await approvalNoticeBody(env, orgId, row.subject_id);
    statements.push(env.CATALOG.prepare(
      // Conditional on still being undelivered, so two overlapping ticks deliver once. The conflict is the
      // signal, again (#9).
      "UPDATE notifications SET delivered_at = ?, body = ? WHERE id = ? AND org_id = ? AND delivered_at IS NULL",
    ).bind(now, body === null ? null : JSON.stringify(body), row.id, orgId));
  }

  const updated = await env.CATALOG.batch<never>(statements);
  const delivered = updated.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
  /*
   * `batchWasFull`, not a count of what is left. A full batch means **there may be more**, and that is all
   * this run can honestly say — counting the remainder would be a second query for a number nothing acts on,
   * and naming a boolean `owed` would be a name claiming to be a quantity. The next tick takes the rest.
   */
  return { delivered, batchWasFull: results.length === SCAN_BATCH };
}

/**
 * What the notice says, and this is a disclosure decision rather than a formatting one.
 *
 * §7 requires the employee be told; it does not say what. The two ends are *"your mailbox was accessed under
 * matter M-19"* and a full transcript of every query, and both are wrong: the first is compliance theatre, and
 * this project's whole argument is that an unusable record is not a record; the second hands somebody a
 * restatement of their own mail in a table with different access rules from the mail.
 *
 * So the notice errs toward **enough to act on**:
 *
 *   who read it        named. It is the first question anybody asks, and a notice that withholds it invites
 *                      the reader to find out by other means. §7's own record names the supervisor.
 *   what they could    the scope, in the product's own two words, and the window between `granted_at` and
 *                      `expires_at` — so "for how long" has a real answer.
 *   what they did      counts, from the trail: queries run, results those queries listed, contents opened,
 *                      raw messages exported. This is the part that distinguishes a grant somebody never used
 *                      from one under which four hundred messages were opened, and without it the notice
 *                      cannot be acted on at all.
 *   which matter       its id and its **type**, and when it closed.
 *
 * And deliberately **not**:
 *
 *   the matter's description   free text naming an investigation and often a third party. `listMatters`
 *                              already treats it as confidential (an org-wide listing would hand *"suspected
 *                              exfiltration by Dana"* to Dana), and closing a matter is not a finding: the
 *                              Node cannot vouch for the sentence, and publishing an accusation as a system
 *                              notice would be overclaiming in exactly the way AGENTS.md §4 forbids.
 *   the ids themselves         they are in the audit trail, which is where a record of *what* was read
 *                              belongs and which whoever may audit can read. A notice that restated them
 *                              would put an unbounded list in a row rendered to a person and would be a
 *                              second copy of the same fact, free to disagree with the first.
 *
 * The counts come from the trail rather than being maintained alongside it, so they cannot drift from the
 * entries they describe — and if somebody deletes entries to shrink them, `verifyChain` reports the break.
 */
async function supervisedNoticeBody(
  env: Env,
  orgId: string,
  grantId: string,
): Promise<SupervisedNoticeBody | null> {
  const grant = await env.CATALOG.prepare(
    `SELECT g.id, g.subject_id, g.mailbox_id, g.scope, g.granted_at, g.expires_at, g.matter_id,
            b.name AS mailbox_name, u.email AS reader_email,
            t.type AS matter_type, t.closed_at AS matter_closed_at
       FROM supervised_grants g
       LEFT JOIN mailboxes b ON b.org_id = g.org_id AND b.id = g.mailbox_id
       LEFT JOIN users u ON u.id = g.subject_id
       LEFT JOIN matters t ON t.org_id = g.org_id AND t.id = g.matter_id
      WHERE g.org_id = ? AND g.id = ? LIMIT 1`,
  ).bind(orgId, grantId).first<{
    id: string; subject_id: string; mailbox_id: string; scope: string; granted_at: string | null;
    expires_at: string; matter_id: string | null; mailbox_name: string | null; reader_email: string | null;
    matter_type: string | null; matter_closed_at: string | null;
  }>();
  if (grant === null) return null;

  /*
   * The acts, counted off the trail this Node cannot rewrite quietly.
   *
   * `subject` is the grant on all three supervised actions, which is why one grouped query answers all of
   * them; it rides `audit_by_action` (0008), so the cost is proportional to this organization's supervised
   * acts rather than to the age of the trail.
   *
   * `listed` sums the `returned` of each query entry, counting **only the first part** of a split one — a
   * query whose id list needed continuation entries carries the same `returned` in each, so summing them all
   * would multiply what a person is told they were shown by the number of pages. The notice would then
   * overstate, which is the same class of untruth as understating and is caught by the same reasoning.
   */
  const counts = await env.CATALOG.prepare(
    `SELECT action, COUNT(*) AS entries,
            SUM(CASE WHEN COALESCE(json_extract(detail, '$.part'), 1) = 1
                     THEN COALESCE(json_extract(detail, '$.returned'), 0) ELSE 0 END) AS listed
       FROM audit_entries
      WHERE org_id = ? AND subject = ?
        AND action IN ('supervised.query', 'supervised.opened', 'supervised.attachment')
      GROUP BY action`,
  ).bind(orgId, grantId).all<{ action: string; entries: number; listed: number | null }>();

  const by = new Map(counts.results.map((row) => [row.action, row]));
  return {
    grantId: grant.id,
    mailboxId: grant.mailbox_id,
    mailboxName: grant.mailbox_name,
    readerId: grant.subject_id,
    readerEmail: grant.reader_email,
    scope: grant.scope,
    grantedAt: grant.granted_at,
    expiresAt: grant.expires_at,
    matterId: grant.matter_id,
    matterType: grant.matter_type,
    matterClosedAt: grant.matter_closed_at,
    acts: {
      queries: by.get("supervised.query")?.entries ?? 0,
      listed: by.get("supervised.query")?.listed ?? 0,
      opened: by.get("supervised.opened")?.entries ?? 0,
      attachments: by.get("supervised.attachment")?.entries ?? 0,
    },
  };
}

/** What #61's notice says: which request, on what, asked by whom. Enough to find it and decide it. */
async function approvalNoticeBody(
  env: Env,
  orgId: string,
  approvalId: string,
): Promise<Record<string, unknown> | null> {
  const row = await env.CATALOG.prepare(
    `SELECT id, subject_kind, subject_id, mailbox_id, actor_user_id, state, requested_at
       FROM approvals WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, approvalId).first<{
    id: string; subject_kind: string; subject_id: string; mailbox_id: string;
    actor_user_id: string; state: string; requested_at: string;
  }>();
  if (row === null) return null;
  return {
    approvalId: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    mailboxId: row.mailbox_id,
    requestedBy: row.actor_user_id,
    requestedAt: row.requested_at,
    // The state at the instant of delivery, not a live one. A notice is a record of having been told, and a
    // request settled since then is still a request this person was asked to decide.
    stateWhenDelivered: row.state,
  };
}
