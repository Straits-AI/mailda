import type { AppRoute } from "../../app-routes.ts";
import type { Area } from "../areas.ts";

/** Every route's search words, one per `AppRoute`: a route added without them is a compile error here. */
type AliasWords = { readonly [R in AppRoute as `palette.alias.${R}`]: string };

/**
 * The command palette (`src/client/app/ui/palette.tsx`).
 *
 * `palette.alias.*` are the extra words an item is found by, beside its label (critic L3). A viewer is never sent
 * another locale's table, so a Chinese one typing `inbox` or the pinyin initials `sjx` finds 收件箱 only because
 * the zh-Hans aliases carry those words. In English each alias is the route's own word, which the label
 * ("Go to Inbox") already contains, so English matching is exactly what it was.
 */
export const palette = {
  "palette.label": "Command palette",
  "palette.input": "Go to or do",
  "palette.placeholder": "Go to or do…",
  "palette.list": "Commands",
  "palette.go": "Go to {route}",
  /** `{term}` is the words as typed: the Node decides what a search means (#107). */
  "palette.search": "Search mail for “{term}”",
  "palette.group.message": "Message",
  "palette.group.mail": "Mail",
  "palette.group.go": "Go to",
  "palette.alias.compose": "compose",
  "palette.alias./": "inbox",
  "palette.alias./queue": "queue",
  "palette.alias./approvals": "approvals",
  "palette.alias./rules": "rules",
  "palette.alias./people": "people",
  "palette.alias./matters": "matters",
  "palette.alias./butlers": "butlers",
  "palette.alias./agents": "agents",
  "palette.alias./limits": "limits",
  "palette.alias./outbox": "outbox",
  "palette.alias./audit": "audit",
  "palette.alias./log": "log",
  "palette.alias./doctor": "doctor",
  "palette.alias./setup": "setup",
  "palette.alias./drafts": "drafts",
  "palette.alias./archive": "archive",
  "palette.alias./trash": "trash",
  "palette.alias./settings": "settings",
} as const satisfies AliasWords & Area<"palette">;
