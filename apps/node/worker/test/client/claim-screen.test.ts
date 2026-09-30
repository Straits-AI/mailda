import { beforeAll, describe, expect, it } from "vitest";

/**
 * The claim screen says what its email is for (28 September 2026). A founder claimed a Node as `admin@` and
 * then found replies going out as `hello@`, with nothing on the way having said the two are different things:
 * the email signs you in, and mail goes out from a mailbox's address, which setup chooses.
 *
 * Booted the way `recovery-codes-screen.test.ts` boots it, and for its reasons: the module renders into `#app`
 * on import, so `/health` answers unclaimed first and the claim screen is waited for by its effect.
 */

beforeAll(async () => {
  document.body.innerHTML = '<div class="rack"><div class="rack-inner"><div id="status"></div></div></div>'
    + '<main id="app"></main>';
  globalThis.fetch = (async () => Response.json({ claimed: false, outboxPending: 0 })) as unknown as typeof fetch;
  await import("../../src/client/app.client.js");
  const app = document.getElementById("app") as HTMLElement;
  for (let attempt = 0; attempt < 400 && app.querySelector("form") === null; attempt += 1) {
    await new Promise((settle) => setTimeout(settle, 5));
  }
});

describe("the claim screen", () => {
  it("says the email signs you in and mail goes out from a mailbox's address", () => {
    const form = document.querySelector("#app form") as HTMLFormElement | null;
    expect(form, "the claim screen never rendered").not.toBeNull();
    // Under the email field, where the question arises, not under the password or the secret.
    const email = form!.querySelector("#email")?.closest("label");
    expect(email?.nextElementSibling?.className).toBe("hint");
    expect(email?.nextElementSibling?.textContent).toBe("You sign in with this email. Mail goes out from a mailbox's address, which setup chooses.");
  });
});
