import { type Ctx } from "@mailda/runtime";

import { auditedBatch } from "../audit.ts";
import { conflict, notFound, unprocessable } from "../errors.ts";
import { getEvidence } from "../evidence-store.ts";
import { dispatchOne, type DispatchResult, type SendState } from "./dispatch.ts";
import { sealManifest } from "./manifest.ts";
import { type TransportAdapter } from "./transport.ts";

/**
 * Retrying one send, and the two differently-named acts that does (#53, §16, ADR 40).
 *
 * §16 says `retry-effect` is *"offered only when reconciliation proves non-acceptance"*. Two things about that
 * sentence turned out to need settling before it could be built, and both are settled here.
 *
 * ## There is no reconciler that could prove it, so the proof is a **recorded outcome**
 *
 * The only reconciler in this repository is `src/reconcile.ts`, which reconciles R2 evidence against
 * `ingress_receipts` and has nothing to say about a send. So the four provable states below are not
 * reconciliation results; they are outcomes this Node wrote down at the moment it learned them. The blueprint's
 * sentence is amended to say so rather than left naming a mechanism that does not exist.
 *
 * ## What can actually be proven is narrow, and the proof is an **allowlist over an exhaustive switch**
 *
 *   | state | what proves non-acceptance |
 *   |:--|:--|
 *   | `refused` | the API boundary rejected the submission. A first-party fact about this Node's own attempt |
 *   | `throttled` | rate-limited before the bytes were taken. Also first-party |
 *   | `suppressed` | this Node declined to hand over. Its own decision |
 *   | `outcome_unknown` **and** `fidelity = 'authored'` **and** `submitted_key IS NULL` | the bytes were rendered, stored and recorded on the row *before* the first `transport.submit`, so an absent key means no submission was ever attempted |
 *
 * **`send_recipients.attempts = 0` is not a proof** and is deliberately not consulted: that column is updated
 * only after the call resolves, so an isolate that died mid-submit leaves it at 0 with the bytes already gone.
 * And **provider observation can only ever disprove** non-acceptance — `transport_message_id` is written only
 * on `handed_over`, so an `outcome_unknown` send has no join key at all and its delivery events land with a
 * NULL `manifest_id`.
 *
 * The rule is written as a `Record<SendState, …>` rather than as a list of states to exclude, and that is the
 * load-bearing shape rather than a style: `outcome_unknown` is `applyOutcome`'s **default** for anything
 * unrecognised, so the unprovable state is the one that grows, and a denylist would guard only the spellings
 * its author thought of. Here a tenth send state does not compile until somebody classifies it, and a state
 * string this module has never heard of falls through to *no mode at all*.
 *
 * ## Two names, because two epistemic states — and the second mints a **new** key on purpose
 *
 * `retryEffect` reuses the **old** manifest and therefore the old effect key: the effect provably did not
 * happen, so the intent is unchanged and re-offering it under a new identity would put a second record in the
 * outbox for one message.
 *
 * `resendMayDuplicate` **seals a new manifest**, so a new key. The old key may already have been handed over,
 * and reusing it would claim these are the same effect — the one thing nobody can say about this case. Two
 * keys make two effects, `send_manifests.resend_of` records that the second is the first one again, and the
 * new seal is re-decided by the **current** policy, current authority and current breakers because it is a new
 * intent in the present.
 *
 * Collapsing them into one act with a flag would put the safe case and the duplicate-risking case behind one
 * button, which is the blur ADR 39's state vocabulary exists to prevent. So: `retry-effect` is offered **iff**
 * non-acceptance is proven and is **absent otherwise — absent, not failing** — and the unprovable case gets
 * its own name, requires a person, requires them to say a duplicate is acceptable, requires a reason, and is
 * audited under an action of its own.
 *
 * ## What makes both safe against a partial send
 *
 * `dispatch.ts`'s `submitPerRecipient` skips a recipient already `handed_over`, citing ADR 40, so a
 * partially-delivered send retried either way reaches only the addresses the bytes never left for.
 */

/** The states whose recorded outcome is itself the proof. Bound as parameters, never interpolated. */
export const PROVEN_STATES = ["refused", "throttled", "suppressed"] as const;

