import type { Ctx } from "@mailda/runtime";
import { agentGrantableActions } from "@mailda/contract/agent";
import { decidersByMailbox } from "../deciders.ts";
import { holdsForReport } from "../holds.ts";
import { noticeState } from "../notifications.ts";
import { type Finding } from "../doctor.ts";
/**
 * Legal hold (#64): what is held, what a hold is failing to enforce, and whether anybody could lift it.
 *
 * ## Why a mechanism with no observable was not an option
 *
 * A hold changes what the Node refuses to destroy and nothing else. It has no screen, and until #64's place
 * route there was no way to make one — so if `doctor` did not report holds, the only evidence a hold existed
 * would be a deletion failing. Three of this month's defects took exactly that shape: a mechanism whose only
 * observable was the failure it caused.
 *
 * ## What changed when the lift arrived, and what it cost
 *
 * `legal_hold_lift_path` is **gone**, because its whole content was the sentence *"there is no way to lift a
 * legal hold on this Node"* and that is now false. A finding kept alive by rewriting it into "lifting works"
 * would be a check that always passes and tells an operator nothing they can act on — which is not the same
 * shape as `workers_paid_plan`, the gap it was modelled on: that one names something no operator action can
 * close, and this one named something a ticket closed.
 *
 * What replaces it is a finding about the state that actually traps people. #64's argument was that *a hold
 * nobody can lift is an operational trap*, and with a lift built that trap is computable: a hold over a
 * mailbox where fewer than two people hold `approval.decide` cannot be lifted by anybody, because #64
 * requires two distinct approvers and excludes whoever requested it. `legal_hold_unliftable` says so **before**
 * an administrator finds out by being refused.
 *
 * Cost: `holdsForReport` is still one fixed query per run, and one further query — `decidersByMailbox`, the
 * single definition of who may decide — is spent **only when a hold is in force**. Three holds still cost what
 * one hold costs, which is the distinction `doctor-check-cost.md`'s `stale_when` separates, and that receipt
 * carries the measured delta.
 *
 * **The "matter closed but unlifted" finding #64 asked for is still deliberately absent**, and the reason is
 * unchanged rather than newly convenient: there are no matters. #63 charted them and settled that `legal_hold`
 * is one of their types, but nothing builds them, `holds.matter_id` is a nullable TEXT with no table behind
 * it, and a check for a closed matter would have to read a table that does not exist. Now that lifting works,
 * the finding it would produce is *actionable* rather than rhetorical — so it arrives with matters, and this
 * paragraph is what stops it being silently dropped in the meantime.
 *
 * ## Severities
 *
 *   legal_holds_active         `report`. A hold is a normal state of a governed Node, not a fault.
 *   legal_hold_lift_pending    `report`, and only when one is open. Somebody is being asked to re-permit
 *                              destruction; that is a normal act with a normal answer, and the reason it was
 *                              asked for is in the detail because that is the fact a reader needs.
 *   legal_hold_mailbox_missing `degraded`, and only when one exists. A hold naming an absent mailbox is a
 *                              hold enforcing nothing while reporting as active — a false statement about
 *                              preservation, which is the one error class this mechanism may not make. It is
 *                              also **not** reachable through the product: `placeHold` refuses an absent
 *                              mailbox and nothing deletes a mailbox, so this cannot become the permanent
 *                              WARN that `DELIVERY_SILENCE_MS` names and `draft_bodies_stranded` avoids.
 *   legal_hold_unliftable      `degraded`, and only when a hold in force has too few eligible approvers. It
 *                              has a fix somebody can run, which is what separates it from a permanent WARN:
 *                              grant `approval.decide` to two people who are not the requester.
 *
 * ## Disclosure
 *
 * Every finding here names a mailbox or a hold id and therefore discloses `data`: the reduced report served
 * without authentication promises only names already public in this repository, and a mailbox id is not one.
 * That is a change — `legal_hold_lift_path` was the one `infrastructure` finding in this group, and it earned
 * that by being a fact about the **build** rather than about the organization. Nothing that survives it is,
 * so nothing here reaches the unauthenticated report, and a Node that cannot authenticate anybody reports no
 * holds at all. Stated because it is a real reduction in what a locked-out operator can see, and the
 * alternative — a finding whose text moved when a hold was placed — would leak that a hold exists.
 */
