import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * The two overlays the interface uses, and nothing cleverer.
 *
 * ## `Popover`: React state and a conditional render, not the Popover API
 *
 * A popover here is always anchored to the control that opened it (Filter, Assign, Health) and holds a form
 * or a short list. The Popover API would add top-layer promotion and light dismiss, and a second source of
 * truth about whether it is open; a `div` that exists only while React says so has one. Position is CSS the
 * caller chooses (`popover-up | popover-down`, `popover-start | popover-end`) inside a `span.popover-wrap`, and
 * the side is a preference: `useInside` takes the other side as it opens when the chosen one would be clipped.
 *
 * On open, focus goes to its first field, or to the popover itself when it has none (Health, or Assign while its
 * form is still loading), so a screen reader starts at its top and Escape works at once. It closes on Escape
 * from inside it or from its anchor, on a press outside both, and when focus moves to something outside both,
 * as the Menu closes on Tab.
 *
 * ## `Modal`: every `<dialog>` in the shell, under one rule
 *
 * The palette, the compose chooser and the narrow layout's drawer are `<dialog>`s shown with `showModal()`,
 * which makes everything else inert, so a closed one must not linger in the DOM with focusable content. The
 * rule: rendered **only while open**; shown in a layout effect; native Escape (`cancel`) and `close` both
 * tell the owner, so React never believes a dialog is open that the browser closed; and on close, focus goes
 * back to whatever had it when the dialog opened.
 *
 * **Closed before focus goes back.** React runs the cleanup while the `<dialog>` is still in the document and
 * still modal, so everything outside it is inert and a `focus()` there does nothing: focus fell to `<body>`
 * after every Escape. happy-dom has no inertness, which is why the unit tests passed over it until
 * `test/client/setup.ts` made them see it.
 */

/**
 * Keeps an open popover or menu inside everything that clips it: the viewport, and every ancestor whose overflow
 * is not visible. The caller's side (`popover-start`, else `popover-end`) is kept when it fits; otherwise the
 * popup takes the other side, and when neither fits it is held against the nearer edge. Measured once, as it
 * opens and before it paints; each popup here has a width of its own, so what it holds later cannot change it.
 *
 * The reader column scrolls, and a scroller clips on both axes: More actions opened leftward from a ••• that the
 * action bar had wrapped to the column's left edge, so at 390 its labels were cut off and at 768 they were hidden
 * behind the list pane, and Assign, opened rightward from x=650, ran past a 768px window (R2V-1, R2V-2).
 */
export function useInside(popup: React.RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const element = popup.current;
    // The containing block its `left`/`right` are measured from: the `.popover-wrap` around its anchor.
    const wrap = element?.offsetParent;
    if (!open || !element || !(wrap instanceof HTMLElement)) return;
    let low = 0;
    let high = document.documentElement.clientWidth;
    for (let at = element.parentElement; at !== null && at !== document.documentElement; at = at.parentElement) {
      if (getComputedStyle(at).overflowX === "visible") continue;
      const edge = at.getBoundingClientRect().left + at.clientLeft;
      low = Math.max(low, edge);
      high = Math.min(high, edge + at.clientWidth);
    }
    const anchor = wrap.getBoundingClientRect();
    const width = element.offsetWidth;
    const start = anchor.left;
    const end = anchor.right - width;
    const [chosen, other] = element.classList.contains("popover-end") ? [end, start] : [start, end];
    // Half a pixel either way: the edges are fractional, and a popup flush with one is inside it.
    const fits = (left: number) => left >= low - 0.5 && left + width <= high + 0.5;
    const left = fits(chosen) ? chosen : fits(other) ? other : Math.max(low, Math.min(chosen, high - width));
    if (left === chosen) return;
    element.style.left = `${left - anchor.left}px`;
    element.style.right = "auto";
  }, [popup, open]);
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), "
  + "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
/** What a popover focuses on open, when it has one: a field. A button or link first would skip what it says. */
const FIELD = "input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

