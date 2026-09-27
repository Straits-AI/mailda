import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { AppRoute } from "../../../app-routes.ts";
import { ROUTE_LABELS, useStartCompose } from "../chrome.tsx";
import { useCommands, usePendingSearch } from "../shell-context.tsx";
import { Modal } from "./popover.tsx";
import { shortcutsEnabled } from "./shortcuts.ts";

/**
 * Cmd+K / Ctrl+K: go anywhere, or do what the current screen offers, from the keyboard.
 *
 * ## Why typing sends nothing
 *
 * The list is **static**: the commands the mounted screen registered, Compose, and one "Go to" per route.
 * Filtering is a substring match over it in the browser, so no keystroke is a request. That is a governance
 * rule before it is a cost one: each listing a supervised reader fetches is a recorded `supervised.query`,
 * and a palette that searched as you typed would write one per letter (Blueprint §5). Searching mail is one
 * explicit item, "Search mail for …", which hands the words to the Inbox's own search, one request.
 *
 * The shortcut is modified, so it is not subject to the single-key switch (WCAG 2.1.4) and it works from
 * inside a field. It is the platform's own chord: Cmd+K on Apple platforms, where Ctrl+K in a field is the
 * system's "delete to end of line" and is left alone, and Ctrl+K (or the Meta key) elsewhere. A held chord
 * toggles once: auto-repeat is swallowed, not acted on.
 *
 * An item that has a single key says so (R, A, F, E, Shift+I, C), which is how the palette teaches the
 * keyboard map, and only while single-key shortcuts are on: a hint for a switched-off key names a key that
 * does nothing.
 */

interface Item {
  id: string;
  label: string;
  /** The single key that does the same, shown only while single-key shortcuts are on. */
  hint?: string;
  group: "Message" | "Mail" | "Go to";
  run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing) return;
      const apple = /Mac|iP(hone|ad|od)/.test(navigator.platform);
      if (!(apple ? event.metaKey : event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k") return;
      // Every match, repeats too, so a held chord never reaches the browser's own Ctrl/Cmd+K.
      event.preventDefault();
      if (event.repeat) return;
      setOpen((was) => !was);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return open ? <Palette onClose={() => setOpen(false)} /> : null;
}

function Palette({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const commands = useCommands();
  const startCompose = useStartCompose();
  const pending = usePendingSearch();
  const navigate = useNavigate();

  const wanted = text.trim().toLowerCase();
  const all: Item[] = [
    ...commands.map((command): Item => ({
      id: command.id, label: command.label, hint: command.hint, group: "Message", run: command.run,
    })),
    { id: "compose", label: "Compose", hint: "C", group: "Mail", run: startCompose },
    ...(Object.keys(ROUTE_LABELS) as AppRoute[]).map((to): Item => ({
      id: `go ${to}`, label: `Go to ${ROUTE_LABELS[to]}`, group: "Go to", run: () => void navigate({ to }),
    })),
  ];
  const items = all.filter((item) => item.label.toLowerCase().includes(wanted));
  if (wanted !== "") {
    items.push({
      id: "search",
      // The words as typed: the Node decides what a search means (#107), not this list.
      label: `Search mail for “${text}”`,
      group: "Mail",
      run: () => {
        pending.request(text);
        void navigate({ to: "/" });
      },
    });
  }
  const at = Math.min(active, items.length - 1);
  const hints = shortcutsEnabled();

  // The list scrolls (320px of 34px rows): the option Enter would run is kept in view as the arrows move.
  useEffect(() => {
    document.getElementById(`palette-option-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  /** Closes first, so whatever the item opens (the composer, a screen) is not covered by this dialog. */
  function run(item: Item | undefined) {
    if (item === undefined) return;
    onClose();
    item.run();
  }

  return (
    <Modal className="palette" label="Command palette" onClose={onClose}>
      <input
        className="palette-input"
        role="combobox"
        aria-expanded={true}
        aria-controls="palette-list"
        aria-activedescendant={at < 0 ? undefined : `palette-option-${at}`}
        aria-label="Go to or do"
        placeholder="Go to or do…"
        autoComplete="off"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((at + 1) % Math.max(items.length, 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((at - 1 + items.length) % Math.max(items.length, 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            run(items[at]);
          }
        }}
      />
      <ul id="palette-list" className="palette-list" role="listbox" aria-label="Commands">
        {items.map((item, index) => (
          <li
            key={item.id}
            id={`palette-option-${index}`}
            className="palette-option"
            role="option"
            aria-selected={index === at}
            onClick={() => run(item)}
            onMouseMove={() => { if (index !== at) setActive(index); }}
          >
            <span>{item.label}</span>
            {hints && item.hint !== undefined ? <kbd className="palette-hint">{item.hint}</kbd> : null}
            <span className="palette-group">{item.group}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
