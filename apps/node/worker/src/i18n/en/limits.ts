import type { Area } from "../areas.ts";

/**
 * Sending limits (`src/client/app/screens/limits.tsx`): breakers, paused domains and suppressions.
 *
 * One verb for a domain, pause, and one count (D3): placing a pause takes two administrators besides whoever
 * asks, lifting one takes a single administrator (`src/domain-pause.ts`). A breaker's own sentence is the Node's
 * and is not here (`<NodeWords>`).
 *
 * `limits.window.*` are plurals on the window's leading unit; `limits.cause.*` is keyed by `SuppressionRow`'s
 * `cause`, and `limits.state.unarmed.*` by `BreakerReading`'s `unarmedReason`.
 */
export const limits = {
  "limits.title": "Sending limits",

  "limits.breakers": "Breakers",
  "limits.breakers.caption":
    "Rates this Node applies to itself. Every limit is a measured budget, not a setting — changing one means changing its receipt.",
  "limits.col.breaker": "Breaker",
  "limits.col.now": "Now",
  "limits.col.over": "Over",
  "limits.col.seen": "Seen",
  "limits.col.state": "State",
  "limits.reading.unarmed": "not enough traffic to judge",
  "limits.reading.count": "{observed} of {limit}",
  "limits.reading.percent": "{percent}% of {limit}%",
  "limits.window.days": { one: "{n} day", other: "{n} days" },
  "limits.window.hours": { one: "{n} hour", other: "{n} hours" },
  "limits.window.minutes": { one: "{n} minute", other: "{n} minutes" },
  "limits.state.tripped": "stopping mail",
  "limits.state.armed": "armed",
  "limits.state.unarmed": "unarmed",
  "limits.state.unarmed.no_observations": "unarmed — no observations",

  "limits.pauses": "Paused domains",
  /** The table's scroller: its own name, as two landmarks with one name are one too many (axe landmark-unique). */
  "limits.pauses.list": "Domains paused now",
  "limits.pauses.lead":
    "Pausing a domain takes the agreement of two other administrators; whoever asks is never one of them. Lifting a pause takes a single administrator, alone, because a mistake in the cautious direction should be easy to undo.",
  "limits.pauses.asked": "Asked. Two other administrators have to agree before this domain is paused.",
  "limits.pauses.domain": "Domain",
  "limits.why": "Why",
  "limits.since": "Since",
  "limits.pauses.act": "Ask to pause this domain",
  "limits.pauses.lift": "Lift",
  "limits.pauses.liftAct": "Let it send again",
  "limits.pauses.empty": "No domain is paused.",

  "limits.suppressed": "Suppressed recipients",
  "limits.suppressed.heading": "Recipients this Node will not send to",
  "limits.suppressed.lead":
    "An address the provider hard-bounced, or that marked a message as spam. A send naming one is refused at the seal, by name. Nothing is added here by hand; an administrator can vouch for an address with a reason, and a later bounce puts it back.",
  /** The list's noun in `chrome.truncated`, with its own measure word in a language that counts with one (F5). */
  "limits.suppressed.noun": "addresses",
  "limits.suppressed.address": "Address",
  "limits.cause.complaint": "marked as spam",
  "limits.cause.hard_bounce": "hard bounce",
  "limits.vouch": "Vouch",
  "limits.vouch.why": "Why {address} is good again",
  "limits.suppressed.empty": "No address is suppressed on this Node.",
} as const satisfies Area<"limits">;
