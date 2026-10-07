import type { Area } from "../areas.ts";

/**
 * The reading pane (`src/client/app/screens/reader.tsx`): a message, its headers, its body frame and its acts.
 *
 * Words the list pane already says are not repeated here: the acts (Reply, Archive, Move to Trash, Mark read)
 * are `inbox.act.*`, "Take it anyway" is `inbox.takeAnyway`, the unreachable sentence is `inbox.unreachable`,
 * and the missing `send.propose` sentence is `inbox.withheld.reply`. One act, one word, in both panes.
 *
 * The sender's content is never here: a subject, a name, a label, a link's text and the body are the message's.
 */
export const reader = {
  "reader.pane": "Message",
  "reader.actions": "Message actions",
  "reader.more": "More actions",
  "reader.back": "Back to {place}",
  /** A subject that is absent, or empty because the header could not be parsed (`src/materialise.ts`). */
  "reader.noSubject": "(no subject)",
  "reader.partlyReadable": "Headers were only partly readable: {problem}. The original is unchanged.",

  // The body, and every notice about it above it.
  "reader.body.frame": "Message body",
  "reader.body.unreadable": "The body could not be read ({status}).",
  "reader.body.unparsed": "This message's body could not be read. The original is unchanged.",
  // Why the body could not be shown, by the code the Node sends beside its sentence (`BODY_PROBLEMS`); the English is
  // the Node's sentence for a body with no plain-text alternative, and {cause} the parser's own words, marked.
  "reader.body.problem.unreadable": "This message's body could not be read ({cause}). The original is unchanged and can still be downloaded.",
  "reader.body.problem.sanitised_empty": "Nothing in this message's HTML survived sanitising. The original is unchanged and can still be downloaded.",
  "reader.body.problem.unrenderable": "This message's HTML could not be rendered safely ({cause}). The original is unchanged and can still be downloaded.",
  // The same two problems where the plain-text alternative is shown below instead: the Node's sentence for that case.
  "reader.body.fallback.sanitised_empty": "Nothing in this message's HTML survived sanitising. Its plain-text alternative is shown instead.",
  "reader.body.fallback.unrenderable": "This message's HTML could not be rendered safely ({cause}). Its plain-text alternative is shown instead.",
  // A message the parser found neither HTML nor text in (§5C, ADR 37): said, rather than an empty panel.
  "reader.body.none": "This message has no body.",
  "reader.body.remote": {
    one: "{n} remote resource withheld. Loading them would tell the sender you opened this.",
    other: "{n} remote resources withheld. Loading them would tell the sender you opened this.",
  },
  "reader.body.truncated": "Shown truncated. The original is complete.",

  // Links that are not what they say: the count (the noun agrees with all the links, the verb with the flagged).
  "reader.links.flaggedOfOne": "1 of 1 link in this message is not what it says:",
  "reader.links.flagged": {
    one: "{n} of {total} links in this message is not what it says:",
    other: "{n} of {total} links in this message are not what they say:",
  },
  "reader.links.image": "(an image)",
  "reader.link.mismatch": "{text} says one place and goes to another: {href}",
  "reader.link.lookalike": "{text} goes to a domain that resembles one of yours and is not it: {href}",
  "reader.link.userinfo": "{text} carries a name before the real host, so it reads as somewhere it is not: {href}",
  "reader.link.ip_host": "{text} goes to a bare address rather than a named site: {href}",

  // What was attached, and each verdict in words. The composer describes a file it attaches with the same words.
  "reader.attachments": "Attachments",
  "reader.attachment.unnamed": "(unnamed)",
  "reader.attachment.size": "{type} · {kb} KB",
  "reader.verdict.archive": "an archive; what is inside has not been opened",
  "reader.verdict.archive_dangerous": "an archive listing a program or a script",
  "reader.verdict.executable": "a program",
  "reader.verdict.script": "a script",
  "reader.verdict.disguised": "a program under a document's name",

  // What the receiving server established about the sender.
  "reader.auth.unevaluated": "Not evaluated — arrived before this Node checked senders",
  "reader.auth.absent": "no authentication header from the receiving server",
  "reader.auth.fromDomain": "the From domain",
  /** A result the header did not carry, beside SPF or DKIM. The results themselves are the protocol's tokens. */
  "reader.auth.missing": "absent",
  "reader.auth.pass": "{domain} vouches for this message",
  "reader.auth.noPolicy": "{domain} publishes no policy",
  "reader.auth.fail": "{domain} {notTheirs}",
  "reader.auth.failEvidence": "{domain} {notTheirs} (dmarc fail; spf {spf}, dkim {dkim})",
  "reader.auth.failEvidencePolicy":
    "{domain} {notTheirs} (dmarc fail; spf {spf}, dkim {dkim}; the domain asks receivers to {policy})",
  "reader.auth.notTheirs": "says this message is not theirs",
  "reader.auth.line": "SPF {spf} · DKIM {dkim} · DMARC {dmarc} — {verdict}",

  // The details under "to …".
  "reader.to": "to {address}",
  "reader.details.from": "From",
  "reader.details.to": "To",
  "reader.details.cc": "Cc",
  "reader.details.replyTo": "Reply-To",
  "reader.details.deliveredTo": "Delivered to",
  "reader.details.received": "Received",
  "reader.details.authentication": "Authentication",
  "reader.details.size": "Size",
  "reader.details.bytes": { one: "{n} byte", other: "{n} bytes" },
  "reader.headers.view": "View headers",
  "reader.original": "Download original",
  "reader.original.recorded": "Downloading is recorded as an export.",
  "reader.original.note": "Recorded as an export.",

  // The header block, on demand.
  "reader.headers": "Headers",
  "reader.headers.close": "Close",
  "reader.headers.truncated": "Shown: the first {n} bytes ({budget}). The full header block is in Download original.",
  "reader.headers.block": "Header block",

  // Labels.
  "reader.label.show": "Show mail labelled {label}",
  "reader.label.remove": "Remove label {label}",
  "reader.label.add": "Add label…",
  "reader.label.field": "Add a label",
  "reader.label.hint": "Label, then Enter",

  // Assign: hand the case to a colleague.
  "reader.assign": "Assign",
  "reader.assign.noCase": "This message has no case yet, so it cannot be assigned. It predates the queue.",
  "reader.assign.closed": "This case is closed.",
  "reader.assign.held": "Held by {who} since {when}.",
  "reader.assign.heldUnrecorded": "Held by {who} since an unrecorded time.",
  "reader.assign.colleague": "a colleague",
  "reader.assign.email": "Colleague's sign-in address",
  "reader.assign.handOver": "Hand over",
  "reader.assign.handed": "Handed to {email}. It is in their queue now, and the trail names you both.",

  // The rest of the conversation.
  "reader.thread": "Conversation",
  "reader.thread.count": {
    one: "{n} other message in this conversation",
    other: "{n} other messages in this conversation",
  },
  "reader.thread.send": " · a send from this Node, {state}",
  "reader.thread.sendBytes": "A send from this Node. Its bytes are in the outbox.",
  "reader.thread.sendBytesAt": "A send from this Node. Its bytes are in the outbox: {link}.",

  // The ••• menu's own item.
  "reader.act.toInbox": "Move to Inbox",
} as const satisfies Area<"reader">;
