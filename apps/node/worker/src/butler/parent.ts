import { ButlerFault } from "./expr.ts";

/**
 * Who a Butler's reply goes to, and where that comes from (#52).
 *
 * ## The rule
 *
 * **A Butler does not name recipients. The Node derives them from the parent delivery.** §16 forbids
 * untrusted content selecting or constructing To/CC/BCC, `draft` used to take a `to` list of expressions,
 * and an expression reads `event.*` — which *is* the inbound message. So the parameter is gone
 * (`packages/butler-ast/src/ast.ts`) and this file is what replaced it.
 *
 * ## What "the parent delivery" means, exactly
 *
 * A Butler is triggered by `mail.received`: one message, delivered into one mailbox, carrying an SMTP
 * envelope. The parent delivery is that message, and the recipient of a reply to it is its **return path** —
 * the envelope sender, `ingress_receipts.envelope_from`, what RFC 5321 calls the reverse path.
 *
 * Three candidates were available and the choice matters, so it is written down rather than left to whoever
 * reads the code next:
 *
 * | candidate | what it is | why not / why |
 * |:--|:--|:--|
 * | the `Reply-To:` header | content | **Refused.** A header is content, and honouring one is §16's sink under another name: a message arriving with `Reply-To: victim@example.com` would aim this Node's reply at a third party, which is exactly the redirection the parameter was removed to prevent. |
 * | the `From:` header (`messages.from_addr`) | content | **Refused**, same reason. It is what a *person's* mail client offers, and a person is a check on it; a program running unattended is not. |
 * | the envelope sender (`ingress_receipts.envelope_from`) | transport | **Used.** It is the address the transport itself treats as the return path, the one SPF authenticates, and the one RFC 3834 requires an automatic responder to answer. |
 *
 * **What that does and does not buy, stated without dressing it up.** It closes the sink: no value an author
 * wrote and no field of the message body or headers can decide who the mail goes to. It does **not** make
 * the envelope sender trustworthy — a spoofed reverse path aims a reply at whoever it names, which is
 * ordinary backscatter and is a property of email rather than of this design. What bounds that today is the
 * human release gate every Butler send carries (`releaseRequired: true` in `effects.ts`); what will bound it
 * properly is the trusted-recipient store that CC, forward and supervisor-notify are also waiting on. Not
 * claimed as closed, because it is not.
 *
 * ## The sink that is still an expression, said here because this file is where a reader looks
 *
 * **`draft.mailboxId` is an `Expr`**, so untrusted content can reach it — and the mailbox decides two of
 * §16's eleven: `From` is the mailbox's address (ADR 36), and `mailbox_id` is a policy condition. The note
 * that *"sender identity is closed structurally"* is half the story: `From` is derived from the mailbox, and
 * the mailbox is chosen by an expression.
 *
 * It is closed by **validation against trusted organization state**, which is §16's own escape clause, and
 * the difference from the recipient is the whole reason the two are treated differently: a recipient had
 * nothing to be validated *against* — no contacts table, no allowlist, no suppression list — while a mailbox
 * has `relationship_tuples`, which only an administrator writes. So `saveDraft`'s `assertMaySend` and
 * `sealManifest`'s `maySend` bound the set to the mailboxes this Butler was granted, and
 * `test/butler-run.test.ts` asserts both arms: content naming a mailbox the Butler does not hold is refused,
 * and content naming one it does hold works. The second half is the residual, stated as a fact rather than
 * left to be inferred from silence.
 *
 * ## A delivery with no return path is refused, never defaulted
 *
 * A bounce arrives with a null reverse path — `MAIL FROM:<>` — and RFC 3834 is explicit that an automatic
 * responder must not answer one. There is no sensible default here: replying to the `From:` header instead
 * would reopen the sink, replying to the mailbox itself would be a loop, and dropping the recipient would
 * seal a manifest with nobody in it. So `draft` **faults**, the run ends `failed`, and the reason names the
 * code. An author who expects such deliveries guards on `event.return_path` before drafting, which is why
 * that fact is in the run's state and the fix line says so.
 *
 * The same fault covers two other cases, and neither is theoretical:
 *
 * - **A trigger that is not a delivery.** The trigger enum has one member today and #49 says it will grow;
 *   the day a `mail.bounced` or a schedule fires a Butler, there is no parent message and no correspondent,
 *   and a `draft` in that run has nobody to write to. It refuses instead of inventing one.
 * - **A run started by the previous version of this Node.** Workflow instances outlive a deploy — a `wait`
 *   reaches 365 days — and a payload created before `return_path` existed does not carry one. Its `draft`
 *   node refuses, which is the safe direction: the alternative is guessing a recipient for mail that leaves
 *   the building.
 *
 * ## A reply to this Node's own address is refused, because it is a loop
 *
 * Found by driving the derivation adversarially rather than by reasoning about it: nothing stopped the
 * derived recipient from being **the address the delivery arrived at**. A message whose reverse path is
 * `support@acme.example`, delivered to `support@acme.example`, produced a sealed manifest `From:` and `To:`
 * that address — which is delivered back into the same mailbox, fires the same Butler, and does it again.
 * Forging `MAIL FROM` is all it takes, so it is reachable from outside rather than only by misconfiguration.
 *
 * The paragraph above already called replying to the mailbox itself *"a loop"*, as a reason not to default to
 * it. It was a reason nothing enforced. It is enforced here now: `E_BUTLER_REPLY_WOULD_LOOP`, before any
 * draft is written, and RFC 3834 §2 states the same rule — an automatic responder must not answer its own
 * address.
 *
 * **The check is one address against one address, and the limit is stated rather than left to be discovered.**
 * It compares the derived return path against `event.mailbox_address`, the address *this* delivery arrived
 * at, because that is the address a reply would come back to and both values are already in the trigger — so
 * the check costs nothing and cannot disagree with the delivery the run is about. It therefore does **not**
 * catch a reply that loops through a *second* mailbox on this Node, or between two Nodes answering each
 * other. Breaking those needs `Auto-Submitted: auto-replied` on what this Node emits and a rule about what
 * it accepts, neither of which exists anywhere in this repository — see "What is unenforced" in
 * `docs/butler-engine.md`.
 */

