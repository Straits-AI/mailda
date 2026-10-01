import type { Area } from "../areas.ts";

/**
 * Agents (`src/client/app/screens/agents.tsx`): agent principals, their capabilities and sponsor mailboxes. Its
 * heading is the route's name, `route./agents`. A capability's description (`says`) and the mint's notice are the
 * Node's words, shown in `<NodeWords>`; a relation's description is `api.agent.*`. Capability ids and relation
 * tokens stay Latin, in mono.
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
  "agents.mint.submit": "Mint agent",
} as const satisfies Area<"agents">;
