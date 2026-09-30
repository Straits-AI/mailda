import { useEffect, useState } from "react";
import { accessExpiresAt, isSignedIn, logout } from "/app/session.js";
import { THEME_CHOICES, chooseTheme, currentTheme, storedTheme, type ThemeChoice } from "/app/theme.js";
import { t } from "/app/locale.js";
import type { Key } from "../../../i18n/catalog.ts";

import { signOutEverywhere, useMe, type Said } from "../api.ts";
import { Nothing } from "../chrome.tsx";
import { useCompose } from "../shell-context.tsx";
import { setShortcutsEnabled, shortcutsEnabled, storedShortcuts } from "../ui/shortcuts.ts";
import { marked, NodeWords, sentence } from "../words.tsx";
import { Language } from "./language.tsx";
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
  return <p>{sentence("settings.session.renews", { time: <span className="mono">{readout}</span> })}</p>;
}

/** The two sign-outs, named by their catalog keys' last part: `settings.sign_out`, `settings.sign_out_everywhere`. */
type SignOut = "sign_out" | "sign_out_everywhere";

/**
 * What stopped a sign-out: a draft that would not save (framed by this page's sentence), or the revocation the
 * Node refused, with who wrote its words (`Said`). Kept as text and a kind, never as a rendered sentence.
 *
 * ponytail: the draft's words are `compose.save()`'s, English today because the composer is not migrated
 * (layer 2a), so they go inside `<NodeWords>`. When the composer migrates, `save()` returns a `Said` and this
 * becomes `marked()` like the revocation.
 */
type Problem = { kind: "draft"; said: string } | { kind: "revocation"; said: Said };

function Account() {
  const me = useMe();
  const compose = useCompose();
  const [problem, setProblem] = useState<Problem | null>(null);
  /**
   * The sign-out a draft that would not save held back, offered again under its own name: "Sign out everywhere
   * anyway" ends every session on every device, and must not read as the plain "Sign out" beside it.
   */
  const [held, setHeld] = useState<SignOut | null>(null);

  /**
   * Every session, every device. The Node revokes first and this page signs out second, so a revocation that
   * did not happen is rendered rather than hidden behind a page that merely looks signed out.
   */
  async function everywhere() {
    const outcome = await signOutEverywhere();
    if (!outcome.ok) { setProblem({ kind: "revocation", said: outcome }); return; }
    await logout();
  }

  const run = (which: SignOut): Promise<void> => (which === "sign_out" ? logout() : everywhere());

  /**
   * An open composer's words go to the Node before the session ends. Signing out unmounts the composer, and its
   * last-chance save would then run with no session: whatever was typed in the autosave pause was lost. A save
   * the Node refuses keeps the session, says why in the Node's words, and leaves the choice to lose the words.
   */
  async function signOut(which: SignOut) {
    setProblem(null);
    setHeld(null);
    const unsaved = await compose.save();
    if (unsaved !== null) {
      // A moment, not a standing state: the dock goes on autosaving, and a later save does not come back here.
      setProblem({ kind: "draft", said: unsaved });
      setHeld(which);
      return;
    }
    await run(which);
  }

  let who: React.ReactNode;
  if (me.isPending) who = <Nothing kind="loading" />;
  else if (me.isError) who = <Nothing kind="failed" detail={marked(me.error)} />;
  else if (me.data.principalKind === "agent") {
    who = <p>{sentence("settings.account.agent", { who: <span className="mono">{me.data.principalId}</span> })}</p>;
  } else {
    who = <p>{sentence("settings.account.person", { who: <span className="mono">{me.data.email ?? me.data.principalId}</span> })}</p>;
  }

  return (
    <section className="settings-block" aria-labelledby="settings-account">
      <h2 id="settings-account">{t("settings.account.heading")}</h2>
      {who}
      {problem === null ? null : (
        <p className="bad" role="alert">
          {problem.kind === "draft"
            ? sentence("settings.account.draft", { problem: <NodeWords>{problem.said}</NodeWords> })
            : marked(problem.said)}
        </p>
      )}
      <p className="row-actions">
        {held === null ? null : (
          <button type="button" className="btn" onClick={() => void run(held)}>{t(`settings.${held}.anyway`)}</button>
        )}
        <button type="button" className="btn" onClick={() => void signOut("sign_out")}>{t("settings.sign_out")}</button>
        <button
          type="button"
          className="btn"
          title={t("settings.sign_out_everywhere.title")}
          onClick={() => void signOut("sign_out_everywhere")}
        >
          {t("settings.sign_out_everywhere")}
        </button>
      </p>
    </section>
  );
}

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
      <h2 id="settings-appearance">{t("settings.appearance.heading")}</h2>
      <fieldset className="theme-choice">
        <legend>{t("settings.theme.legend")}</legend>
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
            {t(`settings.theme.${choice}`)}
            {choice === "system" ? <span className="theme-note">{t("settings.theme.system_note")}</span> : null}
          </label>
        ))}
      </fieldset>
      {unsaved ? <p className="notice" role="status">{t("settings.not_saved")}</p> : null}
      {unreadable
        ? <p className="notice" role="status">{t("settings.theme.unreadable")}</p>
        : null}
    </section>
  );
}

