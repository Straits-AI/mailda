import type { Area } from "../areas.ts";

/**
 * Writing a message (`src/client/app/screens/composer.tsx`): the fields, the quote line and the seal.
 *
 * The limit line's clauses after the first begin with a space, because they follow a sentence on the same line;
 * a locale whose sentences are not separated by spaces leaves it out.
 */
export const composer = {
  // The dock's head.
  "composer.title.reply": "Reply",
  "composer.title.forward": "Forward",
  "composer.title.new": "New message",
  "composer.discard": "Discard",
  "composer.close": "Close",
  "composer.closing": "Saving…",
  "composer.context.reply": "Replying to: {subject}",
  "composer.context.forward": "Forwarding: {subject}",

  // Where the bytes are (the three draft phases, #32).
  "composer.phase.empty": "empty draft",
  "composer.phase.browser": "this browser only · a reload loses it",
  "composer.phase.saving": "saving to your node…",
  "composer.phase.saved": "saved on your node · {time}",
  "composer.phase.failed": "not saved — {why}",
  "composer.save.answered": "this Node answered {status}",
  "composer.save.noDraft": "this Node answered without a draft",
  "composer.save.failed": "this draft could not be saved",
  "composer.close.kept": "This draft is not saved on your Node yet, so the dock is staying open. Retry, or discard it on purpose.",

  // The fields.
  "composer.field.from": "From",
  "composer.field.to": "To",
  "composer.field.copies": "Cc / Bcc",
  "composer.field.cc": "Cc",
  "composer.field.bcc": "Bcc",
  "composer.field.subject": "Subject",
  "composer.field.body": "Message",
  "composer.field.attach": "Attach",
  "composer.from.unreadable": "This Node could not read this mailbox's addresses ({why}), so the address this goes out from is not shown.",
  "composer.from.unlisted": "This mailbox is not among the ones this Node listed, so the address this goes out from is not shown.",
  "composer.from.choose": "Choose an address…",
  "composer.from.mailbox": "· the {name} mailbox",
  "composer.from.none": "No address yet: a send from {name} is refused until an administrator adds one on People.",
  "composer.from.more": "More addresses for this mailbox are added on People, by an administrator.",

  // The attachment limit, before anything is attached and after.
  "composer.limit.none": { one: "Up to {size} in total, {n} file.", other: "Up to {size} in total, {n} files." },
  "composer.limit.used": { one: "{used} of {size} used, {count} of {n} file.", other: "{used} of {size} used, {count} of {n} files." },
  "composer.limit.over": " Over the limit: remove a file or send a link.",
  "composer.limit.tooMany": " Too many files.",
  "composer.limit.checking": " Checking files…",
  "composer.limit.unreadable": {
    one: " {n} file could not be read: remove and attach again.",
    other: " {n} files could not be read: remove and attach again.",
  },
  "composer.limit.flagged": {
    one: " {n} file judged dangerous: see the warning below.",
    other: " {n} files judged dangerous: see the warning below.",
  },

  // Each attached file.
  "composer.files.label": "Attached files",
  "composer.file.remove": "Remove",
  "composer.file.checking": "Checking…",
  "composer.file.dangerous":
    "{name} is {what}. It will be sent because you attached it, and the seal records that you did. Some receiving servers refuse programs and scripts (Gmail refuses .exe, .js, .jar and others, even inside a zip), so a link may be the only way it arrives.",
  "composer.file.unread": "This browser could not read it ({why}), so it cannot be sent: remove it and attach it again.",
  "composer.files.kept": "Files travel with the send, not with the draft: close this and they are not kept.",

  // A draft whose text this Node could not give back (#143).
  "composer.bodyUnavailable.unreadable":
    "This draft's text is stored on this Node and cannot be opened — it is sealed under a key generation the vault does not hold. It is not lost, and saving over it is refused. Restore the vault with one of the ten recovery codes, then reopen this draft.",
  "composer.bodyUnavailable.missing":
    "This draft's text is gone: the row recording it is here and the stored object is not. The recipients and subject above are intact. Nothing can recover the writing.",

  // The seal, and what stops it.
  "composer.takeAnyway": "Take it anyway",
  "composer.seal": "Seal and send",
  "composer.sealing": "Sealing…",
  "composer.seal.refused": "This message could not be sealed.",
  "composer.unreachable": "This Node could not be reached ({why}).",
  "composer.unreachable.unsealed": "This Node could not be reached ({why}). Nothing was sealed, so nothing will be sent.",
  "composer.discard.silent": "This Node answered {status} and gave no reason, so this draft may still be here.",
  "composer.discard.unreachable": "This Node could not be reached ({why}), so this draft may still be here.",
  "composer.sendNote": "Sent as the mailbox; who wrote it is recorded here. Held {n} s so you can stop it; no recall.",
  "composer.how": "How sending works",
  "composer.how.body": {
    one: "This will be sent from the mailbox, not from you. Who wrote it is recorded here and does not travel with the message. Sealing records exactly what will be sent before anything leaves, then waits {n} second so you can still stop it — nothing is recalled, because a recall would not be honest.",
    other: "This will be sent from the mailbox, not from you. Who wrote it is recorded here and does not travel with the message. Sealing records exactly what will be sent before anything leaves, then waits {n} seconds so you can still stop it — nothing is recalled, because a recall would not be honest.",
  },

  /**
   * The reply's quote line, written into the mail in its author's language (plan decision 13, as Gmail and Outlook
   * do): the one catalog string that leaves this browser. `Re:` and `Fwd:` are not here; they stay English.
   */
  "composer.quote": "On {date}, {from} wrote:",
} as const satisfies Area<"composer">;
