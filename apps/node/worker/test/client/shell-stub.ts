/**
 * Stands in for `/app/shell.js`, the React bundle (#134).
 *
 * `app.client.js` imports it **dynamically**, after sign-in, so that an operator staring at a 500 never
 * downloads a hundred kilobytes of React to find out why. vite still resolves the specifier when it transforms
 * the module, so without this the framework-free script cannot be loaded by a test at all — and it is the one
 * that renders the claim, the sign-in and a locked-out doctor.
 *
 * A stub rather than the real bundle, and deliberately: the real one is build output that a clean checkout
 * does not have, and every screen it mounts is already driven by the React tests. What is untested is
 * everything *before* it loads, which is what this unblocks.
 */
export function mount(): void {
  throw new Error(
    "the React shell is stubbed in this suite. A test that needs it belongs in test/client/*.test.tsx, "
    + "which drives the real screens.",
  );
}