/**
 * The keys the shell and the Inbox register, as a person reads them. A table rather than the registrations
 * themselves: the Inbox's are only registered while it is mounted, and this page is not the Inbox.
 */
/** The key caps the table shows, which stay Latin in every locale (`docs/i18n.md`). */
type KeyCap = "C" | "Ctrl" | "K" | "R" | "A" | "F" | "E" | "J" | "Shift" | "I" | "Z" | "Esc";

const SHORTCUT_MAP: ReadonlyArray<{ keys: readonly KeyCap[]; does: Extract<Key, `settings.shortcut.${string}`> }> = [
  { keys: ["C"], does: "settings.shortcut.compose" },
  { keys: ["Ctrl", "K"], does: "settings.shortcut.palette" },
  { keys: ["R"], does: "settings.shortcut.reply" },
  { keys: ["A"], does: "settings.shortcut.reply_all" },
  { keys: ["F"], does: "settings.shortcut.forward" },
  { keys: ["E"], does: "settings.shortcut.archive" },
  { keys: ["J"], does: "settings.shortcut.next" },
  { keys: ["K"], does: "settings.shortcut.previous" },
  { keys: ["Shift", "I"], does: "settings.shortcut.unread" },
  { keys: ["Z"], does: "settings.shortcut.undo" },
  { keys: ["Esc"], does: "settings.shortcut.close" },
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
      <h2 id="settings-keyboard">{t("settings.keyboard.heading")}</h2>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setUnsaved(!setShortcutsEnabled(event.target.checked).saved);
            setEnabled(event.target.checked);
          }}
        />
        {t("settings.keyboard.switch")}
      </label>
      {unsaved ? <p className="notice" role="status">{t("settings.not_saved")}</p> : null}
      {unreadable
        ? <p className="notice" role="status">{t("settings.keyboard.unreadable")}</p>
        : null}
      <table className="shortcut-table">
        <caption className="visually-hidden">{t("settings.keyboard.caption")}</caption>
        <tbody>
          {SHORTCUT_MAP.map((row) => (
            <tr key={row.does}>
              <td>{row.keys.map((key, index) => <span key={key}>{index === 0 ? null : " + "}<kbd>{key}</kbd></span>)}</td>
              <td>{t(row.does)}</td>
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
      <header className="ledger-head"><h1>{t("route./settings")}</h1></header>
      <Account />
      <section className="settings-block" aria-labelledby="settings-session">
        <h2 id="settings-session">{t("settings.session.heading")}</h2>
        <SessionClock />
        <p>{sentence("settings.session.node", { host: <span className="mono">{location.host}</span> })}</p>
      </section>
      <Passkeys />
      <Appearance />
      <Language />
      <Keyboard />
    </>
  );
}
