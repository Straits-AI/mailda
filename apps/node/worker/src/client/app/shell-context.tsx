import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
} from "react";

import type { MailboxQueue } from "./api.ts";
import { Composer, type ComposerContext, type ComposerHandle } from "./screens/composer.tsx";
import { Modal } from "./ui/popover.tsx";

/**
 * What the whole shell shares: the one composer, the toasts, the palette's pending search and its commands.
 *
 * ## Why the composer lives here and not in the Inbox
 *
 * A composer rendered by a screen is unmounted when the person navigates, and the unmount is a close: the
 * draft is flushed (#90) but the window is gone. Rendered here, above the router's outlet, it survives a
 * visit to the Outbox to check something, which is the ordinary way a reply gets written. That is also why
 * the composer claims its case again at send (#42): surviving navigation means a case can be released or
 * taken while it is open.
 *
 * ## Why this calls no router hook
 *
 * `search-field.test.tsx` mounts the Inbox with no router at all. The provider has to work there, so the
 * only thing here that needs a router is the Composer, and it is rendered only while something is open.
 *
 * ## Why four contexts rather than one
 *
 * The palette's commands are registered by whatever is mounted (the Inbox registers message commands while
 * a message is selected), on every render that changes them. Held in the same value as the composer, each
 * registration would re-render every consumer, including the registrant, which would register again. They
 * are a store the palette subscribes to instead, and a registrant never re-renders for its own registration.
 */

export interface Toast {
  text: string;
  /** "status" (default) goes to the polite live region; "alert" to the assertive one. */
  tone?: "status" | "alert";
  /**
   * A toast with an action stays until the next toast replaces it or the person dismisses it (WCAG 2.2.1: an
   * undo that vanishes in 6 s is out of reach for a keyboard or screen-reader user). One without, 6 s.
   */
  action?: { label: string; run: () => void };
}

/**
 * A command the palette offers while its registrant is mounted (the Inbox registers message commands while a
 * message is selected).
 */
export interface PaletteCommand { id: string; label: string; hint?: string; run: () => void }

/**
 * How long a toast without an action stays. A presentation choice, not a measurement: long enough to read a
 * sentence twice. A toast that carries an action does not use it (above).
 */
const TOAST_MS = 6_000;

interface Compose {
  composing: ComposerContext | null;
  open(context: ComposerContext): void;
  close(): void;
  start(rows: readonly MailboxQueue[]): void;
  /**
   * Saves what the open composer holds, now: null once the Node has it (or nothing is open), else the Node's
   * words for why not. Sign-out asks first, so the session does not end under words typed in the autosave pause.
   */
  save(): Promise<string | null>;
  /**
   * True, having said so, while the open composer's seal is in the air: nothing may replace that dock yet. `open`
   * asks it too; a caller with an act of its own to do first (a reply claims its case) asks it before that act.
   */
  refuseWhileSealing(): boolean;
}

interface Toasts {
  show(toast: Toast): void;
  action: (() => void) | null;
}

interface PendingSearch { pending: string | null; request(term: string): void; clear(): void }

/** The palette's commands, as a store: registering notifies the palette and nobody else. */
class CommandRegistry {
  private readonly sets = new Map<symbol, readonly PaletteCommand[]>();
  private readonly listeners = new Set<() => void>();
  private flat: readonly PaletteCommand[] = [];

