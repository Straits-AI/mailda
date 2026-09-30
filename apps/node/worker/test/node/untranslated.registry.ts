/**
 * The untranslated-text scan's two registries (`test/node/untranslated.test.ts`, ADR 46). Data, read by the
 * test; nothing here is a pattern over source text.
 *
 * ## `UNMIGRATED`: the ratchet
 *
 * Each file's count of findings (untranslated words, unregistered non-words, and formatting outside
 * `src/client/app/format.ts`) as of the last change to it. The test fails when a count differs, in either
 * direction: a rise is a new untranslated string; a fall means the number here must come down with it, so
 * the next change cannot spend the difference. A file at zero is deleted from the list. When the list is
 * empty, every screen is migrated, and `preview` comes off the locales that have a complete catalog
 * (`docs/i18n.md`, "The preview flag").
 *
 * Counted on 30 September 2026 when the scan landed: 2330 findings in 32 files.
 *
 * ## `NOT_PROSE`: flagged, and not words
 *
 * A literal the scan flags that no person reads (an API path, a storage key, a media query) is registered
 * here by file and exact text, with its reason, and stops counting (every occurrence of that text in that file). An entry that matches nothing fails the
 * test, so the list cannot outlive the code. A position that is never words in any file belongs in the
 * scan's own structural rules (`test/node/support/untranslated.ts`) instead, with its reason there.
 */

export const UNMIGRATED: Readonly<Record<string, number>> = {
  "src/client/app.client.js": 245,
  "src/client/app/onboarding.tsx": 72,
  "src/client/app/screens/agents.tsx": 56,
  "src/client/app/screens/approvals.tsx": 37,
  "src/client/app/screens/butlers.tsx": 97,
  "src/client/app/screens/composer.tsx": 91,
  "src/client/app/screens/drafts.tsx": 8,
  "src/client/app/screens/first-run.tsx": 17,
  "src/client/app/screens/ledgers.tsx": 185,
  "src/client/app/screens/limits.tsx": 67,
  "src/client/app/screens/matters.tsx": 119,
  "src/client/app/screens/next-steps.tsx": 7,
  "src/client/app/screens/people.tsx": 125,
  "src/client/app/screens/policies.tsx": 73,
  "src/client/app/screens/queue.tsx": 114,
  "src/client/app/screens/reader.tsx": 137,
  "src/client/app/screens/setup.tsx": 185,
  "src/client/app/ui/menu.tsx": 2,
  "src/client/app/ui/popover.tsx": 6,
  "src/client/app/ui/section-tabs.tsx": 1,
  "src/client/delivery.client.js": 134,
  "src/client/session.client.js": 23,
  "src/client/theme.client.js": 7,
};

export interface NotProse {
  /** The finding's exact text (a template's literal parts joined, trimmed). */
  readonly text: string;
  readonly reason: string;
}

/**
 * By file, relative to the worker package, so people migrating different files edit different lines. A file
 * with no entries may be listed with an empty array or left out.
 */
