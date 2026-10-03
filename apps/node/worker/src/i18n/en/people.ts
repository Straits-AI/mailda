import type { Area } from "../areas.ts";

/**
 * People (`src/client/app/screens/people.tsx`): members, invitations, teams, addresses and mailbox access, and the
 * signed-in person's own passkeys (`Passkeys`, rendered by Settings). Its heading is the route's name,
 * `route./people`. The relations' descriptions are `api.grant.*`; the relation tokens stay Latin, in mono.
 *
 * An address's routing outcome is keyed by its state, and only the states with words of their own have a key:
 * the others show the Node's detail whole, in `<NodeWords>`.
 */
export const people = {
  "people.lede": "Everybody with an account on this Node.",
  "people.forbidden": "No directory, or you do not hold org.admin. Granting access is an administrator's act.",

  "people.mailboxes.label": "A new mailbox",
  "people.mailboxes.heading": "Mailboxes",
  "people.mailboxes.lede":
    "A shared inbox with its own queue. You may read and send from it as soon as it exists; grant others below, and add the addresses it receives at.",
  "people.mailboxes.made": "{name} exists. Add an address to it below.",
  "people.mailboxes.name": "Name",
  "people.mailboxes.placeholder": "Invoices",
  "people.mailboxes.create": "Create a mailbox",

  "people.routing.catch_all": "routed by the domain's catch-all; nothing to do in Cloudflare",
  "people.routing.rule_written": "routing rule written",
  "people.removal.catch_all": "removed; the domain's catch-all needed nothing",
  "people.removal.rule_removed": "removed, and its routing rule deleted",
  /** An address and what became of its routing: `{outcome}` is a state's words above, or the Node's detail. */
  "people.address.outcome": "{address}: {outcome}",

  "people.address.domain": "Domain",
  "people.address.domainOf": "{label}: domain",
  "people.address.label": "A new address",
  "people.address.heading": "Add an address",
  "people.address.address": "Address",
  "people.address.mailbox": "Mailbox",
  "people.address.pickMailbox": "mailbox…",
  "people.address.add": "Add the address",

  "people.mailbox.rename": "Rename",
  "people.mailbox.renamed": "renamed to {name}",
  "people.mailbox.noAddress": "No address yet: nothing is routed here, and a send from it is refused until one is.",
  /**
   * A kept forward under its address (ADR 47): where it goes, what the last read of the account's destinations said,
   * and its latest attempt. A refusal is Cloudflare's own words, in `<NodeWords>`.
   */
  "people.forward.to": "forwards to {to} ({state})",
  "people.forward.state.verified": "verified",
  "people.forward.state.waiting": "waiting for verification",
  "people.forward.state.absent": "not a destination of the account",
  "people.forward.state.unchecked": "not checked",
  "people.forward.handedOver": "last forwarded {when}",
  "people.forward.none": "nothing has arrived since it was kept",
  "people.forward.refused": "not forwarded at {when}: {reason}",
  "people.forward.withheld": "not forwarded at {when}: it came back from a forward of this Node's own",
  "people.forward.unknown": "no recorded answer for the forward at {when}: the destination may or may not have it",
  "people.mailbox.addresses": "Addresses of {name}",
  "people.mailbox.remove": "Remove",
  "people.mailbox.access": "Access to {name}",
  "people.mailbox.who": "Who may do what in {name}",
  "people.col.person": "Person",
  "people.col.may": "May",

  "people.org.label": "Administering the organization",
  "people.org.heading": "The organization",
  "people.org.who": "Who administers the organization",

  "people.beside.noMailbox": "No mailbox was made: {why}",
  "people.beside.noAddress": "The mailbox {email} was made, and has no address: {why}",
  "people.beside.made":
    "The mailbox {email} was made, at {address}: {routed}. {email} holds nothing on it until they arrive and you grant it; you may read and send from it, as its creator.",

  "people.invite.heading": "Invite somebody",
  "people.invite.lede":
    "They choose their own password, so you never see it. Hand them the secret however you already trust — nothing is emailed. They arrive holding nothing until you grant access below.",
  "people.invite.address": "Address",
  "people.invite.also": "Also give them a mailbox at",
  "people.invite.theirAddress": "Their mailbox's address",
  "people.invite.mint": "Mint an invitation",
  "people.invite.give": "Give this to {email}. It works once, until {until}.",
  "people.invite.once":
    "Shown once — only its hash is stored, so nothing can recover it. Mint another if it is lost, which invalidates this one.",
  "people.invited.label": "Invited, not yet arrived",
  "people.invited.caption": "Invited, and not yet arrived.",
  "people.invited.address": "Address",
  "people.invited.by": "Invited by",
  "people.invited.expires": "Expires",
  "people.invited.state": "State",
  "people.invited.withdraw": "Withdraw",
  "people.invited.expired": "expired — mint another",
  "people.invited.waiting": "waiting",

  "people.arrival.refused": "{relation} on {mailbox} was not granted to {email}: {why}",
  "people.arrival.unread":
    "People offers nobody the mailbox at their own address while the withdrawals of access cannot be read, so as not to offer back one an administrator took away: {why}",
  "people.arrival.truncated":
    "Only the newest withdrawals of access were read; a mailbox withdrawn from somebody before those may be offered below again.",
  "people.arrival.offer":
    "{email} has an account and holds nothing directly on the mailbox at that address. Give them the mailbox {address}?",
  "people.arrival.grant": "Grant {read} and {send} on {mailbox}",

  "people.teams.heading": "Teams",
  "people.teams.lede":
    "A team is a group an approval stage can require a decision from — one from finance, then one from legal. A team nothing cites changes nothing.",
  "people.teams.new": "New team",
  "people.teams.create": "Create",
  "people.teams.label": "Teams and their members",
  "people.teams.team": "Team",
  "people.teams.members": "Members",
  "people.teams.none": "No teams. Approval stages can name one once it exists.",
  "people.teams.nameOf": "Name of {name}",
  "people.teams.rename": "Rename",

  "people.passkeys.heading": "Your passkeys",
  "people.passkeys.lede":
    "A passkey signs you in with your device instead of a password. Your password still works — it is the fallback, and it is what gets you back in if you lose every device.",
  "people.passkeys.none": "None yet. This account signs in with a password only.",
  "people.passkeys.caption": "“Last used” is what tells you which of these you can remove without locking yourself out.",
  "people.passkeys.name": "Name",
  "people.passkeys.added": "Added",
  "people.passkeys.lastUsed": "Last used",
  "people.passkeys.remove": "Remove",
  "people.passkeys.never": "never",
  "people.passkeys.device": "Name this device",
  "people.passkeys.placeholder": "work laptop",
  "people.passkeys.add": "Add a passkey",
} as const satisfies Area<"people">;
