import { useEffect, useRef } from "react";

/**
 * Single-key shortcuts (C, R, A, F, E, J, K, Shift+I, Z), and the one rule for when a key is not one.
 *
 * ## Why one predicate
 *
 * Every screen that registers keys asks the same question, "is this person typing?", and a second copy of
 * the answer is the one that forgets `<dialog>`: `closest("[role=dialog]")` does not match a `<dialog>`,
 * whose role is implicit, so an attribute selector alone lets E archive a message from inside the palette.
 * So `isEditableTarget` is the only place that answer lives, and `useShortcuts` is the only listener that
 * asks it.
 *
 * ## Why they can be switched off
 *
 * WCAG 2.1.4: a single-character shortcut must be possible to turn off, because speech input types letters
 * and a stray "e" would archive a message. Settings > Keyboard switches them; Cmd/Ctrl+K is modified, so it
 * is not subject to this and stays on.
 */

export interface Shortcut {
  /** Lower-case `KeyboardEvent.key` ("c", "r", "a", "f", "e", "j", "k", "i", "z"). */
  key: string;
  shift?: boolean;
  description: string;
  run: (event: KeyboardEvent) => void;
}

const STORAGE_KEY = "mailda.shortcuts";

/**
 * This tab's choice, kept only when the browser refused to store it: switching shortcuts off must still work
 * for this tab where storage is blocked. `null` whenever storage holds the choice, so a choice made in
 * another tab, which lands in storage, is the one that applies.
 */
let unsaved: boolean | null = null;

/**
 * The stored choice, shaped like `storedTheme()` in `theme.client.js`: `localStorage["mailda.shortcuts"] ===
 * "off"` disables single-key shortcuts, and `readable: false` (with the default, on) when reading storage
 * threw, so a saved "off" the browser will no longer show us is reported rather than silently undone.
 */
export function storedShortcuts(): { enabled: boolean; readable: boolean } {
  try {
    return { enabled: globalThis.localStorage.getItem(STORAGE_KEY) !== "off", readable: true };
  } catch {
    // Not swallowed: `readable: false` is the answer, and Settings renders it as a sentence.
    return { enabled: true, readable: false };
  }
}

/**
 * Whether single keys act now. Read at event time, so a change in Settings applies to the next key press;
 * this tab's unsaved choice first, then storage. An unreadable store falls back to on, and saying so is
 * Settings' job (`storedShortcuts().readable`), not the listener's.
 */
export function shortcutsEnabled(): boolean {
  return unsaved ?? storedShortcuts().enabled;
}

/** `saved: false` when the browser refused to store it; Settings then says so (never a silent no-op). */
export function setShortcutsEnabled(on: boolean): { saved: boolean } {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    unsaved = on;
    return { saved: false };
  }
  unsaved = null;
  return { saved: true };
}

/**
 * Where a key press is text or belongs to something else that is open.
 *
 * `dialog` is named on its own because an attribute selector does not match an implicit role. A `<summary>`
 * and a `role=tab` button are not here: nothing is typed into either, so keys act there.
 */
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
const OWNS_ITS_KEYS = "dialog, [role=dialog], [role=menu], [role=listbox], .composer-dock";

/** The one predicate: true inside a field, and anywhere inside an open dialog, menu, listbox or composer. */
export function isEditableTarget(target: EventTarget | null): boolean {
  // A press with nothing focused targets the body; one dispatched at the document or window is no field.
  if (!(target instanceof Element)) return false;
  return target.closest(EDITABLE) !== null || target.closest(OWNS_ITS_KEYS) !== null;
}

/**
 * One document keydown listener for the component's lifetime.
 *
 * It reads the **latest** shortcuts through a ref rather than the ones it was created with, so a handler
 * never acts on the message that was selected when the listener was attached (R select A, select B, R:
 * B's case is the one claimed). And it ignores auto-repeat: holding E must not archive a row per repeat,
 * and holding J must not open a body per repeat, each of which is a recorded open for a supervised reader.
 */
export function useShortcuts(shortcuts: readonly Shortcut[]): void {
  const latest = useRef(shortcuts);
  latest.current = shortcuts;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.repeat || event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (!shortcutsEnabled()) return;
      const key = event.key.toLowerCase();
      const match = latest.current.find((one) => one.key === key && event.shiftKey === Boolean(one.shift));
      if (match === undefined) return;
      event.preventDefault();
      match.run(event);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
