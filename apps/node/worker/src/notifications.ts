import type { Ctx } from "@mailda/runtime";
import { BUDGETS } from "@mailda/budgets";

import type { AuditGate } from "./audit.ts";
import type { Principal } from "./authz-read.ts";

/**
 * Durable notifications: the obligation to tell somebody something, as a **row** (#63 part B, #61, §7).
 *
 * ## Why a row, decided by what a Workflow instance is not
 *
 * §7 requires that employee notifications be *durable system jobs* that the investigator cannot disable, and
 * `docs/receipts/workflow-provisioning.md` settles the mechanism before preference can get involved: a
 * Workflow instance is **not a durable record** — state is retained 3 days on Free and 30 on Paid,
 * configurable per instance — and a matter can stay open for months. A Durable Object alarm is worse;
 * `wrangler.jsonc` already records its absorbing failure state, *stop re-arming and nothing external notices,
 * ever*, which is exactly the wrong failure mode for an obligation that must not be suppressible.
 *
 * The deciding property is that **`doctor` can count rows and cannot see inside a sleeping instance.** An
 * instance culled by retention and one patiently waiting look identical from the outside. So:
 *
 * - the row is written in the **same `batch()`** as the thing that owes it, so an owed notice that does not
 *   exist is not unlikely, it is unrepresentable;
 * - the one-minute cron `wrangler.jsonc` already declares delivers it — a branch in a trigger that already
 *   runs. (Written out rather than quoted as a crontab expression: a `slash-star` sequence inside a block
 *   comment ends the comment, which has cost this repository a build in CSS, in SQL and in TypeScript, and
 *   `test/node/stylesheet-hazards.test.ts` exists because of it.) Cron's measured weakness is lateness
 *   (`cron-lateness.md`, p99 **8.1 s**), which is irrelevant to a notice measured in days, and the scan is
 *   idempotent so a missed run costs a minute;
 * - `doctor` counts the overdue ones, and separately compares the `supervised.granted` entries in the
 *   hash-linked trail against the rows here. **Suppressing a notice therefore requires deleting an audited
 *   row**, which is a much louder act than letting a timer lapse — and one that leaves the trail and the table
 *   disagreeing where a check can see it.
 *
 * ## Delivery is in-product, and that follows rather than being chosen
 *
 * `src/outbound/transport.ts` already has to catch Cloudflare's *destination address is not a verified
 * address*, so a legal obligation carried by outbound mail is one defeated by a mail-routing setting. The row
 * rendered in the person's own interface has no such dependency, and *"cannot be switched off by the
 * investigator"* holds structurally rather than by policy: the feed below resolves its audience from
 * `relationship_tuples`, and a supervised grant is never a tuple, so the investigator holds no relation over
 * the notification feed of the person whose mail they read.
 *
 * ## One table, two kinds, because #61 asked for exactly that
 *
 * #61's resolution deferred its own notification to #63 and said an approval request should be a row here with
 * `due_at` now, delivered by the same scan — one mechanism rather than a second invention alongside it. The
 * two kinds differ in exactly two ways and share everything else: who they are addressed to, and when they
 * fall due.
 */

/**
 * The kinds of notice this Node can owe. **The declared set, and the only place it is declared.**
 *
 * `notifications.kind` carries no CHECK, for the reason `migrations/0024` gives and `MATTER_TYPES` and
 * `SUPERVISED_SCOPES` already live with: SQLite cannot add one with `ALTER TABLE`, a trigger cannot exist in
 * this tree because `src/migrate.ts` splits migrations on semicolons, and recreating the table would need a
 * `DROP TABLE` that `test/node/content-deletion-world.test.ts` refuses in `migrations/`. So this union is the
 * constraint and `test/node/matter-and-scope-world.test.ts` makes it one: exactly one writer, and every kind
 * the scan and the feed name is declared here.
 *
 * `as const satisfies` and a derived union rather than a `readonly string[]`, because `Record<string, X>`
 * makes `keyof` equal `string` — a mistyped kind would compile, match no scan branch, and sit undelivered
 * for ever, which is the one failure this whole table exists to make impossible.
 */
export const NOTIFICATION_KINDS = ["supervised_read", "approval_request"] as const satisfies readonly string[];

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

const COLUMNS =
  "id, kind, subject_id, user_id, mailbox_id, matter_id, created_at, due_at, delivered_at, body";

