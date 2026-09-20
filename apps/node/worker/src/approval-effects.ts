import type { AuditEvent } from "./audit.ts";
import type { ApprovalSubjectKind } from "./approval-plan.ts";
import type { ApprovalRow } from "./approval-rows.ts";

/** One lift request: what it asks to lift, and the reason it was asked for. */
export interface HoldLiftRow {
  id: string;
  holdId: string;
  reason: string;
}

/**
 * The lift request an approval names, or null if there is none.
 *
 * Lives here rather than in `src/holds.ts` because `decideApproval` is its only caller and a module that
 * imported holds would close a cycle: `holds.ts` calls `planApproval` to open the request. The SQL is three
 * columns of a four-column table, which is a smaller seam than a cycle.
 */
async function readHoldLift(env: Env, orgId: string, liftId: string): Promise<HoldLiftRow | null> {
  const row = await env.CATALOG.prepare(
    "SELECT id, hold_id, reason FROM hold_lifts WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, liftId).first<{ id: string; hold_id: string; reason: string }>();
  return row === null ? null : { id: row.id, holdId: row.hold_id, reason: row.reason };
}

/** What a supervised grant's own entry has to say: who, over what, how much, under what matter, until when. */
interface SupervisedGrantRow {
  id: string;
  subject_id: string;
  mailbox_id: string;
  scope: string;
  matter_id: string | null;
  requested_at: string;
  expires_at: string;
}

/**
 * The supervised grant an approval names, or null if there is none.
 *
 * Here rather than in `src/supervised.ts` for exactly `readHoldLift`'s reason: that module calls
 * `planApproval` to open the request, so importing from it here would close a cycle. A read on this side of
 * the seam is a smaller problem than a cycle, and it is why `src/supervised.ts` deliberately has no
 * single-grant read of its own for the two to disagree about.
 */
async function readSupervisedGrant(
  env: Env,
  orgId: string,
  grantId: string,
): Promise<SupervisedGrantRow | null> {
  return env.CATALOG.prepare(
    `SELECT id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at
       FROM supervised_grants WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, grantId).first<SupervisedGrantRow>();
}

/** What an export's own entry has to say: for whom, over what, under what matter, bound by what. */
interface ExportRequestRow {
  id: string;
  requested_by: string;
  mailbox_id: string;
  matter_id: string;
  predicate_sha256: string;
  max_messages: number;
  destination: string;
}

/**
 * The export an approval names, or null if there is none.
 *
 * Here rather than in `src/exports.ts` for the reason `readHoldLift` and `readSupervisedGrant` give: that
 * module calls `planApproval` to open the request, so importing from it here would close a cycle. Seven
 * columns of a nineteen-column table, on an act that happens at most twice per export.
 */
async function readExportRequest(
  env: Env,
  orgId: string,
  exportId: string,
): Promise<ExportRequestRow | null> {
  return env.CATALOG.prepare(
    `SELECT id, requested_by, mailbox_id, matter_id, predicate_sha256, max_messages, destination
       FROM exports WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, exportId).first<ExportRequestRow>();
}

/**
 * The subject-specific half of a completing decision: what must still be **undone** for it to be legitimate,
 * what it records, and the two refusals it can produce.
 *
 * Data, not logic. The race logic itself — the strong predicate, the "record nothing rather than a false
 * entry" rule, the conditional UPDATE — stays in `decideApproval` and is written once, because **all three of
 * #61's defects were in that logic** and a second copy would be a second place for them. What varies between
 * subject kinds is a SQL clause, an entry, and two sentences, so that is what this holds.
 */
interface CompletingEffect {
  /**
   * ANDed into the completing decision's predicate as `AND EXISTS (<undone>)`.
   *
   * Correlated on `a.subject_id` and `a.org_id` from the enclosing query rather than binding the subject
   * again, so a clause and its placeholder count cannot drift apart.
   */
  undone: string;
  /**
   * The entry that must ride in the same transaction as the effect, or null when the subject row is missing.
   *
   * Reads the subject so the entry can name **what was agreed to**. `approval.decided` says two people agreed
   * and structurally cannot say to what, which is why this exists rather than a richer detail on that entry.
   */
  event: (
    env: Env, orgId: string, approval: ApprovalRow, actorUserId: string, approvedBy: readonly string[],
  ) => Promise<AuditEvent | null>;
  /** The refusal when the subject row is absent — a state no path in this Node produces. */
  missing: { code: string; what: (approval: ApprovalRow) => string; fix: string };
  /** The refusal when the strong predicate failed, so nothing at all was recorded. */
  raced: { code: string; what: (approval: ApprovalRow) => string; why: string };
}

/**
 * Per subject kind, and `null` for a kind whose completion has no second fact about the world.
 *
 * A `Record` keyed on the union, so a fourth subject kind is a compile error here rather than a completing
 * decision that silently closes the request and performs nothing — which is the failure mode a `hold_lift`
 * would have had if this had been a lookup with a default.
 *
 * `send_manifest` is `null` deliberately: releasing a held send has nothing that could already have happened,
 * so its completing decision carries only the `pending` predicate and a lost race is reported as
 * `conflict: "withdrawn"` with the decision **kept**. The other two refuse and record nothing, because their
 * entry would otherwise be a false statement in the one place that is supposed to be checkable.
 */
export const COMPLETING_EFFECT: Record<ApprovalSubjectKind, CompletingEffect | null> = {
  send_manifest: null,

  hold_lift: {
    undone: `SELECT 1 FROM hold_lifts l
               JOIN holds h ON h.org_id = l.org_id AND h.id = l.hold_id
              WHERE l.org_id = a.org_id AND l.id = a.subject_id AND h.lifted_at IS NULL`,
    event: async (env, orgId, approval, actorUserId, approvedBy) => {
      const lift = await readHoldLift(env, orgId, approval.subjectId);
      if (lift === null) return null;
      return {
        action: "hold.lifted",
        outcome: "ok",
        actorUserId,
        // The hold, not the approval: an auditor filtering `hold.lifted` is asking which holds were released,
        // and `hold.placed` already keys on the same subject so the two entries about one hold line up.
        subject: lift.holdId,
        detail: {
          holdId: lift.holdId,
          liftId: lift.id,
          approvalId: approval.id,
          // A lift is mailbox-scoped, so this is the held mailbox — the same value under the same name it
          // always had, kept because `hold.placed` records it too and the two entries about one hold line up.
          mailboxId: approval.scopeId,
          // The reason, in the trail as well as on the hold: this is the entry an investigation reaches for
          // when it asks why preservation stopped.
          reason: lift.reason,
          requestedBy: approval.actorUserId,
          approvedBy: [...approvedBy],
        },
      };
    },
    missing: {
      code: "E_NO_HOLD_LIFT",
      what: (approval) =>
        `approval ${approval.id} names hold lift ${approval.subjectId}, which does not exist`,
      fix: "investigate; completing this would lift a hold with no record of the reason it was lifted for",
    },
    raced: {
      code: "E_HOLD_LIFT_RACED",
      what: (approval) =>
        `approval ${approval.id} was not the decision that lifted this hold, so nothing was recorded`,
      why: "the decision that completes a lift is refused rather than recorded when the state moves under it: "
        + "either somebody withdrew their approval, or the hold was already lifted. Recording it would put a "
        + "hold.lifted entry in the trail for a lift that did not happen",
    },
  },

  /**
   * A supervised read (#63). The same shape as the lift, for the same reason, one table over.
   *
   * `granted_at IS NULL` is the undone half: a grant that is already live must not be granted a second time,
   * because a second `supervised.granted` entry would claim a second authorization over one row and the trail
   * is the whole product here.
   */
  supervised_read: {
    undone: `SELECT 1 FROM supervised_grants g
              WHERE g.org_id = a.org_id AND g.id = a.subject_id AND g.granted_at IS NULL`,
    event: async (env, orgId, approval, actorUserId, approvedBy) => {
      const grant = await readSupervisedGrant(env, orgId, approval.subjectId);
      if (grant === null) return null;
      return {
        action: "supervised.granted",
        outcome: "ok",
        actorUserId,
        // The grant, not the approval: §7's question is about the access, and this is the id every later act
        // under it will cite.
        subject: grant.id,
        detail: {
          grantId: grant.id,
          // The person let in, named separately from the entry's actor — who is the approver, not the reader.
          // Conflating them is how a trail comes to say the wrong person read somebody's mail.
          subjectId: grant.subject_id,
          mailboxId: grant.mailbox_id,
          scope: grant.scope,
          matterId: grant.matter_id,
          expiresAt: grant.expires_at,
          requestedAt: grant.requested_at,
          approvedBy: [...approvedBy],
        },
      };
    },
    missing: {
      code: "E_NO_SUPERVISED_GRANT",
      what: (approval) =>
        `approval ${approval.id} names supervised grant ${approval.subjectId}, which does not exist`,
      fix: "investigate; completing this would let somebody into a mailbox with no record of the scope, the "
        + "matter or the deadline they were granted",
    },
    raced: {
      code: "E_SUPERVISED_RACED",
      what: (approval) =>
        `approval ${approval.id} was not the decision that granted this read, so nothing was recorded`,
      why: "the decision that completes a supervised read is refused rather than recorded when the state moves "
        + "under it: either somebody withdrew their approval, or the grant was already live. Recording it "
        + "would put a supervised.granted entry in the trail for an authorization that did not happen",
    },
  },

  /**
   * An eDiscovery export (#65). The same shape again, and the `undone` clause is the one that needed
   * thought: an export has no authority column to check for "already done", so what must still be undone is
   * that **the run has not started**.
   *
   * `state = 'requested'` is that test. An export already `running`, `completed` or `aborted` when its
   * approval completes is a state no path here produces — nothing runs an unapproved export — so reaching it
   * means the world moved outside the product, and recording `supervised.export_requested` for it would put
   * an entry in the trail claiming two people authorized a copy that had already been taken.
   */
  ediscovery_export: {
    undone: `SELECT 1 FROM exports e
              WHERE e.org_id = a.org_id AND e.id = a.subject_id AND e.state = 'requested'`,
    event: async (env, orgId, approval, actorUserId, approvedBy) => {
      const row = await readExportRequest(env, orgId, approval.subjectId);
      if (row === null) return null;
      return {
        action: "supervised.export_requested",
        outcome: "ok",
        actorUserId,
        // The export, not the approval: every later entry about this copy — the completion, the abort —
        // cites the same id, so one filter answers "everything that happened to this export".
        subject: row.id,
        detail: {
          exportId: row.id,
          // The person the copy is for, named separately from the entry's actor, who is an approver. #63
          // records the same separation for a grant, and conflating them is how a trail comes to say the
          // wrong person took somebody's mail.
          requestedBy: row.requested_by,
          mailboxId: row.mailbox_id,
          matterId: row.matter_id,
          // The hash rather than the predicate text: this is the bound object §18 asks an approval to name,
          // and the text is on the row for anybody who wants to read it.
          predicateSha256: row.predicate_sha256,
          maxMessages: row.max_messages,
          destination: row.destination,
          approvedBy: [...approvedBy],
        },
      };
    },
    missing: {
      code: "E_NO_EXPORT",
      what: (approval) =>
        `approval ${approval.id} names export ${approval.subjectId}, which does not exist`,
      fix: "investigate; completing this would authorize a bulk copy with no record of the predicate, the "
        + "bound, the matter or the destination it was agreed for",
    },
    raced: {
      code: "E_EXPORT_RACED",
      what: (approval) =>
        `approval ${approval.id} was not the decision that authorized this export, so nothing was recorded`,
      why: "the decision that completes an export is refused rather than recorded when the state moves under "
        + "it: either somebody withdrew their approval, or the export had already started. Recording it "
        + "would put a supervised.export_requested entry in the trail for an authorization that did not "
        + "happen",
    },
  },

  /**
   * A domain pause (#66). The same shape a fifth time, and the `undone` clause is `placed_at IS NULL`.
   *
   * A pause already in force when its own approval completes is a state no path here produces — nothing
   * places a pause but this statement — so reaching it means the world moved outside the product, and
   * recording `domain_pause.placed` for it would put an entry in the trail claiming two administrators
   * stopped a domain that was already stopped, which is what an investigation would read as two incidents.
   */
  domain_pause: {
    undone: `SELECT 1 FROM domain_pauses p
              WHERE p.org_id = a.org_id AND p.id = a.subject_id AND p.placed_at IS NULL
                AND p.lifted_at IS NULL`,
    event: async (env, orgId, approval, actorUserId, approvedBy) => {
      const paused = await readDomainPause(env, orgId, approval.subjectId);
      if (paused === null) return null;
      return {
        action: "domain.pause_placed",
        outcome: "ok",
        actorUserId,
        // The pause, not the approval: the lift cites the same id, so one filter answers "everything that
        // happened to this pause" — the shape `supervised.export_requested` and `hold.lifted` both use.
        subject: paused.id,
        detail: {
          pauseId: paused.id,
          domain: paused.domain,
          // The reason the two administrators read before they agreed. In the trail as well as on the row,
          // because this is the entry somebody reaches for when they ask why a customer's mail stopped.
          reason: paused.reason,
          requestedBy: approval.actorUserId,
          approvedBy: [...approvedBy],
        },
      };
    },
    missing: {
      code: "E_NO_DOMAIN_PAUSE",
      what: (approval) =>
        `approval ${approval.id} names domain pause ${approval.subjectId}, which does not exist`,
      fix: "investigate; completing this would stop a domain's mail with no record of which domain or why",
    },
    raced: {
      code: "E_DOMAIN_PAUSE_RACED",
      what: (approval) =>
        `approval ${approval.id} was not the decision that placed this pause, so nothing was recorded`,
      why: "the decision that completes a pause is refused rather than recorded when the state moves under "
        + "it: either somebody withdrew their approval, or the pause was already in force. Recording it "
        + "would put a domain.pause_placed entry in the trail for an act that did not happen",
    },
  },
};

/** What a pause's own entry has to say: which domain, and the reason its two approvers read. */
interface DomainPauseRow {
  id: string;
  domain: string;
  reason: string;
}

/**
 * The domain pause an approval names, or null if there is none.
 *
 * Here rather than in `src/domain-pause.ts` for the reason `readHoldLift`, `readSupervisedGrant` and
 * `readExportRequest` all give: that module calls `planApproval` to open the request, so importing from it
 * here would close a cycle. Three columns of a nine-column table.
 */
async function readDomainPause(env: Env, orgId: string, pauseId: string): Promise<DomainPauseRow | null> {
  return env.CATALOG.prepare(
    "SELECT id, domain, reason FROM domain_pauses WHERE org_id = ? AND id = ? LIMIT 1",
  ).bind(orgId, pauseId).first<DomainPauseRow>();
}

/* ---- withdrawing ----------------------------------------------------------------------------- */
