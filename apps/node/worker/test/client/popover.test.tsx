import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";

/**
 * The anchored popover (`ui/popover.tsx`: Filter, Assign, Health), and how a keyboard gets in and out of it.
 *
 * What would render plausibly and be wrong: a popover that opens with focus left on its button because its
 * content was still loading, so Escape does nothing; one that stays open over the page after Tab has left it;
 * one that Escape only closes while focus happens to be inside.
 */

const { Popover } = await import("../../src/client/app/ui/popover.tsx");

/** A button and its popover, with a field or without one (Health; Assign while its form loads). */
function Harness({ field }: { field: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <span className="popover-wrap">
        <button ref={anchor} type="button" aria-expanded={open} onClick={() => setOpen(!open)}>Filter</button>
        <Popover open={open} onClose={() => setOpen(false)} label="Filter" anchor={anchor}>
          <button type="button">A link-like first control</button>
          {field ? <input aria-label="Sender" /> : <p>Reading…</p>}
          <button type="button">Apply</button>
        </Popover>
      </span>
      <button type="button">elsewhere</button>
    </>
  );
}

const anchor = () => screen.getByRole("button", { name: "Filter" });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Moves focus as Tab would, then lets the popover judge where it landed. */
async function moveFocus(to: HTMLElement) {
  await act(async () => { to.focus(); await tick(); });
}
const popover = () => screen.queryByRole("dialog", { name: "Filter" });

function open(field: boolean) {
  render(<Harness field={field} />);
  anchor().focus();
  fireEvent.click(anchor());
  return popover()!;
}

describe("focus on open", () => {
  it("goes to the first field, not to a control before it", () => {
    open(true);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Sender" }));
  });

  it("goes to the popover itself when it has no field, so it is read from the top and Escape works", () => {
    const box = open(false);
    expect(document.activeElement, "focus stayed on the button").toBe(box);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(anchor());
  });
});

describe("closing", () => {
  it("closes on Escape pressed on its button, not only inside it", () => {
    open(true);
    anchor().focus();
    fireEvent.keyDown(anchor(), { key: "Escape" });
    expect(popover(), "Escape on the button left it open").toBeNull();
  });

  it("closes when focus leaves both it and its button, and not while focus moves inside it", async () => {
    const box = open(true);
    await moveFocus(screen.getByRole("button", { name: "Apply" }));
    expect(popover(), "moving between its own controls closed it").not.toBeNull();
    await moveFocus(anchor());
    expect(popover(), "Shift+Tab back to its button closed it").not.toBeNull();

    // The window losing focus fires a blur and moves nothing: not a dismissal.
    await moveFocus(screen.getByRole("textbox", { name: "Sender" }));
    fireEvent.blur(screen.getByRole("textbox", { name: "Sender" }));
    await act(async () => { await tick(); });
    expect(popover()).toBe(box);

    await moveFocus(screen.getByRole("button", { name: "elsewhere" }));
    expect(popover(), "Tab out of it left it open over the page").toBeNull();
  });

  it("closes when focus leaves from its button, and when Tab goes past the page's last control", async () => {
    open(true);
    await moveFocus(anchor());
    await moveFocus(screen.getByRole("button", { name: "elsewhere" }));
    expect(popover(), "leaving from the button left it open").toBeNull();

    fireEvent.click(anchor());
    expect(popover()).not.toBeNull();
    // Past the last control focus lands on nothing the page owns: the body.
    await act(async () => { (document.activeElement as HTMLElement).blur(); await tick(); });
    expect(popover(), "Tab past the end left it open").toBeNull();
  });
});

describe("a press on its button, where the button does not take focus (Safari, Firefox on macOS)", () => {
  /*
   * Those engines leave focus on `<body>` when a button is pressed, so the field's focus leaves the popover
   * during the press. Judged as a leave, that closed it before the click, and the button's click, a toggle,
   * then opened it again: the button could not close its own popover.
   */
  /** The press as those engines deliver it: pointerdown, focus to `<body>`, not to the button. */
  function pressWithoutFocus() {
    fireEvent.pointerDown(anchor());
    (document.activeElement as HTMLElement).blur();
  }

  it("closes it, once, on the click", async () => {
    open(true);
    await act(async () => { pressWithoutFocus(); await tick(); });
    expect(popover(), "the press closed it before its click").not.toBeNull();
    await act(async () => { fireEvent.pointerUp(anchor()); fireEvent.click(anchor()); await tick(); });
    expect(popover(), "the click reopened what the press closed").toBeNull();
  });

  it("closes it when the press is released before the leave is judged, as a quick click is", async () => {
    open(true);
    await act(async () => { pressWithoutFocus(); fireEvent.pointerUp(anchor()); await tick(); });
    await act(async () => { fireEvent.click(anchor()); await tick(); });
    expect(popover()).toBeNull();
  });

  it("still closes on focus leaving once a press that slid off the button is over", async () => {
    open(true);
    await act(async () => { pressWithoutFocus(); await tick(); });
    await act(async () => { fireEvent.pointerUp(screen.getByRole("button", { name: "elsewhere" })); await tick(); });
    // Back into it, then out, as Tab would: the leave is judged again, and nothing is being pressed now.
    await moveFocus(screen.getByRole("textbox", { name: "Sender" }));
    await moveFocus(screen.getByRole("button", { name: "elsewhere" }));
    expect(popover(), "a press that never clicked left it unable to close on Tab").toBeNull();
  });
});