/**
 * F-A's date as one expression: **the later of the instant the matter closed and the instant the grant
 * expired** — the moment after which the reading this notice describes definitely stopped.
 *
 * A function rather than the same `max(…)` typed at both call sites, because there are two arms that write
 * `due_at` — the close (`noticesDueOnMatterClose`) and the grant taking effect under an already-closed matter
 * (`noticeOwedByGrant`) — and the one thing that must never differ between them is *which instant the notice
 * gets*. Two copies of an expression are two things to edit; this is one.
 *
 * SQLite's two-argument `max()` is the scalar form, and both instants are `toISOString()` output, which sorts
 * lexicographically in the same order it sorts chronologically. The arguments are SQL expressions rather than
 * bound values because each caller reaches the two rows differently.
 */
function whenTheReadingStopped(closedAt: string, expiresAt: string): string {
  return `max(${closedAt}, ${expiresAt})`;
}

/* ---- owing one ---------------------------------------------------------------------------------- */

/**
 * The §7 notice a supervised grant owes, as a statement for the transaction that makes the grant live.
 *
 * Returned rather than executed, like `planApproval`'s rows: `approveStatements` places it in the same
 * `batch()` as the one `UPDATE supervised_grants SET granted_at`, so a live grant with no notice owed is not
 * a state this Node can reach. It carries the **same** `EXISTS (approved)` gate as that update, so a decision
 * that did not complete the approval writes neither.
 *
 * ## `due_at` is where F-A is resolved, and the resolution is *hold the notice*
 *
 * §7 makes the notice due after the matter closes. 0023 decided — correctly — that closing a matter does
 * **not** revoke a live grant, because a cascade would be a second answer to *"may this person still read"*.
 * Those two collide: the close can precede the reading it describes, so a notice could tell somebody their
 * mail was read while it was still being read.
 *
 * The alternative shape was **refusing the close** while a grant citing the matter is live. It was rejected,
 * and the cost of rejecting it is smaller than the cost of taking it: closing is the act the notice hangs on,
 * and `closeMatter` deliberately lets an `org.admin` close somebody else's matter *because the investigator is
 * the one party with a reason to delay it*. A block that any live grant could hold open would hand that delay
 * straight back to the investigator, who is also the only person who asked for the grant. There is no
 * revocation path by design, so the block could not even be cleared — the only remedy would be waiting out a
 * deadline nobody may move, and a notice that never becomes due is worse than a late one.
 *
 * So the notice is **held** instead, and `due_at` is never earlier than the instant the reading stopped:
 *
 *   no matter cited        the grant's own `expires_at`. The only end that exists, and it is known here.
 *   a matter still open    NULL now; `noticesDueOnMatterClose` writes `max(closed_at, expires_at)` when the
 *                          matter closes. Both halves come off rows this Node already has, in the close's own
 *                          transaction, so the date cannot be computed twice and differ.
 *   a matter already       `max(closed_at, expires_at)` **here**, off the matter row, by the same expression.
 *   closed                 See below: this is not a symmetry, it is the hole that made the whole mechanism
 *                          suppressible.
 *
 * "After the matter closes" therefore means *after the reading actually stopped*, which is what the sentence
 * was for.
 *
 * ## Why the already-closed arm exists, and what it was found doing without it
 *
 * `noticesDueOnMatterClose` runs **in the close's transaction**, so it can only date notices that already
 * exist. A grant is asked for at one instant and takes effect at another — two approvers later — and nothing
 * refuses a close in between. `requestSupervisedRead` refuses a *new* request citing a closed matter, and that
 * looked like the whole of the defence; it is not, because the request that matters here was made while the
 * matter was open.
 *
 * So the order *request, close, approve* left the notice with `due_at` NULL and nothing that would ever write
 * it: the close had already passed, and no second close is permitted. The reader then read, every act was
 * recorded, and the person whose mail it was was never told — the cron had nothing due to deliver, `doctor`'s
 * overdue count is `due_at IS NOT NULL` by definition, and `supervision_notice_missing` counts rows rather
 * than dates, so the row was present and the obligation was gone. **No audited row had to be deleted**, and
 * the person who could arrange it is the investigator: `closeMatter` lets whoever opened a matter close it, and
 * the investigator is usually who opened it. That is precisely the property §7 asks for — *cannot be disabled
 * by the investigator* — failing, so the arm below is not tidiness.
 *
 * The two arms cannot both fire and cannot both miss, because each is inside one transaction and D1 serialises
 * them: if the close committed first this INSERT reads its `closed_at`; if this INSERT committed first the
 * close's `UPDATE` finds the row by `ntf_pending_matter`. There is no interleaving in which neither runs, which
 * is the same argument the `EXISTS (approved)` gate rests on one statement up.
 *
 * `doctor`'s `supervision_notice_stranded` counts what would be left if that argument were ever wrong — an
 * undated notice whose matter is closed — rather than trusting this paragraph.
 */
