import type { Ctx } from "@mailda/runtime";

import { type ApprovalState, approvalOfManifest, decisionsOfApproval } from "../approvals.ts";
import { decidersOf } from "../deciders.ts";
import { getEvidence, sha256Hex } from "../evidence-store.ts";
import { evaluate, isStricter, OUTCOMES, type Outcome } from "../policy.ts";
import type { TransportAdapter } from "./transport.ts";

/**
 * The effect envelope, and the recheck an **approved** send gets immediately before the transport is asked
 * (#62, §18, Layer 5).
 *
 * ## Two paths, deliberately, and this file is the expensive one
 *
 * §18 requires that immediately before execution Mailda rechecks approval validity and revocation, current
 * actor authority, approver eligibility, policy, and every bound object hash. #62 settled that this happens on
 * the **approved** path only. An unapproved send keeps ADR 39's authority-only re-check, unchanged.
 *
 * That is not a shortcut, and the next reader must not tidy the two paths into one. An approval is a request
 * for assurance, and it is what pays for the assurance: the checks below cost **8** extra subrequests — 9 on a
 * Node running the shipped adapter — and two SHA-256 passes over real bytes, measured in
 * `docs/receipts/dispatch-recheck-cost.md`. That is half again on what a dispatch costs, 16 to 24, and
 * spending it on every send would buy a guarantee nobody asked for.
 *
 * **#62 priced this against a Butler step, and that was the wrong pot** — recorded here because it is the
 * arithmetic a reader is most likely to repeat. `mail.send.propose` is `sealManifest`; this runs in
 * `dispatchOne`, reached from the `OutboxSweeper` alarm or `POST /api/sends/dispatch`, which is a separate
 * Worker invocation with its own subrequest budget. So no Butler step and no Workflow instance pays for any of
 * it, and `butler.step_cost_max_send_propose` does not move. What these figures bound is one **sweep**:
 * `dispatchDue` takes at most 20 manifests, so 20 × 16 = 320 subrequests of unapproved sends or 20 × 24 = 480
 * of approved ones — 500 with the shipped adapter — all inside the 1,000-per-invocation ceiling on Workers Free.
 *
 * `dispatchOne` therefore branches once, on a column it has already read, and the tripwire is on the **cheap**
 * path: `test/outbound-recheck.test.ts` bounds an unapproved dispatch at
 * `send.dispatch_unapproved_max_subrequests`, four above its measured 16 — enough headroom for an ordinary
 * change to the dispatch path and not enough to hide the recheck's eight.
 *
 * ## Which path a send is on is decided by a column, not by a query
 *
 * `requiresApproval` reads `send_manifests.policy_outcome`, which the seal wrote and nothing rewrites. So
 * asking "is this an approved send" costs **nothing**: the manifest row is already in hand for ADR 39's
 * authority check. Looking the approval up first would have put one query on every unapproved send, which is
 * the exact regression the asymmetry exists to avoid.
 *
 * A manifest that required approval and has **no approval row** is refused rather than dispatched. That state
 * is not reachable through the product — an unsatisfiable gate is `withheld` at the seal and never dispatched
 * — so it means the row went missing, and failing closed is the only honest answer to "the assurance this
 * send was released on cannot be found".
 *
 * ## The order of the checks is a cost decision, and it is the reason a refusal is cheap
 *
 * Structural and free first, expensive last: the approval's own state and its deadline come off a row already
 * read; eligibility costs one query; the policy re-evaluation costs one to three; the two body hashes cost
 * four subrequests and two SHA-256 passes over real bytes. A send that is already refused never pays for the
 * hashes.
 *
 * The consequence, stated because it is observable: when two things are wrong at once the earlier reason is
 * the one recorded. That is a deliberate choice of the *first* answer over the *worst* one, because reporting
 * a hash mismatch on a send whose approval had already lapsed would raise a corruption alarm about a message
 * nobody was going to send.
 *
 * ## Only two of the three hashes can be re-verified, and that is structural
 *
 * §18 says *"every bound object hash"*, and on a send that reads as three: `body_typed_sha256`,
 * `body_normalized_sha256` and `submitted_sha256`. It is two. `submitted_sha256` is written **during**
 * dispatch, immediately before `transport.submit` — `submitClaimed` stores the rendered bytes and then asks —
 * so at recheck time it does not exist, and there is nothing to compare.
 *
 * That is not a gap to close later. The submitted bytes are *derived* from the normalized body at dispatch by
 * `renderRfc822`, so verifying the input verifies what the output is built from. Written down here because a
 * reader counting three and finding two would otherwise reasonably conclude somebody forgot one.
 */

