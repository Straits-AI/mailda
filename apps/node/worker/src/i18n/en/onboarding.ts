import type { Area } from "../areas.ts";

/**
 * Onboarding progress (`src/client/app/onboarding.tsx`): the setup steps, their states and details, and the shell's
 * one-line notice. A step is keyed by its id twice: its label, and its `phrase`, the label as it reads inside a
 * sentence ("next: mail routed to this Node"), which English lowercases at its first word only.
 *
 * A detail that quotes a source (Cloudflare's error, the Node's routing outcome) gets those words as `{said}`, inside
 * `<NodeWords>`; every other detail is this interface's.
 */
export const onboarding = {
  "onboarding.step.address": "An address to receive at",
  "onboarding.step.address.phrase": "an address to receive at",
  "onboarding.step.routed": "Mail routed to this Node",
  "onboarding.step.routed.phrase": "mail routed to this Node",
  "onboarding.step.sending": "A domain onboarded for sending",
  "onboarding.step.sending.phrase": "a domain onboarded for sending",
  "onboarding.step.outcomes": "Delivery outcomes observed",
  "onboarding.step.outcomes.phrase": "delivery outcomes observed",
  "onboarding.step.connected": "Connected to Cloudflare",
  "onboarding.step.connected.phrase": "connected to Cloudflare",

  "onboarding.state.done": "done",
  "onboarding.state.todo": "to do",
  "onboarding.state.unknown": "unknown",
  "onboarding.state.optional": "optional",

  /** The audit trail's record standing in for a live read, by how the act came about. */
  "onboarding.record.install": "{domain}, set up at install on {date} (a record, not a live read)",
  "onboarding.record.token": "{domain}, set up through the held token on {date} (a record, not a live read)",
  "onboarding.record.observed": "{domain}, in place on Cloudflare before this Node, observed on {date} (a record, not a live read)",
  "onboarding.record.none": "not set up; the installer or the Setup screen does it",

  /** One domain and what is true of it; `{said}` may be the source's own words. */
  "onboarding.domain": "{domain}: {said}",
  /** Between one domain's line and the next. */
  "onboarding.join": "; ",
  "onboarding.required": { one: "{n} record still required", other: "{n} records still required" },

  "onboarding.connected.unread": "the connection state could not be read",
  "onboarding.connected.account": "account {account}",
  "onboarding.connected.optional": "only for changing the Cloudflare setup from this screen",
  "onboarding.notRead": "not read",
  "onboarding.needsConnection": "needs the connection first",
  "onboarding.address.unread": "doctor could not be read",
  "onboarding.address.unreported": "doctor did not report on inbound routing",
  "onboarding.address.done": "an address is configured",
  "onboarding.address.todo": "no address is configured; add one on People",
  "onboarding.routed.unread": "routing could not be read with the held token",
  "onboarding.routed.none": "no domain to route yet",
  "onboarding.routed.off": "routing not enabled",
  "onboarding.delivery.unread": "delivery events could not be read with the held token",
  "onboarding.sending.none": "no domain onboarded for sending yet",
  "onboarding.sending.notOnboarded": "not onboarded for sending",
  "onboarding.sending.off": "sending not enabled",
  "onboarding.outcomes.none": "nothing to subscribe yet",
  "onboarding.outcomes.noSubscription": "no subscription",
  "onboarding.outcomes.off": "subscription not enabled",
  "onboarding.outcomes.noQueue": "no queue",
  "onboarding.outcomes.noConsumer": "no consumer on the queue",

  "onboarding.progress.label": "Setup progress",
  /**
   * `{done}` and `{total}` are counts inside elements. Not a plural: `total` is the five steps less the optional
   * connection, so four or five, never one.
   */
  "onboarding.progress.done": "{done} of {total} steps done.",
  "onboarding.progress.next": "{done} of {total} steps done; next: {next}.",
  "onboarding.progress.optional": "The fifth is optional.",

  "onboarding.unfinished.address": "Setup is unfinished: {step} ({detail}).",
  "onboarding.unfinished.routed": "Setup is unfinished: mail is not routed to this Node yet.",
  "onboarding.unfinished.go": "Go to Setup",
} as const satisfies Area<"onboarding">;
