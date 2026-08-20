/**
 * What the receiving world did with one recipient — the words, and the decision about which of them a
 * reader is shown.
 *
 * ## Why this is its own module
 *
 * It was inside `app.client.js`, where nothing could reach it. That file touches `document` and calls
 * `start()` at module scope, so no test can import it, and the outbox's most load-bearing honesty rule
 * lived in the one file in this repository with no coverage at all.
 *
 * It cost something real. The summary beside a send's state was suppressed whenever the recipients
 * agreed — sound reasoning for the case anyone pictures, and wrong for the case that matters: a send
 * whose *every* recipient bounced is unanimous, so the row showed `handed over` in green and nothing
 * else. Three recipients, none reached, rendered identically to a send that arrived. Single-recipient
 * sends — most mail — were worse: a `length < 2` guard meant one bounced recipient produced no chip at
 * all. The per-recipient table underneath carried the truth the whole time.
 *
 * So the rule moved somewhere it can be tested. This module is deliberately **DOM-free**: it decides
 * *what* to say and returns plain data, and `app.client.js` decides how to draw it. `test/node/
 * delivery-summary.test.ts` evaluates the same bytes this file is served as, so what is tested and what
 * a browser runs cannot drift.
 */

/**
 * Delivery state to the word this Node shows a person.
 *
 * `delivered` becomes **accepted** deliberately: the receiving server returned a 250, which is what
 * "accepted" means in mail and is strictly stronger than `handed_over`. What it must never be called is
 * delivered *to a person* — nothing here knows whether a human saw it.
 *
 * `failed` and `rejected` keep their own words rather than collapsing into `bounced`, because telling
 * someone their recipient bounced when the mail service had an internal error is a false statement about
 * somebody else's mail server.
 */
export const DELIVERY_STATES = {
  accepted: {
    label: "accepted",
    note: "The receiving mail server accepted this message and returned a 250. That is not the same as a " +
      "person having read it — nothing here can know that.",
  },
  bounced: {
    label: "bounced",
    note: "The receiving server refused it. A hard bounce means the address is wrong; a soft one means " +
      "temporary failures ran out of retries.",
  },
  deferred: {
    label: "deferred",
    note: "A temporary failure, and the mail service is still retrying. The outcome is genuinely not " +
      "known yet.",
  },
  failed: {
    label: "failed",
    note: "The mail service hit an internal error rather than a refusal from the recipient. This is not a " +
      "bounce and says nothing about the address.",
  },
  rejected: {
    label: "rejected",
    note: "Refused before delivery was attempted.",
  },
};

/**
 * `null` is a state, not a gap. "Unobserved" is what a Node honestly knows between hand-over and an event
 * arriving, and it must not be dressed up as pending, in-progress, or fine.
 */
export const UNOBSERVED = {
  label: "unobserved",
  note: "Nothing has been reported about this recipient yet. This Node will not guess: no news is not " +
    "good news, and it is not bad news either.",
};

/**
 * Envelope order, which is not alphabetical order.
 *
 * `ORDER BY kind` in SQL sorts **bcc, cc, to** — so a reader met the blind copy before the actual
 * addressee, and the summary inherited that order too. The API now sorts explicitly, and this exists as
 * well because the order a person reads recipients in is a presentation decision: a display that depends
 * on a server's `ORDER BY` for its meaning is one query change away from being wrong, and this one can be
 * tested where the SQL cannot.
 *
 * A kind this client does not know sorts last rather than being dropped.
 */
const KIND_ORDER = ["to", "cc", "bcc"];

export function orderRecipients(recipients) {
  if (!Array.isArray(recipients)) return [];
  const rank = (kind) => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };
  return [...recipients].sort((a, b) =>
    rank(a.kind) - rank(b.kind) || String(a.address ?? "").localeCompare(String(b.address ?? "")));
}

/**
 * Worst first, because the outcome a reader's eye lands on first should be the one that needs them.
 *
 * A state absent from this list sorts ahead of everything. An outcome this client does not recognise is
 * exactly what a person should look at, and filing it under "probably fine" would be the same mistake
 * this ordering exists to correct.
 */
export const DELIVERY_SEVERITY = ["bounced", "failed", "rejected", "deferred", "unobserved", "accepted"];

export function severityRank(state) {
  const rank = DELIVERY_SEVERITY.indexOf(state);
  return rank === -1 ? -1 : rank;
}