export async function checkHolds(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "legal_holds_active",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so no hold can have been placed.",
    }];
  }

  const holds = await holdsForReport(env, orgId).catch(() => null);
  if (holds === null) {
    return [{
      check: "legal_holds_active",
      // Actionable, and the same condition `migrations_applied` refuses on: a Node that cannot read this
      // table cannot enforce a hold either, and it must not read as "no holds".
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read the holds table, so this report cannot say what is preserved.",
      fix: "check the migrations_applied finding first — a Node that cannot read holds also cannot enforce one",
    }];
  }

  const orphaned = holds.filter((hold) => !hold.mailboxExists);
  const day = 24 * 60 * 60 * 1000;
  const scope = (hold: (typeof holds)[number]): string => {
    const age = Math.floor((ctx.now() - new Date(hold.placedAt).getTime()) / day);
    const window = hold.fromDate === null && hold.toDate === null
      ? "all dates"
      : `${hold.fromDate ?? "the beginning"} to ${hold.toDate ?? "ongoing"}`;
    return `${hold.id} on mailbox ${hold.mailboxId}, ${window}, ` +
      `matter ${hold.matterId ?? "none cited"}, placed by ${hold.placedBy} ${age} day(s) ago`;
  };

  const findings: Finding[] = [{
    check: "legal_holds_active",
    severity: "report",
    discloses: "data",
    // A hold is not a fault. What would be a fault is one enforcing nothing, which is the finding below.
    ok: true,
    detail: holds.length === 0
      ? "No legal hold is in force, so nothing suppresses orphan collection."
      : `${holds.length} legal hold(s) in force. Orphan collection is suppressed for the whole ` +
        `organization while any hold stands — an orphan is unattributable by definition, so nothing can ` +
        `prove one is not responsive; they are still enumerated by reconcile and never deleted. ` +
        holds.map(scope).join("; ") + ".",
  }];

  // Nothing below has anything to say about a Node with no holds, and the eligibility query at the end costs
  // a subrequest. So a clean Node pays for `holdsForReport` and nothing else — the same shape
  // `draft_bodies_stranded` uses to spend nothing on an unclaimed Node.
  if (holds.length === 0) return findings;

  const pending = holds.filter((hold) => hold.pendingLift !== null);
  if (pending.length > 0) {
    findings.push({
      check: "legal_hold_lift_pending",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: `${pending.length} lift request(s) waiting on two distinct approvers: ` +
        pending.map((hold) =>
          `${hold.id} on mailbox ${hold.mailboxId}, requested by ${hold.pendingLift?.requestedBy} ` +
          `(approval ${hold.pendingLift?.approvalId}), reason: ${hold.pendingLift?.reason}`).join("; ") +
        ". The hold is still in force until the last stage closes.",
      // Not a fault and not an instruction: whether to approve is the approvers' judgement, and doctor
      // pointing at the queue is the whole of its business here.
      fix: "the people holding approval.decide on that mailbox see it at GET /api/approvals and decide with " +
        "POST /api/approvals/:id/decide — the requester cannot be one of them (§18)",
    });
  }

  if (orphaned.length > 0) {
    findings.push({
      check: "legal_hold_mailbox_missing",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `${orphaned.length} hold(s) name a mailbox that no longer exists, so they enforce nothing ` +
        `while reporting as active: ${orphaned.map((hold) => `${hold.id} on ${hold.mailboxId}`).join(", ")}.`,
      fix: "this Node cannot reach that state on its own — placing refuses an absent mailbox and nothing " +
        "deletes a mailbox — so either the mailbox row was removed outside the product or the hold was " +
        "inserted outside it. Restore the mailbox row rather than deleting the hold by hand, which would " +
        "destroy the record of what somebody decided to preserve. Lifting it needs two approvers holding " +
        "approval.decide on a mailbox that is not there, which is why the legal_hold_unliftable finding is " +
        "the one to read next",
    });
  }

  /*
   * Can anybody actually lift these? #64's operational trap, computed rather than warned about.
   *
   * One query for the whole organization — `decidersByMailbox` is the single definition of who may decide, and
   * duplicating its team-resolving UNION here to save nothing would be the second copy of an eligibility
   * computation this repository has already refused once (0021). Spent only when a hold is in force, so a Node
   * with no holds pays nothing, and it does not grow with the number of holds.
   *
   * The arithmetic is deliberately the pessimistic one: a lift needs two approvers **who did not request it**,
   * and the requester is any `org.admin`. So two holders are enough only if neither of them is the person who
   * asks. Reporting "fewer than two holders" as the trap and naming the requester rule in the fix is honest
   * without pretending to know who will ask.
   */
  const eligible = await decidersByMailbox(env, orgId).catch(() => null);
  if (eligible === null) {
    findings.push({
      check: "legal_hold_unliftable",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read who holds approval.decide, so this report cannot say whether these holds can " +
        "be lifted.",
      fix: "check the migrations_applied finding first",
    });
    return findings;
  }

  const stuck = holds.filter((hold) => (eligible.get(hold.mailboxId)?.size ?? 0) < 2);
  if (stuck.length > 0) {
    findings.push({
      check: "legal_hold_unliftable",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `${stuck.length} hold(s) in force cannot be lifted by anybody: ` +
        stuck.map((hold) =>
          `${hold.id} on mailbox ${hold.mailboxId}, where ${eligible.get(hold.mailboxId)?.size ?? 0} ` +
          "person(s) hold approval.decide").join("; ") +
        ". A lift takes two distinct approvers and excludes whoever requested it (#64), so this hold is " +
        "permanent until somebody is granted the relation. Preservation is unaffected — the failure " +
        "direction is over-holding.",
      fix: "grant approval.decide on those mailboxes to at least two people who will not be the one " +
        "requesting the lift — POST /api/access/grant with {\"relation\":\"approval.decide\"} — then " +
        "POST /api/holds/:id/lift with a reason",
    });
  }

  return findings;
}