/* ---- the reason vocabulary ------------------------------------------------------------------- */

/**
 * Why this Node declined to hand a send over. Six reasons, one state.
 *
 * #62 settled the shape: **gates are `awaiting` plus a reason, refusals are `withheld` plus a reason**, which
 * keeps the state machine's two halves symmetric and puts §5C's distinctness in the reason rather than in five
 * new states. Two conventions in one state machine is what later reads as an accident.
 *
 * `authority_lost` is ADR 39's, written before this module existed and still written by `dispatchOne` on both
 * paths. It is declared here anyway, because the list of things that can withhold a send has to be *one* list:
 * the words for all six live in `src/client/delivery.client.js` and `test/outbound-recheck.test.ts` reads this
 * against the exact bytes a browser is served, so a seventh reason with no sentence fails a test rather than
 * showing somebody a raw token.
 *
 * `satisfies` rather than an annotation, so the keys stay literal and `DispatchReason` below is the closed set
 * rather than `string`. That is what makes "six reasons" a statement the compiler holds: annotated as
 * `Record<string, …>` this object typed every call to `withheld` as accepting any string, and a mistyped reason
 * would have compiled, found nothing in this map, and thrown inside `dispatchOne` — leaving a send `held` with
 * no reason recorded, which is the one outcome worse than a refusal.
 */
export const WITHHOLDING = {
  authority_lost: {
    raises: false,
    sentence: "The author's authority to send as this mailbox was withdrawn before hand-over.",
  },
  approval_revoked: {
    raises: false,
    sentence: "The approval this send was released on no longer stands.",
  },
  approver_ineligible: {
    raises: false,
    sentence: "Somebody whose approval released this send is no longer eligible to have given it.",
  },
  policy_stricter: {
    raises: false,
    sentence: "Policy is stricter now than when this send was approved, so it fails closed.",
  },
  approval_expired: {
    raises: false,
    sentence: "The approval for this send passed its deadline before it was handed over.",
  },
  evidence_changed: {
    // The one member of the six that is not the system working. Every other reason is a decision or a
    // deadline: authority withdrawn, policy tightened, an approval lapsed. A hash mismatch means the archive
    // differs from its own record — corruption, or tampering — so it gets a log entry and a `doctor` finding
    // as well as an outbox row. A mechanism with no observable is the shape three of this month's defects
    // took.
    raises: true,
    sentence: "The stored body of this send no longer matches the hash the manifest recorded for it.",
  },
} as const satisfies Record<string, { raises: boolean; sentence: string }>;

/** The six, as a type. A seventh has to be declared above before it can be written anywhere. */
export type DispatchReason = keyof typeof WITHHOLDING;

/** The tokens `send_manifests.state_reason` can carry from a dispatch, derived from the map that writes them. */
export const DISPATCH_REASONS: readonly DispatchReason[] =
  Object.keys(WITHHOLDING) as DispatchReason[];

export interface Withholding {
  /** The machine token written to `state_reason`. */
  reason: DispatchReason;
  /** Prose for `last_error` and for the caller: the fixed sentence plus what was specifically wrong. */
  lastError: string;
  /** True for `evidence_changed` only: this one also logs and produces a `doctor` finding. */
  raises: boolean;
  /** Bounded facts for the audit entry, on top of the envelope's own record. Ids and hashes, never content. */
  evidence: Record<string, unknown>;
}

function withheld(
  reason: DispatchReason,
  because: string,
  evidence: Record<string, unknown>,
): Withholding {
  const entry = WITHHOLDING[reason];
  return { reason, lastError: `${entry.sentence} ${because}`.slice(0, 500), raises: entry.raises, evidence };
}

/** ADR 39's refusal, built here so the six reasons and their sentences live in one place. */
export function authorityLost(actorUserId: string, mailboxId: string): Withholding {
  return withheld(
    "authority_lost",
    `${actorUserId} no longer holds send.propose on ${mailboxId}.`,
    { actorUserId, mailboxId },
  );
}

/* ---- the envelope --------------------------------------------------------------------------- */

