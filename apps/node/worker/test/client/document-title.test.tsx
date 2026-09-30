import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RouteState } from "./router-mock.tsx";

const route: RouteState = { pathname: "/outbox" };
vi.mock("@tanstack/react-router", async () => (await import("./router-mock.tsx")).routerMock(route));

const { DocumentTitle } = await import("../../src/client/app/title.ts");

/**
 * Each signed-in screen is titled for itself (WCAG 2.4.2), and signing out gives the page its plain name back:
 * the shell unmounts over the sign-in screen, which must not keep the title of the screen left behind.
 */
describe("the document title", () => {
  it("names the screen, then the product, and only the product once the shell is gone", () => {
    document.title = "Mailda";
    const shell = render(<DocumentTitle />);
    expect(document.title).toBe("Outbox · Mailda");
    shell.unmount();
    expect(document.title).toBe("Mailda");
  });
});