/**
 * The self-grant, made visible (#63, §7).
 *
 * ## What this finding is about, and what it deliberately does not claim
 *
 * §7 says *"mailbox administration alone does not imply content access"*. On this Node that is true about the
 * **relation** and false about the **administrator**: `org.admin` can grant any grantable relation to any
 * subject including itself, so an administrator can give themselves `mailbox.content.read` on any mailbox in
 * one audited call. #63 decided not to close that, and the reasoning is worth carrying here because this is
 * where somebody will come looking for the rule they expect to find: refusing a grant where actor and subject
 * match traps a two-person organization, where the only other approver is the person being examined — and
 * "impossible" for an administrator genuinely responsible for a mailbox is the wall that gets solved by
 * editing the database directly, which is strictly worse than an audited self-grant.
 *
 * So there are two doors and this finding is what makes them look different:
 *
 *   `supervised.read`   the front door. Matter, scope, expiry, two approvers who are not the reader, and a
 *                       `supervised.granted` entry saying all of it.
 *   the self-grant      still open, and now conspicuous.
 *
 * **This does not prevent an administrator from reading mail, and it does not try to.** It makes the
 * difference between the front door and the back door visible in the record. Written down here rather than
 * left implied, because a finding whose text suggested it *stopped* something would be exactly the claim
 * nothing enforces.
 *
 * ## `report`, not `degraded`, and this was the hard call
 *
 * `degraded` means *something is wrong here*, and a self-grant is not by itself wrong: the two-person
 * organization above is the case #63 kept the door open for, and in it the self-grant is the **correct** act.
 * A `degraded` on a legitimate act is the permanent WARN that `DELIVERY_SILENCE_MS` names in this same file —
 * a false alarm gets a check muted, and a muted check guards nothing. `workers_paid_plan` is the precedent for
 * the shape: a real fact, correctly reported, that no operator action can or should close. `draft_bodies_
 * stranded` reached the same answer from the other side.
 *
 * The thing that *would* justify `degraded` is a self-grant on a mailbox where a supervised read **was**
 * available — two other `approval.decide` holders existed and the front door was walked past. That is
 * computable, and it is not computed here for an honest reason: eligibility is live, so it would be measured
 * now rather than at the instant of the grant, and a finding that changed its verdict about a past act because
 * somebody joined the team is worse than one that reports the act plainly.
 *
 * ## `data`, and one query that costs nothing on a clean Node
 *
 * The detail carries a count and an instant derived from this organization's audit trail — so it never
 * reaches the unauthenticated report. The query is one statement and it rides `audit_by_action` (0008),
 * seeking straight to this organization's `access.granted` entries and applying the actor-equals-subject test
 * over those, so its cost is proportional to **grants made** rather than to how long the Node has been
 * running. That distinction is what `doctor.max_subrequests_per_run` exists to protect.
 *
 * Migration 0023 first carried a purpose-built partial index for this, keyed on the condition itself.
 * **SQLite never chose it**, and forced with `INDEXED BY` it was worse — usable on `org_id` alone, because
 * SQLite's test for whether a query implies a partial index's predicate does not credit a column-to-column
 * comparison. It was deleted rather than left as dead weight under a comment claiming it was load-bearing.
 * The plan is printed in `test/explain.test.ts`, which is where that was found.
 *
 * The finding deliberately does **not** name each entry. Audit entries are never trimmed, so a detail listing
 * every self-grant over a Node's life would grow without bound inside a bounded `detail` column. The entries
 * are in the trail, filtered by action and actor.
 */
