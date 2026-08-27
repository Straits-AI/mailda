/**
 * Webfonts arrive as bytes.
 *
 * `wrangler.jsonc` declares a `Data` rule matching every woff2 file, which bundles each one as a module
 * whose default export is an `ArrayBuffer`. The compiler has no way to know, so it is declared here — `src/ui.ts`
 * needs the bytes at runtime because a Worker cannot read the `fonts/` directory.
 *
 * This file deliberately contains **no imports or exports**, for the reason `sql-modules.d.ts` records: a
 * `.d.ts` with either becomes a module, and a `declare module` inside a module is a module *augmentation*
 * rather than an ambient wildcard, which is why the same declaration in `env.d.ts` had no effect.
 */
declare module "*.woff2" {
  const bytes: ArrayBuffer;
  export default bytes;
}