/** Why non-acceptance is proven. A token, because the words belong to the interface. */
export type NonAcceptanceProof = "refused" | "throttled" | "suppressed" | "never_submitted";

/** Why neither mode is offered. Not a failure: an absent mode and a failing one are different things. */
export type NoRetryReason =
  /** Nothing has been attempted, so there is nothing to retry. `held`, or waiting on a gate. */
  | "not_yet_attempted"
  /** A person or a policy decided. Composing again is the act, not retrying. */
  | "decided"
  /** The transport took the bytes. Non-acceptance is *disproven*; a second copy would be certain. */
  | "acceptance_observed"
  /** A state this Node's code does not classify. Fails closed rather than guessing. */
  | "state_not_classified";

export type RetryOffer =
  | { readonly mode: "retry-effect"; readonly proof: NonAcceptanceProof }
  | { readonly mode: "resend-may-duplicate"; readonly duplicatePossible: true }
  | { readonly mode: null; readonly why: NoRetryReason };

/** The columns the offer is computed from. Every one of them is already in the outbox listing's `SELECT`. */
export interface RetryFacts {
  readonly state: string;
  readonly fidelity: string;
  /** Whether `submitted_key` is non-NULL. A boolean rather than the key: nothing here needs the R2 path. */
  readonly hasSubmitted: boolean;
}

const proven = (proof: NonAcceptanceProof): RetryOffer => ({ mode: "retry-effect", proof });
const none = (why: NoRetryReason): RetryOffer => ({ mode: null, why });

/**
 * Every send state, classified. Exhaustive by construction — a tenth state does not compile without an entry.
 *
 * The `outcome_unknown` arm is the only one that reads a second column, and it is the whole point of the
 * design: the same state is provable or unprovable depending on whether the bytes were ever rendered.
 */
const OFFER_FOR: { [S in SendState]: (facts: RetryFacts) => RetryOffer } = {
  held: () => none("not_yet_attempted"),
  awaiting: () => none("not_yet_attempted"),
  cancelled: () => none("decided"),
  withheld: () => none("decided"),
  handed_over: () => none("acceptance_observed"),
  refused: () => proven("refused"),
  throttled: () => proven("throttled"),
  suppressed: () => proven("suppressed"),
  outcome_unknown: (facts) =>
    // `fidelity === "authored"` is not decoration. The `reconstructed` path in `submitClaimed` never writes
    // `submitted_key` at all, so a NULL there proves nothing about it — and reading the absence as a proof
    // would be the permissive failure on the one path ADR 33 keeps for non-customer mail.
    facts.fidelity === "authored" && !facts.hasSubmitted
      ? proven("never_submitted")
      : { mode: "resend-may-duplicate", duplicatePossible: true },
};

/**
 * Does an existing send **stand** as the answer to a replay proposing the same content again (#53)?
 *
 * `true` means *this message exists and the Node's job is done* — so a replay that would repeat it records the
 * incumbent's key and seals nothing, which is `replay_identical_content`. `false` means the incumbent is a
 * decision **against** this message: it was never handed over, never will be, and pointing a replay at it while
 * reporting `ok` is a no-op reporting success.
 *
 * `cancelled` and `withheld` are the two, and they are exactly the pair `OFFER_FOR` above answers `decided` on
 * — *"a person or a policy decided. Composing again is the act, not retrying"*. The most obvious use of
 * `re-run` is "a policy wrongly denied a Butler's send; fix the policy and re-run", and before this map that
 * request silently did nothing and answered `ok`.
 *
 * ## Why the answer is a refusal and not a re-seal
 *
 * Re-sealing on a `withheld` incumbent would be the permissive reading and it opens a real duplicate path: the
 * content rule's scope is *the source run's own effects*, so two replays of one source run would each find only
 * the original and each mint a manifest. One request to fix a policy, two messages. So the incumbent's key is
 * still reused — nothing new is minted — and what changes is that the run says a decision stands rather than
 * claiming success. Composing again is the act, and it has a name and a person attached to it.
 *
 * A **total map**, for `OFFER_FOR`'s reason: `applyOutcome` defaults an unrecognised outcome to
 * `outcome_unknown`, so the population that grows is the one nobody classified, and a list of two states to
 * refuse on would guard only the spellings its author thought of.
 */