export async function checkSelfGrants(env: Env, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "self_granted_access",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nobody can have granted themselves anything.",
    }];
  }

  const row = await env.CATALOG.prepare(
    // One statement, prepared and executed once: `test/node/doctor-meter-honesty.test.ts` requires that of
    // everything on this path, because the meter in this file counts prepares rather than executions.
    `SELECT COUNT(*) AS n, MAX(at) AS last FROM audit_entries
      WHERE org_id = ? AND action = 'access.granted' AND actor_user_id = subject`,
  ).bind(orgId).first<{ n: number; last: string | null }>().catch(() => null);

  if (row === null) {
    return [{
      check: "self_granted_access",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read the audit trail, so this report cannot say whether anybody has granted "
        + "themselves access to a mailbox.",
      fix: "check the migrations_applied finding first — a Node that cannot read audit_entries cannot record "
        + "an act either",
    }];
  }

  const count = row.n ?? 0;
  return [{
    check: "self_granted_access",
    severity: "report",
    discloses: "data",
    // `ok` says "nothing to look at", not "nothing is wrong". A self-grant is reported, not faulted — see the
    // header for why a `degraded` here would be the permanent WARN this file avoids elsewhere.
    ok: count === 0,
    detail: count === 0
      ? "Nobody has granted a relation to themselves. Every relation in force was granted by one person to "
        + "another, and reading a mailbox you hold nothing on goes through a supervised read with two "
        + "approvers (§7)."
      : `${count} access.granted entr${count === 1 ? "y" : "ies"} where the actor and the subject are the `
        + `same principal, most recently at ${row.last ?? "an unrecorded instant"}. An administrator granting `
        + `themselves a relation is a single audited call and it is not blocked: refusing it would trap a `
        + `two-person organization into seeking approval from the person being examined. This finding does `
        + `not prevent an administrator reading mail — it makes the front door and the back door `
        + `distinguishable in the record.`,
    ...(count === 0 ? {} : {
      fix: "read them in the trail — GET /api/audit filtered on access.granted — and check each was the "
        + "shortest path available. The front door is POST /api/supervised: a time-boxed read with a matter, "
        + "a scope and two approvers who are not the reader, which produces a defensible record where a "
        + "self-grant produces only this finding. Nothing here needs undoing if the self-grant was the right "
        + "call; if it was not, POST /api/access DELETE revokes the relation and §7 makes that effective on "
        + "the next request",
    }),
  }];
}