export function noticeOwedByGrant(
  env: Env,
  ctx: Ctx,
  orgId: string,
  grantId: string,
  mailboxId: string,
  at: string,
  approvedGate: AuditGate,
): D1PreparedStatement {
  // The cited matter's close instant, or NULL while it is open. Correlated on the grant, so it costs the
  // primary-key seek `matters` is built around and nothing else.
  const closedAt = "SELECT m.closed_at FROM matters m WHERE m.org_id = g.org_id AND m.id = g.matter_id";
  return env.CATALOG.prepare(
    // `user_id` NULL: addressed to the mailbox, resolved live by `notificationsFor`. A Mailda mailbox is
    // shared by construction and has no owner column, so "the employee whose mail was read" is whoever the
    // mailbox belongs to — and resolving it live tells whoever that is *now* rather than whoever it was on the
    // day of the grant, which for a departure_handover is precisely the wrong set.
    //
    // `matter_id` and `due_at` are read off the grant in the same statement rather than passed in, because the
    // caller is `approveStatements`, which has an approval and not a grant. A second read to fetch them would
    // be a second thing that could disagree with the row this insert is about.
    //
    // Three arms, and the third is the one that stops the notice being suppressible — see the header. NULL is
    // written only while the matter is genuinely still open, which is what makes "NULL means not yet due" a
    // true sentence rather than also meaning "and never will be".
    `INSERT INTO notifications
       (id, org_id, kind, subject_id, user_id, mailbox_id, matter_id, created_at, due_at, delivered_at, body)
     SELECT ?, ?, 'supervised_read', g.id, NULL, ?, g.matter_id, ?,
            CASE WHEN g.matter_id IS NULL THEN g.expires_at
                 WHEN (${closedAt}) IS NULL THEN NULL
                 ELSE ${whenTheReadingStopped(`(${closedAt})`, "g.expires_at")} END,
            NULL, NULL
       FROM supervised_grants g
      WHERE g.org_id = ? AND g.id = ? AND EXISTS (${approvedGate.sql})`,
  ).bind(ctx.id("ntf"), orgId, mailboxId, at, orgId, grantId, ...approvedGate.params);
}

/**
 * #61's notices: one row per person being asked to decide, for the transaction that opens the request.
 *
 * Addressed to a **named person**, unlike the §7 notice, and the difference is not cosmetic: the eligible set
 * is live, so resolving it at read time would quietly re-address a request that was already answered — and
 * "who was asked, at the instant of asking" is the same fact `approval.requested`'s `eligible` count is
 * recorded for. Frozen here, one row each.
 *
 * The requester is already excluded, because `planApproval` hands over the set it computed after removing
 * them (§18's separation of duty). Nobody is asked to decide their own act.
 */
export function noticesForApprovalRequest(
  env: Env,
  ctx: Ctx,
  orgId: string,
  approvalId: string,
  mailboxId: string,
  deciders: readonly string[],
  at: string,
  gate?: AuditGate,
): D1PreparedStatement[] {
  return deciders.map((userId) => {
    const values = [ctx.id("ntf"), orgId, "approval_request", approvalId, userId, mailboxId, null, at,
      // Due now: somebody is waiting on a decision, so the next tick of the one-minute cron delivers it.
      at, null, null];
    const holes = values.map(() => "?").join(",");
    const head = `INSERT INTO notifications
       (id, org_id, kind, subject_id, user_id, mailbox_id, matter_id, created_at, due_at, delivered_at, body)`;
    return gate === undefined
      ? env.CATALOG.prepare(`${head} VALUES (${holes})`).bind(...values)
      : env.CATALOG.prepare(`${head} SELECT ${holes} WHERE EXISTS (${gate.sql})`)
        .bind(...values, ...gate.params);
  });
}

