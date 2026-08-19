import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Does every check name `src/doctor.ts` *refers to* exist?
 *
 * ## Why this is a test and not a comment
 *
 * `authenticationIsImpossible` tested `f.check === "credential_kek"` for months (#70). No check has ever
 * emitted that name — `checkCredentialKek` emits `credential_key` — so one of its two disjuncts was
 * permanently false, and the dead one was the case the function's own JSDoc says it exists for: a
 * credential key that cannot wrap while the signing key is fine. The other disjunct, `signing_key`, is
 * real, so the commonest lockout worked and every test passed. The `fix:` at `checkSigningKeys` pointed a
 * locked-out operator at "the credential_kek finding" as well, which was a sentence about nothing.
 *
 * A wrong identifier is worse than a wrong comment, because prose does not look like it is being checked
 * and an identifier does. Nothing was checking this one. Same family as `cost-meter-coverage.test.ts`:
 * a claim about the source, answered from the source.
 *
 * ## Derived, not listed
 *
 * #71 is the defect in `cost-meter-coverage.test.ts` where a comment says "read from the config rather
 * than listed here" while the *set of block types* it reads is hand-written. So nothing here is a list of
 * check names. Both sides come out of the file:
 *
 *   emitted     — every `check: "..."` in a Finding this file builds.
 *   referenced  — every equality test against `.check`, and every "the X finding" / "the X and Y findings"
 *                 phrase, which is the one idiom this file uses to send a reader to another check.
 *
 * The scan is file-wide rather than per-function, so it covers `authenticationIsImpossible`,
 * `withoutDataFindings`, and any function added after this test was written — naming the three would be
 * the #71 shape one level up.
 *
 * The prose extractor keeps only snake_case tokens, and the premise that makes that sound — every name a
 * check emits is snake_case with at least one underscore — is asserted below rather than assumed, because
 * an unchecked premise is how this file's subject went wrong in the first place.
 *
 * ## Counts
 *
 * Counted on 18 August 2026 by running `emittedNames`/`referencedNames` over `src/doctor.ts` and printing
 * the sets: **16** distinct emitted names, **8** references — 2 comparisons (both in
 * `authenticationIsImpossible`) and 6 prose mentions across **five** `fix:` strings (`src/doctor.ts:378`,
 * `:576`, `:650`, `:767`, `:792`), one of which names two checks. A sixth `fix:` at `:859` contains the word
 * "finding" without naming one, which is why the count is of *names* rather than of the word.
 * The floors asserted below are deliberately well under those figures: the counts are a snapshot
 * of today's file, and the floors exist only to catch an extractor that has stopped finding anything.
 */

const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "doctor.ts"), "utf8");

/** What a check name looks like in this codebase. Asserted against the emitted set, not assumed. */
const CHECK_NAME = /^[a-z0-9]+(?:_[a-z0-9]+)+$/;

/** Every name a check actually emits. */
function emittedNames(text: string): string[] {
  const names = new Set<string>();
  for (const [, name] of text.matchAll(/\bcheck:\s*"([^"]+)"/g)) {
    // The group is mandatory in the pattern, so this only quiets noUncheckedIndexedAccess. A skipped
    // match would show up as a missing name in the assertions below, never as a silent pass.
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

interface Reference { name: string; where: string }

/** Every name this file points at: an equality test against `.check`, or "the X finding" in prose. */
function referencedNames(text: string): Reference[] {
  const references: Reference[] = [];

  for (const match of text.matchAll(/\.check\s*===\s*"([^"]+)"/g)) {
    const [whole, name] = match;
    if (name !== undefined) references.push({ name, where: `comparison ${whole}` });
  }

  // Backticks become spaces first, so "`key_vault` finding" is found as well as "key_vault finding".
  // Harmless here: the only thing read out of this pass is a snake_case token sitting before the word
  // "finding", and no template literal in this file ends immediately before that word.
  const prose = text.replaceAll("`", " ");
  for (const match of prose.matchAll(/([a-z0-9_]+(?:\s+and\s+[a-z0-9_]+)*)\s+findings?\b/g)) {
    const [whole, list] = match;
    for (const token of (list ?? "").split(/\s+and\s+/)) {
      // "this finding", "a finding", "Infrastructure findings" — no underscore, not a check name.
      if (CHECK_NAME.test(token)) references.push({ name: token, where: `prose "${whole.trim()}"` });
    }
  }

  return references;
}

describe("every check name doctor.ts refers to is one a check emits", () => {
  const emitted = emittedNames(source);
  const referenced = referencedNames(source);

  it("finds the emitted names, so this cannot pass by checking nothing", () => {
    // The vacuous-green failure mode. If the extractor stopped matching, every assertion below would
    // pass against an empty set. Two anchors, chosen because #70 is about exactly this pair — they are
    // an anti-vacuity floor, not the set under test.
    expect(emitted.length).toBeGreaterThanOrEqual(10);
    expect(emitted).toContain("credential_key");
    expect(emitted).toContain("signing_key");
  });

  it("finds references of both forms, so a broken extractor cannot go green", () => {
    const comparisons = referenced.filter((reference) => reference.where.startsWith("comparison"));
    const prose = referenced.filter((reference) => reference.where.startsWith("prose"));
    // `authenticationIsImpossible` is two comparisons on its own; the fix-texts are the prose.
    expect(comparisons.length, "no .check === comparison found — the extractor is broken").toBeGreaterThanOrEqual(2);
    expect(prose.length, "no \"the X finding\" prose found — the extractor is broken").toBeGreaterThanOrEqual(2);
  });

  it("emits only snake_case names, which is what lets the prose extractor filter on that", () => {
    const odd = emitted.filter((name) => !CHECK_NAME.test(name));
    expect(
      odd.length === 0 ? null
        : `${odd.join(", ")} emitted by a check but not snake_case — the "the X finding" extractor in this `
          + "file keeps only snake_case tokens, so a name like that would be referenced with nothing "
          + "watching. Either rename the check or widen CHECK_NAME here",
    ).toBeNull();
  });

  it("refers to no name that nothing emits", () => {
    const dangling = referenced.filter((reference) => !emitted.includes(reference.name));
    expect(
      dangling.length === 0 ? null
        : dangling.map((reference) => `${reference.name} (${reference.where})`).join("; ")
          + ` — referenced in src/doctor.ts but no check emits it. Emitted: ${emitted.join(", ")}. `
          + "A comparison against a name nothing emits is permanently false (#70); a fix: naming one "
          + "sends a locked-out operator to a finding that will not be in the report",
    ).toBeNull();
  });
});