/**
 * The trigger a run carries: what fired it, which delivery, and that delivery's facts.
 *
 * Structurally `ButlerRunPayload["trigger"]`, declared here rather than imported because `interpret.ts`
 * imports `effects.ts` which imports this. Named for the trigger rather than for its `facts` field, because
 * the `event` name is half of what this module reads and a type called `TriggerFacts` would not explain why.
 */
export interface RunTrigger {
  readonly event: string;
  readonly key: string;
  readonly facts: Readonly<Record<string, unknown>>;
}

/** The one trigger that has a parent delivery. */
export const DELIVERY_TRIGGER = "mail.received";

/** The parent delivery of a run, once it has been proved to have one. */
export interface ParentDelivery {
  /** The `msg_` id of the message this run is about. */
  readonly messageId: string;
  /** The envelope sender: who a reply is addressed to. Never empty — that case faults instead. */
  readonly returnPath: string;
}

/** The field of `event.*` this reads. One name, used by the derivation and by the fault's fix line. */
export const RETURN_PATH_FACT = "return_path";

/**
 * The field of `event.*` that says where the delivery arrived — the other half of the loop check.
 *
 * A fact rather than a query for the same reason the return path is: it is already in the trigger, so the
 * two addresses being compared are both facts of one delivery and cannot be two answers to one question.
 */
export const DELIVERED_TO_FACT = "mailbox_address";