/**
 * Dates every notice this matter was holding, in the close's own transaction.
 *
 * `max(closed_at, the grant's own expires_at)` — the F-A resolution, spelled once, here. SQLite's two-argument
 * `max()` is the scalar form, and the grant is reached by primary key from the notice's `subject_id`, so this
 * is one statement over the rows `ntf_pending_matter` already isolates.
 *
 * **The close instant is read off the matter rather than passed in**, and the `EXISTS` is what makes that
 * sound: `closeMatter` places this *after* its `UPDATE matters` in the same transaction, so `closed_at IS NOT
 * NULL` is true exactly when the close landed. A close that lost its race therefore dates nothing, where a
 * bound parameter would have dated every notice from a close that did not happen — the same "record nothing
 * rather than a false statement" rule the rest of this codebase's conditional writes run on.
 *
 * Conditional on `due_at IS NULL` as well, so a second close cannot re-date a notice that is already owed —
 * and `closeMatter` refuses a second close anyway, which makes this the layer that holds if that ever stops
 * being true, the same way `granted_at IS NULL` sits on the one `UPDATE supervised_grants`.
 */
export function noticesDueOnMatterClose(
  env: Env,
  orgId: string,
  matterId: string,
): D1PreparedStatement {
  const closedAt = `SELECT m.closed_at FROM matters m
                     WHERE m.org_id = notifications.org_id AND m.id = notifications.matter_id`;
  // COALESCE to the close instant if the grant is somehow absent, so a missing grant dates the notice from
  // the close rather than leaving `due_at` NULL — which is the state this file's header calls stranded.
  const expiresAt = `COALESCE((SELECT g.expires_at FROM supervised_grants g
                                WHERE g.org_id = notifications.org_id AND g.id = notifications.subject_id),
                              (${closedAt}))`;
  return env.CATALOG.prepare(
    `UPDATE notifications
        SET due_at = ${whenTheReadingStopped(`(${closedAt})`, expiresAt)}
      WHERE org_id = ? AND matter_id = ? AND due_at IS NULL
        AND EXISTS (${closedAt} AND m.closed_at IS NOT NULL)`,
  ).bind(orgId, matterId);
}

/* ---- reading ------------------------------------------------------------------------------------ */

export interface Notification {
  id: string;
  kind: NotificationKind;
  subjectId: string;
  mailboxId: string | null;
  matterId: string | null;
  dueAt: string | null;
  deliveredAt: string | null;
  body: unknown;
}

/**
 * One person's delivered notices, most recent first. **The in-product delivery itself.**
 *
 * Two addressing modes in one predicate, which is where the §7 property lives: a row addressed to a named
 * person is theirs, and a row addressed to a **mailbox** belongs to everybody holding a standing
 * `mailbox.content.read` on it. A supervised grant is a `supervised_grants` row and never a
 * `relationship_tuples` one, so the investigator cannot appear in the second set however wide their grant is —
 * "cannot be switched off by the investigator" is therefore structural rather than a rule somebody enforces.
 *
 * Delivered rows only. An undelivered notice is an obligation the Node has not discharged, not a message
 * somebody has been sent, and showing it early would make `delivered_at` a decoration.
 */
export async function notificationsFor(env: Env, who: Principal, subjects: readonly string[]):
Promise<Notification[]> {
  const placeholders = subjects.map(() => "?").join(", ");
  const { results } = await env.CATALOG.prepare(
    `SELECT ${COLUMNS} FROM notifications n
      WHERE n.org_id = ? AND n.delivered_at IS NOT NULL
        AND (n.user_id = ?
             OR (n.user_id IS NULL AND EXISTS (
                   SELECT 1 FROM relationship_tuples t
                    WHERE t.org_id = n.org_id AND t.subject_id IN (${placeholders})
                      AND t.object_type = 'mailbox' AND t.relation = 'mailbox.content.read'
                      AND t.object_id = n.mailbox_id)))
      ORDER BY n.due_at DESC, n.id DESC LIMIT 50`,
  ).bind(who.orgId, who.userId, ...subjects).all<{
    id: string; kind: NotificationKind; subject_id: string; user_id: string | null;
    mailbox_id: string | null; matter_id: string | null; created_at: string;
    due_at: string | null; delivered_at: string | null; body: string | null;
  }>();

  return results.map((row) => ({
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    mailboxId: row.mailbox_id,
    matterId: row.matter_id,
    dueAt: row.due_at,
    deliveredAt: row.delivered_at,
    // Parsed here rather than by the client, so a body written by an older Node is a value this Node either
    // understands or reports as absent, never a string the interface renders raw.
    body: row.body === null ? null : JSON.parse(row.body) as unknown,
  }));
}

