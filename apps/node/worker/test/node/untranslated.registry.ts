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

export const UNMIGRATED: Readonly<Record<string, number>> = {};

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
  "src/client/app.client.js": [
    ...[
      "notice", "bad", "hint", "primary", "split", "split-lede", "panel", "sub", "errors", "codes", "mono", "dim", "linkish",
      "field", "field mono", "field session mono", "field-row", "dot live", "dot idle", "shell",
    ].map((text) => ({ text, reason: "a class name, set with `class` or classList: a style hook, never shown" })),
    ...["app", "status", "org", "email", "password", "secret", "invitation", "join-password"]
      .map((text) => ({ text, reason: "a document id (`getElementById`, or the id a field's label points at)" })),
    ...["required", "novalidate", "submit", "button", "alert", "off", "username", "new-password", "current-password"]
      .map((text) => ({ text, reason: "an attribute's token (required, novalidate, a button or input type, a role, an autocomplete token)" })),
    { text: "en", reason: "a language tag, the `lang` of the Node's marked words" },
    { text: "modulepreload", reason: "a link relation token" },
    { text: "click", reason: "a DOM event name, in the element helper" },
    { text: "[data-reveal]", reason: "a CSS selector" },
    { text: "--reveal-delay", reason: "a CSS custom property's name" },
    { text: "ms", reason: "a CSS unit, after the reveal delay's figure" },
    ...["/health", "/api/claim", "/api/auth/login", "/api/auth/passkeys/challenge", "/api/auth/passkeys/verify", "/api/invitations/redeem"]
      .map((text) => ({ text, reason: "a route path the page fetches" })),
    { text: "/app/shell.js", reason: "the shell bundle's URL, preloaded and imported after sign-in" },
    { text: "POST", reason: "an HTTP method" },
    { text: "application/json", reason: "a media type in a content-type header" },
    { text: "authenticate", reason: "the passkey challenge's purpose token, sent to the Node" },
    { text: "signed-in", reason: "what the passkey function returns on success, compared by its caller, never shown" },
  ],
  "src/client/app/api.ts": [
    ...[
      "thread", "notifications", "me", "messages", "headers", "sends", "audit", "access.revoked",
      "logs", "doctor", "mailboxes", "readable", "cases", "quarantine", "drafts", "butlers",
      "butler", "butler-runs", "transport", "search-failed", "passkeys", "approvals", "policies", "people",
      "teams", "team-members", "breakers", "domain-pauses", "suppressions", "matters", "holds", "supervised",
      "exports", "invitations", "agent-capabilities", "agents", "sponsor-mailboxes", "provider", "provider-delivery-events", "provider-routing",
      "forwards",
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
  "src/client/app/onboarding.tsx": [
    ...["verdict-ok", "severity-degraded", "state-outcome_unknown", "severity-report"]
      .map((text) => ({ text, reason: "a class name, a step state's chip colour (`CHIP`)" })),
    { text: "/setup", reason: "a route path, the notice's Link `to` and the path it hides on" },
  ],
  "src/client/app/screens/agents.tsx": [
    { text: "agents", reason: "a react-query key" },
    { text: "col", reason: "a <th> scope token" },
  ],
  "src/client/app/screens/approvals.tsx": [
    ...["approvals", "sends", "notifications"].map((text) => ({ text, reason: "a react-query key: invalidated, never shown" })),
  ],
  "src/client/app/screens/butlers.tsx": [
    {
      text: [
        "# A new Butler. It does nothing yet — the one node below stops immediately.",
        "#",
        "# Delete these comments or keep them: the text you write is stored exactly as you write it, and",
        "# comments are the reason this is YAML rather than JSON. Switch the format to json above if you",
        "# would rather write it that way; nothing here rewrites your text for you.",
        "apiVersion: mailda/v1",
        "kind: Butler",
        "metadata:",
        "  name: new butler",
        "  # A team rather than a person, so a leaver does not strand the Butler.",
        "  owner: team:support",
        "",
        "# Nothing is permitted until it is listed here. An empty list is a Butler that can read its trigger",
        "# and decide, and can cause no effect at all.",
        "capabilities: []",
        "",
        "trigger:",
        "  event: mail.received",
        "  mailbox: support@example.com",
        "",
        "entry: halt",
        "nodes:",
        "  - id: halt",
        "    type: stop",
        "    reason: not doing anything yet",
      ].join("\n"),
      reason: "STARTER, a new Butler's source, written into the Node as the Butler's own text and edited by its author: data, not this screen's words, in the author's hands whatever the interface's language (docs/i18n.md, never persist a t() string)",
    },
    { text: "new butler", reason: "a new Butler's name, written into the Node with its source: data, as STARTER is" },
    ...["butlers", "butler", "butler-runs"].map((text) => ({ text, reason: "a TanStack Query cache key: invalidated, never shown" })),
    { text: "col", reason: "a <th> scope token" },
  ],
  "src/client/app/screens/composer.tsx": [
    {
      text: "Re:",
      reason: "the reply subject's prefix, written into the outgoing mail: the mail's data, not this screen's words, English whatever the interface's language (docs/i18n.md)",
    },
    { text: "Fwd:", reason: "the forward subject's prefix, written into the outgoing mail, as Re: is" },
    { text: "/api/drafts", reason: "an API path" },
    { text: "/api/drafts/", reason: "an API path, before the draft's id" },
    { text: "/api/drafts?inReplyTo=", reason: "an API path and the query string the route reads" },
    { text: "/api/sends", reason: "an API path" },
    ...["PUT", "POST", "DELETE"].map((text) => ({ text, reason: "an HTTP method" })),
    { text: "application/json", reason: "a media type in a content-type header" },
    { text: "application/octet-stream", reason: "the media type sent for a file the browser gave none" },
    { text: "sends", reason: "a query key" },
    { text: "drafts", reason: "a query key" },
    { text: "/outbox", reason: "a route path, where a seal navigates" },
  ],
  "src/client/app/screens/drafts.tsx": [],
  "src/client/app/screens/first-run.tsx": [
    { text: "curl -fsSL https://mailda.site/update.sh | bash", reason: "a shell command, copied and run as it is; shown in mono" },
    { text: "mailda.first-run.override", reason: "a sessionStorage key" },
    { text: "/setup", reason: "a route path, the Link's `to`" },
  ],
  "src/client/app/screens/inbox.tsx": [
    { text: "(max-width: 767.98px)", reason: "a media query, the single-pane breakpoint" },
    { text: "button.message-row", reason: "a CSS selector for the list's row buttons" },
    { text: "messages", reason: "a react-query key (`messagesKey`'s first element)" },
    { text: "mailboxes", reason: "a react-query key" },
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
  "src/client/app/screens/ledgers.tsx": [
    ...["sends", "transport", "doctor", "search-failed"]
      .map((text) => ({ text, reason: "a TanStack Query cache key: invalidated, never shown" })),
    ...["/api/sends//cancel", "/api/sends//release-hold", "/api/sends//release", "/api/sends//retry"]
      .map((text) => ({ text, reason: "a route path the screen fetches" })),
    { text: "POST", reason: "an HTTP method" },
    { text: "application/json", reason: "a media type in a content-type header" },
    { text: "resend-may-duplicate", reason: "the retry route's mode token, sent to the Node" },
    { text: "retry-effect", reason: "the retry route's mode token, sent to the Node" },
    {
      text: "col",
      reason: "a <th scope> token (col, row): never shown. A position that is never words in any file, so `scope` belongs in STRUCTURAL_ATTRIBUTES; left here so no other file's count moves mid-layer",
    },
    { text: ".eml", reason: "the submitted bytes' file format, the link's label in every locale, as a file name is" },
    { text: "Email Sending: Edit", reason: "Cloudflare's own name for the API token permission, as its dashboard shows it; in mono, not ours to translate" },
  ],
  "src/client/app/screens/limits.tsx": [
    ...["domain-pauses", "approvals", "suppressions"]
      .map((text) => ({ text, reason: "a TanStack Query cache key: invalidated, never shown" })),
    { text: "col", reason: "a <th> scope token" },
    { text: "example.com", reason: "an input's placeholder that is a domain, the shape the field takes (RFC 2606's example domain), the same in every locale" },
  ],
  "src/client/app/screens/matters.tsx": [
    ...["matters", "holds", "supervised", "exports", "approvals"]
      .map((text) => ({ text, reason: "a TanStack Query cache key: invalidated, never shown" })),
    { text: "col", reason: "a <th> scope token" },
    {
      text: "no longer required",
      reason: "the reason sent with a hold lift, persisted by the Node and read by the approvers: data in its writer's language, never a t() string (docs/i18n.md, L10)",
    },
    { text: "manifest.json", reason: "an export object's file name, the link's label in every locale, as a file name is" },
  ],
  "src/client/app/screens/next-steps.tsx": [],
  "src/client/app/screens/people.tsx": [
    { text: "forwards", reason: "a TanStack Query cache key: invalidated, never shown" },
    { text: "new-address", reason: "a document id, handed to AddressField, which sets it on its input" },
    { text: "invite-mailbox-address", reason: "a document id, handed to AddressField, which sets it on its input" },
    { text: "hello@example.com", reason: "an example address in an address field's placeholder: an address is Latin in every locale" },
    { text: "hello", reason: "an example local part in an address field's placeholder, beside the fixed domain: Latin in every locale" },
    { text: "grant---", reason: "a checkbox id's fixed parts (`grant-<person>-<object>-<relation>`), never shown" },
    { text: "team--", reason: "a checkbox id's fixed parts (`team-<team>-<person>`), never shown" },
    { text: "forward-", reason: "a document id's fixed part (`forward-<address>`) for the Change forwards box, never shown" },
    {
      text: "passkey",
      reason: "the label a passkey is stored under when none is typed: data written into the Node, so never a t() string (docs/i18n.md, critic L10)",
    },
    ...["teams", "team-members", "passkeys", "audit", "people", "invitations", "mailboxes"]
      .map((text) => ({ text, reason: "a react-query key: invalidated, never shown" })),
    { text: "col", reason: "a <th> scope token" },
  ],
  "src/client/app/screens/policies.tsx": [
    { text: "new rule", reason: "a new rule's name, prefilled and written into the Node by createPolicy: data, never a t() string (docs/i18n.md)" },
    ...["true", "false"].map((text) => ({ text, reason: "a three-state condition's <option> value, parsed back to a boolean, never shown" })),
    { text: "policies", reason: "a TanStack Query cache key: invalidated, never shown" },
    { text: "col", reason: "a <th> scope token" },
  ],
  "src/client/app/screens/queue.tsx": [
    { text: "cases", reason: "a react-query key" },
    { text: "mailboxes", reason: "a react-query key" },
    { text: "quarantine", reason: "a react-query key" },
    { text: "col", reason: "a <th> scope token" },
  ],
  "src/client/app/screens/reader.tsx": [
    { text: "body", reason: "a TanStack Query cache key" },
    { text: "messages", reason: "a TanStack Query cache key: invalidated, never shown" },
    { text: "mailboxes", reason: "a TanStack Query cache key: invalidated, never shown" },
    { text: "cases", reason: "a TanStack Query cache key: invalidated, never shown" },
    { text: "/api/messages//body", reason: "a route path the pane fetches" },
    { text: "/api/messages//raw", reason: "a route path the original downloads from" },
    {
      text: "<!doctype html><html data-theme=\"\"><link rel=\"stylesheet\" href=\"/app/frame.css\">",
      reason: "the body frame's own markup (`frameHead`): read by the browser, never by a person",
    },
    { text: "data-script=\"\"", reason: "the body frame's script attribute, markup as `frameHead`'s is" },
    { text: "[aria-haspopup=menu]", reason: "a CSS selector for the ••• menu's trigger" },
    { text: ".eml", reason: "the submitted bytes' file format, the link's label in every locale, as a file name is" },
    { text: "&lt;", reason: "the angle bracket around a sender's address, an HTML entity in JSX text" },
    { text: "&gt;", reason: "the angle bracket around a sender's address, an HTML entity in JSX text" },
  ],
  "src/client/app/format.ts": [
    ...["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((text) => ({
      text,
      reason: "English's own month table, read only when the interface is English (`monthDay`, `recordDay`); every other locale's "
        + "dates come from Intl. Words, registered because they are the en formatter's data, not a message: a catalog "
        + "key would give each locale a table nothing reads",
    })),
  ],
  "src/client/app/screens/setup.tsx": [
    { text: "forwards", reason: "a TanStack Query cache key: invalidated, never shown" },
    { text: "someone@example.com", reason: "an example address in a destination field's placeholder: an address is Latin in every locale" },
    { text: "new", reason: "a select's value meaning a new mailbox named after the address, never shown; never a mailbox id" },
    { text: "mailboxes", reason: "a react-query key, invalidated after a take-over made a mailbox" },
    ...["provider", "provider-routing"].map((text) => ({ text, reason: "a react-query key, invalidated after a write" })),
    { text: "col", reason: "a <th> scope token" },
    { text: "E_PROVIDER_ACCOUNT_AMBIGUOUS", reason: "the Node's error code, compared to decide whether to ask for an account id; never shown by this file" },
    ...["mail.example.com", "inbox@mail.example.com", "example.com"]
      .map((text) => ({ text, reason: "a placeholder's example domain or address: the field's format, the same in every locale" })),
    { text: "mailda setup", reason: "a CLI command, in mono: identifiers stay Latin (docs/i18n.md, Register)" },
    { text: "delivered", reason: "Cloudflare's event kind, in mono beside this Node's word for it, accepted (D31): an identifier" },
    { text: "curl -fsSL https://mailda.site/update.sh | bash", reason: "the update command, in mono, run as written in every locale" },
  ],
  "src/client/app/shell-context.tsx": [
    { text: "commands", reason: "a Symbol's description, seen only in a debugger" },
    { text: "outside ShellProvider", reason: "a programming error thrown when a hook is used outside its provider; never reaches a viewer" },
    { text: "dialog", reason: "a form's method token" },
    { text: ".message-row.current", reason: "a CSS selector" },
    { text: ".compose-button", reason: "a CSS selector" },
    { text: "composer-body", reason: "a document id" },
  ],
  "src/client/app/ui/icons.tsx": [
    { text: "img", reason: "an ARIA role in a spread of attributes, where the role attribute's own rule cannot see it" },
  ],
  "src/client/app/ui/menu.tsx": [
    { text: "[role=menuitem]:not([aria-disabled=true])", reason: "a CSS selector" },
    { text: "-note-", reason: "a document id's middle part, between useId() and the item's index" },
  ],
  "src/client/app/ui/palette.tsx": [
    { text: "compose", reason: "an option's React key" },
    { text: "go", reason: "an option's React key, with the route after it" },
    { text: "search", reason: "an option's React key" },
    { text: "C", reason: "a key cap, shown in <kbd>" },
    { text: "palette-option-", reason: "a document id prefix" },
  ],
  "src/client/app/ui/popover.tsx": [
    { text: "popover-end", reason: "a class name, read with classList.contains" },
    { text: "px", reason: "a CSS unit, in an inline style" },
    { text: "auto", reason: "a CSS value, in an inline style" },
    { text: "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),", reason: "a CSS selector (FOCUSABLE's first line)" },
    { text: "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])", reason: "a CSS selector (FOCUSABLE's second line)" },
    { text: "input:not([disabled]), select:not([disabled]), textarea:not([disabled])", reason: "a CSS selector" },
  ],
  "src/client/app/ui/section-tabs.tsx": [
    { text: "section-tab current", reason: "a class name, in activeProps" },
  ],
  "src/client/app/ui/shortcuts.ts": [
    { text: "mailda.shortcuts", reason: "a localStorage key" },
    { text: "on", reason: "a stored value" },
    { text: "off", reason: "a stored value" },
    { text: "input, textarea, select, [contenteditable]:not([contenteditable=false])", reason: "a CSS selector" },
    { text: "dialog, [role=dialog], [role=menu], [role=listbox], .composer-dock", reason: "a CSS selector" },
  ],
  "src/client/session.client.js": [
    { text: "date", reason: "a response header's name, read for the server's clock" },
    { text: "(?:^|;\\s*)", reason: "a regular expression's source, finding the expiry cookie" },
    { text: "mailda-refresh", reason: "a Web Lock's name, shared by this origin's tabs" },
    ...["/api/auth/refresh", "/api/auth/logout"].map((text) => ({ text, reason: "a route path the session fetches" })),
    { text: "POST", reason: "an HTTP method" },
    { text: "same-origin", reason: "a fetch credentials mode" },
    { text: "application/json", reason: "a media type in a content-type header" },
    { text: "x-mailda-refreshable", reason: "a response header's name, the Node's 401 contract" },
    ...["refreshed", "signed-in", "signed-out"].map((text) => ({ text, reason: "a session event's type, compared by its listeners, never shown" })),
    ...["session_ended", "signed_out", "refresh_did_not_help"].map((text) => ({
      text, reason: "a session event's reason token: `app.client.js` compares it or keys its words by it, never shows it",
    })),
  ],
  "src/client/theme.client.js": [
    { text: "mailda.theme", reason: "a localStorage key" },
    ...["dark", "light", "system"].map((text) => ({
      text, reason: "a theme choice's token, stored and set as `data-theme`; Settings shows the catalog's words for it",
    })),
  ],
};
