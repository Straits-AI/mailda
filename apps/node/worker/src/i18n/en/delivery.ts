import type { DeliveryReason, DeliveryState, SendReason, SendState } from "@mailda/contract/schemas";

/** A token's label, at the key itself, and its explanation at `.note`. */
type Said<K extends string> = K | `${K}.note`;

/**
 * Every key this area must have: a label and a note for each token of the contract's closed lists, plus the two
 * readings that are not on the wire (`never_submitted`, `unobserved`). A token added to the contract without
 * words, or words left here for a token nobody writes, is a compile error in this file.
 */
export type DeliveryKey =
  | Said<`send.state.${SendState | "never_submitted"}`>
  | Said<`send.reason.${SendReason}`>
  | Said<`delivery.state.${DeliveryState | "unobserved"}`>
  | Said<`delivery.reason.${DeliveryReason}`>;

/**
 * The sending vocabulary: what this Node did with a send (`send.state.*`), why a gate or a refusal stopped it
 * (`send.reason.*`), and what the receiving world did with each recipient (`delivery.*`). ADR 39's two scales
 * stay two sets of words: no state here says accepted, bounced or delivered, and no state says a send was sent. A
 * state's note may say it was not ("Not sent yet."): a negation claims no outcome, and the furthest this scale goes
 * is handed over (`docs/i18n.md`, beside D5). Two breaker reasons still say what this Node "sent" in the past
 * tense about earlier mail (`breaker_bounce_rate`, `breaker_complaint_rate`); "handed over" there is an English
 * change the owner has not taken.
 *
 * `src/client/delivery.client.js` decides which token a reader is shown; `src/client/app/delivery-words.ts`
 * looks the words up.
 *
 * - `accepted` is the word for `message.delivered` deliberately (`src/outbound/events.ts`): the receiving server
 *   returned a 250, which is what "accepted" means in mail and is strictly stronger than `handed_over`. What it
 *   must never be called is delivered *to a person*: nothing here knows whether a human saw it.
 * - `failed` and `rejected` keep their own words rather than collapsing into `bounced`, because telling somebody
 *   their recipient bounced when the mail service had an internal error is a false statement about somebody
 *   else's mail server.
 * - `never_submitted` is `outcome_unknown` read with one more column; its label is the state's own, and only the
 *   note says the stronger thing.
 * - Every reason's note names **who can act**, because a state a person cannot act on is a complaint.
 */