function fact(trigger: RunTrigger, name: string): string | null {
  const value = trigger.facts[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // `<>` as well as the empty string: a null reverse path has two spellings on the wire and providers differ
  // about which one they hand over, so both are "there is nobody to reply to" rather than an address.
  return trimmed.length === 0 || trimmed === "<>" ? null : trimmed;
}

/**
 * The parent delivery of this run, or a fault naming which of the four cases applies.
 *
 * Deliberately **pure and free**: no query, no subrequest. The facts were read once by `triggerButlers` when
 * the run was created, so deriving the recipient costs nothing and — more importantly — cannot disagree with
 * the delivery the run is recorded against. A second read here would be a second answer to *"which message
 * is this a reply to"*, which is the correspondence problem ADR 35 rejected for the effect key.
 *
 * The address's *shape* is not validated here, and that absence is deliberate too. `sealManifest` runs every
 * recipient through `normalizeAddress`, which is the one place that decides what may reach a header; a second
 * opinion here would be two spellings of one rule, and the one nobody updates is the one that lies. What this
 * decides is the question that function cannot: whether there is a correspondent at all.
 */
export function parentDelivery(trigger: RunTrigger, node?: string): ParentDelivery {
  if (trigger.event !== DELIVERY_TRIGGER) {
    throw new ButlerFault("E_BUTLER_NO_PARENT_DELIVERY", {
      what: `this run was triggered by ${JSON.stringify(trigger.event)}, which is not a delivery`,
      why: "a Butler does not choose recipients — the Node derives them from the message being replied to "
        + "(§16, #52) — so a run with no parent delivery has nobody to write to",
      fix: `trigger this Butler on ${DELIVERY_TRIGGER}, or take the draft node out of a Butler that is not `
        + "answering mail",
    }, node);
  }

  const messageId = fact(trigger, "message_id");
  const returnPath = fact(trigger, RETURN_PATH_FACT);

  if (messageId === null || returnPath === null) {
    throw new ButlerFault("E_BUTLER_PARENT_HAS_NO_RETURN_PATH", {
      what: messageId === null
        ? "this run's trigger carries no message_id, so the delivery it is about cannot be identified"
        : `delivery ${messageId} has no return path, so there is no address a reply belongs to`,
      why: "a Butler's recipients come from the envelope sender of the delivery that triggered it, and a "
        + "null reverse path — MAIL FROM:<> — is a bounce or a notification that RFC 3834 forbids "
        + "answering automatically. There is no default: the From header is content and would reopen the "
        + "sink #52 closed, and a manifest with no recipients is not a send",
      fix: `guard on \`event.${RETURN_PATH_FACT}\` before the draft node — \`when: event.`
        + `${RETURN_PATH_FACT} == ""\` is the deliveries this Butler cannot answer. A run started before `
        + "this Node was upgraded carries no return path either, and refuses for the same reason",
    }, node);
  }

  /*
   * The loop. Both arms refuse, and the second one refuses *because* it cannot tell.
   *
   * A trigger carrying no `mailbox_address` is a run this version of the Node did not create — the same
   * pre-upgrade payload the branch above describes — and for such a run the question "would this reply come
   * straight back?" has no answer available. Fail-closed is the only honest direction: the alternative is
   * skipping the check whenever the fact is missing, which is a guard that turns itself off on exactly the
   * inputs nobody tested.
   */
  const deliveredTo = fact(trigger, DELIVERED_TO_FACT);
  if (deliveredTo === null || returnPath.toLowerCase() === deliveredTo.toLowerCase()) {
    throw new ButlerFault("E_BUTLER_REPLY_WOULD_LOOP", {
      what: deliveredTo === null
        ? `this run's trigger does not say which address delivery ${messageId} arrived at, so whether a `
          + "reply would come straight back cannot be decided"
        : `delivery ${messageId} arrived from ${returnPath}, which is the address it was delivered to`,
      why: "a reply addressed to the address a message arrived at is delivered back into the same mailbox "
        + "and fires the same Butler again, which does it again. RFC 3834 §2 forbids an automatic responder "
        + "answering its own address, and since the recipient is derived from the envelope sender (#52) a "
        + "forged MAIL FROM naming this mailbox is all it takes to start one from outside",
      fix: `guard on \`event.${RETURN_PATH_FACT} == event.${DELIVERED_TO_FACT}\` before the draft node and `
        + "stop there — that is the delivery this Butler must not answer. This compares one address against "
        + "one address: a reply that loops through a second mailbox, or between two Nodes answering each "
        + "other, is not caught here and needs Auto-Submitted, which this Node does not yet emit",
    }, node);
  }

  return { messageId, returnPath };
}

/**
 * Who a draft written by this run is addressed to.
 *
 * One address, and `cc`/`bcc` are empty — not "empty for now". A Butler cannot copy anybody, because copying
 * somebody means naming a recipient who is not the correspondent, and the trusted-recipient store that would
 * make that safe does not exist. `effects.ts` passes no `cc` or `bcc` to `saveDraft` at all rather than
 * passing empty arrays, so there is no field there for a later edit to start filling in quietly.
 */
export function replyRecipients(parent: ParentDelivery): string[] {
  return [parent.returnPath];
}
