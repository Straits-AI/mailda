import type { ExportState, MatterType } from "@mailda/contract/schemas";

import type { Area } from "../areas.ts";

/**
 * A matter's type and an export's state, keyed by the contract's closed lists (`MATTER_TYPES`, `EXPORT_STATES`;
 * the owner's round three, G12): a token without words, or words for no token, does not compile. The English is
 * the token as the screen showed it before it had words, so English is unchanged.
 */
const tokens = {
  "matters.type.legal_hold": "legal hold",
  "matters.type.security_incident": "security incident",
  "matters.type.departure_handover": "departure handover",
  "matters.type.regulatory_request": "regulatory request",
  "matters.export.requested": "requested",
  "matters.export.running": "running",
  "matters.export.completed": "completed",
  "matters.export.aborted": "aborted",
} as const satisfies Record<`matters.type.${MatterType}` | `matters.export.${ExportState}`, string>;

/**
 * Matters (`src/client/app/screens/matters.tsx`): matters, legal holds, supervised access and exports.
 *
 * Every act here asks rather than does, so each `*.asked` sentence says who has to agree, and each count is the
 * server's: a hold lift, a supervised read and an export need two people holding `approval.decide` on the mailbox,
 * none of them the one who asked (`src/holds.ts`, `src/supervised.ts`, `src/exports.ts`). They are people, not
 * administrators (D3). A matter is not an investigation (D9, glossary: 事项).
 *
 * `matters.scope.*` is keyed by the read scope the Node takes (`metadata`, `content`).
 */
export const matters = {
  ...tokens,
  "matters.open": "{n} open",
  "matters.lead":
    "A matter, and what it authorises. Mail is held so it cannot be deleted, a colleague’s mailbox may be read for a bounded time, a copy may be taken. Closing the matter is what makes the notice to the person who was read about fall due (§7).",

  "matters.field.mailbox": "Mailbox",
  "matters.field.matter": "Under which matter",
  "matters.choose": "choose…",
  "matters.noMatterYet": "no matter yet",

  "matters.new": "Open a matter",
  "matters.new.kind": "What kind",
  "matters.new.describe": "Describe it",
  "matters.new.asked": "Matter opened.",
  "matters.refused": "No matters, or you do not hold org.admin.",
  "matters.empty": "No matters have been opened.",
  "matters.col.matter": "Matter",
  "matters.col.kind": "Kind",
  "matters.col.opened": "Opened",
  "matters.col.state": "State",
  "matters.state.open": "open",
  "matters.state.closed": "closed {at}",
  "matters.close": "Close",
  "matters.close.asked": "Matter closed. The people whose mail was read will be told.",

  "matters.holds": "Legal holds",
  "matters.holds.heading": "Held mail",
  "matters.holds.lead":
    "While a mailbox is held, nothing in it can be deleted — not by a person, not by the reconciler. Lifting a hold takes two other people.",
  "matters.holds.asked": "Hold placed. Nothing in that mailbox can be deleted now.",
  "matters.holds.act": "Hold this mailbox",
  "matters.holds.refused": "No holds, or you do not hold org.admin.",
  "matters.holds.empty": "Nothing is held.",
  "matters.holds.list": "Holds",
  "matters.holds.since": "Since",
  "matters.holds.lift": "Lift",
  "matters.holds.gone": "(mailbox gone)",
  "matters.holds.noMatter": "none",
  "matters.holds.liftWaiting": "a lift is waiting on two approvals",
  "matters.holds.liftAsked": "Asked. Two other people have to agree before this hold lifts.",
  "matters.holds.liftAct": "Ask to lift",

  "matters.read": "Supervised reading",
  "matters.read.heading": "Reading somebody else’s mail",
  "matters.read.lead":
    "A time-boxed grant to read a mailbox you hold nothing on. Two people have to approve it, neither of them you, and it stops at its expiry — renewal is a new request, because time is part of what was approved.",
  "matters.read.howMuch": "How much",
  "matters.read.hours": "For how long (hours)",
  "matters.scope.metadata": "Senders, subjects and dates. Not the messages.",
  "matters.scope.content": "The messages themselves.",
  "matters.read.asked": "Asked. Two people have to approve before you can read anything.",
  "matters.read.act": "Ask to read",
  "matters.read.empty": "Nobody has been granted a supervised read.",
  "matters.read.list": "Supervised reads",
  "matters.read.who": "Who",
  "matters.read.until": "Until",
  "matters.read.live": "reading now",
  "matters.read.waiting": "waiting on two approvals",
  "matters.read.expired": "expired",

  "matters.exports": "Exports",
  "matters.exports.heading": "Copies taken out",
  "matters.exports.lead":
    "An export produces mail that leaves this Node’s controls. It cites a matter, it is approved before it runs, and what it emitted is counted.",
  "matters.exports.atMost": "At most",
  "matters.exports.asked": "Asked. Two other people have to agree before it runs; then run it here, and download from its manifest.",
  "matters.exports.act": "Ask to export",
  "matters.exports.empty": "No exports have been requested.",
  "matters.exports.askedBy": "Asked by",
  "matters.exports.messages": "Messages",
  "matters.exports.run": "Run",
  "matters.exports.ran": "Export run.",
  "matters.exports.emitted": "{emitted} of {max}",
  "matters.exports.objects": "Objects",
  "matters.exports.bytes": { one: "{n} byte", other: "{n} bytes" },
} as const satisfies Area<"matters">;
