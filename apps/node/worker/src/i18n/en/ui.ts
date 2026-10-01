import type { Area } from "../areas.ts";

/**
 * The small shared pieces, one prefix with a segment per file: `ui.menu.*` (`src/client/app/ui/menu.tsx`),
 * `ui.popover.*` (`src/client/app/ui/popover.tsx`), `ui.sectionTabs.*` (`src/client/app/ui/section-tabs.tsx`),
 * `ui.firstRun.*` (`src/client/app/screens/first-run.tsx`) and `ui.nextSteps.*`
 * (`src/client/app/screens/next-steps.tsx`). The menu, the popover and the section tabs have no words of their
 * own (their callers pass them), so only the two screens have keys. Next steps' Claim and Release are the
 * Queue's own words (`queue.act.claim`, `queue.act.release`): the same act on the same case.
 */
export const ui = {
  "ui.firstRun": "Setup needed",
  "ui.firstRun.heading": "This Node is not ready to use yet",
  "ui.firstRun.lead":
    "It has been deployed and claimed. Before it can be used as an inbox it needs an address and mail routed to it; this is where that stands.",
  "ui.firstRun.next": "Next step",
  /** `{step}` is the step's `phrase` (`onboarding.step.*.phrase`): the label as it reads inside a sentence. */
  "ui.firstRun.next.heading": "Next: {step}",
  "ui.firstRun.terminal": "From a terminal (recommended, no token)",
  /** `Copyable`'s noun, in `chrome.copy` ("Copy command"). */
  "ui.firstRun.terminal.what": "command",
  "ui.firstRun.terminal.body":
    "Run it in the directory the install made. After the deploy it asks which domain this Node receives at and sets up receiving, sending and delivery outcomes with the consent wrangler already has.",
  "ui.firstRun.browser": "From this screen",
  /** `{link}` is `ui.firstRun.browser.link`, a link to Setup. */
  "ui.firstRun.browser.body":
    "The browser has no wrangler, so this way needs the Node's own credential: {link}. On an apex domain the catch-all is one act, and addresses are then managed on this Node.",
  "ui.firstRun.browser.link": "connect this Node with one API token, then set up receiving there",
  "ui.firstRun.anyway": "Open the app anyway",
  "ui.firstRun.anyway.note": "(this tab only; sending will refuse until an address is routed)",

  "ui.nextSteps": "Next steps",
  "ui.nextSteps.fromSender": "More from this sender",
  /** The badge on an AI result: the same two letters in every locale, as a product name is. */
  "ui.nextSteps.ai": "AI",
  "ui.nextSteps.provenance": "{profile} · {model} · run {runId} · {at}",
} as const satisfies Area<"ui">;