export function Popover({ open, onClose, label, className = "", anchor, children }: {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  anchor: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  /**
   * A press on the anchor is under way. Its click is the one toggle, so focus leaving during it does not close:
   * Safari and Firefox on macOS do not focus a button on click, so pressing the anchor to close sent focus to
   * `<body>`, the leave closed the popover, and the click then opened it again.
   */
  const pressingAnchor = useRef(false);
  useInside(box, open);

  /*
   * Focus leaving the popover or its anchor closes it, judged once focus has landed: where it went, not how.
   * Tab past the page's last control lands on nothing, so a focusout's `relatedTarget` would be null there and
   * could not tell that from a click. The window losing focus moves nothing, and a press on the popover's
   * own text focuses the popover itself (`tabIndex={-1}`), so neither closes it.
   */
  function onLeave() {
    setTimeout(() => {
      const now = document.activeElement;
      if (pressingAnchor.current || box.current?.contains(now) || anchor.current?.contains(now)) return;
      latestClose.current();
    });
  }

  useEffect(() => {
    if (!open) return;
    (box.current?.querySelector<HTMLElement>(FIELD) ?? box.current)?.focus();
    // A press anywhere outside both the popover and the control that opened it closes it. `pointerdown`,
    // not `click`: a click that starts inside a field and ends outside it is a text selection, not a dismissal.
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target === null) return;
      pressingAnchor.current = anchor.current?.contains(target) === true;
      if (box.current?.contains(target) || pressingAnchor.current) return;
      latestClose.current();
    }
    // Over once the anchor's own click has toggled (a document listener runs after React's), or when the press
    // ends off the anchor and no click will come. Not on every release: a quick press can be released before
    // its leave is judged, and the click would then reopen what the leave closed.
    function onRelease(event: Event) {
      if (event.type === "click" || !anchor.current?.contains(event.target as Node | null)) pressingAnchor.current = false;
    }
    // Escape on the anchor too: Shift+Tab back to it, or a click that left focus there, must not strand it open.
    const trigger = anchor.current;
    function onAnchorKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      latestClose.current();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onRelease);
    document.addEventListener("click", onRelease);
    trigger?.addEventListener("keydown", onAnchorKey);
    trigger?.addEventListener("focusout", onLeave);
    return () => {
      pressingAnchor.current = false;
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onRelease);
      document.removeEventListener("click", onRelease);
      trigger?.removeEventListener("keydown", onAnchorKey);
      trigger?.removeEventListener("focusout", onLeave);
    };
    // `onLeave` reads refs only; the one it was attached with is as good as any later render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchor]);

  if (!open) return null;
  return (
    <div
      ref={box}
      role="dialog"
      aria-label={label}
      // Focusable by script only: the fallback target on open, and where a click on its text leaves focus.
      tabIndex={-1}
      className={`popover ${className}`.trim()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onClose();
        anchor.current?.focus();
      }}
      onBlur={onLeave}
    >
      {children}
    </div>
  );
}

/**
 * A `<dialog>` shown modally for as long as it is rendered. The owner renders it only while open and
 * passes `onClose`, which both Escape and a programmatic close reach.
 */
export function Modal({ className, label, onClose, onClick, returnTo, children }: {
  className: string;
  label: string;
  onClose: () => void;
  onClick?: (event: React.MouseEvent<HTMLDialogElement>) => void;
  /**
   * Where focus goes on close, when that is a known control (the drawer's menu button). Otherwise whatever had
   * focus when the dialog opened, which is not always the control that opened it: Safari does not focus a
   * button on click.
   */
  returnTo?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    // Decided on open: the control that opened it stays mounted while it is open.
    const back = returnTo?.current ?? document.activeElement;
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    // What `showModal()` does in a browser, done explicitly so every engine agrees (happy-dom does not).
    element?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      // Close first (see the header): while it is modal, the page it returns to is inert.
      if (element?.open) element.close();
      if (back instanceof HTMLElement) back.focus();
    };
  }, [returnTo]);

  return (
    <dialog ref={dialog} className={className} aria-label={label} onCancel={onClose} onClose={onClose} onClick={onClick}>
      {children}
    </dialog>
  );
}
