import { BUDGETS } from "@mailda/budgets";

/**
 * Stands in for `/app/config.js` when a component is rendered in a test.
 *
 * That path is a browser-absolute specifier the bundler leaves external, and it is not even a file on disk —
 * the Worker generates it per request (`configModule` in `src/ui.ts`), so under vitest it resolves to nothing
 * unless something says what it is. `vitest.client.config.ts` aliases it here.
 *
 * **The numbers are read from the same budgets the Worker reads**, not typed in. A stub saying
 * `holdWindowSeconds: 15` would put an unreceipted number in the repository and let a screen be asserted
 * against a figure no Node ever sends. Whether the served module actually carries these fields is a property
 * of what the Worker emits and cannot be checked from here; `test/security-headers.test.ts` asserts it there.
 *
 * `expiryCookie` is a literal, and it is the one thing here that is *not* taken from its source: the source
 * is `src/auth/session.ts`, which reaches the D1 and crypto bindings at import and does not load in
 * happy-dom. It is a cookie **name** rather than a limit, and nothing rendered in this suite reads it — the
 * only reader is `session.client.js`, which these tests replace with `session-stub.ts` wholesale. It is here
 * so the double has the module's shape rather than a subset of it, which is what stops a component that
 * starts reading a third field from finding `undefined` and no test noticing.
 */
export const CONFIG = {
  refreshMarginSeconds: BUDGETS["auth.access_token_refresh_margin_seconds"],
  expiryCookie: "mailda_at_exp",
  holdWindowSeconds: BUDGETS["send.hold_window_default_seconds"],
} as const;
