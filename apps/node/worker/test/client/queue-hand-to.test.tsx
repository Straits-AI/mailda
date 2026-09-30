import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HandTo } from "../../src/client/app/screens/queue.tsx";

/**
 * The queue's "Hand to…" field submits on Enter, and an input method's Enter is not that (ADR 46,
 * `src/client/app/ui/ime.ts`). A reader typing a colleague's address through Pinyin commits a candidate with Enter;
 * handing the case to half an address would be a real act on a real case.
 */
describe("handing a case to a colleague", () => {
  function typed(): { field: HTMLElement; onAssign: ReturnType<typeof vi.fn> } {
    const onAssign = vi.fn();
    render(<HandTo onAssign={onAssign} />);
    fireEvent.click(screen.getByRole("button", { name: "Hand to…" }));
    const field = screen.getByRole("textbox", { name: "Colleague's sign-in address" });
    fireEvent.change(field, { target: { value: "wang@example.test" } });
    return { field, onAssign };
  }

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("does not hand over on an input method's Enter (%s)", (_, composing) => {
    const { field, onAssign } = typed();
    fireEvent.keyDown(field, { key: "Enter", ...composing });
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("hands over on a plain Enter", () => {
    const { field, onAssign } = typed();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onAssign).toHaveBeenCalledWith("wang@example.test");
  });
});
