import type { Area } from "../areas.ts";

/**
 * Rules (`src/client/app/screens/policies.tsx`). The code word is `policies`; the interface word is Rules, and the
 * heading is the route's name (`route./rules`).
 *
 * A rule is shown as a sentence assembled from the same columns the evaluator reads: one clause per condition
 * (`policies.when.*`), joined by `policies.when.join`, into a frame (`policies.rule.*`) with the outcome's phrase
 * (`policies.outcome.<token>`, keyed by `PolicyVersionRow["outcome"]`, and the editor's choices too). A new
 * rule's name ("new rule") is written into the Node as the rule's own name, so it is data and not here.
 */
export const policies = {
  "policies.new": "New rule",
  "policies.notAdmin": "No rules here, or you do not hold org.admin. Writing one is an administrator's act.",
  "policies.empty": "No rules yet. Every message goes as the mailbox and its relations allow.",
  "policies.caption":
    "What each rule does, in the order a reader meets it. A message is decided by the strictest rule that matches " +
    "it, not the first.",
  "policies.col.rule": "Rule",
  "policies.col.does": "What it does",
  "policies.col.version": "Version",
  "policies.col.since": "Since",
  "policies.col.edit": "Edit",
  "policies.version": "v{version}",
  "policies.draft": "draft",
  "policies.unpublished": "(unpublished — it decides nothing yet)",
  "policies.publish": "Publish",
  "policies.open": "Open",

  "policies.outcome.allow": "goes as normal",
  "policies.outcome.hold": "is held for a person to release",
  "policies.outcome.require_approval": "needs an approval before it goes",
  "policies.outcome.deny": "is refused",

  /** A rule with no conditions matches everything, and says so. */
  "policies.rule.every": "Every message {outcome}.",
  /** `{conditions}` is the rule's clauses, joined by `policies.when.join`. */
  "policies.rule.when": "Mail {conditions} {outcome}.",
  "policies.when.join": ", ",
  "policies.when.mailbox": "from {mailbox}",
  /** `{user}` is the author's user id. */
  "policies.when.actor": "written by {user}",
  "policies.when.external": "to anyone outside",
  "policies.when.internal": "to colleagues only",
  "policies.when.reply": "as a reply",
  "policies.when.newMessage": "as a new message",
  "policies.when.dmarcFail": "answering mail its sender's domain disowned",
  "policies.when.notDmarcFail": "not answering disowned mail",
  /** `{count}` is the org-wide daily count the evaluator reads, `send_counters.handed_over`. */
  "policies.when.volume": "once this Node has handed over {count} today",

  "policies.editor.label": "Rule {name}",
  "policies.editor.name": "What is this rule called?",
  "policies.editor.mailbox": "Which mailbox?",
  "policies.editor.mailbox.any": "any mailbox",
  "policies.editor.to": "Who is it going to?",
  "policies.editor.to.any": "anyone — not part of this rule",
  "policies.editor.to.external": "anyone outside this organization",
  "policies.editor.to.internal": "colleagues only",
  /** A three-way condition's first choice: the condition is left out of the rule. */
  "policies.editor.either": "either — not part of this rule",
  "policies.editor.reply": "Is it a reply?",
  "policies.editor.reply.only": "only replies",
  "policies.editor.reply.new": "only new messages",
  "policies.editor.dmarc": "Answering mail its sender's domain disowned?",
  "policies.editor.dmarc.only": "only replies to a message whose DMARC failed",
  "policies.editor.dmarc.else": "everything else",
  "policies.editor.then": "Then the message…",
  "policies.editor.approvals": "How many people must approve?",
  "policies.editor.save": "Save draft",
} as const satisfies Area<"policies">;
