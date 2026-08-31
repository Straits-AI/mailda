import { defineConfig } from "vitest/config";

import { measuredTimeouts } from "../../vitest.shared.ts";

/**
 * This package's suite, carrying the measured timeout rather than vitest's default.
 *
 * It had no config at all, which meant the 5,000 ms default `docs/receipts/test-timeout-headroom.md` was
 * written to reject — and `packages/evidence` flaked on it under `turbo test` while the worker's three configs
 * were being fixed. The timeouts come from `vitest.shared.ts` at the repository root, which reads the
 * generated receipt value rather than importing `@mailda/budgets`; see its header for why that matters to
 * `packages/receipts` in particular.
 */
export default defineConfig({
  test: {
    ...measuredTimeouts,
  },
});
