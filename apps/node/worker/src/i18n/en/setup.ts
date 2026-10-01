import type { Area } from "../areas.ts";

/**
 * Setup (`src/client/app/screens/setup.tsx`), which is not migrated yet: only the words added to it since the
 * catalog landed. The choices a routing rule offers are the Node's own words (`takeOver`), shown in `<NodeWords>`.
 */
export const setup = {
  /** The mailbox a taken-over address files into when none of the existing ones is chosen; `mailda setup` says the same. */
  "setup.rules.newMailbox": "a new mailbox named {address}",
  /** Said under a take-over refused after the screen made the mailbox for it; `mailda setup` says the same. */
  "setup.rules.mailboxStays": "The mailbox {name} was made for it and stays.",
  /** Beside the confirm, where no mailbox is chosen: the address row's own, or the only one. */
  "setup.rules.filesInto": "Files into {name}.",
  /** After a take-over whose rule did not read back with the name recording where it went (critic H1). */
  "setup.rules.nameNotRecorded": "Its name does not record where it went, so only this Node can put it back: do that before the Node is ever deleted.",
} as const satisfies Area<"setup">;