  register(commands: readonly PaletteCommand[]): () => void {
    const key = Symbol("commands");
    this.sets.set(key, commands);
    this.changed();
    return () => {
      this.sets.delete(key);
      this.changed();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): readonly PaletteCommand[] => this.flat;

  private changed() {
    this.flat = [...this.sets.values()].flat();
    for (const listener of this.listeners) listener();
  }
}

const ComposeContext = createContext<Compose | null>(null);
const ToastContext = createContext<Toasts | null>(null);
const SearchContext = createContext<PendingSearch | null>(null);
const CommandsContext = createContext<CommandRegistry | null>(null);

function need<T>(value: T | null, hook: string): T {
  if (value === null) throw new Error(`${hook} outside ShellProvider`);
  return value;
}

/**
 * The mailbox a new message is sent from, **chosen, never inferred** (#94).
 *
 * `From` is the mailbox (ADR 36) and `send.propose` is held per mailbox, so which one this goes from is a
 * decision with a governance consequence, and picking the first row for somebody would put their name on an
 * address they did not choose. So the select starts on a real, empty option and "Start message" stays
 * disabled until something else is chosen. It lists exactly the rows it was given and runs no query of its
 * own: `useMailboxes` already returns the mailboxes the caller may send from.
 */
function ComposeChooser({ rows, onStart, onClose }: {
  rows: readonly MailboxQueue[];
  onStart: (mailboxId: string) => void;
  onClose: () => void;
}) {
  // `""` is the unchosen state, and it is a real option: a `<select>` whose value matches no option shows
  // its first one anyway, which would look chosen.
  const [chosen, setChosen] = useState("");
  return (
    <Modal className="compose-chooser" label="Choose a mailbox" onClose={onClose}>
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen !== "") onStart(chosen);
        }}
      >
        <label htmlFor="compose-from">Send from</label>
        <select id="compose-from" value={chosen} onChange={(event) => setChosen(event.target.value)}>
          <option value="">Choose a mailbox…</option>
          {rows.map((row) => (
            // The address, not only the name: two mailboxes can both be called Support, and the address is
            // what a recipient sees. A mailbox with none is said to have none: `sealManifest` refuses it.
            <option key={row.id} value={row.id}>
              {row.name}{row.addresses === null ? " (no address)" : ` · ${row.addresses.split(",")[0]!}`}
            </option>
          ))}
        </select>
        <p className="row-actions">
          <button type="submit" className="primary" disabled={chosen === ""}>Start message</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </p>
      </form>
    </Modal>
  );
}

/** A shown toast: the caller's, and which showing it is. */
type Shown = Toast & { id: number };

/**
 * One live region's content: the toast of this tone, or nothing.
 *
 * Keyed by the showing, so the same words twice ("Archived.", then "Archived." for the next message) replace
 * the node and are announced twice. Unkeyed, the second changed nothing in the DOM, and a screen-reader user
 * who archived two messages heard about one. The key is on the toast, never the region: the regions stay.
 */
function ToastSlot({ toast, onDismiss, onAction }: {
  toast: Shown | null;
  onDismiss: () => void;
  onAction: () => void;
}) {
  if (toast === null) return null;
  return (
    <div key={toast.id} className="toast">
      <span className="toast-text">{toast.text}</span>
      {toast.action === undefined ? null : (
        <>
          <button type="button" className="toast-action" onClick={onAction}>{toast.action.label}</button>
          <button type="button" className="toast-dismiss" aria-label="Dismiss" onClick={onDismiss}>×</button>
        </>
      )}
    </div>
  );
}

/**
 * Whether the open composer is writing the draft `next` asks for: the reply to one message (the Node keeps one
 * reply draft per message and author), or one draft by id — the id it was opened with, or the one its first save
 * got, which is how a new message opened from Compose is known when `/drafts` asks for it. Reopening the draft
 * that is open must not remount it: the new dock would read the draft before the old one's unmount flush landed,
 * so the words typed in the last autosave pause vanished from the screen, and a reply never saved yet was
 * inserted twice.
 */
function sameDraft(open: ComposerContext, writing: string | null, next: ComposerContext): boolean {
  if (open.inReplyToMessageId !== undefined && open.inReplyToMessageId === next.inReplyToMessageId) return true;
  return next.draftId !== undefined && (next.draftId === open.draftId || next.draftId === writing);
}

/**
 * Focus back to `back`, or, when that has left the page, to the message being read or Compose: never `<body>`,
 * where a keyboard user starts again from the top of the page. For the composer closing and a toast going.
 */
function giveFocusBack(back: Element | null) {
  const target = back instanceof HTMLElement && back.isConnected
    ? back
    : document.querySelector<HTMLElement>(".message-row.current") ?? document.querySelector<HTMLElement>(".compose-button");
  target?.focus();
}

