import type { Area } from "../areas.ts";

/** The Drafts list (`src/client/app/screens/drafts.tsx`). Its heading is the route's name, `route./drafts`. */
export const drafts = {
  "drafts.empty": "No drafts.",
  /** The noun in `chrome.truncated`. */
  "drafts.noun": "drafts",
  "drafts.noSubject": "(no subject)",
  "drafts.noRecipient": "no recipient yet",
} as const satisfies Area<"drafts">;
