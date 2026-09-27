import { useEffect, useState } from "react";
import { accessExpiresAt, isSignedIn, logout } from "/app/session.js";
import { THEME_CHOICES, chooseTheme, currentTheme, storedTheme, type ThemeChoice } from "/app/theme.js";

import { signOutEverywhere, useMe } from "../api.ts";
import { Nothing } from "../chrome.tsx";
import { useCompose } from "../shell-context.tsx";
import { setShortcutsEnabled, shortcutsEnabled, storedShortcuts } from "../ui/shortcuts.ts";
import { Passkeys } from "./people.tsx";

/**
 * Your own settings: who you are signed in as, your session, your passkeys, how the interface looks, and
 * whether single keys are shortcuts. Every block is about the person reading it, which is why the page is
 * open to everyone and why the first-run gate lets an administrator through to it: signing out lives here.
 *
 * The two browser preferences (theme, shortcuts) are this browser's, never the Node's: nothing on this page
 * except the sign-outs and the passkeys sends a request. Where the browser will not keep or read one, the page says
 * so instead of looking as if it did (AGENTS.md §3).
 */

/**
 * The session countdown, moved here from the bottom bar.
 *
 * Removing it from the permanent chrome loses no warning: a failed refresh, a non-refreshable 401 and a 401
 * that survives a refresh all emit `signed-out` (`session.client.js`), and `app.client.js` then unmounts the
 * shell and renders sign-in, so expiry is never silent without the clock. It is kept for the person who wants
 * to watch the token lifecycle, which is real machinery. `Date.now()` is correct here: a page has one user,
 * one tab and one clock, and the ctx seam is a Worker concern (see eslint.config.js).
 */