export const NOT_PROSE: Readonly<Record<string, readonly NotProse[]>> = {
  "src/client/app.client.js": [],
  "src/client/app/api.ts": [
    ...[
      "thread", "notifications", "me", "messages", "headers", "sends", "audit", "access.revoked",
      "logs", "doctor", "mailboxes", "readable", "cases", "quarantine", "drafts", "butlers",
      "butler", "butler-runs", "transport", "search-failed", "passkeys", "approvals", "policies", "people",
      "teams", "team-members", "breakers", "domain-pauses", "suppressions", "matters", "holds", "supervised",
      "exports", "invitations", "agent-capabilities", "agents", "sponsor-mailboxes", "provider", "provider-delivery-events", "provider-routing",
    ].map((text) => ({ text, reason: "a TanStack Query cache key: compared and invalidated, never shown" })),
    ...["POST", "PUT", "PATCH", "DELETE"].map((text) => ({ text, reason: "an HTTP method" })),
    { text: "application/json", reason: "a media type in a content-type header" },
    ...["?conversation=", "?action=access.revoked", "?collect=1", "?after=", "?domain="]
      .map((text) => ({ text, reason: "a URL query string the route reads" })),
    { text: "register", reason: "the passkey challenge's purpose token, sent to the Node" },
    { text: "re-run", reason: "the replay mode token, sent to the Node" },
    { text: "manifest.json", reason: "an export object's file name, part of a URL" },
    { text: "ReadFailure", reason: "an Error subclass's name, for stack traces" },
  ],
  "src/client/app/chrome.tsx": [
    { text: "(max-width: 1119.98px)", reason: "a media query, the narrow layout's breakpoint" },
    { text: "rail-row", reason: "a class name, a Row's default" },
    { text: "current", reason: "a class name, added to activeProps' className" },
    { text: "rail-row rail-mailbox", reason: "a class name, in activeProps" },
    { text: "/queue", reason: "a route path, the Link's `to`" },
    { text: "/doctor", reason: "a route path, the Link's `to`" },
    { text: "sends", reason: "a query key" },
    { text: "c", reason: "a KeyboardEvent.key, the Compose shortcut" },
    { text: "z", reason: "a KeyboardEvent.key, the Undo shortcut" },
  ],
  "src/client/app/health.ts": [],
  "src/client/app/main.tsx": [],
  "src/client/app/onboarding.tsx": [],
  "src/client/app/screens/agents.tsx": [],
  "src/client/app/screens/approvals.tsx": [],
  "src/client/app/screens/butlers.tsx": [],
  "src/client/app/screens/composer.tsx": [],
  "src/client/app/screens/drafts.tsx": [],
  "src/client/app/screens/first-run.tsx": [],
  "src/client/app/screens/inbox.tsx": [
    { text: "(max-width: 767.98px)", reason: "a media query, the single-pane breakpoint" },
    { text: "button.message-row", reason: "a CSS selector for the list's row buttons" },
    { text: "messages", reason: "a react-query key (`messagesKey`'s first element)" },
    { text: "mailboxes", reason: "a react-query key" },
    {
      text: "Re:",
      reason: "the reply subject's prefix, written into the outgoing mail: the mail's data, not this screen's words (docs/i18n.md, never persist a t() string); layer 2a (composer) owns whether a Chinese writer's reply says 回复：",
    },
    { text: "Fwd:", reason: "the forward subject's prefix, written into the outgoing mail, as Re: is" },
    { text: "On ,  wrote:", reason: "the reply's quote attribution, written into the outgoing mail's body, as Re: is" },
    { text: "r", reason: "a shortcut's key (`Shortcut.key`)" },
    { text: "a", reason: "a shortcut's key" },
    { text: "f", reason: "a shortcut's key" },
    { text: "e", reason: "a shortcut's key" },
    { text: "j", reason: "a shortcut's key" },
    { text: "k", reason: "a shortcut's key" },
    { text: "i", reason: "a shortcut's key" },
    { text: "R", reason: "a palette command's key cap (`PaletteCommand.hint`)" },
    { text: "A", reason: "a palette command's key cap" },
    { text: "F", reason: "a palette command's key cap" },
    { text: "E", reason: "a palette command's key cap" },
    { text: "Shift+I", reason: "a palette command's key cap" },
    { text: "message.reply", reason: "a palette command's id" },
    { text: "message.reply-all", reason: "a palette command's id" },
    { text: "message.forward", reason: "a palette command's id" },
    { text: "message.archive", reason: "a palette command's id" },
    { text: "message.trash", reason: "a palette command's id" },
    { text: "message.unread", reason: "a palette command's id" },
    { text: "message.read", reason: "a palette command's id" },
  ],
  "src/client/app/screens/ledgers.tsx": [],
  "src/client/app/screens/limits.tsx": [],
  "src/client/app/screens/matters.tsx": [],
  "src/client/app/screens/next-steps.tsx": [],
  "src/client/app/screens/people.tsx": [
    { text: "new-address", reason: "a document id, handed to AddressField, which sets it on its input" },
    { text: "invite-mailbox-address", reason: "a document id, handed to AddressField, which sets it on its input" },
  ],
  "src/client/app/screens/policies.tsx": [],
  "src/client/app/screens/queue.tsx": [],
  "src/client/app/screens/reader.tsx": [],
  "src/client/app/screens/setup.tsx": [
    { text: "new", reason: "a select's value meaning a new mailbox named after the address, never shown; never a mailbox id" },
    { text: "mailboxes", reason: "a react-query key, invalidated after a take-over made a mailbox" },
  ],
  "src/client/app/shell-context.tsx": [
    { text: "commands", reason: "a Symbol's description, seen only in a debugger" },
    { text: "outside ShellProvider", reason: "a programming error thrown when a hook is used outside its provider; never reaches a viewer" },
    { text: "dialog", reason: "a form's method token" },
    { text: ".message-row.current", reason: "a CSS selector" },
    { text: ".compose-button", reason: "a CSS selector" },
    { text: "composer-body", reason: "a document id" },
  ],
  "src/client/app/ui/menu.tsx": [],
  "src/client/app/ui/palette.tsx": [
    { text: "compose", reason: "an option's React key" },
    { text: "go", reason: "an option's React key, with the route after it" },
    { text: "search", reason: "an option's React key" },
    { text: "C", reason: "a key cap, shown in <kbd>" },
    { text: "palette-option-", reason: "a document id prefix" },
  ],
  "src/client/app/ui/popover.tsx": [],
  "src/client/app/ui/section-tabs.tsx": [],
  "src/client/app/ui/shortcuts.ts": [
    { text: "mailda.shortcuts", reason: "a localStorage key" },
    { text: "on", reason: "a stored value" },
    { text: "off", reason: "a stored value" },
    { text: "input, textarea, select, [contenteditable]:not([contenteditable=false])", reason: "a CSS selector" },
    { text: "dialog, [role=dialog], [role=menu], [role=listbox], .composer-dock", reason: "a CSS selector" },
  ],
  "src/client/delivery.client.js": [],
  "src/client/session.client.js": [],
  "src/client/theme.client.js": [],
};
