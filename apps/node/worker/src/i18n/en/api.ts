import type { Area } from "../areas.ts";

/**
 * What `src/client/app/api.ts` says in its own words: only when the Node said nothing (a failure with no
 * body, a code with no message), or where the interface describes a token the Node names (a relation, a
 * matter type). The Node's own `message` is passed through untouched and never has a key (ADR 46).
 */
export const api = {
  "api.no_reason": "This Node answered {status} and gave no reason.",
  "api.answered": "This Node answered {status}.",
  /** `revokeAgent`'s shorter form, kept as it was. */
  "api.answered.short": "Answered {status}.",
  "api.revoked": "Revoked.",
  /**
   * A refusal sent bare as `{ error, what, why, fix }`, laid out in the four-part shape the Node's `message`
   * has (AGENTS.md §3). The labels stay Latin in every locale, as the `E_` code beside them does: the Node's
   * own `message` carries the same shape in English, and one screen must not show both.
   */
  "api.refusal": "{code}  {what}\n  why      {why}\n  fix      {fix}",
  /** Stands where the refusal's code would be when the body names none. */
  "api.refusal.code": "refused",
  /** Stands where the holder's address would be when a held case names none. */
  "api.held.somebody": "somebody",
  "api.held.message": "Somebody else is holding this.",
  "api.withdrawal.malformed": "The access.revoked entry {id} names no person or no object: {detail}",
  "api.passkey.unsupported": "This browser has no passkey support.",
  "api.passkey.none": "No passkey was created.",

  // What each relation an administrator grants to a person lets them do (People).
  "api.grant.mailbox.metadata.read": "See that mail exists — senders, subjects, when. Not the message itself.",
  "api.grant.mailbox.content.read": "Read the messages.",
  "api.grant.send.propose": "Write and send from this mailbox, and claim its cases.",
  "api.grant.approval.decide": "Decide approvals for its mail. Never their own.",
  "api.grant.message.export": "Take a copy of a message out of the Node.",
  "api.grant.ediscovery.export": "Run a bulk export against a matter.",
  "api.grant.org.admin": "Administer the organization: rules, Butlers, access, holds.",

  // What each relation minted to an agent lets it do (Agents): the same tokens, said for a machine.
  "api.agent.mailbox.metadata.read": "See that mail exists — senders, subjects, when. Not the message itself.",
  "api.agent.mailbox.content.read": "Read the messages themselves, including the original bytes.",
  "api.agent.send.propose": "Draft and propose mail from this mailbox. Sealing a send is withheld from every machine.",
  "api.agent.message.export": "Take copies of individual messages out of this mailbox.",

  // Why a matter is opened (Matters).
  "api.matter.legal_hold": "Preserving mail for a legal obligation.",
  "api.matter.security_incident": "Investigating a compromise or a misuse of an account.",
  "api.matter.departure_handover": "Passing on the work of somebody who has left.",
  "api.matter.regulatory_request": "Answering a regulator.",
} as const satisfies Area<"api">;