/**
 * Every §18 envelope member this build does **not** bind, with the reason it cannot be bound rather than a
 * field waiting to be filled.
 *
 * A bound field nothing populates is this repository's most-repeated defect: it reads as governance and is
 * inert. So each of these is named here, carried on every envelope, and recorded in the audit detail of every
 * refusal **that binds one** — an investigator reading a withheld send learns what the recheck did not cover
 * from the record itself rather than from this comment. The qualification is `authority_lost` on the unapproved
 * path, which binds no envelope because there is no approval there to bind one; that entry carries the reason
 * and the two ids and nothing else, and `test/outbound-recheck.test.ts` asserts that absence rather than
 * leaving a reader to wonder whether it was dropped.
 */
export const ENVELOPE_ABSENT: Readonly<Record<string, string>> = {
  rendered_html:
    "Composition carries bodyTyped only. packages/contract's sendMailInput has an optional bodyHtml the Node "
    + "does not implement, which is a contract-versus-implementation gap rather than a missing binding here.",
  attachment_hashes:
    "There is no attachment representation in the outbound path at all: SubmitRequest is from, to, cc, bcc, "
    + "subject, raw, text.",
  attachment_filenames: "Same as attachment_hashes — nothing carries an attachment to name.",
  template_and_prompt_versions:
    "Neither object exists. The Butler AST work moved template.render to reserved-and-rejected on finding no "
    + "template subsystem.",
  butler_version:
    "Layer 4 is not built. A Butler-originated send is already distinguishable by provenance, and the "
    + "envelope should carry the version when there is one.",
  delegator: "There is no delegation mechanism in this product, so there is no delegator to bind.",
  dlp_results:
    "There is no DLP in this product. §18 lists it among both the policy dimensions and the things the "
    + "recheck re-evaluates, and #60 named it absent among the eight conditions it did not ship for the same "
    + "reason: a result field with no scanner behind it would always read clean.",
  submitted_sha256:
    "Written during dispatch, immediately before transport.submit, so it does not exist at recheck time. The "
    + "submitted bytes are derived from the normalized body, so verifying the input verifies what the output "
    + "is built from — see this module's header.",
};

/**
 * The canonical effect envelope of one send, bound from columns that already carry every member (§18).
 *
 * Built once, in full, **before** the first check runs, because §18 makes the envelope the thing the recheck
 * is performed against rather than a by-product of it. That costs one query on a Node with an EMAIL binding —
 * the transport capability — and it is the only member not answerable from the manifest row plus the approval.
 *
 * Two members are **recorded rather than checked**, and it is worth saying which so nobody looks for the
 * check: `emittedHeaders` and `transport`. Nothing compares them, because a manifest is immutable so the
 * header set it implies cannot have moved, and the transport's own refusal is already the gate on its
 * capability — a seventh withholding reason for it is not something #62 decided. They are bound because they
 * are what makes a hash mismatch diagnosable: the header set says which lines the submitted bytes would have
 * carried, and the capability says what this Node could do at the moment it declined.
 */
