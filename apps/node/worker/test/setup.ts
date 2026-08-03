import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Schema is applied once per test worker, using the platform's own migration
// runner rather than a hand-rolled SQL splitter.
beforeAll(async () => {
  await applyD1Migrations(env.CATALOG, env.TEST_MIGRATIONS);
});
