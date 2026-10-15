import { beforeAll, describe, expect, it, vi } from "vitest";

import { answer, app, boot, session, signInScreen, until } from "./preauth-driver.ts";
import { stand } from "./shell-stub.ts";

/**
 * Signing in hands the page to the shell once, and the shell's page survives it (15 October 2026).
 *
 * A sign-in hands over twice at once: `adopt()` says `signed-in`, whose listener hands over, and the form then
 * calls `route()`, which hands over too. The caller used to clear `#app` before calling `mount`, which is
 * idempotent, so the second handover deleted the nodes React had just committed and left a root that no longer
 * owned them; its next update threw "Failed to execute 'removeChild' on 'Node'". A reload did one handover, so it
 * went away. The stand-in `mount` below does what `main.tsx` does: once, clear and render.
 */

vi.mock("./session-stub.ts", async (original) => {
  const { controlled: control, session: held } = await import("./preauth-driver.ts");
  const controlled = control(await original<object>());
  // The real `adopt()` says `signed-in` (session.client.js); the suite's stub says nothing.
  return { ...controlled, adopt: () => { held.signedIn = true; held.listener?.({ type: "signed-in" }); } };
});

// The words are installed by the suite's setup; the built table `loadApp` imports is not on disk under test.
vi.mock("../../src/client/locale.ts", async (original) => ({ ...(await original<object>()), loadApp: async () => {} }));

let mounts = 0;
beforeAll(() => {
  stand.mount = (element) => {
    mounts += 1;
    // Guarded as `main.tsx` guards it, on having mounted, not on what the element holds: a root does not redraw.
    if (mounts > 1) return;
    const shell = Object.assign(document.createElement("div"), { textContent: "shell" });
    shell.setAttribute("data-shell", "");
    element.replaceChildren(shell);
  };
});

beforeAll(async () => {
  await boot();
});

describe("signing in", () => {
  it("leaves the shell's page in place after both handovers", async () => {
    await signInScreen();
    answer("/api/auth/login", () => Response.json({}));
    app().querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await until(() => mounts === 2, `expected two handovers, saw ${mounts}: ${app().textContent}`);
    await new Promise((settle) => setTimeout(settle, 20));
    expect(session.signedIn).toBe(true);
    expect(app().querySelector("[data-shell]"), "a second handover cleared the shell's page").not.toBeNull();
  });
});