const INCUMBENT_STANDS: { [S in SendState]: boolean } = {
  held: true,
  awaiting: true,
  handed_over: true,
  refused: true,
  throttled: true,
  suppressed: true,
  outcome_unknown: true,
  cancelled: false,
  withheld: false,
};

/**
 * The same question, of a state string off a row.
 *
 * An unclassified state **stands**, and that is the safe direction rather than the tidy one: standing reuses
 * the incumbent's key and seals nothing, so the worst a state this code has never heard of can produce is a
 * replay that performs less than it might have. Not standing mints nothing either, but it *reports* a decision
 * nobody made — and inventing a governance decision for an unrecognised row is the failure this repository
 * names. Mirrors `retryOffer`'s own `Object.hasOwn` guard: the map constrains what can be written, never what
 * a row holds.
 */
export function incumbentStands(state: string): boolean {
  return Object.hasOwn(INCUMBENT_STANDS, state) ? INCUMBENT_STANDS[state as SendState] : true;
}

/**
 * What this send offers, or nothing.
 *
 * Pure, so the outbox listing computes it from the row it already read (`state`, `fidelity`,
 * `submitted_key IS NOT NULL`) at no cost, and so the whole rule is testable without a database.
 */
export function retryOffer(facts: RetryFacts): RetryOffer {
  const arm = Object.hasOwn(OFFER_FOR, facts.state)
    ? OFFER_FOR[facts.state as SendState]
    : undefined;
  // A state string the code does not classify. `Record<SendState, …>` above constrains what can be *written*;
  // it cannot constrain what a row holds, and a row is where a hand-edited or a future-migration value would
  // arrive. Fails closed: no mode.
  return arm === undefined ? none("state_not_classified") : arm(facts);
}

/**
 * The same rule, in SQL, so the act is conditional on the proof rather than on a read that could go stale.
 *
 * Two expressions of one rule is a correspondence risk and it is answered by a test rather than by care:
 * `test/butler-replay.test.ts` drives both over every state crossed with both fidelities and both key states
 * and asserts they agree on all of them. That is why the two are written to the same three conditions in the
 * same order.
 */
export function provenNonAcceptanceSql(): string {
  const states = PROVEN_STATES.map(() => "?").join(", ");
  return `(state IN (${states})`
    + " OR (state = 'outcome_unknown' AND fidelity = 'authored' AND submitted_key IS NULL))";
}

/** One row of what `retryEffect` and `resendMayDuplicate` need to know. */
interface ManifestRow {
  state: string;
  fidelity: string;
  has_submitted: number;
  mailbox_id: string;
  author_user_id: string;
  subject: string;
  envelope_from: string;
  envelope_to: string;
  envelope_cc: string | null;
  envelope_bcc: string | null;
  in_reply_to_message_id: string | null;
  body_typed_key: string;
}

type RetryRow = ManifestRow & RetryFacts;

const RETRY_COLUMNS =
  `state, fidelity, submitted_key IS NOT NULL AS has_submitted, mailbox_id, author_user_id, subject,
   envelope_from, envelope_to, envelope_cc, envelope_bcc, in_reply_to_message_id, body_typed_key`;

async function retryRow(env: Env, orgId: string, manifestId: string): Promise<RetryRow | null> {
  const row = await env.CATALOG.prepare(
    `SELECT ${RETRY_COLUMNS} FROM send_manifests WHERE org_id = ? AND id = ? LIMIT 1`,
  ).bind(orgId, manifestId).first<ManifestRow>();
  if (row === null) return null;
  // D1 answers a boolean expression as 0 or 1. Converted here, once, so nothing downstream compares a number
  // against a boolean and gets the right answer for the wrong reason.
  return { ...row, hasSubmitted: row.has_submitted === 1 };
}

/** What either act answers with. `offered` says which mode ran; a refusal says what was offered instead. */
export interface RetryResult {
  readonly mode: "retry-effect" | "resend-may-duplicate";
  /** For `retry-effect`, the manifest that was dispatched again — the **same** id. */
  readonly manifestId: string;
  /** For `resend-may-duplicate`, the new manifest and therefore the new effect key. */
  readonly sealedAs?: string;
  /** The dispatch's own answer, when the act dispatched. Absent for a resend, which enters the hold window. */
  readonly dispatch?: DispatchResult;
  readonly detail: string;
}

