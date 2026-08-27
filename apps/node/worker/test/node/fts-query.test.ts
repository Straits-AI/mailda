import { describe, expect, it } from "vitest";

import { ftsQuery } from "../../src/search.ts";

/**
 * Turning a person's typing into an FTS5 expression (#107).
 *
 * ## Why this is a node test and not a workerd one
 *
 * `ftsQuery` touches nothing — no D1, no request, no clock. What it needs is *many* inputs, and the table
 * below is the point of the file: the shipped behaviour is defined by what happens to each of these strings,
 * not by one happy path.
 *
 * ## The inputs are not invented
 *
 * Every string in `BREAKS_RAW_MATCH` was measured against a live D1 returning `fts5: syntax error near …`
 * before `ftsQuery` existed. That is what makes this file a regression test rather than a guess about what a
 * tokenizer ought to reject: the alternative to each of these lines is a **500 on the search box**, reached
 * by typing an ordinary English word.
 */

/** Measured to raise `fts5: syntax error` when passed to `MATCH` unaltered. */
const BREAKS_RAW_MATCH = ["AND", "NOT", "a OR", "foo(", "NEAR(", "*", "sub:x"];

describe("a search box's contents as an FTS5 expression", () => {
  it("never emits an operator, a colon or a parenthesis for input measured to break MATCH", () => {
    /*
     * The assertion this file exists for. Each input is checked two ways, because either alone passes for the
     * wrong reason: the output must be a **quoted** expression (so nothing is a bare operator), and it must
     * not contain the metacharacters that made the raw form fail.
     */
    for (const raw of BREAKS_RAW_MATCH) {
      const built = ftsQuery(raw);
      if (built === null) continue; // `*` reduces to nothing searchable, which is a legitimate answer.
      expect(built, `${JSON.stringify(raw)} produced an unquoted expression`).toMatch(/^"/);
      for (const forbidden of ["(", ")", ":"]) {
        expect(built.includes(forbidden), `${JSON.stringify(raw)} kept ${forbidden} in ${built}`).toBe(false);
      }
    }
  });

  it("reads operators as words, so searching for the word AND finds mail containing it", () => {
    // The product consequence, stated as its own case: `AND` is a word people write in subject lines.
    expect(ftsQuery("AND")).toBe('"AND"*');
    expect(ftsQuery("terms and conditions")).toBe('"terms" "and" "conditions"*');
  });

  it("requires every word and prefixes only the last", () => {
    /*
     * FTS5 puts an implicit AND between phrases, so this is where "every word must appear" is decided. The
     * prefix goes on the last token alone: on all of them, `inv 44` would match far more than a person means;
     * on none, a half-typed word finds nothing, which reads as "no such mail".
     */
    expect(ftsQuery("demurrage hapag")).toBe('"demurrage" "hapag"*');
    expect(ftsQuery("demur")).toBe('"demur"*');
  });

  it("keeps non-Latin words whole", () => {
    /*
     * `\w` would have cut these into fragments, and the mail most likely to be damaged is the mail least
     * likely to be checked by whoever wrote the pattern. Asserted rather than left to the comment.
     */
    expect(ftsQuery("förderung")).toBe('"förderung"*');
    expect(ftsQuery("発注書 4471")).toBe('"発注書" "4471"*');
  });

  it("answers null for nothing searchable, and null is not the same as matching nothing", () => {
    /*
     * Three states get conflated here if this is wrong: no search, a search for nothing, and a search
     * matching nothing. `null` means the caller adds **no predicate**; an empty string would be a syntax
     * error and an always-true expression would make a blank box look like a filter over the whole mailbox.
     */
    for (const empty of [null, "", "   ", "()", "***", "-- ;"]) {
      expect(ftsQuery(empty), `${JSON.stringify(empty)} should be null`).toBeNull();
    }
  });

  it("splits an email address the way the index tokenizes it", () => {
    // `unicode61` splits on `@` and `.`, so this must too or a query names tokens the index cannot hold.
    expect(ftsQuery("ops@carrier.example")).toBe('"ops" "carrier" "example"*');
  });

  it("bounds how many terms one query carries, and truncates rather than refusing", () => {
    /*
     * Pasting a paragraph into a search box is ordinary, not an attack, so it truncates. Checked by counting
     * phrases rather than by asserting the whole string, so the limit can move without rewriting the test —
     * and asserted to be *strictly* fewer than the input, which a no-op implementation would fail.
     */
    const many = ftsQuery(Array.from({ length: 40 }, (_, n) => `word${n}`).join(" "));
    expect(many).not.toBeNull();
    const phrases = many!.match(/"/g)!.length / 2;
    expect(phrases).toBeLessThan(40);
    expect(phrases).toBeGreaterThan(1);
  });

  it("cannot be made to emit a quote, which is what makes the quoting safe without escaping", () => {
    /*
     * The property the whole design rests on. `ftsQuery` wraps tokens in `"` and does no escaping, which is
     * only sound because a token cannot contain a `"`. That is a claim about the extraction, so it is tested
     * against input built to break it rather than asserted in a comment.
     */
    for (const raw of ['a" OR "b', '""', 'x"*', '"; DROP TABLE messages; --']) {
      const built = ftsQuery(raw);
      if (built === null) continue;
      // Every quote must be one this function placed: an even count, and none adjacent to another.
      expect((built.match(/"/g) ?? []).length % 2, `unbalanced quotes in ${built}`).toBe(0);
      expect(built, `${JSON.stringify(raw)} produced adjacent quotes: ${built}`).not.toMatch(/""/);
    }
  });
});
