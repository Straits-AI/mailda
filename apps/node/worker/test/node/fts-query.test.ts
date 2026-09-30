import { describe, expect, it } from "vitest";

import { BUDGETS } from "@mailda/budgets";
import { SEARCH_MAX_WORDS } from "@mailda/contract/routes";

import { CallerError } from "../../src/errors.ts";
import { bodyIndexText, ftsQuery, searchText } from "../../src/search.ts";

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

  it("keeps words in scripts written with spaces whole", () => {
    /*
     * `\w` would have cut these into fragments, and the mail most likely to be damaged is the mail least
     * likely to be checked by whoever wrote the pattern. Asserted rather than left to the comment.
     */
    expect(ftsQuery("förderung")).toBe('"förderung"*');
    expect(ftsQuery("доставка груза")).toBe('"доставка" "груза"*');
  });

  it("turns a Chinese or Japanese run into consecutive bigrams, one phrase per word typed", () => {
    /*
     * This asserted `"発注書" "4471"*` — the run kept whole — under the title "keeps non-Latin words whole".
     * That was the defect: the index held `关于发票的问题` as one token too, so a search for part of it found
     * nothing. One phrase per typed word, so the bigrams must be adjacent in the row; the last run of the last
     * word keeps the prefix.
     */
    expect(ftsQuery("発注書 4471")).toBe('"発注 注書" "4471"*');
    expect(ftsQuery("发票抬头")).toBe('"发票 票抬 抬头"*');
    expect(ftsQuery("订单123")).toBe('"订单 单 123"*');
    // A single character is matched as a prefix wherever it stands: in the index it only ever begins a token.
    expect(ftsQuery("发 问题")).toBe('"发"* "问题"*');
  });

  it("folds full-width letters and digits, on the query side as the index does", () => {
    expect(ftsQuery("ＡＢＣ　１２３")).toBe('"ABC" "123"*');
    // Folded inside words only. `㈱` is a symbol, a separator to `unicode61`, and stays one: folding it to `(株)`
    // would also fold `™` to `TM` and `№` to `No`, joining them to the word beside them (`Acme™` → `AcmeTM`).
    expect(ftsQuery("㈱")).toBeNull();
    // A decomposed accent is folded with its letter, which is why marks are inside the folded runs.
    expect(ftsQuery("cafe\u0301")).toBe('"caf\u00e9"*');
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

  it("refuses more words than one search may carry, by name, rather than dropping the extra ones", () => {
    /*
     * This truncated, silently: the thirteenth word was dropped, so mail lacking it matched and the page did
     * not say so. Asserted on the code and the numbers, because a refusal an agent cannot read is a refusal
     * it cannot act on (AGENTS.md §3) — and on the boundary from both sides, so a limit that moved by one in
     * either direction fails here.
     */
    const words = (n: number) => Array.from({ length: n }, (_, k) => `word${k}`).join(" ");
    expect(ftsQuery(words(SEARCH_MAX_WORDS))!.match(/"/g)!.length / 2).toBe(SEARCH_MAX_WORDS);
    let refusal: unknown = null;
    try {
      ftsQuery(words(SEARCH_MAX_WORDS + 1));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CallerError);
    expect((refusal as CallerError).code).toBe("E_SEARCH_TOO_MANY_WORDS");
    expect((refusal as CallerError).status).toBe(422);
    expect((refusal as Error).message).toContain(`${SEARCH_MAX_WORDS + 1} words`);
    expect((refusal as Error).message).toContain(`at most ${SEARCH_MAX_WORDS}`);
    // A run without spaces is one word typed, however many bigrams it becomes.
    expect(() => ftsQuery("关于发票抬头的问题请尽快回复谢谢大家的支持与帮助")).not.toThrow();
  });

  it("refuses a search that would look up more index terms than one may, by name, whatever its word count", () => {
    /*
     * The word limit counts words typed, and a Chinese run is one word however long: pasted, it was a phrase of
     * a term per character with nothing bounding it but the URL, and its time grows with the terms
     * (`docs/receipts/cjk-search-bigrams.md`). Both sides of the boundary, so a limit off by one fails here.
     */
    const limit = BUDGETS["search.max_query_terms"];
    const terms = (expression: string) => [...expression.matchAll(/"([^"]*)"/g)]
      .reduce((n, [, phrase]) => n + phrase!.split(" ").length, 0);
    const run = (characters: number) => "的人".repeat(characters).slice(0, characters);
    // The last word's run gives one bigram per character after the first.
    expect(terms(ftsQuery(run(limit + 1))!)).toBe(limit);
    let refusal: unknown = null;
    try {
      ftsQuery(run(limit + 2));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CallerError);
    expect((refusal as CallerError).code).toBe("E_SEARCH_TOO_LONG");
    expect((refusal as CallerError).status).toBe(422);
    expect((refusal as Error).message).toContain(`search.max_query_terms=${limit}, this search asked for ${limit + 1}`);
    expect((refusal as Error).message).toContain("docs/receipts/cjk-search-bigrams.md");
    // Twelve words, each under any word limit, are counted together.
    expect(() => ftsQuery(Array.from({ length: SEARCH_MAX_WORDS }, () => run(20)).join(" "))).toThrow(/E_SEARCH_TOO_LONG/);
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

/**
 * What `unicode61` makes of a string, modelled closely enough to decide a match: split on anything that is not
 * a letter or a number, fold case. (It also strips diacritics; the samples below carry none, so the model does
 * not need to.)
 */
function unicode61(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((token) => token !== "").map((token) => token.toLowerCase());
}

/**
 * Whether FTS5 would match a row holding `indexed` against the expression `ftsQuery` built. Every phrase must
 * occur as consecutive tokens; a phrase ending in `*` matches its last term as a prefix. That is the whole of
 * the language `ftsQuery` emits, so it is the whole of what the model needs.
 */
function matches(indexed: string, expression: string): boolean {
  const tokens = unicode61(searchText(indexed));
  return [...expression.matchAll(/"([^"]*)"(\*?)/g)].every(([, text, star]) => {
    const terms = unicode61(text!);
    return tokens.some((_, at) => terms.every((term, k) => {
      const token = tokens[at + k];
      if (token === undefined) return false;
      return star === "*" && k === terms.length - 1 ? token.startsWith(term) : token === term;
    }));
  });
}

/** Strings a mailbox holds, in the scripts this rewrite is for and the one it must leave alone. */
const SAMPLES = [
  "关于发票的问题，请尽快回复。",
  "订单123已发货 order 4471 shipped",
  "東京タワーへ行く予定です",
  "らーめん屋さんの営業時間",
  "회의를 시작합니다 오늘 오후",
  "ＡＢＣ株式会社の請求書",
  "㈱山田商事 御中",
  "Demurrage claim on the Hapag booking",
  "Re: terms and conditions for Q3",
];

const LETTER = /[\p{L}\p{N}]/u;
const CJK = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]/u;

describe("a search finds every row containing what was typed", () => {
  it("matches every substring of every sample that starts at a word or inside a CJK run", () => {
    /*
     * The property the bigrams exist for, over every substring rather than a few chosen ones. A substring may
     * start anywhere inside a Chinese, Japanese or Korean run and end anywhere at all (the last word is a
     * prefix). It may not start in the middle of a Latin word: `unicode61` indexes whole words, so `emurrage`
     * has never found `demurrage`, and this rewrite does not claim it does.
     */
    let checked = 0;
    for (const sample of SAMPLES) {
      const characters = [...sample.replace(/[\p{L}\p{M}\p{N}]+/gu, (run) => run.normalize("NFKC"))];
      for (let start = 0; start < characters.length; start++) {
        const before = characters[start - 1];
        const first = characters[start]!;
        if (before !== undefined && LETTER.test(before) && !CJK.test(before) && LETTER.test(first) && !CJK.test(first)) {
          continue;
        }
        for (let end = start + 1; end <= characters.length; end++) {
          const typed = characters.slice(start, end).join("");
          const expression = ftsQuery(typed);
          if (expression === null) continue;
          checked += 1;
          expect(matches(sample, expression), `${JSON.stringify(typed)} → ${expression} misses ${sample}`)
            .toBe(true);
        }
      }
    }
    // Anti-vacuity: a loop that skipped everything would agree with anything.
    expect(checked).toBeGreaterThan(500);
  });

  it("does not match characters that are present but not adjacent, so the model can say no", () => {
    /*
     * The control for the property above. A model that matched everything would pass it; this is the model
     * refusing what a substring search must refuse — the characters of `发问` both occur in the sample, apart.
     */
    expect(matches("关于发票的问题", ftsQuery("发问")!)).toBe(false);
    expect(matches("关于发票的问题", ftsQuery("票发")!)).toBe(false);
    expect(matches("Demurrage claim", ftsQuery("emurrage")!)).toBe(false);
  });

  it("matches keywords typed with spaces the text does not have", () => {
    /*
     * The ordinary way to search Chinese: the keywords, spaced, out of a sentence written without spaces. So
     * a word typed before a space may stop part-way through an indexed run — which is why it contributes only
     * its bigrams, and why a single character is a prefix wherever it stands. Substrings of the samples
     * above never exercise this, because their spaces are where the text's are.
     */
    for (const typed of ["发票 问题", "发 题", "关于 回复", "東京 タワー", "タワ 予定"]) {
      const text = typed.startsWith("東京") || typed.startsWith("タワ") ? SAMPLES[2]! : SAMPLES[0]!;
      expect(matches(text, ftsQuery(typed)!), `${typed} → ${ftsQuery(typed)} misses ${text}`).toBe(true);
    }
  });
});

describe("English searches are unchanged by the CJK rewrite", () => {
  it("builds the same expressions it built before", () => {
    /*
     * A golden, recorded from the function as it was before `searchText` existed. For text with no Chinese,
     * Japanese or Korean in it and nothing NFKC folds, the rewrite must be the identity — or every English
     * row indexed in search form 0 stops matching until the backfill reaches it.
     */
    const golden: Record<string, string> = {
      "demurrage": '"demurrage"*',
      "demurrage hapag": '"demurrage" "hapag"*',
      "Invoice #4471 overdue": '"Invoice" "4471" "overdue"*',
      "ops@carrier.example": '"ops" "carrier" "example"*',
      "re: Q3 terms, and conditions": '"re" "Q3" "terms" "and" "conditions"*',
      "10:30 call": '"10" "30" "call"*',
      "acme widget": '"acme" "widget"*',
      "invoice 5": '"invoice" "5"*',
    };
    for (const [typed, expected] of Object.entries(golden)) expect(ftsQuery(typed), typed).toBe(expected);
    // Symbols `unicode61` has always split on stay separators: NFKC would make `Acme™` `AcmeTM` and `№5` `No5`,
    // and `acme widget` and `invoice 5`, which found these at HEAD, would find nothing.
    for (const text of [
      "Demurrage claim on the Hapag booking", "ops@carrier.example", "Q3 — 10:30", "Acme™ widget order",
      "Invoice №5 attached", "Call ℡ 555",
    ]) {
      expect(searchText(text), text).toBe(text);
    }
  });
});

describe("a body the index binds fits in one D1 string", () => {
  it("cuts a long Chinese body at the last whole term under d1.max_row_bytes and says so, and leaves a short one alone", () => {
    /*
     * A Chinese body at `render.max_body_bytes` is 3.1 MB of UTF-8 before the rewrite and 6.4 MB after it,
     * and the value rides in the ingest batch — past D1's string limit it would fail the batch that delivers
     * the message. Measured in `test/message-search-cjk.measure.test.ts`.
     */
    const limit = BUDGETS["d1.max_row_bytes"];
    const long = "关于发票的问题请尽快回复".repeat(Math.ceil(BUDGETS["render.max_body_bytes"] / 12))
      .slice(0, BUDGETS["render.max_body_bytes"]);
    const { text: bound, cutFromBytes } = bodyIndexText(long);
    const bytes = new TextEncoder().encode(bound).byteLength;
    expect(bytes).toBeLessThanOrEqual(limit);
    expect(bytes, "cut far below the limit, dropping text that would have fitted").toBeGreaterThan(limit - 16);
    // Whole terms only: no half character, and the text is a prefix of the rewrite rather than a new string.
    expect(bound).not.toContain("\uFFFD");
    expect(searchText(long).startsWith(`${bound} `)).toBe(true);
    // The cut is reported, with the size of what was asked for, so the settlement can record it (AGENTS §3).
    expect(cutFromBytes, "the cut was made and not reported").toBe(new TextEncoder().encode(searchText(long)).byteLength);

    expect(bodyIndexText("发票抬头")).toEqual({ text: searchText("发票抬头"), cutFromBytes: null });
  });
});