/**
 * `retry-effect`: hand the **same** bytes under the **same** key to dispatch again.
 *
 * ## Why this moves the send to `held` rather than calling `dispatchOne` directly
 *
 * `movableNow` admits `held`-and-due, `throttled`, and a rate-gated `awaiting`. Three of the four provable
 * states are not in that set — deliberately, because the system must not retry them on its own — so the act of
 * a person asking is exactly the transition back into movability. `release_at` is left alone: a manifest in any
 * of the four states has already been claimed once, and the claim required `release_at <= now`, so the window
 * has elapsed by construction and rewriting it would restart a clock that has nothing left to protect.
 *
 * `last_error` is left alone too. It is the account of why the send is in the state it is in, and clearing it
 * before the retry has an answer would leave a send with no reason at all if this invocation died in between —
 * which is the gap `recordUnexplainedDispatch` exists to close. `applyOutcome` overwrites it either way.
 *
 * ## The proof is in the `UPDATE`'s predicate, not in the read above it
 *
 * A send can move between the offer and the act — the sweeper retries `throttled` on its own, and a
 * `never_submitted` send is one another dispatcher may pick up. So the gate is `provenNonAcceptanceSql()`, and
 * a lost race writes nothing and answers with what the send actually is. Same shape as `cancelSend`.
 */
export async function retryEffect(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actorUserId: string,
  manifestId: string,
  transport?: TransportAdapter,
): Promise<RetryResult> {
  const row = await retryRow(env, orgId, manifestId);
  if (row === null) {
    throw notFound("E_NO_MANIFEST", {
      what: `${manifestId} is not a send in this organization`,
      why: "a retry acts on a recorded send; there is nothing here to act on",
      fix: "check the id against GET /api/sends",
    });
  }

  const offer = retryOffer(row);
  if (offer.mode !== "retry-effect") {
    /*
     * Refused with the offer that *is* available, because the four-part rule applies to a mode as much as to a
     * budget: a caller who asked for the safe act and cannot have it needs to be told which act exists and
     * what it costs them. This is the only place the two modes are named side by side, and it says plainly
     * that the other one may deliver a second copy.
     */
    throw conflict("E_RETRY_NOT_PROVEN", {
      what: `${manifestId} is ${row.state} and this Node cannot prove the message never left`,
      /*
       * Three arms, not two, and the third is a correction: a `reconstructed` send reaches here with a **NULL**
       * `submitted_key`, so the authored sentence — *"this send has one"* — would state the opposite of what
       * the row holds. An agent reading an error is told a column has a value it does not have, which is worse
       * than a vague reason because it sends the reader to check the wrong thing. `offer.mode` alone cannot
       * tell the two apart; the fidelity can.
       */
      why: offer.mode === null
        ? `retry-effect is offered only where non-acceptance is recorded, and this send's state means `
          + `${offer.why}`
        : row.fidelity !== "authored"
          ? `this send is ${row.fidelity} rather than authored, and the reconstructed path never writes `
            + "submitted_key at all — so its absence is not evidence of anything and cannot prove these bytes "
            + "never left (ADR 33)"
          : "the bytes were rendered and stored before the first submission, so an absent submitted_key is the "
            + "only durable proof of non-submission and this send has one",
      fix: offer.mode === "resend-may-duplicate"
        ? "POST /api/sends/:id/retry with mode=resend-may-duplicate, acceptDuplicateRisk=true and a reason. "
          + "It seals a new send under a new idempotency key and the recipient may receive two copies."
        : "nothing here is retryable; compose a new message if one is owed",
    });
  }

  const at = new Date(ctx.now()).toISOString();
  const gate = provenNonAcceptanceSql();
  const { results } = await auditedBatch<never>(
    env, ctx, orgId,
    {
      action: "send.retried",
      outcome: "ok",
      actorUserId,
      subject: manifestId,
      detail: {
        // The proof, in the entry for the act it authorized. Without it the trail would record that somebody
        // retried a send and not what made that safe — which is the only interesting thing about the act.
        proof: offer.proof,
        from: row.state,
        mailboxId: row.mailbox_id,
        duplicatePossible: false,
      },
    },
    (entry) => [
      // The entry precedes the update it is gated on, which `AuditGate` requires: an update that cleared the
      // predicate first would leave the act done and unrecorded.
      entry,
      env.CATALOG.prepare(
        `UPDATE send_manifests SET state = 'held', state_at = ?, state_reason = NULL
          WHERE org_id = ? AND id = ? AND ${gate}`,
      ).bind(at, orgId, manifestId, ...PROVEN_STATES),
      // The recipients follow the manifest, as they do on every other transition in `dispatch.ts` — and here
      // it is load-bearing rather than cosmetic: `applyOutcome` mirrors its result onto recipients still
      // reading `held`, so a recipient left at `refused` would keep that state for ever while the send went
      // out. `submission_state != 'handed_over'` is what makes this safe: ADR 40's skip needs those rows
      // untouched, and it is the same clause `submitPerRecipient` relies on from the other end.
      env.CATALOG.prepare(
        `UPDATE send_recipients SET submission_state = 'held', submission_state_at = ?
          WHERE org_id = ? AND manifest_id = ? AND submission_state != 'handed_over'`,
      ).bind(at, orgId, manifestId),
    ],
    {
      sql: `SELECT 1 FROM send_manifests WHERE org_id = ? AND id = ? AND ${gate}`,
      params: [orgId, manifestId, ...PROVEN_STATES],
    },
  );

  if ((results[1]?.meta.changes ?? 0) === 0) {
    // Lost the race between the read and the commit. Nothing committed — the entry shares the transaction —
    // so this is the honest answer rather than a retry that half happened.
    throw conflict("E_RETRY_RACED", {
      what: `${manifestId} moved before the retry could be recorded`,
      why: "another dispatcher or the sweeper changed its state between the check and the write",
      fix: "read GET /api/sends again and decide against the state it is in now",
    });
  }

  const dispatch = await dispatchOne(env, ctx, orgId, manifestId, transport);
  return {
    mode: "retry-effect",
    manifestId,
    dispatch,
    detail: "The same message was handed to dispatch again under its original key, because this Node has a "
      + `recorded outcome proving it never left (${offer.proof}).`,
  };
}