export interface EffectEnvelope {
  /** §18's command type. One value today, because mail is the one effect that reaches this file. */
  command: "mail.send";
  /**
   * Target resource **and** expected version, which are the same value.
   *
   * Layer 5's answer 1 makes the manifest the revision: editing a sealed manifest is not an operation, and a
   * revision mints a new id (ADR 35), so the id *is* the version. Both fields carry it rather than one being
   * left null, because §18 asks for both and this is the honest answer to both.
   */
  targetResource: string;
  expectedVersion: string;
  /**
   * ADR 9's effect key, which 0007 says on the column itself: `send_manifests.id` **is** the effect key. So
   * this is the manifest id a third time, and no second identifier was invented for it — two ids that must
   * correspond is a correspondence somebody eventually gets wrong, and the failure is a duplicate the
   * recipient keeps for ever.
   */
  idempotencyKey: string;
  /**
   * §18's normalized parameters, bound from the manifest.
   *
   * Bound for evaluation and deliberately **not** copied into the audit trail: the policy facts and the
   * header set below are derived from these, and `sealManifest` already records the reason only counts and
   * the mailbox reach an entry — recipients and subject are the action, not the content, and §12 keeps the
   * rest in R2.
   */
  parameters: {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    isReply: boolean;
  };
  /** §18's referenced artifact hashes. Two, for the structural reason in this module's header. */
  artifactHashes: { bodyTyped: string; bodyNormalized: string };
  /** §18's actor. The delegator is in `ENVELOPE_ABSENT`. */
  actorUserId: string;
  mailboxId: string;
  /**
   * §18's policy version and result, as **bound** at the seal — not as they are now.
   *
   * `boundOutcome` is null when the send was sealed before the policy plane existed, and also when the stored
   * value is outside the four outcomes. Both are treated as the weakest possible bound (`allow`) by the
   * stricter-than comparison, which fails closed: any current outcome above `allow` then reads as stricter.
   * 0019 chose that reading; this is where it is applied.
   */
  policy: { boundOutcome: Outcome | null; boundVersionIds: string[] };
  /** The approval, its deadline and the people whose decisions released the send. Null when there is none. */
  approval: {
    approvalId: string;
    state: ApprovalState;
    requestedAt: string;
    expiresAt: string | null;
    approvers: string[];
    withdrawn: string[];
  } | null;
  /**
   * §18's allowed header set: fixed, enumerable, and derived from the same two columns `renderRfc822` derives
   * it from, so the two cannot disagree about what goes on the wire.
   *
   * `test/outbound-recheck.test.ts` renders real bytes and reads the header names back out of them, which is
   * what makes "the emitted header set is exactly this" an enforced statement rather than a list somebody
   * wrote down once. `Bcc` is absent on purpose, and that is what Bcc means.
   */
  emittedHeaders: readonly string[];
  /** §18's adapter capability. Its *version* is named absent below, on the field. */
  transport: {
    /** The adapter's name. `TransportAdapter` has no version and Cloudflare's binding exposes none, so the
     * honest binding is the name plus the date `mailda deploy` last verified the capability. */
    adapter: string;
    canSend: boolean;
    arbitraryRecipients: boolean;
    verifiedAt: string | null;
  };
  /** What §18 asks for that this build cannot bind, carried with the envelope rather than left implicit. */
  absent: Readonly<Record<string, string>>;
}

/**
 * The manifest columns the envelope and the recheck read, as one list.
 *
 * Exported as SQL text so `dispatchOne` issues exactly one widened `SELECT` — the row it already had to read
 * for ADR 39's authority check — and this module cannot come to expect a column that query does not fetch.
 * Widening a `SELECT` already being issued costs nothing; a second read of the same row would cost one
 * subrequest on **every** send, approved or not.
 */
export const ENVELOPE_COLUMNS =
  `author_user_id, mailbox_id, envelope_from, envelope_to, envelope_cc, envelope_bcc, subject,
   in_reply_to_message_id, references_header, body_typed_key, body_typed_sha256,
   body_normalized_key, body_normalized_sha256, policy_outcome, policy_versions`;

export interface EnvelopeRow {
  author_user_id: string;
  mailbox_id: string;
  envelope_from: string;
  envelope_to: string | null;
  envelope_cc: string | null;
  envelope_bcc: string | null;
  subject: string;
  in_reply_to_message_id: string | null;
  references_header: string | null;
  body_typed_key: string;
  body_typed_sha256: string;
  body_normalized_key: string;
  body_normalized_sha256: string;
  policy_outcome: string | null;
  policy_versions: string | null;
}

/**
 * Is this send on the approved path? Answered from the seal's own record, at no cost.
 *
 * `require_approval` is the one outcome that produces an approval, and `policy_outcome` is written once at the
 * seal and never rewritten — `approveStatements` clears `state_reason` when it releases a send and leaves this
 * column alone, deliberately, because "which rule applied" is a fact about the seal.
 */
export function requiresApproval(row: Pick<EnvelopeRow, "policy_outcome">): boolean {
  return row.policy_outcome === "require_approval";
}

function outcomeOf(stored: string | null): Outcome | null {
  return stored !== null && (OUTCOMES as readonly string[]).includes(stored) ? (stored as Outcome) : null;
}

function jsonList(stored: string | null): string[] {
  if (stored === null) return [];
  try {
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    // A malformed record is not a reason to refuse a send: this list is evidence about the past, and the
    // decision below rests on `policy_outcome` and on the current evaluation rather than on these ids. An
    // empty list is the honest rendering of "the record cannot be read", and the row itself still holds it.
    return [];
  }
}

