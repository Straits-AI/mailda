import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../../..");
const workerDir = join(import.meta.dirname, "../..");

/**
 * Every receipt a comment cites actually exists.
 *
 * ## Why this is worth a file
 *
 * This repository's comments carry its evidence. *"Measured: see `docs/receipts/x.md`"* is how a reader is
 * meant to check a claim rather than take it, and a great deal of the source is written that way on purpose.
 * A citation pointing at a file that does not exist is therefore the same defect as a comment asserting a
 * property the code lacks (#103) — it reads as evidence, and there is nothing behind it. Worse than a broken
 * link in prose, because the reader who follows it is precisely the reader who was trying to verify something.
 *
 * It has already happened. `src/search-backfill.ts` cited a receipt called `body-search-cost.md` — a file
 * that was never created, because the receipt shipped as `message-search-cost.md` — and the sentence it
 * introduced promised a caveat *"recorded in"* that file which was not recorded anywhere either. Found by
 * grepping, on the way to answering a question about what work was left, and not by any check.
 *
 * That name is written here **without its directory prefix on purpose.** The scan below matches the full
 * `docs/receipts/<id>.md` form, so spelling the historical path in full would make this file's own
 * explanation a dangling citation — which it did, on the first run. Prose cannot be filtered out of the
 * scan the way `content-deletion-world.test.ts` filters it, because in this repository citations live in
 * comments almost exclusively; the scan would see nothing.
 *
 * ## Why it is cheap enough to be worth having
 *
 * The whole check is a path existence test. It costs milliseconds, it needs no fixture, and the failure it
 * catches is one nothing else in the suite can see: a receipt rename or a citation typo is invisible to the
 * compiler, to lint, and to every behavioural test.
 */

/** Directories whose citations are checked, relative to the worker. Prose lives elsewhere and is not scanned. */
const SCANNED = ["src", "test", "scripts"];

/** `docs/receipts/<id>.md`, the one form every citation in this repository uses. */
const CITATION = /docs\/receipts\/[a-z0-9-]+\.md/g;

/**
 * Paths that are deliberately not files.
 *
 * `packages/receipts` tests the *parser* and feeds it invented paths to check the error messages it builds, so
 * those are fixtures rather than citations. Listed rather than pattern-matched, so a real citation cannot hide
 * behind a name that happens to look like a fixture.
 */
const FIXTURES = new Set(["docs/receipts/x.md"]);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const full = join(workerDir, dir);
  if (!existsSync(full)) return out;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(rel));
    else if (/\.(ts|tsx|mjs|sql)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

function citations(): { file: string; path: string }[] {
  const found: { file: string; path: string }[] = [];
  for (const dir of SCANNED) {
    for (const file of filesUnder(dir)) {
      const source = readFileSync(join(workerDir, file), "utf8");
      for (const match of source.match(CITATION) ?? []) {
        if (!FIXTURES.has(match)) found.push({ file, path: match });
      }
    }
  }
  return found;
}

describe("citations to receipts point at receipts that exist", () => {
  it("finds citations to check, so this cannot pass by scanning nothing", () => {
    /*
     * Anti-vacuity. If `SCANNED` went stale after a directory move, or the citation form changed, every
     * assertion below would agree with everything — and this file would go on reporting success about a
     * convention it could no longer see. The number is deliberately a floor rather than an exact count: it
     * should grow, and a test that has to be edited every time somebody cites a receipt gets muted.
     */
    expect(citations().length, "no receipt citations found in src/, test/ or scripts/ — has the "
      + "`docs/receipts/<id>.md` convention changed, or a directory moved?").toBeGreaterThan(20);
  });

  it("resolves every cited receipt to a file", () => {
    /*
     * The rule. Reported with the citing file, because the fix is almost always at the citation rather than
     * the receipt — a rename that left one reference behind, or a receipt whose name was decided after the
     * comment was written. That is what happened the first time: the code named one file and the receipt
     * shipped as another.
     */
    const dangling = [...new Set(
      citations().filter(({ path }) => !existsSync(join(repoRoot, path)))
        .map(({ file, path }) => `${file} cites ${path}, which does not exist`),
    )];
    expect(
      dangling.length === 0 ? null : `${dangling.length} dangling receipt citation(s):\n  `
      + `${dangling.join("\n  ")}\n\nA citation is how a reader checks a claim instead of taking it. One `
      + "pointing at nothing reads as evidence and is not any.",
    ).toBeNull();
  });

  it("resolves the ones in the receipts themselves too, since they cite each other constantly", () => {
    /*
     * Receipts cross-reference heavily — `authz-check-rows-read.md` is cited by four others — and a rename
     * breaks those the same way. Scanned separately because the directory is outside the worker and the
     * failure is the same one.
     */
    const dir = join(repoRoot, "docs/receipts");
    const dangling: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const source = readFileSync(join(dir, name), "utf8");
      for (const match of new Set(source.match(CITATION) ?? [])) {
        if (!FIXTURES.has(match) && !existsSync(join(repoRoot, match))) {
          dangling.push(`docs/receipts/${name} cites ${match}, which does not exist`);
        }
      }
    }
    expect(dangling.length === 0 ? null : dangling.join("\n")).toBeNull();
  });
});
