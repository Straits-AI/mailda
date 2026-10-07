import type { Area } from "../areas.ts";

/**
 * Setup (`src/client/app/screens/setup.tsx`): connecting this Node to its Cloudflare account, and the receiving,
 * sending and delivery-outcome forms. Everything the Node or Cloudflare says (a refusal, a permission's purpose, a
 * routing outcome, where a rule goes) is the Node's English, filled in as `{said}`-style parameters inside
 * `<NodeWords>`. Cloudflare's tokens (a rule's action, a record, a queue's name) are identifiers and stay as they come.
 *
 * The choices a routing rule offers are the Node's own words (`takeOver`), shown in `<NodeWords>`.
 */
export const setup = {
  "setup.connected": "Connected.",
  "setup.unconnected": "This Node holds no Cloudflare credential of its own.",
  "setup.unconnected.why":
    "Receiving, sending and delivery outcomes are set up at install, with the consent wrangler already had, or later with {command}. Connecting this Node, below, is what lets you change them from this screen.",
  "setup.buying":
    "Buying a domain through this credential is not on this screen yet. It spends money, and who may press that button is a decision this Node has not been given.",
  /** A section that cannot act until the Node is connected; `{command}` is the update script. */
  "setup.inert": "Needs the connection above, or the terminal command: {command}, which sets this up with the consent wrangler already has.",

  /** Shared by every form on the screen. */
  "setup.working": "Working…",
  "setup.domain": "Domain",
  "setup.intoMailbox": "Into mailbox",
  "setup.chooseMailbox": "choose a mailbox…",
  "setup.thisNode": "this Node",
  /** Where a rule sent mail before, when that rule was off. `{rule}` is Cloudflare's action and destinations. */
  "setup.rule.disabled": "{rule}, disabled",

  "setup.connection.label": "Optional connection",
  "setup.connection.title": "Optional: connect this Node to Cloudflare from this screen",
  "setup.connection.why":
    "The install set receiving, sending and delivery outcomes up with the consent wrangler already had, so this Node works without a credential of its own. Connecting it is only for changing that from here: another receiving domain, a sending domain, taking over a routing rule.",
  "setup.connection.held": "Connected to account {account} ({id}).",
  "setup.connection.heldSince": "Connected to account {account} ({id}) since {at}.",
  "setup.connection.unnamed": "unnamed",
  "setup.connection.forgetting": "Forgetting…",
  "setup.connection.forget": "Forget this token",
  "setup.connection.forgetNote": "Forgetting it here does not delete it in Cloudflare; that is yours to do on the token page.",
  "setup.connection.create":
    "Create one API token in Cloudflare with exactly these permissions, restricted to this account, and paste it below. This Node holds it wrapped under its credential key and never shows it again.",
  "setup.connection.permissions": "Permissions the token needs",
  "setup.connection.col.permission": "Permission",
  "setup.connection.col.scope": "Scope",
  "setup.connection.col.why": "What this Node does with it",
  "setup.connection.optional": "Optional.",
  "setup.connection.tokenPage": "Open the token page",
  "setup.connection.token": "API token",
  "setup.connection.accountId": "Account id",
  "setup.connection.connecting": "Connecting…",
  "setup.connection.connect": "Connect",

  "setup.receiving.title": "Receiving",
  "setup.receiving.label": "Receiving mail",
  "setup.receiving.heading": "3. Receiving",
  "setup.receiving.about":
    "A subdomain of a zone in this Cloudflare account. Pointing it here writes the MX records Cloudflare asks for, reads them back, and only then routes an address at this Node.",
  "setup.receiving.routed": "Domains this Node already routes",
  "setup.receiving.routedCaption": "What Cloudflare says about the domains this Node already routes.",
  "setup.receiving.col.zone": "Zone",
  "setup.receiving.col.receiving": "Receiving",
  "setup.receiving.col.records": "Records Cloudflare wants",
  "setup.receiving.noZone": "no zone found",
  "setup.receiving.unread": "could not be read",
  "setup.receiving.on": "on",
  /** `{status}` is Cloudflare's own token for the domain's routing. */
  "setup.receiving.onStatus": "on — {status}",
  "setup.receiving.off": "off",
  "setup.receiving.subdomain": "Subdomain",
  "setup.receiving.address": "Address to route here",
  "setup.receiving.propose": "See what pointing this here would do",
  "setup.receiving.plan": "What would happen to {domain}",
  "setup.receiving.enablesZone":
    "This also turns on Email Routing for {zone}, which writes MX and SPF at that zone's apex. That decides where mail for the whole domain goes, not just this subdomain. The records below are read after that, so this list is short because nothing can be read yet — not because little would change.",
  "setup.receiving.noRecords": "No records would be created.",
  "setup.receiving.col.type": "Type",
  "setup.receiving.col.name": "Name",
  "setup.receiving.col.pointsAt": "Points at",
  "setup.receiving.col.priority": "Priority",
  "setup.receiving.present": "Already there: {records}",
  "setup.receiving.catchAll": "Route every address at {domain} without a rule of its own to this Node (catch-all)",
  "setup.receiving.catchAll.none": "No catch-all is set on this zone today.",
  "setup.receiving.catchAll.enabled": "Currently: {rule}, enabled.",
  "setup.receiving.catchAll.disabled": "Currently: {rule}, disabled.",
  "setup.receiving.catchAll.then": "Addresses are then managed on this Node, and an address it does not know bounces.",
  "setup.receiving.subdomainNote": "{domain} is a subdomain, so each address gets its own rule; adding an address later writes one the same way.",
  "setup.receiving.apply": "Do this",
  "setup.receiving.needsAddress": "An address to route here is needed before this can be applied.",
  /** After the catch-all was taken over. `{before}` is where it went (Cloudflare's action and destinations). */
  "setup.receiving.done.catchAll":
    "The catch-all on {domain} now routes to this Node (before: {before}). Addresses without a rule of their own are managed on this Node from here; put it back from Routing rules.",
  "setup.receiving.done.nothing": "Nothing was confirmed in DNS for {domain}, so no routing rule was made.",
  "setup.receiving.done.routed": {
    one: "{domain} now has {n} confirmed record and mail is routed to {rule}.",
    other: "{domain} now has {n} confirmed records and mail is routed to {rule}.",
  },
  "setup.receiving.done.notRouted": {
    one: "{domain} now has {n} confirmed record and no rule routes the address here.",
    other: "{domain} now has {n} confirmed records and no rule routes the address here.",
  },

  "setup.ownRules.unread":
    "Which addresses at {domain} have a routing rule of their own could not be read, so what the catch-all would not reach is unknown: {said}",
  "setup.ownRules.none": "No address at {domain} has a routing rule of its own.",
  "setup.ownRules.some":
    "Addresses at {domain} with a routing rule of their own ({n}). An enabled rule outranks the catch-all, so the catch-all does not reach that address; this Node leaves every one of these rules as it is.",
  /** One address with a rule of its own, and where that rule sends it. */
  "setup.ownRules.row": "{address}: {goes}",
  "setup.ownRules.disabled": "disabled (enabled, it would be {where}); Cloudflare does not say whether the catch-all then applies",

  "setup.rules.title": "Rules already on a zone",
  "setup.rules.about":
    "A zone that was receiving mail before this Node has rules that send it elsewhere. Nothing changes unless you choose it here. Every rule can be pointed back; mail that arrived here meanwhile stays here. The catch-all is listed and left alone.",
  "setup.rules.list": "List the rules on this zone",
  "setup.rules.none": "No routing rules on {zone}.",
  "setup.rules.on": "Routing rules on {zone}",
  "setup.rules.caption": "Routing rules on {zone}.",
  "setup.rules.col.address": "Address",
  "setup.rules.col.goesTo": "Goes to",
  "setup.rules.catchAll": "catch-all",
  "setup.rules.disabled": "(disabled)",
  "setup.rules.putBack": "Put back",
  "setup.rules.putBack.confirm": "Yes, put it back",
  "setup.rules.takeOver.confirm": "Yes, point {address} here",
  /** After a take-over or a put-back. `{before}` and `{after}` are Cloudflare's action and destinations. */
  "setup.rules.done": "{address}: was {before}, now {after}.",
  "setup.rules.filedInto": "It files into {name}.",
  /** The mailbox a taken-over address files into when none of the existing ones is chosen; `mailda setup` says the same. */
  "setup.rules.newMailbox": "a new mailbox named {address}",
  /** Said under a take-over refused after the screen made the mailbox for it; `mailda setup` says the same. */
  "setup.rules.mailboxStays": "The mailbox {name} was made for it and stays.",
  /** Beside the confirm, where no mailbox is chosen: the address row's own, or the only one. */
  "setup.rules.filesInto": "Files into {name}.",
  /** After a take-over whose rule did not read back with the name recording where it went (critic H1). */
  "setup.rules.nameNotRecorded": "Its name does not record where it went, so only this Node can put it back: do that before the Node is ever deleted.",

  "setup.sending.title": "Sending",
  "setup.sending.label": "Sending mail",
  "setup.sending.heading": "4. Sending",
  "setup.sending.about":
    "Onboarding a domain for sending tells Cloudflare this account may send as it. It is separate from receiving, and a domain can have one without the other.",
  "setup.sending.propose": "See what onboarding this would do",
  "setup.sending.coveredBy":
    "Already covered by {domain}, which is onboarded. This name itself is not, so it stops being covered if that one is removed.",
  "setup.sending.onboarded": "Already onboarded for sending.",
  "setup.sending.creates": "Would create: {records}",
  "setup.sending.leavesBehind": "Leaves behind, and this Node cannot remove it: {said}",
  "setup.sending.apply": "Onboard this domain",
  "setup.sending.done": "{domain} is onboarded for sending.",
  "setup.sending.notDone": "{domain} is still not onboarded.",

  "setup.outcomes.title": "Delivery outcomes",
  "setup.outcomes.heading": "5. Delivery outcomes",
  /**
   * `{delivered}` is Cloudflare's event kind, in mono: this Node reads it as accepted (`src/outbound/events.ts`), and no
   * Node observes a message reach a person, so the sentence says what the Node does with it (D31).
   */
  "setup.outcomes.about":
    "A sending domain reports what happened to each message — accepted (Cloudflare's {delivered}), bounced, complained — only if a subscription publishes those events into this Node's queue. Without one, every send stays unobserved. The domain must be onboarded for sending first.",
  "setup.outcomes.propose": "See what subscribing this would do",
  "setup.outcomes.carriedBy": "Carried by {domain}, the onboarded domain that covers this name; the subscription is made for that one.",
  "setup.outcomes.subscribed": "Already subscribed, as {name}.",
  "setup.outcomes.publish": { one: "Would publish {n} event type into {queue}.", other: "Would publish {n} event types into {queue}." },
  "setup.outcomes.noConsumer": "Nothing reads {queue} yet — events would sit unobserved. Subscribing attaches this Node as its consumer.",
  "setup.outcomes.apply": "Subscribe this domain",
  "setup.outcomes.done": "{domain}'s delivery events now reach this Node.",
  "setup.outcomes.notDone": "{domain} is still not subscribed.",

  "setup.verified.title": "Verified destinations",
  "setup.verified.about":
    "Cloudflare reported no delivery outcome for mail to a verified destination address of this account, in the one case measured. Reading which of this Node's recipients are verified destinations lets the Outbox and doctor say so instead of waiting. It needs the optional permission Email Routing Addresses: Edit on this Node's token; {command} reads it with wrangler's login instead.",
  "setup.verified.read": "Read verified destinations",
  "setup.verified.failed":
    "The read did not succeed: {said}. When Cloudflare refuses it for lack of permission, the token needs Email Routing Addresses: Edit: add it in Cloudflare's dashboard, or make a new token and register it above (if the dashboard shows a new value after the edit, register that).",
  "setup.verified.failed.never": "Until a read succeeds, these recipients show as unobserved.",
  "setup.verified.failed.stands": "The read of {at} still stands.",
  "setup.verified.nobody": "Read {at} from account {account}. This Node has handed mail to nobody yet, so there was nothing to compare.",
  /** `n` is how many are verified; `{recipients}` is `setup.verified.recipients`, its own plural. */
  "setup.verified.some": {
    one: "Read {at} from account {account}. {n} of the {recipients} this Node has handed mail to is a verified destination. No outcome is reported for verified destinations; the Outbox marks their hand-overs made while they were verified.",
    other: "Read {at} from account {account}. {n} of the {recipients} this Node has handed mail to are verified destinations. No outcome is reported for verified destinations; the Outbox marks their hand-overs made while they were verified.",
  },
  "setup.verified.recipients": { one: "{n} address", other: "{n} addresses" },
  /** The account's whole destination list, counted (ADR 47); the addresses only when the box below is ticked. */
  "setup.verified.listed": "Destination addresses in the account: {verified} verified, {waiting} waiting for verification.",
  "setup.verified.showAddresses": "Show the addresses",
  "setup.verified.addresses": "The account's destination addresses",
  "setup.verified.state.verified": "verified",
  "setup.verified.state.waiting": "waiting for verification",

  "setup.destination.title": "Register a destination address",
  "setup.destination.about":
    "A forward goes only to a verified destination. Registering one makes Cloudflare mail it a link; until someone at that address clicks it, it is waiting for verification and nothing can be forwarded to it. This Node deletes no destination.",
  "setup.destination.email": "Address",
  "setup.destination.add": "Register",
  "setup.destination.waiting": "{email} is waiting for verification until someone at that address clicks the link Cloudflare mailed them.",
  "setup.destination.alreadyWaiting": "{email} was already registered and is waiting for verification; no second link was sent.",
  "setup.destination.verified": "{email} is a verified destination.",

  /** A forward rule's choice, and what a take-over that kept the forward left (ADR 47). */
  "setup.rules.keptForward": "It keeps forwarding to {to}, after each message is stored here.",
  /** Copies with a kept forward (ADR 47, amended 3 October 2026): the box, what a copy is, and what the take-over did. */
  "setup.rules.copy": "Also send a copy when Cloudflare refuses the forward as not verified",
  "setup.rules.copyAbout":
    "A copy is sent from {address}: the recipient sees it from \"<sender> via {mailbox}\", and replies go to the sender. One copy goes to every destination refused for a message, and names them all in its To. Up to {size}. A message with an attachment this Node judges dangerous, a quarantined one, or one that failed DMARC is not copied. Each copy counts towards today's sending, is in the Outbox like any send, and is sealed under you, so you need send.propose on the mailbox.",
  "setup.rules.copyOn": "When the forward is refused as not verified, a copy is sent from {address}.",
  /**
   * A Worker rule's forward (ADR 47, amended 7 October 2026): the box the addresses go in, what filled it from the
   * Worker's code (offered, never applied by itself), and what the take-over left.
   */
  "setup.rules.forwardTo": "Forward to (separated by commas)",
  "setup.rules.foundIn": "Filled in from the addresses {worker}'s code names that the account lists as verified destinations. Check them before you confirm.",
  "setup.rules.foundNothing": "{worker}'s code names no verified destination of the account, so type the addresses.",
  "setup.rules.forwardsTo": "It forwards to {to}, after each message is stored here.",
} as const satisfies Area<"setup">;