/**
 * The header names `renderRfc822` will emit for this manifest, in the order it emits them.
 *
 * Every conditional field is decided from the same value that decides it there, one for one: `To` and `Cc`
 * from the lists, because `addAddresses` emits nothing for an empty one; `In-Reply-To` from
 * `in_reply_to_message_id` and `References` from `references_header`, because those are two different
 * questions about one row and `addIfPresent` answers each separately. Deriving both from "is this a reply"
 * would be one question standing in for two, which is how a claim about the wire form goes quietly wrong.
 *
 * `Bcc` is absent, and that is what Bcc means — the other recipients must not learn it, and the envelope
 * carries the recipient list separately.
 */
function emittedHeadersFor(
  row: EnvelopeRow,
  parameters: { to: string[]; cc: string[] },
): string[] {
  return [
    "From",
    ...(parameters.to.length === 0 ? [] : ["To"]),
    ...(parameters.cc.length === 0 ? [] : ["Cc"]),
    "Subject", "Message-ID", "Date", "MIME-Version", "Content-Type",
    ...(row.in_reply_to_message_id === null ? [] : ["In-Reply-To"]),
    ...(row.references_header === null ? [] : ["References"]),
  ];
}

/** Binds the envelope. One query on a Node with an EMAIL binding, none without one. */
export async function bindEnvelope(
  env: Env,
  orgId: string,
  manifestId: string,
  row: EnvelopeRow,
  transport: TransportAdapter,
): Promise<EffectEnvelope> {
  const approval = await approvalOfManifest(env, orgId, manifestId);
  const decisions = approval === null
    ? { approvers: [], withdrawn: [], denied: [] }
    : await decisionsOfApproval(env, approval.id);
  const capability = await transport.capability(env);
  const parameters = {
    from: row.envelope_from,
    to: jsonList(row.envelope_to),
    cc: jsonList(row.envelope_cc),
    bcc: jsonList(row.envelope_bcc),
    subject: row.subject,
    isReply: row.in_reply_to_message_id !== null,
  };

  return {
    command: "mail.send",
    targetResource: manifestId,
    expectedVersion: manifestId,
    idempotencyKey: manifestId,
    parameters,
    artifactHashes: { bodyTyped: row.body_typed_sha256, bodyNormalized: row.body_normalized_sha256 },
    actorUserId: row.author_user_id,
    mailboxId: row.mailbox_id,
    policy: {
      boundOutcome: outcomeOf(row.policy_outcome),
      boundVersionIds: jsonList(row.policy_versions),
    },
    approval: approval === null ? null : {
      approvalId: approval.id,
      state: approval.state,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
      approvers: decisions.approvers,
      withdrawn: decisions.withdrawn,
    },
    emittedHeaders: emittedHeadersFor(row, parameters),
    transport: {
      adapter: transport.name,
      canSend: capability.canSend,
      arbitraryRecipients: capability.arbitraryRecipients,
      verifiedAt: capability.verifiedAt,
    },
    absent: ENVELOPE_ABSENT,
  };
}

/**
 * The envelope as it goes into an audit entry: ids, hashes, counts and names, never content.
 *
 * `sealManifest` set the discipline and the reason: recipients and subject are the *action* rather than the
 * content, they are still the most sensitive thing in the row, and §12 keeps the rest in R2. So the addresses
 * and the subject that the checks above evaluate do not travel into the trail — the counts and the mailbox do,
 * which is what an investigation needs to find the manifest whose own row holds the rest.
 */
export function envelopeRecord(envelope: EffectEnvelope): Record<string, unknown> {
  return {
    command: envelope.command,
    targetResource: envelope.targetResource,
    expectedVersion: envelope.expectedVersion,
    idempotencyKey: envelope.idempotencyKey,
    actorUserId: envelope.actorUserId,
    mailboxId: envelope.mailboxId,
    recipients: {
      to: envelope.parameters.to.length,
      cc: envelope.parameters.cc.length,
      bcc: envelope.parameters.bcc.length,
    },
    isReply: envelope.parameters.isReply,
    artifactHashes: envelope.artifactHashes,
    policy: envelope.policy,
    approval: envelope.approval,
    emittedHeaders: envelope.emittedHeaders,
    transport: envelope.transport,
    // Names only. The reasons are in `ENVELOPE_ABSENT`, in source, where they can be read once rather than
    // repeated into every entry — but *which* members were unbound belongs on the record, because it is what
    // the recheck did not cover.
    absent: Object.keys(envelope.absent),
  };
}

