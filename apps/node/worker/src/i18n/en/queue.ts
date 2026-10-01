import type { QuarantineReason } from "@mailda/contract/schemas";

import type { Area } from "../areas.ts";

/**
 * The shared Queue (`src/client/app/screens/queue.tsx`): cases, their clocks and the acts on them, and the
 * mailbox's quarantine switches and held deliveries.
 *
 * Two English words name two concepts each here, and the keys keep them apart so a translation can too:
 * **Release** gives a case back to the queue (`queue.act.release`) or lets a held delivery in
 * (`queue.held.release`); **held** is a case a colleague holds (`queue.state.held`) or a delivery held back
 * for an administrator (`queue.held.*`).
 *
 * Durations are compact on purpose (read at a glance) and are plurals keyed by their leading unit, so a locale
 * whose units inflect can say so. English does not inflect `m`, `h` or `d`, so both branches are the same.
 */
export const queue = {
  "queue.handTo.open": "Hand to…",
  "queue.handTo.placeholder": "colleague@…",
  "queue.handTo.label": "Colleague's sign-in address",
  "queue.handTo.submit": "Hand over",

  "queue.duration.underMinute": "under a minute",
  "queue.duration.minutes": { one: "{n}m", other: "{n}m" },
  "queue.duration.hours": { one: "{n}h {m}m", other: "{n}h {m}m" },
  "queue.duration.days": { one: "{n}d {h}h", other: "{n}d {h}h" },
  "queue.age.justNow": "just now",

  "queue.clock.answered": "answered",
  "queue.clock.targetPassed": "Target passed at {at}",
  "queue.clock.overdue": "overdue {age}",
  "queue.clock.overdueJustNow": "overdue just now",
  "queue.clock.dueNow": "due now",
  "queue.clock.dueIn": "in {until}",

  "queue.restricted": "restricted",
  "queue.restricted.subject":
    "You hold send.propose on this mailbox but neither read relation, so the subject is withheld. An administrator grants mailbox.metadata.read.",
  "queue.restricted.sender":
    "You hold send.propose on this mailbox but neither read relation, so the sender is withheld. An administrator grants mailbox.metadata.read.",

  "queue.state.unclaimed": "unclaimed",
  "queue.state.mine": "mine",
  "queue.state.held": "held",
  "queue.pick": "Pick {subject} for merging",
  "queue.pick.noSubject": "Pick this case for merging",
  "queue.noSubject": "(no subject)",
  // Shown only when a case has more than one message, so `one` is never rendered; it is here for the grammar.
  "queue.case.messages": { one: "{n} message", other: "{n} messages" },
  "queue.holder.you": "you",

  "queue.act.claim": "Claim",
  "queue.act.release": "Release",
  "queue.act.close": "Close",
  "queue.act.take": "Take",

  "queue.merged": { one: "Merged. {n} message moved.", other: "Merged. {n} messages moved." },
  "queue.target.cleared": "This mailbox now promises nothing, so its cases carry no clock.",
  "queue.target.set": {
    one: "First response promised within {n} minute. Clocks start on the next message.",
    other: "First response promised within {n} minutes. Clocks start on the next message.",
  },
  "queue.target.none": "This mailbox promises no response time, so no case here carries a clock.",
  "queue.target.promised": { one: "First response promised within {n} minute.", other: "First response promised within {n} minutes." },
  "queue.target.minutes": "Minutes",
  "queue.target.label": "First response target in minutes; empty promises nothing",
  "queue.overdue": { one: "{n} overdue", other: "{n} overdue" },

  "queue.quarantine.dmarc.on":
    "From now on, a delivery whose sender's domain disowns it (DMARC fail, p=reject or p=quarantine) is held back here for an administrator.",
  "queue.quarantine.attachments.on":
    "From now on, a delivery carrying an executable, a script, or a program under a document's name is held back here for an administrator.",
  "queue.quarantine.off": "That is off. Deliveries already held stay held until released.",
  "queue.quarantine.dmarc.label": "Hold back deliveries whose sender's domain disowns them",
  "queue.quarantine.dmarc.text": "Hold back a delivery its sender's domain disowns (DMARC fail, p=reject or p=quarantine).",
  "queue.quarantine.attachments.label": "Hold back deliveries carrying a dangerous attachment",
  "queue.quarantine.attachments.text": "Hold back a delivery carrying an executable, a script, or a program under a document's name.",
  "queue.limits.saved": "Attachment limits saved. They apply to the next message in and the next send out.",
  "queue.limits.maxSize": "Largest attachment, in KB",
  "queue.limits.noLimit": "no limit",
  "queue.limits.types": "Allowed attachment types",
  "queue.limits.typesPlaceholder": "any — or pdf, docx, png",

  "queue.released": "Released. It is in the queue now, with the case it would have had.",
  "queue.handedTo": "Handed to {email}. It is in their queue now, and the trail names you both.",

  "queue.mailbox": "Mailbox",
  "queue.mailbox.option": { one: "{name} ({n} unclaimed)", other: "{name} ({n} unclaimed)" },
  "queue.noMailbox": "You cannot work any mailbox on this Node yet. An administrator grants send.propose on one.",

  "queue.held.count": { one: "{n} held", other: "{n} held" },
  "queue.held.noun": "held deliveries across this Node",
  "queue.held.table": "Held back",
  "queue.held.col.at": "Held",
  "queue.held.col.why": "Why",
  "queue.held.release": "Release",
  "queue.held.reason.held": "Held on request: {note}",
  "queue.held.noReason": "Held on request: no reason given",
  "queue.held.reason.attachment_too_large": "Carries an attachment over this mailbox's size limit.",
  "queue.held.reason.attachment_type_refused": "Carries an attachment of a type this mailbox does not accept.",
  "queue.held.reason.attachment_dangerous":
    "Carries an executable, a script, a program under a document's name, or an archive listing one.",
  "queue.held.reason.dmarc_fail_reject": "{domain} says this is not theirs and asks receivers to reject it.",
  "queue.held.reason.dmarc_fail_quarantine": "{domain} says this is not theirs and asks receivers to quarantine it.",
  // Substituted for {domain} when the delivery carried none: a fragment by construction, like `inbox.thisMailbox`.
  "queue.held.fromDomain": "The From domain",

  "queue.merge.picked": "Two cases picked.",
  "queue.merge.do": "Merge them",
  "queue.merge.hint": "— most merges are refused, and the refusal names the pair to resolve first.",
  "queue.merge.clear": "Clear",

  "queue.empty": "Nothing waiting in this queue.",
  "queue.cases": "Cases",
  "queue.col.state": "State",
  "queue.col.subject": "Subject",
  "queue.col.from": "From",
  "queue.col.holder": "Held by",
  "queue.col.response": "Response",
  "queue.col.action": "Action",
} as const satisfies Area<"queue"> & Record<`queue.held.reason.${QuarantineReason}`, unknown>;
