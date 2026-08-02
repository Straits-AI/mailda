import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    CATALOG: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
