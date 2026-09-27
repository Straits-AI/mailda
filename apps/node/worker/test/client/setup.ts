import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Unmount whatever the last test mounted.
 *
 * Testing Library does this automatically when a global `afterEach` is available, and this file is here to
 * not depend on that: a component left mounted keeps its effects and its timers, and a timer surviving
 * into the next test would surface as a flake in whichever test ran next rather than as a failure in the
 * one that leaked it. This suite is about effect lifetimes, so leaking one is the least acceptable
 * possible bug in its own harness.
 */
afterEach(cleanup);

/**
 * A modal `<dialog>` makes the rest of the page inert, and happy-dom does not.
 *
 * Every "focus goes back to the opener" assertion in this suite passed while Chromium left focus on `<body>`:
 * the shell's `Modal` moved focus from its cleanup while the dialog was still modal, a `focus()` a browser
 * ignores and happy-dom obeyed. So `showModal()` is recorded here, and a `focus()` on anything outside the
 * topmost open, connected modal dialog does nothing, as in a browser. `close()` and leaving the document both
 * end it, as they do there. This is the one browser behaviour these tests depend on that happy-dom lacks; a
 * real-browser check of the same thing is in the review flow, since an emulation is only as right as its reading.
 */
const modals: HTMLDialogElement[] = [];
const showModal = HTMLDialogElement.prototype.showModal;
const close = HTMLDialogElement.prototype.close;
const focus = HTMLElement.prototype.focus;
HTMLDialogElement.prototype.showModal = function showModalRecorded(this: HTMLDialogElement) {
  showModal.call(this);
  modals.push(this);
};
HTMLDialogElement.prototype.close = function closeRecorded(this: HTMLDialogElement, returnValue?: string) {
  const at = modals.indexOf(this);
  if (at !== -1) modals.splice(at, 1);
  close.call(this, returnValue);
};
afterEach(() => { modals.length = 0; });
HTMLElement.prototype.focus = function focusUnlessInert(this: HTMLElement, options?: FocusOptions) {
  const top = modals.filter((dialog) => dialog.isConnected && dialog.open).at(-1);
  if (top !== undefined && !top.contains(this)) return;
  focus.call(this, options);
};
