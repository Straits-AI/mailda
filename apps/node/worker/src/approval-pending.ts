import { adminsOf, decidersByMailbox } from "./deciders.ts";
import { type Stage, stagesOfApproval } from "./approval-plan.ts";
import { APPROVAL_COLUMNS, type ApprovalRow, type RawApproval, approvalOf, decisionsOf, openStage } from "./approval-rows.ts";

export interface PendingApproval extends ApprovalRow {
  /**
   * What this request asks for, per stage: the count, and the team it must come from (#73).
   *
   * The team is in the queue rather than only in the trail, for the reason `supervised` and `exportRequest`
   * below are: the person being asked has to see what they are being asked for. A stage they cannot take
   * still appears — they may hold `approval.decide` on the mailbox and be outside the team — and it is shown
   * rather than filtered, because a request that vanished from one person's queue with no explanation is how
   * an approval waits on somebody who never learns they are the one holding it up.
   */
  stages: Stage[];
  openStage: number | null;
  /** True when the caller has already decided, so the row is theirs to withdraw rather than to decide. */
  decidedByMe: boolean;
  /**
   * The reason a `hold_lift` was requested for, and null for every other subject kind.
   *
   * In the queue, not only in the audit trail, because **this is where a reader meets it**: somebody being
   * asked to re-permit destruction has to be able to see what they are being asked for, and a trail is where
   * a decision is accounted for afterwards. `LEFT JOIN`, so it costs no extra query — the outer join is what
   * makes a send's null a null rather than a missing row.
   */
  reason: string | null;
  /**
   * What a `supervised_read` request asks for, and null for every other subject kind (#63).
   *
   * **In the queue, not only in the trail, and this is the whole of the control on a supervised read's
   * duration.** §7 makes time part of the bound scope, so the deadline is part of what is being approved —
   * and `src/supervised.ts` deliberately caps nothing, because a maximum duration is a number with no
   * receipt. What stands in for a cap is that the two people asked see the mailbox, the scope, the matter and
   * the exact deadline before they answer. A queue that showed only "somebody wants a supervised read" would
   * be asking them to agree to nothing in particular, which is the same defect a blank lift reason is.
   *
   * Another `LEFT JOIN` on the same query, so it costs no extra round trip — the same shape `reason` uses.
   */
  supervised: {
    grantId: string;
    subjectId: string;
    scope: string;
    matterId: string | null;
    /**
     * The cited matter's kind and words, or null when the grant cites none.
     *
     * Here rather than in `GET /api/matters`, and that placement is the whole point: the two approvers need
     * this text and **nobody else does**. An org-wide matter listing hands *"suspected exfiltration by Dana"*
     * to Dana, and §7 makes the notice to her due after the matter closes, not on the day it opened. So the
     * text travels with the request that cites it, to exactly the people being asked to agree to it, on the
     * `LEFT JOIN` that was already fetching the grant. Null here means the grant cites no matter — which is a
     * real answer (#63: the first act precedes the matter), and one the approvers should see as such rather
     * than as a blank.
     */
    matter: { type: string; description: string } | null;
    expiresAt: string;
  } | null;
  /**
   * What an `ediscovery_export` request asks for, and null for every other subject kind (#65).
   *
   * **In the queue, and this is the whole of the control on how much an export copies.** §18 binds an
   * approval to the artifact hashes it names, and an export's bound artifact is a *predicate* — so the two
   * people being asked have to see the predicate itself, its canonical hash, and the hard `max_messages`
   * that stops the same predicate matching more next week. A queue that showed only "somebody wants an
   * export" would be asking them to agree to an unbounded future disclosure, which is the exact failure
   * `max_messages` exists to close.
   *
   * A fourth `LEFT JOIN` on the same query rather than a second round trip, the shape `reason` and
   * `supervised` already use.
   */
  exportRequest: {
    exportId: string;
    requestedBy: string;
    /** The canonical predicate as stored — the text the hash beside it is over. */
    predicate: string;
    predicateSha256: string;
    maxMessages: number;
    matterId: string;
    destination: string;
  } | null;
  /**
   * #66's domain pause: which domain this would stop, and the reason its requester gave.
   *
   * A fifth `LEFT JOIN` on the same query. The two administrators being asked are the only people who see
   * this text before deciding, which is why it travels with the request rather than living only in the trail
   * — a person asked to stop a customer's mail with no stated reason is being asked to agree to nothing in
   * particular.
   */
  domainPause: { pauseId: string; domain: string; reason: string } | null;
}