function SessionClock() {
  const [readout, setReadout] = useState<string | null>(null);

  useEffect(() => {
    function tick() {
      if (!isSignedIn()) return setReadout(null);
      const expiresAt = accessExpiresAt();
      if (expiresAt === null) return setReadout(null);
      const remaining = Math.max(0, expiresAt - Date.now());
      const minutes = Math.floor(remaining / 60_000);
      const seconds = Math.floor((remaining % 60_000) / 1000);
      setReadout(`${minutes}:${String(seconds).padStart(2, "0")}`);
    }
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  if (readout === null) return null;
  // `aria-live` deliberately absent. A countdown that announces itself every second makes a screen reader
  // unusable; the states that matter (renewing, signed out) are announced by the surfaces that change.
  return <p>Renews in <span className="mono">{readout}</span></p>;
}

function Account() {
  const me = useMe();
  const compose = useCompose();
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The sign-out a draft that would not save held back, offered again under its own name: "Sign out everywhere
   * anyway" ends every session on every device, and must not read as the plain "Sign out" beside it.
   */
  const [held, setHeld] = useState<{ run: () => Promise<void>; label: string } | null>(null);

  /**
   * Every session, every device. The Node revokes first and this page signs out second, so a revocation that
   * did not happen is rendered rather than hidden behind a page that merely looks signed out.
   */
  async function everywhere() {
    const outcome = await signOutEverywhere();
    if (!outcome.ok) { setProblem(outcome.message); return; }
    await logout();
  }

  /**
   * An open composer's words go to the Node before the session ends. Signing out unmounts the composer, and its
   * last-chance save would then run with no session: whatever was typed in the autosave pause was lost. A save
   * the Node refuses keeps the session, says why in the Node's words, and leaves the choice to lose the words.
   */
  async function signOut(then: () => Promise<void>, label: string) {
    setProblem(null);
    setHeld(null);
    const unsaved = await compose.save();
    if (unsaved !== null) {
      // A moment, not a standing state: the dock goes on autosaving, and a later save does not come back here.
      setProblem(`Your draft was not saved on your Node when you asked to sign out, so you are still signed in: ${unsaved}`);
      setHeld({ run: then, label: `${label} anyway` });
      return;
    }
    await then();
  }

  let who: React.ReactNode;
  if (me.isPending) who = <Nothing kind="loading" />;
  else if (me.isError) who = <Nothing kind="failed" detail={me.error.message} />;
  else if (me.data.principalKind === "agent") {
    who = <p>Signed in as an agent, <span className="mono">{me.data.principalId}</span>.</p>;
  } else {
    who = <p>Signed in as <span className="mono">{me.data.email ?? me.data.principalId}</span>.</p>;
  }

  return (
    <section className="settings-block" aria-labelledby="settings-account">
      <h2 id="settings-account">Account</h2>
      {who}
      {problem === null ? null : <p className="bad" role="alert">{problem}</p>}
      <p className="row-actions">
        {held === null ? null : (
          <button type="button" className="btn" onClick={() => void held.run()}>{held.label}</button>
        )}
        <button type="button" className="btn" onClick={() => void signOut(logout, "Sign out")}>Sign out</button>
        <button
          type="button"
          className="btn"
          title="Ends every session you hold, on every device, including this one."
          onClick={() => void signOut(everywhere, "Sign out everywhere")}
        >
          Sign out everywhere
        </button>
      </p>
    </section>
  );
}

const THEME_LABELS: Record<ThemeChoice, string> = { dark: "Dark", light: "Light", system: "System" };

const NOT_SAVED = "Not saved in this browser; this applies until you reload.";

/**
 * Dark, Light or System, for this viewer in this browser (`/app/theme.js`). Choosing applies first, so the
 * change is live whatever storage does, and only then stores.
 */
function Appearance() {
  const [theme, setTheme] = useState<ThemeChoice>(currentTheme);
  const [unreadable] = useState(() => !storedTheme().readable);
  const [unsaved, setUnsaved] = useState(false);

  return (
    <section className="settings-block" aria-labelledby="settings-appearance">
      <h2 id="settings-appearance">Appearance</h2>
      <fieldset className="theme-choice">
        <legend>Theme</legend>
        {THEME_CHOICES.map((choice) => (
          <label key={choice} className="theme-option">
            <input
              type="radio"
              name="theme"
              value={choice}
              checked={theme === choice}
              onChange={() => {
                setUnsaved(!chooseTheme(choice).saved);
                setTheme(choice);
              }}
            />
            {THEME_LABELS[choice]}
            {choice === "system" ? <span className="theme-note">Follows your device's light or dark setting.</span> : null}
          </label>
        ))}
      </fieldset>
      {unsaved ? <p className="notice" role="status">{NOT_SAVED}</p> : null}
      {unreadable
        ? <p className="notice" role="status">This browser would not let Mailda read a saved theme, so each page starts in Dark.</p>
        : null}
    </section>
  );
}

/**
 * The keys the shell and the Inbox register, as a person reads them. A table rather than the registrations
 * themselves: the Inbox's are only registered while it is mounted, and this page is not the Inbox.
 */
const SHORTCUT_MAP: ReadonlyArray<{ keys: readonly string[]; does: string }> = [
  { keys: ["C"], does: "Compose" },
  { keys: ["Ctrl", "K"], does: "Command palette (⌘K on a Mac; works even with single-key shortcuts off)" },
  { keys: ["R"], does: "Reply, claiming the case first" },
  { keys: ["A"], does: "Reply all, claiming the case first" },
  { keys: ["F"], does: "Forward" },
  { keys: ["E"], does: "Archive" },
  { keys: ["J"], does: "Next message" },
  { keys: ["K"], does: "Previous message" },
  { keys: ["Shift", "I"], does: "Mark unread" },
  { keys: ["Z"], does: "Undo, when a notice offers it" },
  { keys: ["Esc"], does: "Close a menu, popover or dialog" },
];

/**
 * Single-key shortcuts can be switched off (WCAG 2.1.4): speech input types letters, and a stray "e" would
 * archive a message. The switch applies to the next key press.
 */
function Keyboard() {
  const [enabled, setEnabled] = useState(shortcutsEnabled);
  const [unreadable] = useState(() => !storedShortcuts().readable);
  const [unsaved, setUnsaved] = useState(false);

  return (
    <section className="settings-block" aria-labelledby="settings-keyboard">
      <h2 id="settings-keyboard">Keyboard</h2>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setUnsaved(!setShortcutsEnabled(event.target.checked).saved);
            setEnabled(event.target.checked);
          }}
        />
        Single-key shortcuts
      </label>
      {unsaved ? <p className="notice" role="status">{NOT_SAVED}</p> : null}
      {unreadable
        ? <p className="notice" role="status">This browser would not let Mailda read a saved shortcut choice, so single-key shortcuts start on.</p>
        : null}
      <table className="shortcut-table">
        <caption className="visually-hidden">Keyboard shortcuts</caption>
        <tbody>
          {SHORTCUT_MAP.map((row) => (
            <tr key={row.does}>
              <td>{row.keys.map((key, index) => <span key={key}>{index === 0 ? null : " + "}<kbd>{key}</kbd></span>)}</td>
              <td>{row.does}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function Settings() {
  return (
    <>
      <header className="ledger-head"><h1>Settings</h1></header>
      <Account />
      <section className="settings-block" aria-labelledby="settings-session">
        <h2 id="settings-session">Session</h2>
        <SessionClock />
        <p>This Node: <span className="mono">{location.host}</span></p>
      </section>
      <Passkeys />
      <Appearance />
      <Keyboard />
    </>
  );
}