export function ShellProvider({ children }: { children: React.ReactNode }) {
  // The composer, keyed by a counter so opening a different context remounts it: the old one's unmount
  // flush saves its draft (#90), and the new one starts from its own context rather than the old state.
  const [composing, setComposing] = useState<{ key: number; context: ComposerContext } | null>(null);
  const [choosing, setChoosing] = useState<readonly MailboxQueue[] | null>(null);
  const [toast, setToast] = useState<Shown | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const counter = useRef(0);
  const toasts = useRef(0);
  const [registry] = useState(() => new CommandRegistry());
  // What `open` compares against, current without making `open` change identity on every keystroke's render.
  const openNow = useRef(composing);
  openNow.current = composing;
  /** The open composer, for its draft's id and a save on request. */
  const composer = useRef<ComposerHandle>(null);
  const toastRegion = useRef<HTMLDivElement>(null);
  /**
   * What had focus before it went into the toasts (Tab to Undo), so the toast going — its action run, or
   * dismissed — does not drop focus to `<body>` with the button it was on (WCAG 2.4.3).
   */
  const beforeToast = useRef<Element | null>(null);
  /**
   * Where focus goes when the composer closes: whatever had it when the composer opened. `undefined` while no
   * composer is open, so the first render, with nothing ever opened, moves no focus at all.
   */
  const returnTo = useRef<Element | null | undefined>(undefined);

  const show = useCallback((next: Toast) => {
    toasts.current += 1;
    setToast({ ...next, id: toasts.current });
  }, []);
  /** Takes the toast away; if focus was on it, it goes back to where it came from. */
  const hide = useCallback(() => {
    const hadFocus = toastRegion.current?.contains(document.activeElement) === true;
    setToast(null);
    if (hadFocus) giveFocusBack(beforeToast.current);
  }, []);

  // A toast without an action goes away on its own; one with an action waits (see `Toast.action`).
  useEffect(() => {
    if (toast === null || toast.action !== undefined) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /*
   * A dock whose seal is in the air is kept: replaced, a refusal would land on a dock nobody sees, and a seal that
   * succeeded would close the new one. The person hears why, in the assertive region (AGENTS.md §3, never swallow).
   */
  const refuseWhileSealing = useCallback(() => {
    if (composer.current?.sealing() !== true) return false;
    show({ tone: "alert", text: "Still sealing the open message. Open this again once the Node has answered it." });
    return true;
  }, [show]);
  const open = useCallback((context: ComposerContext) => {
    const now = openNow.current;
    if (now !== null && sameDraft(now.context, composer.current?.draftId() ?? null, context)) {
      // Kept as it is, context and all: a new context would re-run its resume and overwrite what was typed.
      document.getElementById("composer-body")?.focus();
      return;
    }
    if (refuseWhileSealing()) return;
    counter.current += 1;
    setComposing({ key: counter.current, context });
  }, [refuseWhileSealing]);
  const close = useCallback(() => setComposing(null), []);
  const save = useCallback(async () => (composer.current === null ? null : composer.current.save()), []);

  /*
   * Focus into and out of the dock. A layout effect, so it runs after a closing dialog's own cleanup (the
   * palette's Reply, the chooser's Start) has put focus back on what opened it, and before the Composer's
   * mount effect moves focus into the dock. On open it records that; on close it returns there, or, when that
   * is gone (a sent reply's row after the move to the Outbox), to the selected message or Compose, never to
   * `<body>`, where a keyboard user starts again from the top of the page.
   */
  const docked = composing !== null;
  useLayoutEffect(() => {
    if (docked) {
      const at = document.activeElement;
      returnTo.current = at === document.body ? null : at;
      return;
    }
    const back = returnTo.current;
    returnTo.current = undefined;
    // Nothing was open, or focus already went somewhere on purpose: nothing to return.
    if (back === undefined || (document.activeElement !== null && document.activeElement !== document.body)) return;
    giveFocusBack(back);
  }, [docked]);
  const start = useCallback((rows: readonly MailboxQueue[]) => {
    if (rows.length === 0) {
      show({ text: "Sending needs send.propose on a mailbox, and you hold it on none." });
    } else if (rows.length === 1) {
      open({ mailboxId: rows[0]!.id });
    } else {
      setChoosing(rows);
    }
  }, [open, show]);

  const compose = useMemo<Compose>(
    () => ({ composing: composing?.context ?? null, open, close, start, save, refuseWhileSealing }),
    [composing, open, close, start, save, refuseWhileSealing],
  );

  const runAction = useMemo(() => {
    const action = toast?.action;
    if (action === undefined) return null;
    // Dismissed before it runs, so an undo that fails replaces this toast with its own refusal.
    return () => {
      hide();
      action.run();
    };
  }, [toast, hide]);
  const toastApi = useMemo<Toasts>(() => ({ show, action: runAction }), [show, runAction]);

  const search = useMemo<PendingSearch>(() => ({
    pending,
    request: (term: string) => setPending(term),
    clear: () => setPending(null),
  }), [pending]);

  const alert = toast !== null && toast.tone === "alert";
  return (
    <ComposeContext.Provider value={compose}>
      <ToastContext.Provider value={toastApi}>
        <SearchContext.Provider value={search}>
          <CommandsContext.Provider value={registry}>
            {children}
            <div className="composer-host">
              {composing === null
                ? null
                : <Composer key={composing.key} ref={composer} context={composing.context} onClose={close} />}
            </div>
            {choosing === null ? null : (
              <ComposeChooser
                rows={choosing}
                onClose={() => setChoosing(null)}
                onStart={(mailboxId) => {
                  setChoosing(null);
                  open({ mailboxId });
                }}
              />
            )}
            {/*
              Both live regions are always in the DOM, empty when idle: a live region inserted together with
              its text is often not announced at all.
            */}
            <div
              ref={toastRegion}
              className="toast-region"
              onFocus={(event) => {
                // Arriving from outside: remember where from. Moving between its own buttons is not arriving.
                if (!event.currentTarget.contains(event.relatedTarget)) beforeToast.current = event.relatedTarget;
              }}
            >
              <div role="status" aria-live="polite">
                <ToastSlot toast={alert ? null : toast} onDismiss={hide} onAction={() => runAction?.()} />
              </div>
              <div role="alert">
                <ToastSlot toast={alert ? toast : null} onDismiss={hide} onAction={() => runAction?.()} />
              </div>
            </div>
          </CommandsContext.Provider>
        </SearchContext.Provider>
      </ToastContext.Provider>
    </ComposeContext.Provider>
  );
}

/**
 * The one composer. `open` replaces any open composer (its unmount flush saves that draft, #90). `start(rows)`
 * is what Compose and C call with the sendable mailboxes: none → a toast saying which authority sending needs;
 * one → that mailbox; more → the chooser, because a mailbox is chosen, never inferred (#94).
 */
export function useCompose(): Compose {
  return need(useContext(ComposeContext), "useCompose");
}

/** Shows one toast; a new one replaces the current. */
export function useToast(): (toast: Toast) => void {
  return need(useContext(ToastContext), "useToast").show;
}

/** The visible toast's action, for the Z shortcut; null when there is none. */
export function useToastAction(): (() => void) | null {
  return need(useContext(ToastContext), "useToastAction").action;
}

/** The palette's "Search mail for …": `request` stores it; the Inbox consumes it and clears it. */
export function usePendingSearch(): PendingSearch {
  return need(useContext(SearchContext), "usePendingSearch");
}

/** Registers commands for the palette while the caller is mounted (pass null to register none). */
export function useRegisterCommands(commands: readonly PaletteCommand[] | null): void {
  const registry = need(useContext(CommandsContext), "useRegisterCommands");
  useEffect(() => {
    if (commands === null) return;
    return registry.register(commands);
  }, [registry, commands]);
}

/** What the palette reads. */
export function useCommands(): readonly PaletteCommand[] {
  const registry = need(useContext(CommandsContext), "useCommands");
  return useSyncExternalStore(registry.subscribe, registry.snapshot);
}
