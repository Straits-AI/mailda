import type { Area } from "../areas.ts";

/** What the whole shell shares (`src/client/app/shell-context.tsx`): the mailbox chooser and the toasts. */
export const shell = {
  "shell.chooser.label": "Choose a mailbox",
  "shell.chooser.from": "Send from",
  "shell.chooser.none": "Choose a mailbox…",
  /** A mailbox by its name and first address; two mailboxes can share a name, never an address. */
  "shell.chooser.option": "{name} · {address}",
  "shell.chooser.option.no_address": "{name} (no address)",
  "shell.chooser.start": "Start message",
  "shell.cancel": "Cancel",
  "shell.toast.dismiss": "Dismiss",
  "shell.sealing": "Still sealing the open message. Open this again once the Node has answered it.",
  "shell.no_mailbox": "Sending needs send.propose on a mailbox, and you hold it on none.",
  /** The Z shortcut's description (`src/client/app/ui/shortcuts.ts`). */
  "shortcuts.undo": "Undo",
} as const satisfies Area<"shell">;
