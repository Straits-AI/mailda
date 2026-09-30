---
id: cjk-search-bigrams
kind: measured-tripwire
measured_on: 2026-09-30
stale_when: >
  searchText in apps/node/worker/src/search.ts changes what it emits (a different character set, runs no
  longer breaking where the script changes, the trailing single character dropped, or a segmenter replacing
  the bigrams); ftsQuery changes the phrase or prefix it builds for a CJK word; either search table's
  tokenizer or detail= option changes; messagePageQuery's searched plan changes in any way that makes
  message-search-cost.md stale; the measure test's worst phrase at search.max_query_terms is timed above its
  commonest one-character search; or a corpus of real Chinese, Japanese or Korean mail becomes available, which
  would replace the literary corpus below
values:
  search.cjk_rows_read_per_page: 941
  search.max_query_terms: 128
---

**Measured:** 30 September 2026, local D1 under `@cloudflare/vitest-pool-workers`, by
`apps/node/worker/test/message-search-cjk.measure.test.ts`. **Not production D1, and not mail.** The corpus is
`apps/node/worker/test/fixtures/na-han.ts`: 35,000 characters of Lu Xun's 《吶喊》 (1923, Traditional Chinese,
public domain, from the Project Gutenberg edition). 1,200 deliveries, subjects its sentences (at most 60
characters), bodies 200-character windows of it, seeded with the reader's own rows exactly as
`message-search-cost.md`'s English corpus is. A novelist's vocabulary and sentence length are not a
mailbox's, so these figures say how the index behaves on Chinese prose and nothing about a Chinese inbox.

## Rows read per searched page

| typed | what it is | rows read | rows |
|:--|:--|--:|--:|
| `櫃台` | a rare word | 440 | 41 |
| `我們` | an ordinary word | 849 | 51 |
| `的` | the commonest character, as a prefix over every bigram it begins | **941** | 51 |
| `我在年青時候也曾經做過許多夢` | one typed word, thirteen bigrams in one phrase | 36 | 2 |
| `的 了 是 我 他 在 不 一 有 人 這 也` | `SEARCH_MAX_WORDS` words, each a prefix | 527 | 51 |

**Sized:** `search.cjk_rows_read_per_page` is the worst of the five, **941**, against
`authz.list.max_rows_read` of 1,000. The measure test asserts every shape against this figure, so a change
that makes Chinese search dearer fails there rather than being found in a bill.

It is above the English figure (`search.max_rows_read_per_page` = 888 in `message-search-cost.md`), and that
receipt is deliberately not restated: its figure is the English corpus's, and the English corpus did not
move (888, 225, 138, re-run on the same day with the rewrite in place). The two are different corpora and
each is asserted on its own.

**The headroom is 59 rows, and that is the finding worth reading.** A full page of a common term costs what
the page costs — seeks per returned row across two arms — plus the index's own reads, and a single CJK
character is a prefix over many distinct bigrams. Re-run at 2,400 and 4,800 deliveries (the same text
cycled; obtained by setting `DELIVERIES` in the measure test to each and running it once — not a committed
run, so re-measure before relying on them), the full-page shapes stayed at 930–940 and did not track the archive: the rare word rose to 620 and
697 as it began to fill the page. So the cost is bounded by the page and not by the corpus on this text. A
corpus with longer bodies or a wider vocabulary could read more, and nothing here shows it does not.

**Cost if wrong:** a searched page reading past `authz.list.max_rows_read`, the budget the listing is sized
against, on the commonest searches a Chinese reader makes. Nothing refuses an unwindowed search at runtime by
rows read, so it would arrive as cost and latency rather than as an error; the measure test is the check.

## How many terms one search may look up

`search.max_query_terms` is **128**. `SEARCH_MAX_WORDS` counts words typed, and a Chinese, Japanese or Korean run
is one word however long, so without this a pasted paragraph was one phrase with a term per character, bounded
only by the URL (about 1,800 Han characters). Each term is one doclist lookup, so a phrase's time grows with its
terms, and **rows read cannot show it**: D1 counts the rows FTS5 returns, not its doclist reads, so a long
phrase that matches nothing reads 2 rows whatever it costs. So it is timed.

The same measure test, second `describe`: the searched page statement, median of nine runs after one to warm,
on the same local corpus. The phrase is the worst this text offers, `的人` repeated: two of its commonest
bigrams alternating, so every term's doclist is long and none is missing (a phrase with a rare or absent term
stops early; a 1,799-term phrase of the novel's own text took 2 ms). Two runs on 30 September 2026:

| shape | terms | run 1 | run 2 |
|:--|--:|--:|--:|
| `的`, the commonest one-character search (the 941-row page above) | 1 | 10.0 ms | 7.0 ms |
| `的人…`, half the limit | 64 | 6.0 ms | 3.0 ms |
| `的人…`, **at the limit** | 128 | 5.0 ms | 6.0 ms |
| `的人…`, twice the limit (refused; timed from the terms it would build) | 256 | 9.8 ms | 12.4 ms |
| `的人…`, four times the limit (refused) | 512 | 19.2 ms | 21.9 ms |

A probe the review ran beforehand on the same corpus, not committed, took the curve further: 899 terms 33 ms, and
twelve words of 150 characters (1,788 terms, under the word limit) 68 ms, with 0 rows read on every one.

**Sized:** 128, where the worst phrase costs no more than the commonest one-character search, which the
rows-read figure above accepts; past it the time grows linearly and nothing reported it. 128 terms is a run of
129 characters, over twice the longest subject in this corpus (60). `ftsQuery` refuses past it with
`E_SEARCH_TOO_LONG`, naming `search.max_query_terms`, the limit and the ask. The timings are local, at
millisecond resolution, and not asserted: a timing check in CI is flaky, and a muted one is worse than none.

**Cost if wrong:** too low refuses a pasted subject a reader meant to find, with an error that says so; too high
lets one search cost several times the commonest one, which on production D1 is latency and CPU rather than an
error.

## NFKC is applied inside words only

`searchText` and `ftsQuery` fold NFKC only inside runs of letters, marks and numbers. Over the whole text it
turned symbols `unicode61` splits on into letters that joined the neighbouring word (`Acme™` → `AcmeTM`,
`№5` → `No5`), so `acme widget` and `invoice 5`, which found those subjects before, found nothing. `㈱` is such
a symbol too, and is now a separator as it always was to `unicode61`, rather than `(株)`. The rows-read and index
figures above are unchanged by it (re-run the same day: 941, 849, 440, 36, 527; 748,794 bytes), because
punctuation is a separator either way; only the bound body grew (below).

## What the rewrite costs the index

The same 1,200 bodies in two contentless FTS5 tables of the body index's shape, raw (as before `searchText`,
search form 0) and through `searchText`:

| | `_data` bytes | distinct terms | token instances |
|:--|--:|--:|--:|
| Chinese, as `unicode61` held it | 197,107 | 5,667 | 30,434 |
| Chinese, bigrams | **748,794** | 14,907 | 204,011 |
| English, either way | 42,435 | 1,209 | 12,000 |

**3.8 times** the posting bytes for Chinese text, and none for English: `searchText` is the identity on it,
which the table asserts. D1 bills storage, so a Chinese mailbox's body index costs about four times an
unbigrammed one; it was also, before this, unable to find a word in a sentence.

## A body at the display bound does not fit in one D1 string

`extractBody` cuts a body at `render.max_body_bytes` (1,048,576) **UTF-16 units**. For Chinese that is
3,135,564 bytes of UTF-8 before the rewrite and 6,422,026 after it (6,250,448 when NFKC was applied to the whole
text and folded full-width punctuation to one byte; it now folds only inside words, below), against `d1.max_row_bytes` (2,000,000,
`d1-platform-limits.md`). The body index write rides in the ingest batch, so `bodyIndexText` cuts the
rewritten text at the last whole term under that limit, and records the cut on the message
(`body_index_cut_from_bytes`, counted by `doctor`'s `body_index_partial`). The limit applied before this change
too: a Chinese body over about 667,000 characters was already past it.

## What this does not establish

- How `search.max_query_terms`'s phrases scale on production D1 or on a larger archive: the timings are local,
  at 1,200 deliveries.
- Anything on production D1. Rows read and storage were measured on the local SQLite that the Workers test
  pool runs, and nothing was written to a Cloudflare account for this receipt.
- Anything about Japanese or Korean volume. The corpus is Chinese; `test/message-search-cjk.test.ts` shows
  Japanese and Korean are *found*, not what they cost.
- Whether 2,000,000 bytes is exactly where production D1 refuses a bound string. The figure is the published
  limit; no string that size was bound in production.
