/**
 * Builds the authenticated application (ADR 30).
 *
 * ## Why this runs from wrangler's own config rather than from `pnpm run deploy`
 *
 * A one-click install does not run our scripts. Workers Builds executes `npx wrangler deploy` directly —
 * measured, in `docs/receipts/deploy-button-install.md` — so a bundle that only got built by
 * `pnpm run deploy` would simply be absent on the install path most customers take. `wrangler.jsonc`
 * declares this as `build.command`, which means every route to a deploy runs it: the button, the CLI, and
 * `wrangler dev`.
 *
 * The failure mode if it ever does not run is a **failed deploy**, not a dead Node: `ui.ts` imports the
 * bundle, so a missing file stops wrangler at bundle time. That is the right direction for this to fail
 * in — the alternative designs all end with a Worker that deploys green and serves a blank page.
 *
 * ## The output lives outside `src/`
 *
 * `wrangler` watches the source tree to re-run this command, so an artifact written *into* what it watches
 * makes every build trigger the next one. It did: `wrangler dev` looped until it stopped answering
 * requests. Hence `generated/` at the package root and `watch_dir: "src"` — two independent reasons the
 * loop cannot come back.
 *
 * ## Why the output is not committed
 *
 * It was the other candidate, and it works: `packages/budgets/src/generated.ts` is committed with CI
 * failing on any regeneration diff, and the same pattern would remove every ordering concern here. It
 * loses on review: that file changes on **every** interface commit, so each one would carry a hundred
 * kilobytes of minified diff, and a reviewer who cannot read the artifact cannot notice anything wrong
 * in it. A generated file is worth committing when a human might need to read it. This one is not.
 */

import { build } from "esbuild";
import { mkdir, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const workerRoot = join(here, "..");
const entry = join(workerRoot, "src/client/app/main.tsx");
const outDir = join(workerRoot, "generated");
// `.client.js` so wrangler's Text rule matches it and `ui.ts` can import it as a string, exactly like
// the framework-free scripts it sits beside.
const outFile = join(outDir, "app.bundle.client.js");

await mkdir(outDir, { recursive: true });

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  // The pre-authentication surface stays framework-free and server-rendered, so this bundle is only ever
  // reached by an authenticated operator on a browser they already signed in with. Modern target,
  // therefore, rather than transpiling for browsers that could not have got here.
  target: "es2022",
  platform: "browser",
  minify: true,
  // No source map. It would double the served bytes to help debug code that a customer cannot patch
  // anyway — they fork and rebuild (ADR 24), which regenerates the map locally.
  sourcemap: false,
  jsx: "automatic",
  // Left as runtime imports rather than bundled. `session.client.js` holds the token lifecycle in module
  // scope, and a bundled copy would put two refresh timers on a page that also loads the framework-free
  // script; `delivery.client.js` stays external so the module React renders from is the one the node test
  // evaluates. See `src/client/app/externals.d.ts`.
  external: ["/app/session.js", "/app/delivery.js"],
  // React reads this to strip development-only warnings and the dev-mode reconciler. Without it the
  // bundle carries both, which is both larger and slower.
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: outFile,
  metafile: true,
  logLevel: "silent",
});

if (result.warnings.length > 0) {
  for (const warning of result.warnings) {
    console.warn(`warning: ${warning.text} (${warning.location?.file}:${warning.location?.line})`);
  }
}

const bytes = (await stat(outFile)).size;
const gzipped = gzipSync(readFileSync(outFile)).length;

// Printed rather than written to a file. The first version wrote `bundle-size.json` next to the bundle so
// a receipt could read it, and since wrangler's custom build watches for changes, every build triggered the
// next one — `wrangler dev` spun until it stopped answering. The receipt cites this line instead, which is
// reproducible by running the build.

console.log(`app bundle: ${bytes} bytes raw, ${gzipped} bytes gzip -> ${outFile.replace(workerRoot, ".")}`);
