import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A closed world over every R2 prefix this Worker writes, against the set the reconciler lists (#67, #65, #74).
 *
 * ## Why this file exists
 *
 * #67 and #74 are **the same defect in two places**: a prefix the Worker wrote and no listing covered. Both
 * were invisible for the same reason — nothing reported the gap — and neither was found by remembering. #67
 * was found by reading a comment that claimed a hand-off to a reconciler which had never been given the
 * prefix; #74 was found by counting write sites during #65's grounding. Two instances of one pattern, with
 * `${orgId}/exports/` narrowly avoiding being the third because #65 put it into the scan in the change that
 * created it.
 *
 * A third instance is what this file makes impossible. It derives the **written** set from `src/` and the
 * **scanned** set from `scannedPrefixes` in `src/reconcile.ts`, and requires them to be equal. Neither side is
 * written down here: a list maintained by hand is the landmine AGENTS.md describes, and this is a test whose
 * whole subject is a list somebody forgot to extend.
 *
 * It is also what lets `formatReconcile` say *"every prefix this Worker writes for this organization"*
 * instead of hedging about objects it did not list. That sentence is a claim about the whole source tree, and
 * a claim nothing enforces is a defect — so it is enforced here rather than asserted there.
 *
 * ## The two blind spots, stated because a tripwire that hides its boundary is the thing it replaces
 *
 * - **A key built without an `${orgId}/…/` literal is invisible to the scan.** That is closed from the other
 *   end by `WRITERS` below: every file in `src/` that calls `putEvidence` or `EVIDENCE.put` is classified with
 *   the prefixes it writes, and a file classified as writing *none* has to contain no such literal — so a
 *   writer that assembled a key from fragments would be an unclassified writer, not a silent one. For that
 *   closure to hold, "no such literal" has to mean *any* literal and not a spelling this file guessed at: see
 *   `writtenSegmentsIn`, where assuming otherwise was a real hole, found by mutation and measured.
 * - **Another organization's prefixes, and anything a hand put in the bucket.** Out of reach of any Worker
 *   code. The reconcile report's second clause still covers those, which is why it was narrowed rather than
 *   deleted.
 *
 * Lexical, like `content-deletion-world.test.ts` and for the same reason: the behavioural half is
 * `test/sent-evidence.test.ts` and `test/stranded-draft-bodies.test.ts`, which collect real objects.
 */

const workerDir = join(import.meta.dirname, "..", "..");

/** Every `.ts` under a directory, recursively, excluding declaration files. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(workerDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

const SOURCES = sourceFiles("src");

/**
 * The file with its **comments removed**, which is what every scan below reads.
 *
 * Not tidiness. A tripwire in this repository was satisfied by its own comments, and this file's subject is
 * doc comments discussing prefixes: `reconcile.ts` and `doctor.ts` between them name all four in prose, so a
 * scan that counted comments would report `raw/` as written by the reconciler — which writes nothing — and
 * would go on passing after the last real writer was deleted. Same helper as
 * `test/node/matter-and-scope-world.test.ts`.
 */
function codeOf(file: string): string {
  return readFileSync(join(workerDir, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Every `` `${…}/<segment>/ `` an R2 key could be built from, as a list of second segments.
 *
 * **The interpolation must be the first thing in the template literal**, which is what distinguishes a key
 * from a URL. Every evidence key in this product is org-scoped as its first segment — one bucket holds every
 * organization (ADR 2) — so a builder always opens with `${orgId}`. Without that anchor this scan reported
 * `objects` as a fifth prefix, from `GET /api/exports/${exportId}/objects/manifest.json` in `exports.ts`: a
 * route, not a key. Measured rather than reasoned about, because the loose form was written first and this is
 * what it found.
 *
 * The identifier itself is matched loosely — any name or member expression — so renaming `orgId` cannot hide a
 * writer. **The segment is matched as loosely as it can be**: anything at all up to the next `/`, rather than
 * a spelling this file guessed prefixes would use.
 *
 * That last part was a hole for one afternoon and is the reason the anchor carries the whole restriction. The
 * segment was first written `[a-z][a-z_]*`, which is what the four existing prefixes happen to look like — and
 * a pattern shaped like the answers it already has is a tripwire that cannot see a new one. Spelling
 * `${orgId}/sentX/`, `${orgId}/Sent/` or `${orgId}/raw-copies/` into `dispatch.ts` left all five assertions
 * below **passing**: a fifth prefix, written by this Worker, listed by nothing, and reported as a closed
 * world by the file whose whole job is to make that impossible. Widening to `[^`$/]+` finds exactly the same
 * four segments across `src/` today — verified, so it costs no false positive — and `finds a literal second
 * segment whatever it is spelled with` below is what keeps the width rather than leaving it to a comment.
 */
function writtenSegmentsIn(code: string): string[] {
  return [...code.matchAll(/`\$\{[A-Za-z_][A-Za-z0-9_.]*\}\/([^`$/]+)\//g)].map((match) => match[1]!);
}

/** Where the reconciler's own prefix builders live, and what each one spells. */
function scannedSegments(): string[] {
  const reconcile = codeOf("src/reconcile.ts");
  const body = /function scannedPrefixes\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(reconcile)?.[1] ?? "";
  const builders = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\(orgId\)/g)].map((match) => match[1]!);

  return builders.map((builder) => {
    // The builder is resolved to the literal it returns, wherever in `src/` it is declared. Following it is
    // the point: `scannedPrefixes` naming a function that spells a *different* prefix than the writer does is
    // precisely the disagreement this file exists to catch, and a scan that stopped at the function name
    // would be blind to it.
    for (const file of SOURCES) {
      const declared = new RegExp(
        `function ${builder}\\(orgId: string\\): string \\{\\s*return \`([^\`]*)\``,
      ).exec(codeOf(file));
      if (declared !== null) {
        // The captured literal has lost its opening backtick, and `writtenSegmentsIn` requires one — see the
        // anchor argument there. Put it back rather than loosening the pattern for one caller.
        const segments = writtenSegmentsIn(`\`${declared[1]!}`);
        if (segments.length === 1) return segments[0]!;
        return `${builder}: returns ${declared[1]!}, which is not one org-scoped prefix`;
      }
    }
    return `${builder}: declared nowhere this scan can read`;
  });
}

/**
 * Every file in `src/` that writes an evidence object, and the prefixes it writes.
 *
 * The classification, and the only thing in this file written by hand. It closes the regex's blind spot from
 * the other end: a writer that built its key without an `${orgId}/…/` literal would fail the *empty* rule
 * below rather than passing unseen.
 */
interface Writer {
  file: string;
  /** The org-scoped second segments this file spells. Empty means it writes a key it was handed. */
  segments: string[];
  why: string;
}

const WRITERS: Writer[] = [
  {
    file: "src/evidence-store.ts",
    segments: [],
    why:
      "The one implementation of `putEvidence`, and the only `EVIDENCE.put` in the product. It seals and "
      + "writes the key its caller passes and composes none of its own, which is what makes the callers below "
      + "the complete set of prefix authors.",
  },
  {
    file: "src/ingress.ts",
    segments: ["raw"],
    why:
      "Accepted mail: `${orgId}/raw/${timeBucket}/${receiptId}.eml`, written before the `ingress_receipts` "
      + "row so the reachable partial state is an orphan blob rather than a receipt pointing at nothing.",
  },
  {
    file: "src/reseal.ts",
    segments: [],
    why:
      "Re-seals an object **in place** under a new content key, writing back to the `blob_key` its receipt "
      + "already names (ADR 28). It composes no key, so it can introduce no prefix.",
  },
  {
    file: "src/drafts.ts",
    segments: ["drafts"],
    why:
      "Draft bodies: `${orgId}/drafts/${draftId}.txt`, whose referent is a `drafts` row keyed by `body_key`. "
      + "#67 is the prefix this Worker wrote and no listing covered.",
  },
  {
    file: "src/exports.ts",
    segments: ["exports"],
    why:
      "eDiscovery exports (#65). Both spellings live here — `exportDestination` for one export's objects and "
      + "`exportsPrefix` for the organization's — and `matter-and-scope-world.test.ts` keeps them here.",
  },
  {
    file: "src/outbound/manifest.ts",
    segments: ["sent"],
    why:
      "The composition evidence a seal stages — `typed.txt` and `normalized.txt` — and the one spelling of "
      + "`sentObjectKey`/`sentPrefix` that #74 introduced so the writer and the reconciler cannot disagree.",
  },
  {
    file: "src/outbound/dispatch.ts",
    segments: [],
    why:
      "Writes `submitted.eml` under the same prefix, through `sentObjectKey` from `manifest.ts` rather than "
      + "by spelling it again. That is why it declares none: a second spelling here is exactly the drift #74 "
      + "removed, and the empty rule below is what keeps it removed.",
  },
];

const WRITE_SITE = /\bputEvidence\(|\bEVIDENCE\.put\b/;

describe("the reconciler lists every prefix this Worker writes", () => {
  /**
   * The prefixes each **writing** file spells.
   *
   * Restricted to files that contain a write site, which is the difference between *spelled* and *written* and
   * is load-bearing in both directions. `reconcile.ts` spells `raw/` and `drafts/` and writes neither — it is
   * the reader — so counting it as a writer would make the "listed but written by nothing" half of this test
   * vacuous: the reconciler's own builders would satisfy it whatever happened to `ingress.ts`.
   */
  const written = new Map<string, string[]>();
  for (const file of SOURCES.filter((file) => WRITE_SITE.test(codeOf(file)))) {
    const segments = writtenSegmentsIn(codeOf(file));
    if (segments.length > 0) written.set(file, [...new Set(segments)].sort());
  }
  const writtenSet = [...new Set([...written.values()].flat())].sort();

  it("finds the writers and the builders, so nothing below can pass by scanning nothing", () => {
    // The vacuous-green failure mode. If either extractor broke, the equality below would compare two empty
    // sets and report the world closed. Anchors, not the sets under test.
    expect(writtenSet.length).toBeGreaterThanOrEqual(4);
    expect(scannedSegments().length).toBeGreaterThanOrEqual(4);
    // And the comment stripper is doing its job: `doctor.ts` writes nothing and names `${orgId}/raw/` and
    // `${orgId}/drafts/` in five doc comments. A scan that counted prose would find it here.
    expect(SOURCES.filter((file) => writtenSegmentsIn(codeOf(file)).length > 0))
      .not.toContain("src/doctor.ts");
    // The reader is not a writer, which is what makes the second direction below mean something.
    expect([...written.keys()]).not.toContain("src/reconcile.ts");
  });

  it("finds a literal second segment whatever it is spelled with, and still refuses a route", () => {
    /*
     * The extractor itself, mutated rather than reasoned about — because every other assertion in this file
     * is only as wide as this pattern is, and a pattern shaped like the four prefixes that already exist
     * cannot see the fifth.
     *
     * The first three cases all passed the whole file when the segment was `[a-z][a-z_]*`: a writer spelling
     * `${orgId}/raw-copies/` was a prefix this Worker wrote, nothing listed, and this file called a closed
     * world. Measured by putting each spelling into `dispatch.ts` in turn and watching five of five pass.
     */
    expect(writtenSegmentsIn("`${orgId}/sentX/${manifestId}/submitted.eml`")).toEqual(["sentX"]);
    expect(writtenSegmentsIn("`${orgId}/Sent/${manifestId}/submitted.eml`")).toEqual(["Sent"]);
    expect(writtenSegmentsIn("`${orgId}/raw-copies/${manifestId}/submitted.eml`")).toEqual(["raw-copies"]);
    // The four real shapes, so widening cannot have been bought by breaking what it replaced.
    expect(writtenSegmentsIn("`${orgId}/sent/${manifestId}/typed.txt`")).toEqual(["sent"]);
    expect(writtenSegmentsIn("`${orgId}/raw/${timeBucket}/${receiptId}.eml`")).toEqual(["raw"]);
    // The anchor keeps the whole restriction, so it is the thing that has to stay non-vacuous: a route is not
    // a key, and a key assembled from a prefix already built spells no segment of its own.
    expect(writtenSegmentsIn("`/api/exports/${exportId}/objects/manifest.json`")).toEqual([]);
    expect(writtenSegmentsIn("`${row.destination}${message.id}.eml`")).toEqual([]);
  });

  it("scans exactly the prefixes it writes, in both directions", () => {
    const scanned = [...new Set(scannedSegments())].sort();

    const unscanned = writtenSet.filter((segment) => !scanned.includes(segment));
    // If this fails, a new prefix arrived and nothing lists it. That is #67 and #74, and the cost of it is
    // invisible precisely because nothing reports it. Give it a referent rule, a scan function and its own
    // line in `formatReconcile`, and re-derive `reconcile.list_limit` — `test/evidence-lifecycle.test.ts`
    // asserts that a fifth prefix does *not* fit at the current value. Do not delete a writer to pass.
    expect(
      unscanned.length === 0 ? null
        : `${unscanned.join(", ")}: written by this Worker and listed by nothing. Written at `
          + [...written.entries()]
            .filter(([, segments]) => segments.some((segment) => unscanned.includes(segment)))
            .map(([file]) => file).join(", "),
    ).toBeNull();

    const unwritten = scanned.filter((segment) => !writtenSet.includes(segment));
    // The same landmine pointing the other way, and it is the one #65 names: a reconciler that lists a prefix
    // nothing writes reports a clean scan of it for ever, which reads as coverage of something absent.
    expect(
      unwritten.length === 0 ? null
        : `${unwritten.join(", ")}: listed by scannedPrefixes and written by nothing in src/`,
    ).toBeNull();

    // The set itself, so a reader of a failure elsewhere can see what the world currently is. Asserted as a
    // value rather than only as an equality, because "the two sides agree" is also true of two empty sides.
    expect(scanned).toEqual(["drafts", "exports", "raw", "sent"]);
  });

  it("classifies every file that writes an evidence object", () => {
    const actual = SOURCES.filter((file) => WRITE_SITE.test(codeOf(file))).sort();
    const declared = WRITERS.map((writer) => writer.file).sort();
    // Both directions: an unclassified writer could introduce a prefix the regex above cannot see, and a
    // stale row reads as coverage of a file that no longer writes anything.
    expect(actual).toEqual(declared);
  });

  it("holds every declared writer to the prefixes it declares", () => {
    const wrong: string[] = [];
    for (const writer of WRITERS) {
      const segments = [...new Set(writtenSegmentsIn(codeOf(writer.file)))].sort();
      const expected = [...writer.segments].sort();
      if (segments.join(",") !== expected.join(",")) {
        wrong.push(
          `${writer.file} spells [${segments.join(", ") || "none"}] but declares `
          + `[${expected.join(", ") || "none"}]`,
        );
      }
    }
    /*
     * The empty rows are the load-bearing half, and they are why this assertion is worth more than a count.
     *
     * `evidence-store.ts`, `reseal.ts` and `dispatch.ts` write objects and compose no key. If one of them
     * ever spells a prefix itself, that is either a fifth prefix arriving in a file nobody would look in, or
     * — for `dispatch.ts` — the second spelling of `${orgId}/sent/` that #74 removed, which is how a writer
     * and the reconciler come to disagree silently.
     */
    expect(wrong.length === 0 ? null : wrong.join("; ")).toBeNull();
  });

  it("gives every classification a reason long enough to have needed thought", () => {
    // Same bar as `content-deletion-world.test.ts`. This does not check the reason is *good* — a reader does
    // that — only that somebody was made to write one.
    expect(WRITERS.filter((writer) => writer.why.trim().length < 40).map((writer) => writer.file)).toEqual([]);
  });
});