/**
 * Is this Node discharging §7's notification obligation? (#63 part B.)
 *
 * ## This is the check the whole mechanism was chosen for
 *
 * #63 rejected a Workflow instance and a Durable Object alarm for the notice, and the deciding argument was
 * about *this function*: **`doctor` can count rows and cannot see inside a sleeping instance.** An instance
 * culled by retention and one patiently waiting look identical from outside, so a report built on one could
 * only ever say "we started something". A row that is due and undelivered is a number.
 *
 * Two findings, from **one** statement — `doctor-meter-honesty.test.ts` requires every `prepare` on this path
 * to be executed exactly once, because the meter in this file counts prepares.
 *
 * ## `supervision_notices_overdue` is `degraded`, unlike `self_granted_access`
 *
 * The hard call one function up went the other way, and the difference is what makes both defensible. A
 * self-grant can be the **correct** act in a two-person organization, so faulting it would be the permanent
 * WARN this file avoids elsewhere. An overdue notice cannot be correct: the row says the obligation fell due
 * and the scan has not discharged it, which means the cron is not running, or it is failing, and both are
 * things an operator must fix. The `fix` names the log event the scan writes when it fails.
 *
 * ## `supervision_notice_missing` is the one that makes suppression loud
 *
 * Every notice row was inserted in the same transaction as the `supervised.granted` entry that records the
 * grant taking effect. So the two counts agree unless somebody removed one of them — and the audit side is
 * hash-linked, so removing *that* half breaks `verifyChain` at a nameable point. Deleting the row instead
 * shows up here. **Neither half can be removed quietly**, which is the property §7's "cannot be disabled by
 * the investigator" needs and which no timer can offer.
 *
 * It is deliberately a comparison of counts rather than a per-grant join. A join would name which grant lost
 * its notice, and would cost a query proportional to grants rather than a scalar; the count answers the
 * question the finding exists to ask — *has anything been removed* — and the trail answers the next one.
 * `refuse` would be wrong too: a Node in this state still refuses unauthorized reads, and refusing to start
 * over a governance discrepancy would take mail down for a records problem.
 *
 * ## `supervision_notice_stranded` is the third, and it exists because the pair above has a blind spot
 *
 * Both checks above are about a row being **removed**. Neither can see a row that is present and *inert*: a
 * notice with no due date whose matter has already closed is one nothing will ever deliver, and it passes the
 * missing-notice count (the row is there) and the overdue count (which is `due_at IS NOT NULL` by
 * construction). That was a real, reachable state until `noticeOwedByGrant` grew its already-closed arm —
 * reached by closing a matter while the grant citing it was still waiting for its second approver, which the
 * investigator can arrange for themselves — so the check is here to keep the repair honest rather than to
 * describe a hypothesis.
 */
export async function checkSupervisionNotices(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) {
    return [{
      check: "supervision_notices_overdue",
      severity: "report",
      discloses: "data",
      ok: true,
      detail: "No organization yet, so nobody's mail can have been read under supervision.",
    }];
  }

  const state = await noticeState(env, ctx, orgId);
  if (state === null) {
    return [{
      check: "supervision_notices_overdue",
      // The same condition `legal_holds_active` degrades on, for the same reason: a Node that cannot read the
      // table cannot deliver from it either, and this must not read as "nothing is owed".
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "Could not read the notifications table, so this report cannot say whether §7's notices to the "
        + "people whose mail was read have been delivered.",
      fix: "check the migrations_applied finding first — a Node that cannot read notifications cannot deliver "
        + "one either, and the obligation does not lapse because the table is unreachable",
    }];
  }

  const findings: Finding[] = [{
    check: "supervision_notices_overdue",
    severity: "degraded",
    discloses: "data",
    ok: state.overdue === 0,
    detail: state.overdue === 0
      ? "No notification is due and undelivered. §7's notices to the people whose mail was read are dated "
        + "when the matter closes — or when the grant expires, if it cited no matter — and delivered by the "
        + "one-minute cron into those people's own interface."
      : `${state.overdue} notification(s) fell due and have not been delivered, the oldest at `
        + `${state.oldestOverdueDueAt ?? "an unrecorded instant"}. Each one is a person who has not been told `
        + `their mail was read, or somebody who has not been told they are being asked to decide something.`,
    ...(state.overdue === 0 ? {} : {
      fix: "the delivering scan runs on this Worker's scheduled trigger every minute. Check GET /api/logs for "
        + "notifications.scan_failed, and confirm the cron trigger exists on this Worker — a Node deployed "
        + "without one accrues these silently and this finding is the only thing that says so",
    }),
    receipt: "docs/receipts/supervised-notice-scan.md",
  }];

  if (state.stranded > 0) {
    findings.push({
      check: "supervision_notice_stranded",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `${state.stranded} notification(s) have no due date and cite a matter that has already closed, `
        + "so they can never fall due and nobody will be told their mail was read. This Node writes a due "
        + "date on both orderings — when the matter closes, and when a grant takes effect under a matter that "
        + "is already closed — so it cannot produce this state.",
      fix: "read the supervised.granted entries for the grants these notices name (GET /api/audit) — they "
        + "carry the mailbox, the scope, the matter and the deadline. Do not clear the rows: a notice that "
        + "cannot fall due is an obligation this Node still owes, and deleting it removes the only evidence "
        + "that it does",
    });
  }

  if (state.noticesOwed < state.grantsRecorded) {
    findings.push({
      check: "supervision_notice_missing",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: `The trail records ${state.grantsRecorded} supervised grant(s) taking effect and this Node holds `
        + `${state.noticesOwed} notification(s) for them. Every notice is written in the same transaction as `
        + `the grant, so this Node cannot produce that difference: ${state.grantsRecorded - state.noticesOwed} `
        + `row(s) were removed outside the product.`,
      fix: "do not re-create the rows by hand — a notice minted now would carry a due date nobody decided. "
        + "Run the audit verification (GET /api/audit) to see whether the trail itself was edited too, then "
        + "read the supervised.granted entries: they name the grant, the mailbox, the scope, the matter and "
        + "the deadline, which is what the missing notices were going to say",
    });
  }

  return findings;
}


