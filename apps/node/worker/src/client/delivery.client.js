/**
 * What this Node did with a send and what the receiving world did with each recipient: the decision about which
 * state, reason and reading a reader is shown.
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
 * *what* to say and returns plain data, and the shell (`ledgers.tsx`) decides how to draw it. `test/node/
 * delivery-summary.test.ts` evaluates the same bytes this file is served as, so what is tested and what
 * a browser runs cannot drift.
 *
 * ## What it returns: tokens, never words (ADR 46)
 *
 * It decides *which* state, reason and reading a reader is shown, and returns the token for it. The words for
 * every token are in the catalog (`src/i18n/en/delivery.ts` and its twins), keyed by the contract's closed lists
 * (`SEND_STATES`, `SEND_REASONS`, `DELIVERY_STATES`, `DELIVERY_REASONS`), and the shell looks them up
 * (`src/client/app/delivery-words.ts`). A token this client does not know, from a newer Node, is returned as it
 * came and shown raw: a word nobody wrote is worse than the Node's own token.
 *
 * Two tokens here are not on the wire. `unobserved` is what a recipient with no `delivery_state` is, and it
 * is a state, not a gap: what a Node honestly knows between hand-over and an event arriving, never dressed up
 * as pending or fine. `never_submitted` is the stronger reading of `outcome_unknown` (see `describeSend`).
 *
 * The types below are JSDoc and nothing else: the module imports nothing at run time. They say which strings
 * here are tokens of the contract's lists, for a reader and for the untranslated-text scan alike, and they are
 * closed: a sentence written where a token goes is a finding. A token from a newer Node passes through as
 * `String(value)`, which carries no literal, and is shown raw.
 *
 * @typedef {import("@mailda/contract/schemas").DeliveryState | import("@mailda/contract/schemas").DeliveryReason
 *   | "unobserved"} DeliveryToken
 * @typedef {import("@mailda/contract/schemas").SendState | "never_submitted"} SendToken
 */

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
/** @type {readonly import("@mailda/contract/schemas").RecipientKind[]} */
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
 * One recipient's tokens: the delivery state (`unobserved` when none is set), and the `delivery_reason` beside
 * it when there is one (28 September 2026). A reason explains silence and is never a delivery state:
 * `delivery_state` is set only by events, and an observed outcome wins, so the reason is dropped once a state
 * is set.
 */
/** @returns {{ state: DeliveryToken, reason: string | null }} */
export function describeRecipient(recipient) {
  const state = recipient?.delivery_state;
  if (state !== null && state !== undefined) return { state: String(state), reason: null };
  const reason = recipient?.delivery_reason;
  const none = reason === null || reason === undefined || reason === "";
  return { state: "unobserved", reason: none ? null : String(reason) };
}

/**
 * Worst first, because the outcome a reader's eye lands on first should be the one that needs them.
 *
 * A state absent from this list sorts ahead of everything. An outcome this client does not recognise is
 * exactly what a person should look at, and filing it under "probably fine" would be the same mistake
 * this ordering exists to correct.
 *
 * `verified_destination` is a reason, not a state, and ranks below `unobserved` because nothing waits on it:
 * no answer is coming and no action follows.
 */
/** @type {DeliveryToken[]} */
export const DELIVERY_SEVERITY = ["bounced", "failed", "rejected", "deferred", "unobserved", "verified_destination", "accepted"];

export function severityRank(state) {
  const rank = DELIVERY_SEVERITY.indexOf(state);
  return rank === -1 ? -1 : rank;
}

/**
 * The observed delivery outcomes of one send, worst first, as `{ state, count }`. `state` is a delivery state,
 * `unobserved`, or a reason token (`DELIVERY_REASONS`) for a recipient that has none.
 *
 * Returns an empty array in exactly one case: **nothing has been observed about any recipient, and none
 * carries a reason.** Then the submission state is the whole of what this Node knows and an "unobserved"
 * chip beside it would add no fact — the detail row says it in words instead. A send whose every recipient
 * is a verified destination does get its chip, because that adds one: nothing is coming, so do not wait.
 *
 * It does *not* return empty for a unanimous outcome. Unanimity is collapsed to one entry, never
 * suppressed, because "they all agree" and "they all bounced" are the same shape.
 */
export function summariseDelivery(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) return [];

  /** @type {Map<DeliveryToken, number>} */
  const counts = new Map();
  for (const recipient of recipients) {
    /** @type {DeliveryToken} */
    const state = recipient.delivery_state ?? (recipient.delivery_reason || "unobserved");
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  if (counts.size === 1 && counts.has("unobserved")) return [];

  return [...counts.entries()]
    .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
    .map(([state, count]) => ({ state, count }));
}

/**
 * The manifest's own state, and the one case where this Node knows more than the state name admits.
 *
 * ## Why this decision lives here and not in the React screen
 *
 * The words were a literal map inside `ledgers.tsx`, keyed on `state` alone. That is fine for every state but
 * one. `outcome_unknown` read "We do not know whether it left" **unconditionally**, and there is a
 * combination in which the Node can prove it did not:
 *
 *     state = outcome_unknown  AND  fidelity = authored  AND  submitted_key IS NULL
 *
 * On the authored path `dispatch.ts` stores the submitted bytes and sets `submitted_key` **before** calling
 * `transport.submit`. So a terminal authored send with no submitted key never reached the transport — the
 * bytes were never handed anywhere. Saying "we do not know" there is weaker than the evidence, and Layer 2's
 * proof line is that these words are never blurred. That reading is the token `never_submitted`, whose label
 * in every locale is the `outcome_unknown` label (the glossary binds both keys to one row), because the state
 * in the database really is `outcome_unknown`; only the note carries the extra knowledge.
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
 *
 * Returns the state token, `never_submitted`, or the raw state for one this client does not know.
 */
/** @returns {SendToken} */
export function describeSend(send) {
  const neverSubmitted = send?.state === "outcome_unknown"
    && send?.fidelity === "authored"
    // Served as 0/1 by D1's `submitted_key IS NOT NULL AS has_submitted`, so both forms are accepted
    // rather than assuming one — a boolean here and an integer there is how a truthiness bug arrives.
    && (send?.has_submitted === 0 || send?.has_submitted === false);
  // A row with no state breaks the contract (`state` is `min(1)`); it is shown as it came, raw, not given a word.
  return neverSubmitted ? "never_submitted" : String(send?.state);
}

/**
 * Why a send is `awaiting` or `withheld` (#60, #62): its `state_reason` token, or `null` when the row carries
 * none, which is the ordinary case for `held`. The words for every reason are the catalog's `send.reason.*`,
 * and each names **who can act**, because a state a person cannot act on is a complaint.
 */
export function describeReason(send) {
  const reason = send?.state_reason;
  return reason === null || reason === undefined || reason === "" ? null : String(reason);
}