/**
 * The pending approvals this person could act on: on a mailbox where they hold `approval.decide`, and never one
 * gating their own act.
 *
 * Their own sends and their own lift requests are excluded rather than shown as undecidable, because a queue
 * that lists work somebody cannot do is a queue they learn to ignore. They see a send in their own outbox,
 * where the state and its reason already are, and a lift in `doctor`, which reports a pending one beside the
 * hold it would release.
 *
 * The rows they have already decided **are** included, with `decidedByMe`, because withdrawal is an act on
 * exactly those and a person cannot withdraw from something they cannot find.
 *
 * Two queries per pending approval, which is stated rather than hidden: it is bounded by the outstanding set —
 * approvals nobody has finished deciding — and if that ever stops being small, the two reads collapse into one
 * grouped query over both tables. Bounded by what people have left undone is the right kind of bound for a
 * queue; it is the same shape as the outbox's own list.
 */
export async function pendingApprovals(
  env: Env,
  orgId: string,
  userId: string,
): Promise<PendingApproval[]> {
  const byMailbox = await decidersByMailbox(env, orgId);
  const mailboxes = [...byMailbox.entries()]
    .filter(([, people]) => people.has(userId))
    .map(([mailboxId]) => mailboxId);

  /*
   * The organization, when this person administers it (#66).
   *
   * `scope_id` is the object whose relation-holders may decide, so an administrator's queue is
   * "the mailboxes where I hold approval.decide" **plus** "the organization, if I hold org.admin" — one
   * `IN` list over one column rather than a second query or a second predicate. That is what the rename in
   * migration 0026 buys: the filter did not have to learn about a second kind of scope, only about a second
   * value that can appear in the same column.
   *
   * One query, unconditionally, and it is the cheapest of the three `pendingApprovals` already makes: a
   * person who is not an administrator gets an empty set and the list is unchanged. Skipping it for
   * non-administrators would need to know they are not one, which is this query.
   */
  const scopes = (await adminsOf(env, orgId)).has(userId) ? [...mailboxes, orgId] : mailboxes;
  if (scopes.length === 0) return [];

  const placeholders = scopes.map(() => "?").join(", ");
  const { results } = await env.CATALOG.prepare(
    `SELECT ${APPROVAL_COLUMNS.split(", ").map((column) => `a.${column}`).join(", ")}, l.reason AS reason,
            g.id AS grant_id, g.subject_id AS grant_subject_id, g.scope AS grant_scope,
            g.matter_id AS grant_matter_id, g.expires_at AS grant_expires_at,
            mt.type AS matter_type, mt.description AS matter_description,
            x.id AS export_id, x.requested_by AS export_requested_by, x.predicate AS export_predicate,
            x.predicate_sha256 AS export_predicate_sha256, x.max_messages AS export_max_messages,
            x.matter_id AS export_matter_id, x.destination AS export_destination,
            dp.id AS pause_id, dp.domain AS pause_domain, dp.reason AS pause_reason
       FROM approvals a
       LEFT JOIN hold_lifts l ON a.subject_kind = 'hold_lift' AND l.id = a.subject_id AND l.org_id = a.org_id
       LEFT JOIN supervised_grants g ON a.subject_kind = 'supervised_read' AND g.id = a.subject_id
                                    AND g.org_id = a.org_id
       -- The cited matter, for the two people being asked. A third outer join on the same query rather than a
       -- second round trip, and outer because a grant citing no matter is a real answer rather than a gap.
       LEFT JOIN matters mt ON mt.org_id = g.org_id AND mt.id = g.matter_id
       -- #65's export, on the same query and outer for the same reason: every other subject kind produces
       -- all-null here, and an approver deciding an export must see the bound before they agree to it.
       LEFT JOIN exports x ON a.subject_kind = 'ediscovery_export' AND x.id = a.subject_id
                          AND x.org_id = a.org_id
      -- #66's pause, on the same query and outer for the same reason as the three above: an administrator
      -- being asked to stop a customer's mail must see which domain and why before they agree to it, and
      -- every other subject kind produces all-null here.
      LEFT JOIN domain_pauses dp ON a.subject_kind = 'domain_pause' AND dp.id = a.subject_id
                                AND dp.org_id = a.org_id
      WHERE a.org_id = ? AND a.state = 'pending' AND a.scope_id IN (${placeholders})
        AND a.actor_user_id != ?
      ORDER BY a.requested_at, a.id`,
  ).bind(orgId, ...scopes, userId).all<RawApproval & {
    reason: string | null;
    grant_id: string | null;
    grant_subject_id: string | null;
    grant_scope: string | null;
    grant_matter_id: string | null;
    grant_expires_at: string | null;
    matter_type: string | null;
    matter_description: string | null;
    export_id: string | null;
    export_requested_by: string | null;
    export_predicate: string | null;
    export_predicate_sha256: string | null;
    export_max_messages: number | null;
    export_matter_id: string | null;
    export_destination: string | null;
    pause_id: string | null;
    pause_domain: string | null;
    pause_reason: string | null;
  }>();

  const out: PendingApproval[] = [];
  for (const row of results) {
    const approval = approvalOf(row);
    const stages = await stagesOfApproval(env, approval.id);
    const decisions = await decisionsOf(env, approval.id);
    out.push({
      ...approval,
      stages,
      openStage: openStage(stages, decisions),
      decidedByMe: decisions.some((decision) => decision.decider_user_id === userId),
      reason: row.reason,
      // Every field or none: a half-populated object would let a caller render "until null", and the
      // deadline is the field this exists for. The `LEFT JOIN` produces all-null for any other subject kind.
      supervised: row.grant_id === null || row.grant_scope === null || row.grant_expires_at === null
        || row.grant_subject_id === null
        ? null
        : {
          grantId: row.grant_id,
          subjectId: row.grant_subject_id,
          scope: row.grant_scope,
          matterId: row.grant_matter_id,
          // Both columns or neither, for the same reason the object above is all-or-nothing: a type with no
          // description would let a caller render a matter it cannot show, and the description is the half
          // the two approvers are actually reading.
          matter: row.matter_type === null || row.matter_description === null
            ? null
            : { type: row.matter_type, description: row.matter_description },
          expiresAt: row.grant_expires_at,
        },
      // Every field or none, like `supervised` above: the bound is the field this exists for, and a
      // half-populated object would let a caller render "up to null messages".
      exportRequest: row.export_id === null || row.export_predicate === null
        || row.export_predicate_sha256 === null || row.export_max_messages === null
        || row.export_matter_id === null || row.export_destination === null
        || row.export_requested_by === null
        ? null
        : {
          exportId: row.export_id,
          requestedBy: row.export_requested_by,
          predicate: row.export_predicate,
          predicateSha256: row.export_predicate_sha256,
          maxMessages: row.export_max_messages,
          matterId: row.export_matter_id,
          destination: row.export_destination,
        },
      // Every field or none, for the third time and the same reason: the reason is the field this exists
      // for, and a half-populated object would let a caller render "pause null because null".
      domainPause: row.pause_id === null || row.pause_domain === null || row.pause_reason === null
        ? null
        : { pauseId: row.pause_id, domain: row.pause_domain, reason: row.pause_reason },
    });
  }
  return out;
}