/**
 * `resend-may-duplicate`: seal the same content again, under a **new** key, because nobody can prove the first
 * attempt did not arrive.
 *
 * ## Human-only, and the acknowledgement is a parameter rather than a confirmation dialog
 *
 * A dialog is somebody else's code. `acceptDuplicateRisk` is refused with the four parts when it is absent, so
 * every channel — API, CLI, SDK, MCP — has to carry the same sentence, and no caller can reach the risky act
 * by default. The reason is mandatory for the same reason `resumeButlerPause`'s is: this is the only human
 * judgement in the act, and a resend with an invented justification would be this Node writing down a decision
 * nobody made.
 *
 * ## What it re-asks, which is everything
 *
 * It calls `sealManifest`, so the send is re-decided by the **current** policy, the current breakers, the
 * current domain pause and the author's current authority, and it requests a fresh approval if a policy now
 * demands one. The original's approval is untouched and stays bound to the original manifest, which is ADR
 * 11's property falling out of the identifiers rather than a rule anybody enforces.
 *
 * ## The typed body, not the normalized one, and not the submitted bytes
 *
 * `sealManifest` normalizes what it is given, and handing it an already-normalized body would normalize twice
 * — harmless today and a silent content change the day the normalizer does more. The author's typed original
 * is the record of what was meant (§12 keeps both for exactly this reason), so it is what is re-sealed.
 *
 * ## It does not dispatch
 *
 * The new send enters the ordinary hold window and the sweeper takes it. Deliberate: this is the one act in
 * this Node that may produce a second copy of a message somebody has already read, so it is also the one that
 * most deserves the window in which `cancelSend` still works.
 */
