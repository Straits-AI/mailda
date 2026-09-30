import type { Catalog } from "./catalog.ts";
import type { Locale } from "./locales.ts";
import { preauth as en } from "./en/preauth.ts";
import { preauth as zhHans } from "./zh-Hans/preauth.ts";

/**
 * Every locale's `preauth` table, and nothing else: `src/client/locale.ts` imports this, so what esbuild
 * bundles into `/app/locale.js` is these tables and not the `app` ones, which are served per locale.
 * `test/catalog-served.test.ts` holds that by reading the built file.
 */
export const PREAUTH: Readonly<Record<Locale, Catalog["preauth"]>> = { en, "zh-Hans": zhHans };