/**
 * The observed delivery outcomes of one send, worst first, as `{ state, count, label, note }`.
 *
 * Returns an empty array in exactly one case: **nothing has been observed about any recipient.** Then the
 * submission state is the whole of what this Node knows and an "unobserved" chip beside it would add no
 * fact — the detail row says it in words instead.
 *
 * It does *not* return empty for a unanimous outcome. Unanimity is collapsed to one entry, never
 * suppressed, because "they all agree" and "they all bounced" are the same shape.
 */
export function summariseDelivery(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) return [];

  const counts = new Map();
  for (const recipient of recipients) {
    const state = recipient.delivery_state ?? "unobserved";
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  if (counts.size === 1 && counts.has("unobserved")) return [];

  return [...counts.entries()]
    .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
    .map(([state, count]) => {
      const meta = state === "unobserved" ? UNOBSERVED : (DELIVERY_STATES[state] ?? { label: state, note: "" });
      return { state, count, label: meta.label, note: meta.note };
    });
}

/**
 * The manifest's own state, and the one case where this Node knows more than the state name admits.
 *
 * ## Why the words moved here from the React screen
 *
 * They were a literal map inside `ledgers.tsx`, keyed on `state` alone. That is fine for every state but
 * one. `outcome_unknown` read "We do not know whether it left" **unconditionally**, and there is a
 * combination in which the Node can prove it did not:
 *
 *     state = outcome_unknown  AND  fidelity = authored  AND  submitted_key IS NULL
 *
 * On the authored path `dispatch.ts` stores the submitted bytes and sets `submitted_key` **before** calling
 * `transport.submit`. So a terminal authored send with no submitted key never reached the transport — the
 * bytes were never handed anywhere. Saying "we do not know" there is weaker than the evidence, and Layer 2's
 * proof line is that these words are never blurred.
 *
 * The `authored` guard is load-bearing rather than decorative: on the reconstructed path `submitted_key` is
 * never written at all, so its being NULL says nothing. ADR 33 routes all customer mail through `authored`,
 * so the distinction covers the path that matters and stays silent on the one it cannot speak about.
 *
 * ## Why here rather than on the server
 *
 * The same three fields already decide whether the outbox offers the `.eml` link, so a server-side flag
 * would be a second derivation that has to agree with that one. And this module exists precisely because
 * the rule deciding what a reader is shown belongs somewhere a test can reach — the outbox's previous
 * honesty defect lived in the one file with no coverage.
 */
export const SEND_STATES = {
  held: { label: "held", note: "Not sent yet. You can still stop this." },
  awaiting: {
    label: "awaiting",
    note:
      "Not sent. A policy gated this send, and it is waiting for somebody to clear the gate. Which gate is " +
      "in the reason beside it — a hold anybody who may send as this mailbox can release, or an approval " +
      "only an approver can give.",
  },
  cancelled: { label: "cancelled", note: "Stopped before it left." },
  withheld: {
    label: "withheld",
    note:
      "Not sent. This Node declined to hand it over, and the reason beside it says why — a policy denied it, " +
      "an approver denied it, or something it was approved on had changed by the time it was due to go. " +
      "Nobody cancelled it and the mail service was never asked.",
  },
  throttled: { label: "throttled", note: "Rate-limited by the mail service. It has not left, and will be retried." },
  refused: { label: "refused", note: "The mail service would not accept it. It never left." },
  suppressed: { label: "suppressed", note: "The mail service will never deliver to this recipient." },
  handed_over: {
    label: "handed over",
    note: "Accepted by the mail service. Whether it arrived is not knowable from here.",
  },
  outcome_unknown: {
    label: "outcome unknown",
    note: "We do not know whether it left. It will not be retried automatically.",
  },
};

/**
 * The stronger statement available when the bytes provably never reached the transport.
 *
 * Deliberately a separate entry rather than a rewrite of `outcome_unknown`: the state in the database really
 * is `outcome_unknown`, and this is a *reading* of it plus one more column. Anything comparing the label to
 * the stored state should still find them consistent, which is why the label keeps the state's name and the
 * note carries the extra knowledge.
 */
export const NEVER_SUBMITTED = {
  label: "outcome unknown",
  note:
    "It never left. This Node stores the submitted bytes before asking the mail service, and there are " +
    "none — so the attempt failed before the mail service was contacted. Nothing was sent, and no " +
    "duplicate can result from sending it again.",
};