export async function resendMayDuplicate(
  env: Env,
  ctx: Ctx,
  orgId: string,
  actor: { userId: string; acceptDuplicateRisk: boolean; reason: string },
  manifestId: string,
): Promise<RetryResult> {
  const row = await retryRow(env, orgId, manifestId);
  if (row === null) {
    throw notFound("E_NO_MANIFEST", {
      what: `${manifestId} is not a send in this organization`,
      why: "a resend acts on a recorded send; there is nothing here to act on",
      fix: "check the id against GET /api/sends",
    });
  }

  const offer = retryOffer(row);
  if (offer.mode !== "resend-may-duplicate") {
    throw conflict("E_RESEND_NOT_OFFERED", {
      what: `${manifestId} is ${row.state}, which is not the state this act exists for`,
      why: offer.mode === "retry-effect"
        ? `non-acceptance is proven here (${offer.proof}), so the safe act is available and this one would `
          + "mint a second effect key for an effect that provably never happened"
        : `this send has nothing to repeat: ${offer.why}`,
      fix: offer.mode === "retry-effect"
        ? "POST /api/sends/:id/retry with mode=retry-effect, which reuses the original key and cannot duplicate"
        : "compose a new message if one is owed",
    });
  }

  if (!actor.acceptDuplicateRisk) {
    throw unprocessable("E_DUPLICATE_RISK_NOT_ACCEPTED", {
      what: "this resend was requested without accepting that the recipient may receive two copies",
      why: "the first attempt's outcome is unknown: the transport may have taken the bytes and the "
        + "acknowledgement been lost, and Cloudflare offers no idempotency key to deduplicate against "
        + "(ADR 40). A second delivery cannot be recalled",
      fix: "send acceptDuplicateRisk: true, or use retry-effect where non-acceptance is proven",
    });
  }
  if (actor.reason.trim() === "") {
    throw unprocessable("E_RESEND_REASON_REQUIRED", {
      what: "this resend was requested with no reason",
      why: "it is the only human judgement in the act, and an entry with no reason records that somebody did "
        + "it without recording why — which is the one thing the audit trail is for here",
      fix: "send a reason saying why a possible duplicate is worth it",
    });
  }

  const body = new TextDecoder().decode(await getEvidence(env, row.body_typed_key));
  const sealed = await sealManifest(env, ctx, orgId, {
    mailboxId: row.mailbox_id,
    // The **original author**, not the person asking. `sealManifest` re-checks that the author may still send
    // as the mailbox (§7, live), which is the right question about a message that is theirs — including when
    // the author is a Butler. Whether the *requester* may act at all is the route's question, answered before
    // this function is reached, and the two are deliberately different checks.
    authorUserId: row.author_user_id,
    // Named rather than inferred, so a mailbox that has gained a second address since does not refuse this
    // with `E_SENDER_AMBIGUOUS` — and so the resend goes out as the address the original did rather than as
    // whichever one a later `ORDER BY created_at` would pick. That defect is #49's era and is not reintroduced
    // here by omission.
    senderAddress: row.envelope_from,
    inReplyToMessageId: row.in_reply_to_message_id ?? undefined,
    to: JSON.parse(row.envelope_to) as string[],
    cc: row.envelope_cc === null ? undefined : (JSON.parse(row.envelope_cc) as string[]),
    bcc: row.envelope_bcc === null ? undefined : (JSON.parse(row.envelope_bcc) as string[]),
    subject: row.subject,
    bodyTyped: body,
    fidelity: "authored",
    // **Not** `releaseRequired`, even when the original author is a Butler. That gate exists because no person
    // had seen the message; here a named person has just asked for it and accepted the consequence, which is
    // what the gate asks for. Requiring a second human to release a send a human just requested would be
    // ceremony, and #50's own argument against it is that a gate needing a person is above a gate needing time
    // precisely because the person is the point.
    resend: {
      ofManifestId: manifestId,
      requestedByUserId: actor.userId,
      reason: actor.reason.trim(),
    },
  });

  return {
    mode: "resend-may-duplicate",
    manifestId,
    sealedAs: sealed.id,
    detail: "A new send was sealed from the same content under a new idempotency key, and it enters the hold "
      + "window where it can still be cancelled. The recipient may receive two copies: the first attempt's "
      + "outcome is unknown and cannot be established.",
  };
}
