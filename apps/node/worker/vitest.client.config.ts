import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { BUDGETS } from "@mailda/budgets";

/**
 * The interface, rendered.
 *
 * ## Why this config exists at all
 *
 * An external audit found seven code-level defects. **Four of them were in `src/client/`** — a draft lost
 * on close (#90), a sending mailbox inferred under a comment saying it never is (#94), a recipient parser
 * that splits inside a quoted name (#100), an empty inbox asserting routing is live (#101). At the time it
 * ran, this package had 1,135 tests in workerd and 204 in node, and **not one of them rendered a
 * component**. The client was the only unexercised layer and it held most of the bugs. That is not a
 * coincidence to note in passing; it is the reason this file is here.
 *
 * A third config rather than a `projects` block, for exactly the reason `vitest.node.config.ts` gives for
 * being the second: `vitest.config.ts` carries the Cloudflare pool, and restructuring it to host a DOM
 * environment would put a stable suite at risk for no gain.
 *
 * Both files used to say "the measured timeouts and the Cloudflare pool", and both then omitted the
 * timeouts — the sentence naming the dropped thing, in the file dropping it. See the note beside them.
 *
 * ## What belongs here, and what does not
 *
 * Here: behaviour that only exists once a component is mounted — an effect's cleanup racing a click
 * handler, a control disabled until a choice is made, what a screen says when a query returns nothing.
 *
 * Not here: anything extractable. `splitAddresses` and `chosenMailbox` are plain functions and are tested
 * in `test/node/` where they need neither a DOM nor a render. Mounting a component to test a pure function
 * is a slower test with more ways to be wrong, and it hides that the function was extractable.
 *
 * The dividing line is whether the *mount* is the thing under test. For #90 it is: no arrangement of pure
 * functions can express "the unmount cancelled the timer before the click handler's save fired", which is
 * the whole defect.
 *
 * `happy-dom` rather than `jsdom`: this suite needs a DOM to mount into and nothing more exotic, and it is
 * the faster of the two. If a test ever needs something happy-dom lacks, that is the moment to reconsider
 * — not now, on speculation.
 */
export default defineConfig({
  resolve: {
    alias: {
      /*
       * `/app/session.js` is a browser-absolute path the client bundle leaves external, so under vitest it
       * resolves to nothing. The stub is what a test can count calls through and resolve on demand — see
       * its own header for why it is not the real module.
       */
      "/app/session.js": fileURLToPath(new URL("./test/client/session-stub.ts", import.meta.url)),
      /*
       * `/app/config.js` is the same kind of specifier and is not even a file on disk — the Worker generates
       * it per request (#97). Its stub is built from the same budgets the Worker reads, so a rendered screen
       * shows the figure a real Node would send.
       */
      "/app/config.js": fileURLToPath(new URL("./test/client/config-stub.ts", import.meta.url)),
      /*
       * `/app/delivery.js` is the third specifier of this kind, and unlike the two above it **is** a real file
       * — `src/client/delivery.client.js`, served verbatim by the Worker. So this alias points at the shipped
       * module rather than at a stub: the delivery vocabulary is the thing `ledgers.tsx` is not allowed to
       * restate, and a stub of it here would be exactly the second copy that rule exists to prevent.
       */
      "/app/delivery.js": fileURLToPath(new URL("./src/client/delivery.client.js", import.meta.url)),
      /*
       * The framework-free script's own relative imports (#134).
       *
       * `src/client/app.client.js` imports the session and config modules by the relative names the Worker serves,
       * which are `session.client.js` on disk and generated per request. Neither resolves under vitest, so
       * **the script could not be imported by a test at all**, and it is the one that renders the claim, the
       * sign-in and a locked-out doctor.
       *
       * That is not a small gap: the claim screen received ADR 29's ten recovery codes and dropped them, and
       * no test in either suite was positioned to see it, because the React tests do not drive this file and
       * this file could not be loaded. Aliasing the two specifiers is what makes it testable.
       */
      "./session.js": fileURLToPath(new URL("./test/client/session-stub.ts", import.meta.url)),
      "./config.js": fileURLToPath(new URL("./test/client/config-stub.ts", import.meta.url)),
      /*
       * The React bundle, which `app.client.js` imports dynamically after sign-in. vite resolves the
       * specifier at transform time even though the import is lazy, so the script cannot load without this.
       * Stubbed rather than pointed at the real bundle: that is build output a clean checkout lacks, and every
       * screen it mounts is already covered by the `.test.tsx` files.
       */
      "/app/shell.js": fileURLToPath(new URL("./test/client/shell-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/client/**/*.test.tsx", "test/client/**/*.test.ts"],
    environment: "happy-dom",
    // Testing Library's `cleanup` between tests. Without it, a component from the previous test is still
    // mounted and its effects are still live, so a leaked timer lands in the next test's assertions —
    // which is the exact class of bug this suite exists to catch, arriving as a flake instead.
    globals: true,
    setupFiles: ["test/client/setup.ts"],

    // The measured budget, for the reason `vitest.node.config.ts` records at length: this config gives the
    // same explanation for being separate — that `vitest.config.ts` is the one carrying the measured
    // timeouts — and then did not carry them either. Both were fixed together, and
    // `test/node/vitest-timeout-world.test.ts` holds every config to it now.
    //
    // No breach has been observed here yet: this suite mounts components and its slowest case is far under
    // the limit. It is set because 5,000 ms is an inherited default rather than a measured one, and waiting
    // for a flake to prove that a third time is not a plan.
    testTimeout: BUDGETS["test.timeout_ms"],
    hookTimeout: BUDGETS["test.hook_timeout_ms"],

    // So the headroom ceiling can see this suite too — it read only the workerd report until now. See the
    // note on the same line in `vitest.node.config.ts`.
    reporters: process.env.CI === undefined
      ? ["default"]
      : ["default", ["json", { outputFile: "./.vitest-report-client.json" }]],
  },
});
