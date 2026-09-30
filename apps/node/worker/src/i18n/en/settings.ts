import type { Area } from "../areas.ts";

/**
 * Settings (`src/client/app/screens/settings.tsx`): Account, Session, Appearance and Keyboard. The page's
 * heading is the route's name, `route./settings`; Language and Passkeys have their own areas.
 */
export const settings = {
  "settings.account.heading": "Account",
  "settings.account.person": "Signed in as {who}.",
  "settings.account.agent": "Signed in as an agent, {who}.",
  /** `{problem}` is the Node's refusal, verbatim. */
  "settings.account.draft":
    "Your draft was not saved on your Node when you asked to sign out, so you are still signed in: {problem}",
  "settings.sign_out": "Sign out",
  "settings.sign_out.anyway": "Sign out anyway",
  "settings.sign_out_everywhere": "Sign out everywhere",
  "settings.sign_out_everywhere.anyway": "Sign out everywhere anyway",
  "settings.sign_out_everywhere.title": "Ends every session you hold, on every device, including this one.",

  "settings.session.heading": "Session",
  /** `{time}` is the countdown, `m:ss`. */
  "settings.session.renews": "Renews in {time}",
  "settings.session.node": "This Node: {host}",

  "settings.appearance.heading": "Appearance",
  "settings.theme.legend": "Theme",
  "settings.theme.dark": "Dark",
  "settings.theme.light": "Light",
  "settings.theme.system": "System",
  "settings.theme.system_note": "Follows your device's light or dark setting.",
  "settings.theme.unreadable": "This browser would not let Mailda read a saved theme, so each page starts in Dark.",
  /** Under a theme or a shortcut choice the browser would not store. */
  "settings.not_saved": "Not saved in this browser; this applies until you reload.",

  "settings.keyboard.heading": "Keyboard",
  "settings.keyboard.switch": "Single-key shortcuts",
  "settings.keyboard.unreadable":
    "This browser would not let Mailda read a saved shortcut choice, so single-key shortcuts start on.",
  "settings.keyboard.caption": "Keyboard shortcuts",
  "settings.shortcut.compose": "Compose",
  "settings.shortcut.palette": "Command palette (⌘K on a Mac; works even with single-key shortcuts off)",
  "settings.shortcut.reply": "Reply, claiming the case first",
  "settings.shortcut.reply_all": "Reply all, claiming the case first",
  "settings.shortcut.forward": "Forward",
  "settings.shortcut.archive": "Archive",
  "settings.shortcut.next": "Next message",
  "settings.shortcut.previous": "Previous message",
  "settings.shortcut.unread": "Mark unread",
  "settings.shortcut.undo": "Undo, when a notice offers it",
  "settings.shortcut.close": "Close a menu, popover or dialog",
} as const satisfies Area<"settings">;
