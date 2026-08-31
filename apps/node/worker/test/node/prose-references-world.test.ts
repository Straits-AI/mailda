import { describe, expect, it } from "vitest";
import { BUDGETS } from "@mailda/budgets";
import { pathsIn, proseLines, referencesUnder, resolves, type Reference } from "./support/prose-references";

/**
 * Every path this repository's prose names must exist, or be listed below with a reason.
 *
 * ## What defect this closes
 *
 * Issue #103. A comment that cites a file which is not there reads exactly like one that cites a file which
 * is, and a reader who follows the citation finds nothing and moves on. Nothing in the toolchain resolves a
 * path inside a comment, so it can be wrong at the moment it is written and stay wrong indefinitely.
 *
 * It is not hypothetical. The audited corpus contains `test/composer.test.ts` — a file that has never
 * existed; the real one is `test/drafts.test.ts`. Building this check found three more that no reviewer had
 * caught: a receipt whose **Measured** line named `apps/node/workers/state/test/authz.measure.test.ts`
 * while line 140 of the same receipt named the real `apps/node/worker/test/authz.measure.test.ts`, and both
 * client type declarations pointing at an `../externals-note.md` that exists nowhere.
 *
 * ## What it deliberately does not close
 *
 * A wrong claim *about* a real file. `src/auth/session.ts` cited `client.ts`, which resolves nowhere and so
 * was caught; had it cited a real-but-unrelated module the check would have passed it. Worse, while fixing
 * the two declarations above the first attempt **removed** a correct reference to `session.client.js` after
 * an `ls` of the wrong directory — a false claim introduced by the act of fixing one, and invisible here,
 * because a reference that is gone is never unresolvable. Existence is the part that mechanises. Accuracy
 * is not, and [the receipt](../../../../../docs/receipts/false-claim-detectability.md) records what was
 * measured before concluding that.
 *
 * ## A trap for anyone editing prose and running the suite locally
 *
 * This test reads the **whole repository**, including files outside the package it lives in. Turbo's cache
 * keys on the package's own inputs, so a change to the root `README.md` alone leaves the cached result in
 * place and `pnpm test` reports green without re-running this. That happened while #92's backup commands were
 * landing: two references added to the README passed locally and failed in CI, which runs clean.
 *
 * Run it directly — `npx vitest run --config vitest.node.config.ts test/node/prose-references-world.test.ts`
 * — after editing prose outside this package, or trust CI to be the one that actually looked.
 */

