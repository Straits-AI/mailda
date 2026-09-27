import { Fragment, useEffect, useId, useRef, useState } from "react";

import { useInside } from "./popover.tsx";

/**
 * A button that opens a list of actions: the ARIA menu-button pattern, keyboard included.
 *
 * Used where the actions do not fit on a bar ("More actions" in the reader), so every one of them stays
 * reachable at 320px. An item is a `<button>`, or an `<a>` when it goes somewhere the browser should load
 * itself (Download original).
 */

export interface MenuItem {
  label: string;
  /** A second line under the label, and the item's accessible description (e.g. "Recorded as an export."). */
  note?: string;
  onSelect?: () => void;
  /**
   * Renders `<a role="menuitem" href>` instead of a button. **No `download` attribute, ever:** the route sends
   * `content-disposition` itself, and with the attribute a refusal would be saved as a file of error JSON
   * instead of opening as the Node's words.
   */
  href?: string;
  disabled?: boolean;
  /** Draws a rule above this item, starting a new group. Ignored on the first item: a menu never opens on a rule. */
  startsGroup?: boolean;
}

/** The items the arrow keys move between, in order: every enabled one. */
function entries(list: HTMLElement | null): HTMLElement[] {
  return [...(list?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? [])];
}

export function Menu({ label, face, items }: { label: string; face: React.ReactNode; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  // Opens leftward from its button (`popover-end`) unless that would be clipped: see `useInside`.
  useInside(list, open);

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    entries(list.current)[0]?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target === null) return;
      if (list.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const all = entries(list.current);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => { event.preventDefault(); all[(index + all.length) % all.length]?.focus(); };
    if (event.key === "ArrowDown") move(at + 1);
    else if (event.key === "ArrowUp") move(at - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(all.length - 1);
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === "Tab") setOpen(false);
    // A button activates on Space by itself; a link does not, and in a menu both must.
    else if (event.key === " " && document.activeElement instanceof HTMLAnchorElement) {
      event.preventDefault();
      document.activeElement.click();
    }
  }

  /**
   * Closes and hands focus back to the trigger first, then runs. The item runs with focus on a live control, so
   * one that changes nothing on screen (Mark unread) leaves focus where the person was rather than on `<body>`,
   * and one that opens a dialog records the trigger, not this menu's detached item, as where to come back to.
   */
  function activate(item: MenuItem) {
    close(true);
    item.onSelect?.();
  }

  return (
    <span className="popover-wrap">
      <button
        ref={trigger}
        type="button"
        className="btn btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((was) => !was)}
      >
        {face}
      </button>
      {open ? (
        <div ref={list} role="menu" aria-label={label} className="menu popover-down popover-end" onKeyDown={onKeyDown}>
          {items.map((item, index) => {
            const noteId = item.note === undefined ? undefined : `${id}-note-${index}`;
            const body = (
              <>
                <span>{item.label}</span>
                {/* Hidden from the name, which is the label alone; `aria-describedby` still reads it, once. */}
                {item.note === undefined ? null : <span id={noteId} className="menu-note" aria-hidden="true">{item.note}</span>}
              </>
            );
            // An `<hr>` is a separator by its implicit role, allowed in a menu; `entries()` never lands on it.
            const rule = item.startsGroup === true && index > 0 ? <hr className="menu-sep" /> : null;
            // A native `disabled` would drop the item out of the arrow-key order; `aria-disabled` keeps it
            // announced as unavailable and `entries()` skips it.
            const control = item.href === undefined ? (
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                tabIndex={-1}
                aria-disabled={item.disabled === true ? true : undefined}
                aria-describedby={noteId}
                onClick={() => { if (item.disabled !== true) activate(item); }}
              >
                {body}
              </button>
            ) : (
              <a
                role="menuitem"
                className="menu-item"
                tabIndex={-1}
                href={item.href}
                aria-describedby={noteId}
                onClick={() => activate(item)}
              >
                {body}
              </a>
            );
            return <Fragment key={item.label}>{rule}{control}</Fragment>;
          })}
        </div>
      ) : null}
    </span>
  );
}
