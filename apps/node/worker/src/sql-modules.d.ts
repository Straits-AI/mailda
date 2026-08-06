/**
 * Migration files arrive as strings.
 *
 * wrangler's default Text rule bundles `.sql` as a module whose default export is its contents, and
 * `wrangler.jsonc` deliberately preserves that rule with `fallthrough: true`. The compiler has no way
 * to know, so it is declared here — `src/migrate.ts` needs the schema at runtime because a Worker
 * cannot read the `migrations/` directory.
 *
 * This file deliberately contains **no imports or exports**. A `.d.ts` with either becomes a module,
 * and a `declare module` inside a module is a module *augmentation* rather than an ambient wildcard —
 * which is why the same declaration in `env.d.ts` had no effect.
 */
declare module "*.sql" {
  const sql: string;
  export default sql;
}