/**
 * Why a send is `awaiting` or `withheld`, in words, keyed on `state_reason` (#60, #62).
 *
 * ## Why the reasons are here and not beside the code that writes them
 *
 * `src/policy.ts`, `src/approvals.ts`, `src/breakers.ts` and `src/outbound/recheck.ts` mint the tokens; this
 * module owns the sentences. One place for the prose, because two copies of the same claim means the authoritative one is
 * whichever file the reader opened — and because this is the module a test can evaluate as the exact bytes a
 * browser is served. The same argument that moved `SEND_STATES` here in the first place.
 *
 * The correspondence is enforced in both directions: every token those modules declare must have an entry
 * here, and every entry here must be a token one of them declares. A one-way check would have let a sentence
 * for a renamed reason sit here for ever, reading as the explanation for something nothing writes.
 *
 * ## Why a reason at all, rather than more states
 *
 * `awaiting` a hold and `awaiting` an approval are the same state with different answers to *"who can clear
 * this"*, and #62 settled that the machine's two halves stay symmetric — gates are `awaiting` plus a reason,
 * refusals are `withheld` plus a reason. Five new states would have made §5C's distinctness a property of
 * the state machine rather than of the explanation, and two conventions in one state machine is what later
 * reads as an accident.
 *
 * Every sentence names **who can act**, because a state a person cannot act on is a complaint.
 *
 * #66's four are where that rule earns its keep, because three of them have a genuinely unusual answer:
 * **nobody**. A rate breaker clears because failures age out of a window, so the honest sentence is *"nothing
 * has to be cleared by anybody, and it goes on its own"* — and it says so rather than leaving a reader
 * hunting for the person who has to press something. The fourth, `domain_paused`, has the opposite shape: two
 * people stopped it and **one** can restart it, which is the asymmetry #66 chose and which a reader has to be
 * told, because the intuitive reading of a two-person act is that it takes two to undo.
 */