/**
 * Agents still holding a capability no machine may have any more.
 *
 * ## What this counts, and why it is not zero by construction
 *
 * `principalFor` intersects a pinned ceiling with `agentGrantableActions()` on every request, so a withdrawn
 * capability is already **unreachable**. This finding is not about reachability — it is about the operator not
 * knowing. Two ways the state arises:
 *
 * - An agent minted before the capability layer, holding route strings the old API accepted. The column is
 *   plain `TEXT` and no migration rewrote it, deliberately: rewriting somebody's stored ceiling so a report
 *   looks clean is the opposite of keeping a record of what they were granted.
 * - A route reclassified as `governed` or `operator` after a review decided it was irreversible. Every agent
 *   holding it narrows on the deploy that reclassifies it, which is correct — and an automation that quietly
 *   stops doing part of its job is exactly the thing somebody needs told about.
 *
 * `report` rather than `degraded`. Nothing is broken and nothing is exposed: the refusal is in force. What is
 * true is that a credential is narrower than whoever minted it believes.
 */
export async function checkAgentCeilings(env: Env, ctx: Ctx, orgId: string | null): Promise<Finding[]> {
  if (orgId === null) return [];

  /*
   * Live agents only. A revoked or expired one reaches nothing regardless, so listing it would be a finding
   * nobody can act on or clear — and a report that accumulates unclearable entries is one people stop reading.
   */
  const rows = await env.CATALOG.prepare(
    `SELECT a.id, a.name, x.action
       FROM agents a JOIN agent_actions x ON x.agent_id = a.id
      WHERE a.org_id = ? AND a.revoked_at IS NULL AND a.expires_at > ?
      ORDER BY a.name, x.action`,
  ).bind(orgId, new Date(ctx.now()).toISOString())
    .all<{ id: string; name: string; action: string }>()
    .catch(() => null);

  if (rows === null) {
    return [{
      check: "agent_withdrawn_capabilities",
      severity: "degraded",
      discloses: "data",
      ok: false,
      detail: "The catalog could not be read, so this report cannot say what the agents on this Node hold.",
      fix: "check the `catalog_reachable` finding in this same report first — this one is downstream of it",
    }];
  }

  const grantable = new Set(agentGrantableActions());
  const stale = new Map<string, { name: string; actions: string[] }>();
  for (const row of rows.results) {
    if (grantable.has(row.action)) continue;
    const held = stale.get(row.id) ?? { name: row.name, actions: [] };
    held.actions.push(row.action);
    stale.set(row.id, held);
  }

  const affected = [...stale.values()];
  return [{
    check: "agent_withdrawn_capabilities",
    severity: "report",
    discloses: "data",
    ok: affected.length === 0,
    detail: affected.length === 0
      ? "Every live agent's pinned ceiling is within what a machine may hold today."
      : `${affected.length} live agent(s) hold capabilities no machine may have any more, and those acts are `
        + `refused: ${affected.map((one) => `${one.name} (${one.actions.join(", ")})`).join("; ")}. A ceiling `
        + "is pinned at mint and the classification is not, so a route reclassified as needing a person "
        + "narrows every agent already holding it. Nothing is exposed — the refusal is in force — but an "
        + "automation that has quietly stopped doing part of its job is worth knowing about.",
    ...(affected.length === 0 ? {} : {
      fix: "re-mint each agent with the capabilities it still needs, and give the withheld act to a person. "
        + "The stored rows are left alone on purpose: rewriting a ceiling so this report looks clean would "
        + "destroy the record of what was granted",
    }),
  }];
}
