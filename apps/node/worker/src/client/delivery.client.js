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