export const delivery = {
  "send.state.held": "held",
  "send.state.held.note": "Not sent yet. You can still stop this.",
  "send.state.awaiting": "awaiting",
  "send.state.awaiting.note":
    "Not sent. A policy gated this send, and it is waiting for somebody to clear the gate. Which gate is " +
    "in the reason beside it — a hold anybody who may send as this mailbox can release, or an approval " +
    "only an approver can give.",
  "send.state.cancelled": "cancelled",
  "send.state.cancelled.note": "Stopped before it left.",
  "send.state.withheld": "withheld",
  "send.state.withheld.note":
    "Not sent. This Node declined to hand it over, and the reason beside it says why — a policy denied it, " +
    "an approver denied it, or something it was approved on had changed by the time it was due to go. " +
    "Nobody cancelled it and the mail service was never asked.",
  "send.state.throttled": "throttled",
  "send.state.throttled.note": "Rate-limited by the mail service. It has not left, and will be retried.",
  "send.state.refused": "refused",
  "send.state.refused.note": "The mail service would not accept it. It never left.",
  "send.state.suppressed": "suppressed",
  "send.state.suppressed.note": "The mail service will never deliver to this recipient.",
  "send.state.handed_over": "handed over",
  /** D8 (`docs/i18n.md`): this said "Accepted by the mail service", which is the delivery scale's word. */
  "send.state.handed_over.note": "Taken by the mail service. Whether it arrived is not knowable from here.",
  "send.state.outcome_unknown": "outcome unknown",
  "send.state.outcome_unknown.note": "We do not know whether it left. It will not be retried automatically.",
  "send.state.never_submitted": "outcome unknown",
  "send.state.never_submitted.note":
    "It never left. This Node stores the submitted bytes before asking the mail service, and there are " +
    "none — so the attempt failed before the mail service was contacted. Nothing was sent, and no " +
    "duplicate can result from sending it again.",

  "send.reason.policy_hold": "policy hold",
  "send.reason.policy_hold.note":
    "A policy holds this send. It has not left. Anybody who may send as this mailbox can release it — no " +
    "approver is needed, which is what makes a hold the lesser of the two gates.",
  "send.reason.policy_approval_required": "approval required",
  "send.reason.policy_approval_required.note":
    "A policy requires this send to be approved. It has not left. Only somebody holding approval.decide " +
    "on this mailbox can approve it, which is why this is the stricter gate.",
  "send.reason.policy_denied": "policy denied",
  "send.reason.policy_denied.note":
    "A policy denied this send. This Node declined to hand it over; nobody cancelled it and the mail " +
    "service was never asked. There is no act that clears a denial — compose again, or change the policy.",
  "send.reason.authority_lost": "authority lost",
  "send.reason.authority_lost.note":
    "The author's authority to send as this mailbox was withdrawn before hand-over, so this Node declined " +
    "to hand it over. Whoever revoked it can grant send.propose again, and the message has to be " +
    "composed again — a sealed send is never edited.",
  "send.reason.approval_revoked": "approval revoked",
  "send.reason.approval_revoked.note":
    "The approval this send was released on no longer stands: it is not recorded as approved any more, or " +
    "somebody's approval was taken back. No path in this Node produces that after an approval completes, " +
    "so an administrator should look at how the record changed. Compose again to get a fresh approval.",
  "send.reason.approver_ineligible": "approver no longer eligible",
  "send.reason.approver_ineligible.note":
    "Somebody whose approval released this send no longer holds approval.decide on this mailbox, so this " +
    "Node will not act on their approval. Separation of duty is evaluated live, not trusted from when the " +
    "decision was taken. Grant the relation again, or compose again so eligible approvers can decide it.",
  "send.reason.policy_stricter": "policy is stricter now",
  "send.reason.policy_stricter.note":
    "Policy changed between the approval and the hand-over, and it is stricter than what this send was " +
    "approved under — so it fails closed rather than going out under a rule that no longer applies. " +
    "Compose again and it will be judged, and approved if needed, under the policy in force now.",
  "send.reason.approval_expired": "approval expired",
  "send.reason.approval_expired.note":
    "The approval for this send passed its deadline before it was handed over. That is final: an approval " +
    "is bound to these exact bytes, and one that could be revived indefinitely would be a standing " +
    "permission rather than a decision. Compose again and the new message gets its own approval.",
  "send.reason.evidence_changed": "evidence changed",
  "send.reason.evidence_changed.note":
    "The stored body of this send no longer matches the hash its own record holds, so this Node refused to " +
    "send bytes it cannot vouch for. This one is not a decision anybody took — it means the archive " +
    "disagrees with its own record, which is corruption or tampering. It is in the operational log and " +
    "mailda doctor reports it; do not compose again until somebody has looked at it.",
  "send.reason.approval_denied": "approval denied",
  "send.reason.approval_denied.note":
    "An approver denied this send. This Node declined to hand it over; nobody cancelled it and the mail " +
    "service was never asked. A denial is final — there is no act that reverses one, because approval is " +
    "bound to these exact bytes. Compose again and the new message gets its own approval.",
  "send.reason.breaker_volume": "too much, too fast",
  "send.reason.breaker_volume.note":
    "This Node has handed over more mail in the last hour than its own volume breaker allows, so this one " +
    "is waiting. It has not left and it is not lost: nothing has to be cleared by anybody, and it goes on " +
    "its own once the oldest sends fall out of the hour. The exact limit, what this Node is at, and how " +
    "long until it clears are in the message on the send itself.",
  "send.reason.breaker_bounce_rate": "too many addresses refused",
  "send.reason.breaker_bounce_rate.note":
    "Too many of the addresses this Node recently sent to are being refused by their own mail servers, so " +
    "it stopped sending rather than making the reputation worse. This one has not left and is not lost — " +
    "it goes once enough of those refusals age out of the window. Nobody has to clear it, but somebody " +
    "should look at the recipient list: the outbox shows which addresses bounced and what their servers " +
    "said.",
  "send.reason.breaker_complaint_rate": "too many spam reports",
  "send.reason.breaker_complaint_rate.note":
    "Too many recipients marked this Node's recent mail as spam, so it stopped sending. This one has not " +
    "left and is not lost — it goes once enough of those reports age out of the window. Nobody has to " +
    "clear it, and nobody should raise the limit without finding out what was sent: a complaint is a " +
    "person saying they did not want this.",
  "send.reason.domain_paused": "domain paused",
  "send.reason.domain_paused.note":
    "Two administrators stopped every send from this domain, and the reason they gave is on the message. " +
    "This Node declined to hand it over; nobody cancelled it and the mail service was never asked. Any " +
    "one administrator can restart the domain on their own — the harm of a wrongly paused domain grows " +
    "every minute — and after that the message has to be composed again, because a sealed send is never " +
    "edited.",
  "send.reason.approval_unsatisfiable": "approval impossible",
  "send.reason.approval_unsatisfiable.note":
    "A policy required an approval that nobody can give: too few people hold approval.decide on this " +
    "mailbox for the stages the policy asks for, and the author of a send is never eligible to approve it. " +
    "This is not waiting for somebody — nobody can clear it. An administrator has to grant approval.decide " +
    "to enough distinct people, and then the message has to be composed again.",
  "send.reason.butler_release_required": "waiting for a person",
  "send.reason.butler_release_required.note":
    "A Butler wrote this send and no person has seen it yet, so this Node will not hand it over. It has " +
    "not left and it is not lost. Anybody who may send as this mailbox can release it — the same authority " +
    "that composed it would have needed — and releasing it puts it back in the ordinary hold window, where " +
    "it can still be cancelled. Nothing releases it on its own: a Butler is a program, and the whole point " +
    "of this gate is that a program does not get to decide that a person agreed.",

  "delivery.state.accepted": "accepted",
  "delivery.state.accepted.note":
    "The receiving mail server accepted this message and returned a 250. That is not the same as a " +
    "person having read it — nothing here can know that.",
  "delivery.state.bounced": "bounced",
  "delivery.state.bounced.note":
    "The receiving server refused it. A hard bounce means the address is wrong; a soft one means " +
    "temporary failures ran out of retries.",
  "delivery.state.deferred": "deferred",
  "delivery.state.deferred.note":
    "A temporary failure, and the mail service is still retrying. The outcome is genuinely not known yet.",
  "delivery.state.failed": "failed",
  "delivery.state.failed.note":
    "The mail service hit an internal error rather than a refusal from the recipient. This is not a " +
    "bounce and says nothing about the address.",
  "delivery.state.rejected": "rejected",
  "delivery.state.rejected.note": "Refused before delivery was attempted.",
  "delivery.state.unobserved": "unobserved",
  "delivery.state.unobserved.note":
    "Nothing has been reported about this recipient yet. This Node will not guess: no news is not " +
    "good news, and it is not bad news either.",

  "delivery.reason.verified_destination": "verified destination",
  "delivery.reason.verified_destination.note":
    "No outcome is reported for verified destinations. A read of this Node's Cloudflare account showed this " +
    "address as a verified Email Routing destination, verified before this message was handed over, and Cloudflare " +
    "published no delivery event for mail to a verified destination in the one case measured. So nothing is " +
    "expected here. The silence is not a fault in this Node, and it says nothing about whether this message " +
    "arrived. An address removed from the account's list after the latest read still shows this until the " +
    "list is read again.",
} as const satisfies Record<DeliveryKey, string>;
