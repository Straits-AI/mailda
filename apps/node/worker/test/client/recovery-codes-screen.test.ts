import { beforeAll, describe, expect, it } from "vitest";

/**
 * The ten recovery codes reach a screen (#134).
 *
 * ## Why this file exists at all
 *
 * `src/client/app.client.js` renders the claim, the sign-in and a locked-out doctor — the screens an operator
 * sees when the Node is broken — and **no test had ever loaded it**. Its relative imports name the session and
 * config modules as the Worker serves them, not as files on disk, so it could not be resolved. The React suite
 * drives the screens after sign-in; this file was outside both.
 *
 * The cost of that was measured. The claim returns ADR 29's ten codes in plaintext — the contract calls it
 * *"the only response in this contract that carries them"* — and the claim handler did
 * `adopt(); startSessionTicker(); return route();` without ever reading the body. Ten codes minted, hashed,
 * escrowed, and discarded by the one interface that ever received them.
 *
 * It surfaced during #92's restore drill: a full catalog and every object restored into a different Cloudflare
 * account, and the destination refused with `signing_key: E_EVIDENCE_AUTH_FAILED` because the vault needs a
 * code and none had ever been obtainable.
 *
 * This file drives the **screen**. That the claim handler reaches it is asserted in
 * `test/node/claim-shows-codes.test.ts`, which reads source and therefore belongs in the node suite — this
 * one runs under happy-dom and has no filesystem.
 */

const CODES = [
  "aaaa-bbbb-cccc", "dddd-eeee-ffff", "gggg-hhhh-iiii", "jjjj-kkkk-llll", "mmmm-nnnn-oooo",
  "pppp-qqqq-rrrr", "ssss-tttt-uuuu", "vvvv-wwww-xxxx", "yyyy-zzzz-0000", "1111-2222-3333",
];

/** Polls a condition rather than sleeping for a guessed interval. Throws with `why` if it never holds. */
async function until(holds: () => boolean, why: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (holds()) return;
    await new Promise((settle) => setTimeout(settle, 5));
  }
  throw new Error(why);
}

let screen: { renderRecoveryCodes: (codes: string[]) => void };

/*
 * Built **once**, not per test. `app.client.js` captures `document.getElementById("app")` at module load, the
 * way a script served to a browser does — so replacing the body between tests leaves the module holding a
 * detached node and rendering into nothing. The first test passed and the rest saw an empty page, which is a
 * fixture bug that looks exactly like a rendering bug.
 *
 * `show()` replaces the element's children anyway, so tests do not leak into each other.
 *
 * ## The module boots on import, and the boot writes to the same element
 *
 * Its last line is `route().catch(...)`, because a script a browser loads has no other place to start. So
 * importing it starts an asynchronous render into `#app` that lands whenever it lands — and with no `fetch`
 * answering `/health`, it lands as `Could not reach this Node`, replacing whatever a test had put there.
 *
 * That raced, and CI is where it was caught: locally the rejection resolved before the second test began, on a
 * loaded runner it resolved *during* it, and ten codes became zero. A `setTimeout` long enough to be safe today
 * is the kind of number that starts failing again on a different machine.
 *
 * So `/health` is answered before the import, and the boot is then **waited for by its effect** rather than by a
 * duration: nothing below runs until the claim screen the boot renders is on the page. After that the file's own
 * `route()` is finished and no longer competing for the element.
 */
beforeAll(async () => {
  document.body.innerHTML = '<div class="rack"><div class="rack-inner"><div id="status"></div></div></div>'
    + '<main id="app"></main>';
  globalThis.fetch = (async () =>
    Response.json({ claimed: false, outboxPending: 0 })) as unknown as typeof fetch;

  screen = await import("../../src/client/app.client.js") as unknown as typeof screen;

  const app = document.getElementById("app") as HTMLElement;
  await until(
    () => app.childElementCount > 0,
    "the module's own route() never rendered, so nothing here can tell its output from a test's",
  );
});

async function render(codes: string[]): Promise<HTMLElement> {
  screen.renderRecoveryCodes(codes);
  /*
   * A macrotask before asserting, and it is a real assertion rather than a wait for convenience.
   *
   * A mutation adding an unconditional `route()` to this screen — rendering the codes and then navigating
   * straight past them, which is the original defect in a new place — **passed** every test here. `route()`
   * is async, so the replacement landed on a microtask after the synchronous assertions had already read the
   * DOM. Yielding first means the tests see the screen a person would see, not the one that existed for an
   * instant.
   */
  await new Promise((settle) => setTimeout(settle, 0));
  return document.getElementById("app") as HTMLElement;
}

describe("the screen that shows the codes once", () => {
  it("shows every one of them", async () => {
    const app = await render(CODES);
    const shown = [...app.querySelectorAll("li")].map((node) => node.textContent);
    expect(shown).toEqual(CODES);
  });

  it("stays on screen, rather than being replaced a moment later", async () => {
    /*
     * The property the codes' whole value rests on: nothing navigates away until a person says they have
     * saved them. A screen that renders ten codes and routes to the inbox on the next tick is the original
     * defect wearing the fix's clothes, and it is invisible to any assertion made in the same tick.
     */
    const app = await render(CODES);
    expect(app.querySelectorAll("li")).toHaveLength(CODES.length);
    // And again after a second yield, in case the navigation is merely slower than one tick.
    await new Promise((settle) => setTimeout(settle, 5));
    expect((document.getElementById("app") as HTMLElement).querySelectorAll("li")).toHaveLength(CODES.length);
  });

  it("leads with an instruction rather than a label", async () => {
    /*
     * The heading is what a person reads first and what decides whether they act. "Recovery codes" is a
     * label somebody scrolls past; the screen has one job, which is to get ten strings written down before
     * anything else happens. A mutation softening this passed every other assertion here, because the
     * substantive warnings live in the paragraphs below it.
     */
    const heading = (await render(CODES)).querySelector("h1");
    expect(heading?.textContent).toBe("Write these down now.");
  });

  it("says they cannot be produced again, in the words that matter", async () => {
    /*
     * The screen's job is not to display ten strings; it is to make somebody write them down. A person who
     * reads "recovery codes" and closes the tab has lost the organization's mail, so the text has to say what
     * is at stake and that there is no second chance.
     */
    const text = (await render(CODES)).textContent ?? "";
    expect(text).toContain("only way to recover");
    expect(text).toContain("shown here once");
    expect(text).toContain("nothing, including us, can produce them again");
  });

  it("offers one way forward, and it asserts something rather than acknowledging", async () => {
    /*
     * "OK" would let somebody dismiss this without having claimed anything. The button says what clicking it
     * means, so a person who has not saved them has to notice that they are saying they did.
     */
    const app = await render(CODES);
    const buttons = [...app.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.textContent).toBe("I have saved these ten codes");
  });

  it("names the next step, because ten codes nobody has read are the same as none", async () => {
    // `doctor` reports degraded until one is typed back, and the screen is where somebody learns why.
    expect((await render(CODES)).textContent).toContain("recovery-codes confirm");
  });
});