/** What `doctor` needs to say whether this Node is discharging its obligations. One statement, one execution. */
export interface NoticeState {
  overdue: number;
  oldestOverdueDueAt: string | null;
  grantsRecorded: number;
  noticesOwed: number;
  /**
   * Notices with no `due_at` whose matter has already closed: an obligation that can never fall due.
   *
   * Unrepresentable through this Node — the two arms that write `due_at` cover every ordering — and counted
   * anyway, because *that* is the whole difference between a mechanism and a paragraph claiming one. It is
   * also the shape the defect took before the already-closed arm existed, so a regression has a number rather
   * than a silence.
   */
  stranded: number;
}

/**
 * The counts behind `supervision_notices_overdue`, `supervision_notice_missing` and
 * `supervision_notice_stranded`.
 *
 * One `prepare`, one execution, five scalar sub-selects — because `test/node/doctor-meter-honesty.test.ts`
 * requires that of everything on the doctor path, the meter there counting prepares rather than executions.
 * Adding the fifth therefore costs `doctor` nothing it measures, which is why the guard could be paid for.
 *
 * The third and fourth are the pair that makes deletion loud: every `supervised.granted` entry rode in the
 * same transaction as a notice row, so the two counts agree unless somebody removed one of them. The audit
 * side is hash-linked, so removing *that* half breaks `verifyChain` at a nameable point; removing the row
 * shows up here.
 *
 * The fifth is the pair's blind spot, and it was a live defect rather than a hypothetical: **deleting the row
 * is not the only way to suppress a notice if a notice can be left unable to fall due.** An undated notice
 * whose matter is already closed is exactly that, so it is counted rather than argued away — see
 * `noticeOwedByGrant`, which is where the state is now prevented.
 */
export async function noticeState(env: Env, ctx: Ctx, orgId: string): Promise<NoticeState | null> {
  /*
   * Not "due before now" — due before now **minus the grace**, and the grace is why this check is usable.
   *
   * #61's approval-request notices fall due the instant they are written, because somebody is waiting on a
   * decision. Without a grace, every approval opened since the last cron tick would make this Node report
   * `degraded`, and a check that warns about the ordinary state of a healthy Node is the muted check this
   * file's own `DELIVERY_SILENCE_MS` comment names.
   *
   * `notify.overdue_grace_seconds` is derived from figures `cron-lateness.md` already measured — trigger
   * propagation after a deploy dominates it at 900 s — and sized well past their sum, because §7's
   * obligation is measured in days and an hour of grace costs the person nothing.
   */
  const now = new Date(ctx.now() - BUDGETS["notify.overdue_grace_seconds"] * 1000).toISOString();
  const row = await env.CATALOG.prepare(
    `SELECT
       (SELECT COUNT(*) FROM notifications
         WHERE org_id = ?1 AND delivered_at IS NULL AND due_at IS NOT NULL AND due_at <= ?2) AS overdue,
       (SELECT MIN(due_at) FROM notifications
         WHERE org_id = ?1 AND delivered_at IS NULL AND due_at IS NOT NULL AND due_at <= ?2) AS oldest,
       (SELECT COUNT(*) FROM audit_entries
         WHERE org_id = ?1 AND action = 'supervised.granted') AS granted,
       (SELECT COUNT(*) FROM notifications
         WHERE org_id = ?1 AND kind = 'supervised_read') AS owed,
       (SELECT COUNT(*) FROM notifications n
         WHERE n.org_id = ?1 AND n.due_at IS NULL AND n.matter_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM matters m
                        WHERE m.org_id = n.org_id AND m.id = n.matter_id
                          AND m.closed_at IS NOT NULL)) AS stranded`,
  ).bind(orgId, now).first<{
    overdue: number; oldest: string | null; granted: number; owed: number; stranded: number;
  }>().catch(() => null);

  if (row === null) return null;
  return {
    overdue: row.overdue ?? 0,
    oldestOverdueDueAt: row.oldest,
    grantsRecorded: row.granted ?? 0,
    noticesOwed: row.owed ?? 0,
    stranded: row.stranded ?? 0,
  };
}
