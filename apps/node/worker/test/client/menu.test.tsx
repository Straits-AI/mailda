import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * The menu button (`ui/menu.tsx`): the keyboard contract, and where focus is when an item has run.
 *
 * What would render plausibly and be wrong: an item that runs with the menu's own detached button still
 * "focused", so focus falls to `<body>` after Mark unread and a dialog opened from the menu records a node
 * that no longer exists as the place to come back to; a note read twice, once in the name and once as the
 * description; a group rule the arrow keys stop on.
 */

const { Menu } = await import("../../src/client/app/ui/menu.tsx");
const { Modal } = await import("../../src/client/app/ui/popover.tsx");

/** A reader's overflow menu in miniature: plain acts, a link with a note, and one that opens a dialog. */
function Harness({ onSelect = vi.fn() }: { onSelect?: (label: string) => void }) {
  const [dialog, setDialog] = useState(false);
  // What the reader does for View headers: the opener is whatever has focus when the item runs.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <>
      <button type="button">before</button>
      <Menu
        label="More actions"
        face="•••"
        items={[
          { label: "Mark unread", onSelect: () => onSelect("Mark unread") },
          { label: "Move to Trash", disabled: true },
          {
            label: "View headers",
            startsGroup: true,
            onSelect: () => {
              opener.current = document.activeElement as HTMLElement;
              setDialog(true);
            },
          },
          { label: "Download original", note: "Recorded as an export.", href: "/raw" },
        ]}
      />
      {dialog ? (
        <Modal className="headers-dialog" label="Headers" onClose={() => setDialog(false)} returnTo={opener}>
          <button type="button" onClick={() => setDialog(false)}>Close</button>
        </Modal>
      ) : null}
    </>
  );
}

const trigger = () => screen.getByRole("button", { name: "More actions" });
const menu = () => screen.queryByRole("menu", { name: "More actions" });
const item = (name: string | RegExp) => screen.getByRole("menuitem", { name });

function openMenu() {
  trigger().focus();
  fireEvent.click(trigger());
  return menu()!;
}

describe("the keyboard", () => {
  it("opens on the first item, moves with the arrows, Home and End, wrapping and skipping what is disabled", () => {
    render(<Harness />);
    const list = openMenu();
    expect(document.activeElement).toBe(item("Mark unread"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement, "the disabled item took focus").toBe(item("View headers"));
    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(item("Download original"));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(document.activeElement, "ArrowDown did not wrap").toBe(item("Mark unread"));
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement, "ArrowUp did not wrap").toBe(item("Download original"));
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(item("Mark unread"));
  });

  it("closes on Escape with focus back on the button, and on Tab", () => {
    render(<Harness />);
    fireEvent.keyDown(openMenu(), { key: "Escape" });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(openMenu(), { key: "Tab" });
    expect(menu()).toBeNull();
  });
});

describe("where focus is once an item has run", () => {
  it("is on the button, after an act that changes nothing on screen", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    openMenu();
    fireEvent.click(item("Mark unread"));
    expect(onSelect).toHaveBeenCalledWith("Mark unread");
    expect(menu()).toBeNull();
    expect(document.activeElement, "focus fell to <body>").toBe(trigger());
  });

  it("is on the button again when a dialog the menu opened closes", () => {
    render(<Harness />);
    openMenu();
    fireEvent.click(item("View headers"));
    const dialog = screen.getByRole("dialog", { name: "Headers" });
    act(() => { fireEvent(dialog, new Event("cancel")); });
    expect(screen.queryByRole("dialog", { name: "Headers" })).toBeNull();
    expect(document.activeElement, "the dialog came back to the menu's detached item").toBe(trigger());
  });
});

describe("what a screen reader hears", () => {
  it("names an item by its label and describes it by its note, once each", () => {
    render(<Harness />);
    openMenu();
    const download = screen.getByRole("menuitem", { name: "Download original", description: "Recorded as an export." });
    expect(download.tagName).toBe("A");
  });

  it("draws one rule where a group starts, never first, and the arrows pass over it", () => {
    render(<Harness />);
    const list = openMenu();
    const rules = within(list).getAllByRole("separator");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.previousElementSibling).toBe(item("Move to Trash"));
    expect(rules[0]!.nextElementSibling).toBe(item("View headers"));
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(document.activeElement).toBe(item("Mark unread"));
  });

  it("draws no rule above the first item, even one that starts a group", () => {
    render(<Menu label="Actions" face="•••" items={[{ label: "Only", startsGroup: true }, { label: "Next" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(within(screen.getByRole("menu")).queryAllByRole("separator")).toEqual([]);
  });
});
