import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const { ScreenFailed } = await import("../../src/client/app/main.tsx");

/**
 * A screen that throws says so in this interface's words and keeps the error's own (15 October 2026). The router's
 * default was "Something went wrong!" in English with the error behind a button, which is what a viewer met when a
 * sign-in's double handover broke React's tree (`shell-handover.test.ts`).
 */
describe("a screen that threw", () => {
  it("says what happened, shows the error's words, and offers a reload", () => {
    render(<ScreenFailed error={new Error("Failed to execute 'removeChild' on 'Node'")} reset={() => {}} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("This screen stopped because of an error in this interface.");
    expect(alert.querySelector("pre")?.textContent).toBe("Failed to execute 'removeChild' on 'Node'");
    expect(screen.getByRole("button").textContent).toBe("Reload the page");
  });
});