/* ---- the recheck ---------------------------------------------------------------------------- */

export interface RecheckResult {
  envelope: EffectEnvelope;
  /** Null when every check passed and the transport may be asked. */
  withholding: Withholding | null;
}

/**
 * The five checks an approved send gets beyond ADR 39's authority re-read, in the order they are cheapest.
 *
 * Called from `dispatchOne` **before the claim**, for the same reason ADR 39's check is: the claim increments
 * `attempts` and moves the manifest to `outcome_unknown`, so a refusal discovered afterwards would spend an
 * attempt and park a never-submitted message in the one state that means "we do not know whether it left". It
 * did not leave, and we do know.
 */
export async function recheckApproved(
  env: Env,
  ctx: Ctx,
  orgId: string,
  manifestId: string,
  row: EnvelopeRow,
  transport: TransportAdapter,
): Promise<RecheckResult> {
  const envelope = await bindEnvelope(env, orgId, manifestId, row, transport);
  const approval = envelope.approval;

  // 1. The approval is valid and unrevoked. Three ways it is not, and all three are read off rows already in
  //    hand rather than re-derived from the stage counts: `approvals.state` is the materialised answer to
  //    "did distinct people satisfy every stage", written by a conditional UPDATE whose predicate is exactly
  //    that, and re-computing it here would be a second definition of completeness.
  if (approval === null) {
    return {
      envelope,
      withholding: withheld(
        "approval_revoked",
        "A policy required this send to be approved and there is no approval for it, which no path in this "
        + "Node produces — an unsatisfiable gate is withheld at the seal and never dispatched.",
        { approvalId: null, boundOutcome: envelope.policy.boundOutcome },
      ),
    };
  }
  if (approval.state !== "approved") {
    return {
      envelope,
      withholding: withheld(
        "approval_revoked",
        `Approval ${approval.approvalId} is ${approval.state}, not approved.`,
        { approvalId: approval.approvalId, approvalState: approval.state },
      ),
    };
  }
  if (approval.withdrawn.length > 0 || approval.approvers.length === 0) {
    // A withdrawal after completion is refused by `withdrawApproval`, which is precisely what is supposed to
    // make an approved send safe to dispatch — so this is a row that moved outside the product. Checked
    // anyway, because the entire point of re-reading is not to trust what the manifest's state implies, and
    // an `approved` approval with nobody's approval standing would otherwise pass the eligibility check
    // below **vacuously**: no approvers, nothing to find ineligible.
    return {
      envelope,
      withholding: withheld(
        "approval_revoked",
        `Approval ${approval.approvalId} has ${approval.approvers.length} standing approval(s) and `
        + `${approval.withdrawn.length} withdrawn.`,
        {
          approvalId: approval.approvalId,
          standing: approval.approvers.length,
          withdrawn: approval.withdrawn,
        },
      ),
    };
  }

  // 2. The deadline, off the same row. Terminal: re-seal is the invalidation mechanism, so the author composes
  //    again and gets a new manifest and a fresh approval. Returning the send to `awaiting` was rejected —
  //    it makes expiry mean nothing, because the same manifest could be re-approved indefinitely, and it
  //    creates a queue that never drains.
  //
  //    A null deadline is not expired. See 0022: it means the request predates the column, and a migration
  //    inventing a deadline for a decision somebody already took would be a false statement about the past.
  if (approval.expiresAt !== null && ctx.now() > Date.parse(approval.expiresAt)) {
    return {
      envelope,
      withholding: withheld(
        "approval_expired",
        `Approval ${approval.approvalId} was requested at ${approval.requestedAt} and lapsed at `
        + `${approval.expiresAt}. This is terminal: compose again, and the new message gets its own approval.`,
        { approvalId: approval.approvalId, expiresAt: approval.expiresAt, requestedAt: approval.requestedAt },
      ),
    };
  }

  // 3. Every approver is still eligible. One query, and it is `decidersOf` rather than a second eligibility
  //    query written here: that function resolves a relation held **through a team** to the people who hold
  //    it, which is the subtlety dual control turns on, and a second copy of it is the thing 0021 refused.
  //
  //    The actor is re-excluded as well. It costs nothing — both values are in hand — and it is the one
  //    exclusion that is a §18 rule rather than a grant, so it is the one that would still have to hold if
  //    somebody granted `approval.decide` to an author.
  const eligible = await decidersOf(env, orgId, envelope.mailboxId);
  const lost = approval.approvers.filter(
    (userId) => !eligible.has(userId) || userId === envelope.actorUserId,
  );
  if (lost.length > 0) {
    return {
      envelope,
      withholding: withheld(
        "approver_ineligible",
        `${lost.join(", ")} no longer hold(s) approval.decide on ${envelope.mailboxId}, or is the author of `
        + "this send. §18's separation of duty is evaluated live, so an approval given by somebody who has "
        + "since lost the relation is not an approval this Node will act on.",
        { approvalId: approval.approvalId, ineligible: lost, eligibleNow: eligible.size },
      ),
    };
  }

  // 4. Policy, re-evaluated against the **current** rules. `evaluate` plus `isStricter` is the whole of what
  //    this needs and #60 said so — nothing here re-implements a condition. Stricter is computable rather
  //    than a judgement because the four outcomes are totally ordered: `max(current) > max(bound)`.
  const current = await evaluate(env, ctx, orgId, {
    mailboxId: envelope.mailboxId,
    actorUserId: envelope.actorUserId,
    recipients: [...envelope.parameters.to, ...envelope.parameters.cc, ...envelope.parameters.bcc],
    isReply: envelope.parameters.isReply,
  });
  const bound = envelope.policy.boundOutcome ?? "allow";
  if (isStricter(current.outcome, bound)) {
    return {
      envelope,
      withholding: withheld(
        "policy_stricter",
        `Policy now says ${current.outcome} for this send; it was approved under ${bound}. `
        + (current.matched.length === 0
          ? "No policy matched, which cannot be stricter than anything — investigate."
          : `The rule(s) that apply now: ${current.matched
            .map((match) => `${match.policyName}@${match.version}`).join(", ")}.`),
        {
          approvalId: approval.approvalId,
          boundOutcome: envelope.policy.boundOutcome,
          currentOutcome: current.outcome,
          currentVersionIds: current.matched.map((match) => match.versionId),
        },
      ),
    };
  }

  // 5. The two body hashes, last because they are the expensive pair: an R2 get and a vault RPC each, then a
  //    SHA-256 over real bytes.
  for (const body of [
    { name: "body_typed", key: row.body_typed_key, expected: row.body_typed_sha256 },
    { name: "body_normalized", key: row.body_normalized_key, expected: row.body_normalized_sha256 },
  ]) {
    const verified = await verifyBody(env, body.key, body.expected);
    if (verified.ok) continue;
    return {
      envelope,
      withholding: withheld(
        "evidence_changed",
        `${body.name} at ${body.key} ${verified.found === null
          ? `could not be read: ${verified.why}`
          : `hashes to ${verified.found}, and the manifest records ${body.expected}`}. `
        + "This Node declined to hand it over, and the mismatch is logged and reported by doctor: an archive "
        + "that disagrees with its own record is corruption or tampering, not a decision.",
        {
          approvalId: approval.approvalId,
          object: body.name,
          blobKey: body.key,
          recordedSha256: body.expected,
          foundSha256: verified.found,
        },
      ),
    };
  }

  return { envelope, withholding: null };
}

/**
 * Does the stored object still hash to what the manifest recorded?
 *
 * An **unreadable** object is treated as changed rather than as a separate reason, and the two are
 * distinguished in the detail rather than in the state: a missing R2 object is §24's worst failure — a record
 * pointing at bytes that are not there — and a decryption failure is the same claim about the same object. Both
 * mean the archive cannot answer for its own record, which is exactly what `evidence_changed` says.
 *
 * The reason is not swallowed: it reaches `last_error`, the audit entry, the operational log and `doctor`. What
 * it must not do is throw, because a throw here would leave the send `held` and the next sweep would try again
 * for ever with nothing recorded — the one outcome worse than a refusal.
 */
async function verifyBody(
  env: Env,
  blobKey: string,
  expected: string,
): Promise<{ ok: true } | { ok: false; found: string | null; why: string }> {
  let found: string;
  try {
    found = await sha256Hex(await getEvidence(env, blobKey));
  } catch (error) {
    return {
      ok: false,
      found: null,
      why: (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200),
    };
  }
  return found === expected ? { ok: true } : { ok: false, found, why: "hash mismatch" };
}