export const SEND_REASONS = {
  policy_hold: {
    label: "policy hold",
    note:
      "A policy holds this send. It has not left. Anybody who may send as this mailbox can release it — no " +
      "approver is needed, which is what makes a hold the lesser of the two gates.",
  },
  policy_approval_required: {
    label: "approval required",
    note:
      "A policy requires this send to be approved. It has not left. Only somebody holding approval.decide " +
      "on this mailbox can approve it, which is why this is the stricter gate.",
  },
  policy_denied: {
    label: "policy denied",
    note:
      "A policy denied this send. This Node declined to hand it over; nobody cancelled it and the mail " +
      "service was never asked. There is no act that clears a denial — compose again, or change the policy.",
  },
  authority_lost: {
    label: "authority lost",
    note:
      "The author's authority to send as this mailbox was withdrawn before hand-over, so this Node declined " +
      "to hand it over. Whoever revoked it can grant send.propose again, and the message has to be " +
      "composed again — a sealed send is never edited.",
  },
  approval_revoked: {
    label: "approval revoked",
    note:
      "The approval this send was released on no longer stands: it is not recorded as approved any more, or " +
      "somebody's approval was taken back. No path in this Node produces that after an approval completes, " +
      "so an administrator should look at how the record changed. Compose again to get a fresh approval.",
  },
  approver_ineligible: {
    label: "approver no longer eligible",
    note:
      "Somebody whose approval released this send no longer holds approval.decide on this mailbox, so this " +
      "Node will not act on their approval. Separation of duty is evaluated live, not trusted from when the " +
      "decision was taken. Grant the relation again, or compose again so eligible approvers can decide it.",
  },
  policy_stricter: {
    label: "policy is stricter now",
    note:
      "Policy changed between the approval and the hand-over, and it is stricter than what this send was " +
      "approved under — so it fails closed rather than going out under a rule that no longer applies. " +
      "Compose again and it will be judged, and approved if needed, under the policy in force now.",
  },
  approval_expired: {
    label: "approval expired",
    note:
      "The approval for this send passed its deadline before it was handed over. That is final: an approval " +
      "is bound to these exact bytes, and one that could be revived indefinitely would be a standing " +
      "permission rather than a decision. Compose again and the new message gets its own approval.",
  },
  evidence_changed: {
    label: "evidence changed",
    note:
      "The stored body of this send no longer matches the hash its own record holds, so this Node refused to " +
      "send bytes it cannot vouch for. This one is not a decision anybody took — it means the archive " +
      "disagrees with its own record, which is corruption or tampering. It is in the operational log and " +
      "mailda doctor reports it; do not compose again until somebody has looked at it.",
  },
  approval_denied: {
    label: "approval denied",
    note:
      "An approver denied this send. This Node declined to hand it over; nobody cancelled it and the mail " +
      "service was never asked. A denial is final — there is no act that reverses one, because approval is " +
      "bound to these exact bytes. Compose again and the new message gets its own approval.",
  },
  breaker_volume: {
    label: "too much, too fast",
    note:
      "This Node has handed over more mail in the last hour than its own volume breaker allows, so this one " +
      "is waiting. It has not left and it is not lost: nothing has to be cleared by anybody, and it goes on " +
      "its own once the oldest sends fall out of the hour. The exact limit, what this Node is at, and how " +
      "long until it clears are in the message on the send itself.",
  },
  breaker_bounce_rate: {
    label: "too many addresses refused",
    note:
      "Too many of the addresses this Node recently sent to are being refused by their own mail servers, so " +
      "it stopped sending rather than making the reputation worse. This one has not left and is not lost — " +
      "it goes once enough of those refusals age out of the window. Nobody has to clear it, but somebody " +
      "should look at the recipient list: the outbox shows which addresses bounced and what their servers " +
      "said.",
  },
  breaker_complaint_rate: {
    label: "too many spam reports",
    note:
      "Too many recipients marked this Node's recent mail as spam, so it stopped sending. This one has not " +
      "left and is not lost — it goes once enough of those reports age out of the window. Nobody has to " +
      "clear it, and nobody should raise the limit without finding out what was sent: a complaint is a " +
      "person saying they did not want this.",
  },
  domain_paused: {
    label: "domain paused",
    note:
      "Two administrators stopped every send from this domain, and the reason they gave is on the message. " +
      "This Node declined to hand it over; nobody cancelled it and the mail service was never asked. Any " +
      "one administrator can restart the domain on their own — the harm of a wrongly paused domain grows " +
      "every minute — and after that the message has to be composed again, because a sealed send is never " +
      "edited.",
  },
  approval_unsatisfiable: {
    label: "approval impossible",
    note:
      "A policy required an approval that nobody can give: too few people hold approval.decide on this " +
      "mailbox for the stages the policy asks for, and the author of a send is never eligible to approve it. " +
      "This is not waiting for somebody — nobody can clear it. An administrator has to grant approval.decide " +
      "to enough distinct people, and then the message has to be composed again.",
  },
  butler_release_required: {
    label: "waiting for a person",
    note:
      "A Butler wrote this send and no person has seen it yet, so this Node will not hand it over. It has " +
      "not left and it is not lost. Anybody who may send as this mailbox can release it — the same authority " +
      "that composed it would have needed — and releasing it puts it back in the ordinary hold window, where " +
      "it can still be cancelled. Nothing releases it on its own: a Butler is a program, and the whole point " +
      "of this gate is that a program does not get to decide that a person agreed.",
  },
};

/**
 * The words for a reason, or `null` when the row carries none.
 *
 * An unrecognised reason returns the raw token as its label rather than nothing, for the same reason
 * `describeSend` falls back on the raw state: showing somebody `approval_revoked` is poor, and showing them a
 * blank where a reason exists is worse. The fallback is a floor, not a plan — the closed-world test over the
 * token lists is what keeps it unreachable.
 */
export function describeReason(send) {
  const reason = send?.state_reason;
  if (reason === null || reason === undefined || reason === "") return null;
  return SEND_REASONS[reason] ?? { label: String(reason), note: "" };
}

/**
 * What to tell a reader about one send, given the row.
 *
 * Takes the row rather than a state string, because the honest answer needs three of its fields. Returns the
 * same shape as `DELIVERY_STATES` so a caller renders both identically.
 */
export function describeSend(send) {
  const base = SEND_STATES[send?.state] ?? { label: String(send?.state ?? "unknown"), note: "" };
  const neverSubmitted = send?.state === "outcome_unknown"
    && send?.fidelity === "authored"
    // Served as 0/1 by D1's `submitted_key IS NOT NULL AS has_submitted`, so both forms are accepted
    // rather than assuming one — a boolean here and an integer there is how a truthiness bug arrives.
    && (send?.has_submitted === 0 || send?.has_submitted === false);
  return neverSubmitted ? NEVER_SUBMITTED : base;
}
