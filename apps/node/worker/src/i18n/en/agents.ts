import type { CapabilityId } from "@mailda/contract/capability";

import type { Area } from "../areas.ts";

/**
 * Agents (`src/client/app/screens/agents.tsx`): agent principals, their capabilities and sponsor mailboxes. Its
 * heading is the route's name, `route./agents`. A capability's description is `capability.<id>` (layer 3), and a
 * capability id this interface does not know shows the Node's `says` in `<NodeWords>`; the mint's notice is
 * `agents.mint.token`, with the expiry in the viewer's format; a relation's description is `api.agent.*`. Capability ids and relation tokens stay Latin, in mono.
 */
export const agents = {
  "agents.lede":
    "A machine identity acting under a named person's authority. It can never hold more than that person holds, and every act it takes lands in the audit trail under both.",
  "agents.none": "No agent has been minted on this Node.",

  "agents.col.name": "Name",
  "agents.col.sponsor": "Sponsor",
  "agents.col.may": "May do",
  "agents.col.where": "Where",
  "agents.col.standing": "Standing",
  "agents.col.expires": "Expires",
  "agents.col.withdraw": "Withdraw",

  "agents.standing.revoked": "revoked",
  "agents.standing.expired": "expired",
  "agents.standing.live": "live",
  /** A capability held in part: how many of its pinned routes the agent holds. */
  "agents.held.partial": "{held} of {total}",
  "agents.unnamed": { one: "{n} pinned route this Node no longer names:", other: "{n} pinned routes this Node no longer names:" },
  "agents.noMailbox": "no mailbox",
  "agents.notEffective": "not effective — the sponsor no longer holds this",
  "agents.withdraw": "Withdraw",

  "agents.mint.heading": "Mint an agent",
  "agents.mint.actingFor": "Acting for",
  "agents.mint.actingFor.note": "The agent can never exceed this person, and stops when their access does.",
  "agents.mint.name": "Name",
  "agents.mint.name.placeholder": "what this agent is for",
  "agents.mint.may": "What it may do",
  "agents.mint.reachesContent": "reaches message content",
  "agents.mint.which": "Which mailboxes, and how",
  "agents.mint.which.note":
    "Nothing is granted by default, and an agent can never exceed its sponsor: a relation the sponsor does not hold is refused when you mint, rather than written and silently never matching.",
  "agents.mint.noMailbox": "No mailbox on this Node yet.",
  "agents.mint.holdsNothing": "this person holds nothing here",
  "agents.mint.days": "Expires after (days)",
  "agents.review": "This agent will hold {capabilities} across {relations}, until it expires or is withdrawn.",
  "agents.review.capabilities": { one: "{n} capability", other: "{n} capabilities" },
  "agents.review.relations": { one: "{n} mailbox relation", other: "{n} mailbox relations" },
  "agents.review.bounded":
    "Every one of them also stops the moment the sponsor loses that access — an agent is bounded by the person it acts for, checked on each request rather than at this moment.",
  "agents.review.unmet":
    "{capability} needs {missing} on the same mailbox as its other relations — no mailbox here carries all of them, so the agent will authenticate and be refused.",
  "agents.mint.renewal":
    "There is no refresh and no way to widen a ceiling later — re-minting is the renewal, and it issues a new token.",
  /** Shown once with a freshly minted token; `{at}` is its expiry. */
  "agents.mint.token": "This token is shown once and cannot be shown again. It expires on {at} and there is no refresh — re-mint to renew.",
  "agents.mint.submit": "Mint agent",

  // A capability's description, keyed by its id (`CAPABILITY_IDS`). The English is the Node's `says`, byte for byte:
  // `test/node/capability-words.test.ts` holds the two equal, so the contract's words and these cannot drift.
  "capability.mail.read":
    "Read mail: list the mailboxes you may read, page their messages, open one or read its header block, and fetch the original bytes. The original `.eml` needs `message.export` as well as content read — the route checks both.",
  "capability.mail.label":
    "Put words on a message, or take them off, to find it again, and mark it read or unread for yourself. Reads nothing a mail.read holder cannot. A label change is audited with the words named; read state is your own bookmark and is not.",
  "capability.mail.place":
    "Move a message between your Inbox, Archive and Trash. Your own view only: nobody else's Inbox changes, nothing is destroyed, and Trash can always be moved back.",
  "capability.mail.hold":
    "Hold a received message back from its mailbox's queue, with the reason in words and, from a model, its score. The act a classifier you run reaches (#263). An administrator releases it, and the release is the answer the next run learns from. Reads nothing a mail.read holder cannot.",
  "capability.mail.draft":
    "Write and revise drafts. Sending is not included and cannot be — sealing a send is withheld from every machine.",
  "capability.send.observe":
    "See what has been sent, how each delivery went, and the bytes that were submitted. The submitted message needs `message.export` as well as content read, the same as an inbound original.",
  "capability.send.cancel":
    "Cancel a send that has not gone out yet. Its own capability rather than part of observing, because it stops somebody else's message leaving.",
  "capability.queue.read":
    "See where there is work: the mailboxes you may send from, and each one's case queue.",
  "capability.queue.assign":
    "Hand a case to a colleague who may answer it. Triage, which is what a machine reading a queue is for; the colleague can hand it back, and the trail names both of you.",
  "capability.notice.read":
    "Read the notices due on the mailboxes this credential can read — what is waiting, and on which mailbox. Not notices addressed to a person: those reach the person they name.",
  "capability.health.read":
    "Read this Node's own condition: the doctor's findings, the send breakers and any domain pauses. The doctor's organization-wide half is an administrator's and is not included.",
  "capability.identity.read":
    "Read who this credential is acting as and whose authority it borrows, the relations it actually holds, and the signing keys a client needs to check a session.",
  "capability.directory.read":
    "Read the teams this organization has and how many people are in each. Not who is in them and not what they hold — both of those are an administrator's.",
  "capability.matter.open":
    "Open a matter and read the ones this credential opened. A matter is a folder that a hold or an export can be scoped to; opening one places no hold and reaches no mail.",
} as const satisfies Area<"agents">;

/** Every capability has words and no words are for a capability the contract does not list: compile errors here. */
type CapabilityKey = `capability.${CapabilityId}`;
agents satisfies Record<CapabilityKey, string>;
type Unlisted = Exclude<Extract<keyof typeof agents, `capability.${string}`>, CapabilityKey>;
type None<T extends never> = T;
export type NoUnlistedCapability = None<Unlisted>;