const ROOT = new URL("../../../../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * The paths prose names that are not files in this repository, each with the reason it cannot be.
 *
 * Keyed `file → path`, not `file:line → path`: a line number churns with every edit above it, and an
 * exemption that has to be renumbered is an exemption that gets bulk-updated without being read.
 *
 * This is a closed list. An entry that the scan stops producing fails too — see the staleness test — so a
 * reference that gets fixed or deleted cannot leave a permanent licence behind for the next one.
 */
const NOT_FILES: ReadonlyArray<{ readonly file: string; readonly path: string; readonly why: string }> = [
  // Module names resolved at runtime by the browser or by the Workers bundle, not paths on disk.
  { file: "apps/node/worker/src/ui.ts", path: "app.js", why: "served asset name; the source is src/client/app.client.js" },
  { file: "apps/node/worker/src/ui.ts", path: "./session.js", why: "the specifier app.js imports in the browser" },
  { file: "apps/node/worker/src/butlers.ts", path: "index.js", why: "the single esbuild output the Workers target emits" },
  { file: "docs/receipts/butler-source-format.md", path: "index.js", why: "the same bundle, in the receipt that measured it" },

  // Produced by a build, so absent from a clean checkout.
  { file: "apps/node/worker/scripts/build-client.mjs", path: "bundle-size.json", why: "written by this script" },
  { file: "docs/receipts/react-shell-bundle.md", path: "bundle-size.json", why: "the artefact the receipt reads" },
  { file: "docs/receipts/react-shell-bundle.md", path: "apps/node/worker/generated/app.bundle.client.js", why: "build output" },

  // Names inside a payload rather than in the repository.
  { file: "apps/node/worker/src/exports.ts", path: "manifest.json", why: "an entry inside an export archive" },
  { file: "apps/node/worker/test/ediscovery-export.test.ts", path: "manifest.json", why: "the same archive entry" },
  /*
   * Files `mailda backup` *writes*, into a directory an operator chooses (#92). The same class as the export
   * archive above and the reason the class was worth naming: a command that produces files has to document
   * their names, and those names are not paths in this repository. `inventory.jsonl` needs no entry — the
   * extension is not one this scan resolves.
   */
  { file: "packages/cli/src/backup.mjs", path: "catalog.sql", why: "a file mailda backup writes" },
  { file: "packages/cli/src/backup.mjs", path: "index.json", why: "a file mailda backup writes" },
  { file: "packages/cli/src/mailda.mjs", path: "catalog.sql", why: "the same, in the command that writes it" },
  { file: "packages/cli/src/mailda.mjs", path: "index.json", why: "the same, in the command that writes it" },

  // Written by the customer, or by a repository that consumes these instructions.
  { file: "Mailda-Full-Engineering-Blueprint.md", path: "mailda.yaml", why: "the butler source a customer authors" },
  { file: "AGENTS.md", path: "CONTEXT.md", why: "a layout this file tells a consuming repo to adopt" },
  { file: "docs/agents/domain.md", path: "CONTEXT.md", why: "the same instruction, in the agent doc that defines it" },
  { file: "docs/agents/domain.md", path: "CONTEXT-MAP.md", why: "the multi-context variant, explicitly conditional" },

  // Absent on purpose: the prose is about a file that was removed, or never existed.
  { file: "docs/receipts/deploy-button-install.md", path: "apps/node/worker/src/butler-probe.ts", why: "a deleted probe branch the receipt reports on" },
  { file: "apps/node/worker/test/node/receipt-references.test.ts", path: "body-search-cost.md", why: "the stale citation that test exists to describe" },
  { file: "apps/node/worker/test/node/receipt-references.test.ts", path: "docs/receipts/x.md", why: "a parser fixture" },

  // Tokens this check's own explanation quotes as things it must not flag.
  { file: "apps/node/worker/test/node/support/prose-references.ts", path: "gate.sql", why: "quoted false positive" },
  { file: "apps/node/worker/test/node/support/prose-references.ts", path: "query.sql", why: "quoted false positive" },
  { file: "apps/node/worker/test/node/support/prose-references.ts", path: "ajv/dist/2020.js", why: "quoted false positive" },
  { file: "apps/node/worker/test/node/support/prose-references.ts", path: "foo.src/index.ts", why: "quoted non-match" },

  /*
   * The four defects this check was built to catch, quoted in the explanation at the top of this file. The
   * file that documents the defect is necessarily exempt from it; there is no way to name a wrong path as an
   * example without naming it.
   */
  { file: "apps/node/worker/test/node/prose-references-world.test.ts", path: "test/composer.test.ts", why: "the audited instance, quoted" },
  { file: "apps/node/worker/test/node/prose-references-world.test.ts", path: "apps/node/workers/state/test/authz.measure.test.ts", why: "the stale receipt path, quoted" },
  { file: "apps/node/worker/test/node/prose-references-world.test.ts", path: "../externals-note.md", why: "the stale declaration path, quoted" },
  { file: "apps/node/worker/test/node/prose-references-world.test.ts", path: "client.ts", why: "the loose reference, quoted" },

  /*
   * A `//` inside a string literal, in this file's own control fixture below. Comment detection is
   * line-based, so the extractor reads the rest of that line as prose. The alternative is a tokeniser, and
   * the measured cost of not having one is these two lines.
   */
  { file: "apps/node/worker/test/node/prose-references-world.test.ts", path: "docs/one.md", why: "control fixture inside a string literal" },
  { file: "apps/node/worker/test/node/prose-references-world.test.ts", path: "docs/two.md", why: "control fixture inside a string literal" },
];

function exempt(ref: Reference): boolean {
  return NOT_FILES.some((one) => one.file === ref.file && one.path === ref.path);
}

const scan = referencesUnder(ROOT);
const unresolvable = scan.refs.filter((ref) => !resolves(ref, scan.disk));

describe("every path the prose names", () => {
  it("exists, or is listed with a reason", () => {
    const offending = unresolvable.filter((ref) => !exempt(ref));
    expect(
      offending.map((ref) => `${ref.file}:${ref.line} -> ${ref.path}`),
      "prose naming a file that is not there. Fix the reference, or add it to NOT_FILES with the reason it "
        + "cannot be a file.",
    ).toEqual([]);
  });

  it("does not keep an exemption for a reference that is gone", () => {
    const dead = NOT_FILES.filter(
      (one) => !unresolvable.some((ref) => ref.file === one.file && ref.path === one.path),
    );
    expect(
      dead.map((one) => `${one.file} -> ${one.path}`),
      "these exemptions no longer match anything: either the reference was fixed, or the file moved. Delete "
        + "them, so the list stays a description of this repository rather than an accumulation.",
    ).toEqual([]);
  });
});

/**
 * The controls. A scanner that finds nothing passes the tests above, and a resolver that says yes to
 * everything passes them too, so both halves are measured against a known answer.
 */
describe("the scan itself", () => {
  it("reads the whole repository, not a corner of it", () => {
    /*
     * 2,931 references when measured. The floor sits well below that on purpose — too low and a broken
     * extractor passes, too high and adding a document breaks the build — and it comes from the receipt so
     * it is a chosen number rather than one somebody typed.
     */
    expect(scan.refs.length).toBeGreaterThan(BUDGETS["prose.references.min_scanned"]);

    /*
     * The walk is checked by naming files it must have reached, not by counting what it found. The first
     * version of this line asserted a file count above 500, which passed locally at 5xx and failed CI at
     * 499 — the difference being build artefacts a clean checkout does not have. A count of files on disk is
     * not a property of this repository, it is a property of the machine, and it was a bare number nobody
     * had measured. These three are the root, the deepest directory the scan must descend into, and a
     * package outside the worker.
     */
    expect(scan.disk.has("AGENTS.md")).toBe(true);
    expect(scan.disk.has("apps/node/worker/src/client/app/types/session.d.ts")).toBe(true);
    expect(scan.disk.has("packages/contract/src/routes.ts")).toBe(true);
  });

  it("keeps the exemption list from growing", () => {
    expect(
      NOT_FILES.length,
      "an unresolvable path is either a defect to fix or a new class of legitimately-absent path. If it is "
        + "genuinely the latter, raise prose.references.max_exemptions in the receipt and say why there.",
    ).toBeLessThanOrEqual(BUDGETS["prose.references.max_exemptions"]);
  });

  it("resolves a reference that exists and refuses one that does not", () => {
    const real = { file: "AGENTS.md", line: 1, path: "docs/receipts/react-shell-bundle.md" };
    const beside = { file: "apps/node/worker/src/index.ts", line: 1, path: "./ui.ts" };
    const absent = { file: "AGENTS.md", line: 1, path: "docs/absent/no-such-doc.md" };
    expect(resolves(real, scan.disk)).toBe(true);
    expect(resolves(beside, scan.disk)).toBe(true);
    expect(resolves(absent, scan.disk)).toBe(false);
  });

  it("reads comments and paragraphs, and skips code and fenced examples", () => {
    const source = [
      "import { a } from './real-code.ts';",
      "// a comment naming docs/one.md",
      "const x = `${gate.sql}`;",
      "/* a block naming docs/two.md */",
    ].join("\n");
    const fromSource = proseLines("src/x.ts", source).flatMap(([, text]) => text);
    expect(fromSource.join(" ")).toContain("docs/one.md");
    expect(fromSource.join(" ")).toContain("docs/two.md");
    expect(fromSource.join(" ")).not.toContain("real-code.ts");
    expect(fromSource.join(" ")).not.toContain("gate.sql");

    const markdown = ["prose naming docs/three.md", "```", "fenced naming docs/four.md", "```"].join("\n");
    const fromMarkdown = proseLines("docs/x.md", markdown).flatMap(([, text]) => text);
    expect(fromMarkdown.join(" ")).toContain("docs/three.md");
    expect(fromMarkdown.join(" ")).not.toContain("docs/four.md");
  });

  it("does not mistake a method call for a filename", () => {
    expect(pathsIn("reads bodies with request.json(), which never inspects")).toEqual([]);
    expect(pathsIn("the shape in request.json is the body")).toEqual(["request.json"]);
    expect(unresolvable.some((ref) => ref.path === "request.json")).toBe(false);
  });

  it("extracts a path however many directories it climbs", () => {
    /*
     * One `../` is the common case and the one a hand-written pattern gets right. Five is what a receipt
     * link from `test/node/` needs, and dropping it costs 14 references out of 2,931 — a loss no count
     * assertion notices, so it is asserted here directly.
     */
    expect(pathsIn("see ./one.md and ../two.md")).toEqual(["./one.md", "../two.md"]);
    expect(pathsIn("see ../../../../../docs/absent/three.md")).toEqual([
      "../../../../../docs/absent/three.md",
    ]);
    expect(pathsIn("a bare four.test.ts and docs/five.md")).toEqual(["four.test.ts", "docs/five.md"]);
    /* A token that only looks like a path: no extension, or an extension this repository does not resolve. */
    expect(pathsIn("the src/index module and a note.txt file")).toEqual([]);
  });
});
