---
id: message-page-size
kind: measured-tripwire
measured_on: 2026-09-26
stale_when: >
  the ir_org_accepted or mpl_by_place index is dropped or reordered; messagePageQuery gains a join, a
  correlated subquery or a predicate, since the per-row cost below is a handful of index seeks and each one of
  those adds another — the derived columns (labels, read, place, standing content, the case join) and the
  0068 projection columns are part of that cost; the filters place, unread or mine change meaning; the placed
  plan stops being driven by the filing table; the lookback's shape changes — a per-person predicate moved
  inside the lookback, or any statement that reads the lookback before the page fills (a window function, a
  sort, a count), or the edge statement stops re-walking the page's inner statement; RELATIONS_FOR_METADATA or STANDING_CONTENT_RELATIONS gains or loses a relation, since the
  tuple sub-selects probe one row per relation; a sibling field is added to the supervised.query entry's
  detail, which lowers how many ids one entry holds; audit.max_detail_bytes moves; or authz.list.max_rows_read
  moves
values:
  messages.page_size: 50
  messages.max_lookback: 500
  messages.lookback_rows_read_per_message: 9
---

**How many messages `GET /api/messages` returns in one page, what decides it, and how far one Inbox, Unread
or Mine request looks back.**

## Remeasured 26 September 2026: the redesign's columns, filters, placed plan and lookback

**The figures below this section are the 27 August measurement, and they were already stale before this
change**: bytes had moved from 24,226 to 33,202 for a 50-row page with the authentication, attachment, label
and read columns, none of which re-measured this file, and the `read` and `labels_json` probes had been
measured against empty tables. This section replaces them, and the older sections stay as the argument for the
shapes that shipped (the index, the two-predicate cursor, the page size).

**What changed in the corpus.** The same 1,200 deliveries, and now **the readers' own rows seeded**, because a
correlated probe into an empty table reads nothing: a case for every delivery; for the healthy reader, by
delivery index `i`, `i % 20 === 0` in Trash, otherwise `i % 2 === 0` in Archive (half stay in the Inbox),
`i % 5 === 1` unread (every other delivery has a `message_reads` row), `i % 20 === 3` a case they hold; an
inbox-zero reader who has filed and read everything and holds no case; and three readers who have filed 1 %,
50 % and 95 %. Every message carries the 0068 projections as a settled Node holds them (a display name on
70 %, a sealed preview ~200 base64 characters wide, projected).

**What changed in the row.** `place`, `from_name`, `preview` (opened from `preview_sealed` only for
`standing_content = 1`), `standing_content`, `case_mine` and `case_state`. The case columns come from one
`LEFT JOIN cases` on the delivery's own mailbox instead of the correlated `case_id` subquery, and that is
**measured, not assumed**: the same walk with the join removed entirely reads the same 332 rows, so the join
is no worse than one correlated seek and better than the three a subquery per column would be.

Measured by `apps/node/worker/test/message-page.measure.test.ts`:

```
MEASURE message_page  size=50  first_rows_read=332  deep_rows_read=333  deep_page=20  filtered_rows_read=383  first_bytes=46513  bytes_per_row=912
MEASURE message_page_sweep  size=25  first_rows_read=175 / 50: 332 / 100: 647 / 200: 1277
MEASURE message_page_sparse  deliveries=1200  quiet_mailbox_rows=3  quiet_rows_read=2424
MEASURE message_page_sparse_lookback  walk=2424  reader=4833(page 2420 + edge 2413)  inbox_zero=4827(page 2415 + edge 2412)
MEASURE message_page_placed  filed_1pct=83(12 rows)  filed_50pct=316(51 rows)  filed_95pct=316(51 rows)  trash_5pct=367(51 rows)
MEASURE message_page_lookback_healthy  F=101  rows_read=557  rows=51  max_lookback=500  bytes_per_row=910
MEASURE message_page_lookback_exhausted  N=500  inbox_zero=4516  at_half=2266  c=9  no_unread=4516  no_mine=4516  first_page=557  bound=5057
```

| plan | page 1 | deep (page 20) | one mailbox | asserted |
|:--|--:|--:|--:|:--|
| the walk (every place: a thread, a mailbox, sender, date, label) | 332 | 333 | 383 | ≤ `authz.list.max_rows_read` |
| placed: Archive at 1 % / 50 % / 95 % filed | 83 / 316 / 316 | | | ≤ the list budget, each |
| placed: Trash (5 %) | 367 | | | ≤ the list budget |
| the lookback: the healthy default Inbox | 557 | | | ≤ the list budget, fills, not exhausted |
| the lookback: inbox zero, nothing unread, no case held | 4,516 each | | | ≤ c × N + the first page |

**`messages.page_size` stays 50.** A page now reads 332 against the 1,000-row budget, 3.0× inside it (it was
4.8×); at 100 it reads 647 and at 200 it breaches (1,277), so the cost ceiling is now a little over 150 and
the audit fill (57 ids an entry) is still the tighter of the two. **Bytes**: 46,513 for a 50-row page, 912 a
row, with a 120-character preview on every row a content reader sees.

**The placed plan costs a page.** Driven by `mpl_by_place` (the filing table's own copy of the receipt's
position, 0067), Archive and Trash read what a page reads whether 1 % or 95 % of the corpus is filed. Driven
from the receipts instead, the mutation that turns its assertion red, a reader who has filed little pays for
everything they have not.

### Sizing the lookback

Inbox, Unread and Mine filter on the reader's own state, which no ordering index can serve. Before the bound
they walked until the page filled: for a reader who archives nearly everything, reads everything or holds few
cases, about four rows read for every message they can see (≈ 400,000 a load at 100 k). The user chose a bound
over that (§7 Q-A, decided 26 September 2026).

1. **F = 101**: the healthy default Inbox's page 1 looks through 101 messages to fill `page_size + 1` rows,
   counted from the seeded data (the visible receipts from the newest down to the page's probe row).
2. **`messages.max_lookback` = 500**: the smallest multiple of 100 ≥ 4 × F (404). Four times, the order of
   headroom `messages.page_size` keeps under the list budget: a healthy Inbox uses at most a quarter of its
   lookback. On this corpus Unread (Inbox and unread: 10 % of deliveries) would need about 510 to fill and Mine
   (5 %) about 1,020, so both stop at the lookback with what they found and a cursor. Those tabs, and an
   inbox-zero Inbox, are where the lookback is meant to be felt, and `lookback_exhausted` says so.
3. **`messages.lookback_rows_read_per_message` = 9**: rows read per message looked at, both statements
   together, as the slope between the inbox-zero reader at N and at N / 2: (4,516 − 2,266) / 250 = 9. The
   estimate before measuring was about 7; the derived columns over the page and the edge statement's own walk
   are the difference.
4. **Related to `authz.list.max_rows_read`, not reused as the bound.** Reused, N would be ⌊(1,000 − 557) / 9⌋
   = 49, below the healthy F of 101: every healthy Inbox would exhaust its lookback on its first page — a
   tripwire the healthy widget feels, which AGENTS §2 forbids. So N is sized from the healthy fill, and its
   cost is written against the budget: an exhausted lookback reads 9 × 500 + 557 = **5,057 rows, about five
   list budgets, a constant**, where the unbounded walk read about four times every message the reader can see
   (40,000 at 10 k, 400,000 at 100 k, 4,000,000 at 1 M). The list budget is not raised: it keeps bounding the
   first, deep and one-mailbox pages, and now also the healthy default Inbox page.
5. **Assertions**, each seen to fail: (a) the healthy default Inbox reads ≤ the list budget, fills, is not
   exhausted, and 4 × F ≤ `messages.max_lookback` (a corpus or query change that grows F goes red and asks for
   this remeasure); (b) inbox zero, nothing unread and no case held each read ≤ c × N + the first page, after
   asserting `DELIVERIES ≥ 2 × N` (an unbounded walk over twice the lookback breaches it — binding a lookback of
   a million turns it red); (c) the healthy page reads less than half the exhausted figure, the early stop
   (numbering the rows with `ROW_NUMBER() OVER (…)` inside the inner statement turns (a), (b) and (c) red,
   because it sorts the whole lookback before the first row returns).

**What the lookback does not bound**, said as plainly: the walk's pre-existing authorization term (a reader of
one mailbox among many passes the others' receipts on the way to the ones they can see — the quiet-mailbox
figure below, now 2,424) and a sparse mailbox, label or sender filter. It bounds the reader's own state and
nothing else.

**And a lookback page that does not fill pays those terms twice** (corrected 26 September 2026; this paragraph
first said they were "unchanged, not worsened", which the measurement behind it could not see, because every
reader in the corpus holds all three mailboxes). The edge statement re-runs the page's inner statement with
`OFFSET N - 1`, and when the reader sees fewer than N messages that match, SQLite steps through every receipt
the page statement already passed to prove it. So an Inbox, Unread or Mine page on a quiet mailbox reads the
walk twice: **4,833** rows for the healthy reader (page 2,420 + edge 2,413, one row returned) and **4,827** for
the inbox-zero reader (2,415 + 2,412), against **2,424** for the same mailbox with no per-person filter
(`message_page_sparse_lookback`, above). The ceiling is twice the walk the page already did, never more, and
`test/message-page.measure.test.ts` asserts it with the edge seen to run and not exhausted. Neither shortcut
closes it: skipping the edge on an empty page strands an inbox-zero reader who can see N or more behind the
lookback with no cursor, and starting it from the page's last row is not possible because that row's rank in
the walk is unknown. The fix that removes both walks' term together is the per-mailbox ordering the quiet
figure already names.

### The vault, per page and per ingest

A page holding a sealed preview opens it: **one Durable Object request per distinct content-key generation on
the page**, which is one in practice (rotation is rare, and `reseal.ts` moves previews with their receipts),
run-cached for the page. Ingest seals the preview in the run that read the evidence: **+1 vault RPC per
ingest**, the sealing key (the read already asked for its opening key). The backfill asks for **at most 3 vault RPCs a pass** (its run cache holds the
opening and sealing keys for all 25 messages). None of these is a D1 row, so none is in the figures above.


`listMessages` returned `LIMIT 50` from Layer 1 until #91, with no cursor, so the fifty-first message was
not slow to reach, it was unreachable. The fifty was also unmeasured, which is why this file exists: the
number stays 50 and now has a reason, a ceiling above it, and a condition that would move it.

**Measured:** `apps/node/worker/test/message-page.measure.test.ts`, under
`@cloudflare/vitest-pool-workers` in the real Workers runtime against a seeded D1. It imports
`messagePageQuery` from `src/authz-read.ts` rather than restating the statement, so the figures describe the
query that ships. `authz-check-rows-read.md` records what happens when they do not: it says of this very
listing *"gained a `UNION` inside its mailbox sub-select and is not separately priced here"*.

**Every figure here rose by exactly 2 on 27 August 2026**, and the cause is worth a line rather than a
silent re-measure. `messagePageQuery`'s standing-relation arm read `AND relation = 'mailbox.content.read'`,
one relation, while its own header claimed the columns were what `mailbox.metadata.read` covers. So somebody
holding exactly the relation the access UI sells as *"See that mail exists"* was shown an empty inbox. The
predicate now reads `IN (?, ?)` from `RELATIONS_FOR_METADATA`, the sub-select probes one row per relation,
and every figure below moved by the one extra probe. Nothing about the row shape changed, which is why the
byte columns did not move.

Corpus: 1,200 deliveries across three mailboxes, one reader holding `mailbox.content.read` on all three,
realistic field widths (64-character digests, RFC message-ids, a 62-character subject, typed-prefix ULIDs).
Every fourth delivery shares its predecessor's `accepted_at`, because one message to two addresses of one
mailbox arrives as two receipts with one timestamp and a corpus without that tie would be testing a total
order the real one is not.

**`rows_read`, not milliseconds**, for the reason `authz-check-rows-read.md` established: `performance.now()`
inside workerd is clamped by the Spectre mitigation and does not advance during execution, so a timing figure
would be the clock's resolution. D1 bills on rows *scanned*, so this number is the cost, the ceiling
pressure, and a direct test of whether the index is used.

## What a page costs

| page size | rows read, page 1 | rows read, one mailbox | body bytes |
|---:|---:|---:|---:|
| 25 | 110 | 134 | 12,351 |
| **50** | **210** | **260** | **24,226** |
| 100 | 410 | 510 | 47,976 |
| 200 | 810 | **1,010** | 95,473 |

Four seeks per returned row (the receipt, its address, its message, its case) plus the page's one probe
row and the tuple sub-select, which probes **two** relations. So `rows_read ≈ 4 × (size + 1) + 6`, and
`authz.list.max_rows_read = 1000` puts the cost ceiling a little under **200**: at 200 a page bounded to one
mailbox already reads 1,010.

**These figures were not reproducible when first recorded**, and the fix was in the corpus rather than in
the table. The keyset order is `(accepted_at, id)`, every fourth delivery in the fixture shares a timestamp
on purpose, and the receipt ids came from `ctx.id("rcpt")`, random ULIDs. So the id decided every tie, which
decided how far the walk got before the page filled, and the one-mailbox column moved by a row or two
between runs (506 then 508 at size 100; 134 then 132 at size 25). A receipt whose command prints a different
number each time is not a receipt. The fixture now uses zero-padded deterministic ids, so lexical order
matches insertion order, and the figures above are stable across repeated runs.

**The mailbox-bounded page reads more than the unbounded one**, which is the opposite of the intuition and
is the whole of why the filter was measured rather than assumed: bounding to a mailbox means scanning
receipts in time order until enough of them belong to that mailbox. In this corpus two thirds of the mail is
in mailbox A, so filling 51 rows takes about 76 receipts.

## Depth is flat, and it took two fixes to be

| | rows read |
|:--|---:|
| page 1 | 210 |
| page 20 | 212 |
| page 1, **without** `ir_org_accepted` | 6,006 |
| page 5, without `ir_org_accepted` | 5,206 |

**The index is load-bearing and it did not exist.** `ingress_receipts` has been ordered by `accepted_at`
since Layer 1 and carried no index on it, only the primary key and `ir_derived_key` on `(org_id,
provider_event_id)`. So *every inbox load already scanned the whole table and sorted it*: 6,006 rows read on
1,200 deliveries, against a 1,000-row budget, on the first page. That was invisible because the fixtures have
three messages in them. Migration `0038_inbox_page_order.sql` adds `(org_id, accepted_at, id)`, and the
measurement above is with and without it in the same run.

**The obvious cursor spelling does not use the index either.** `exports.ts` compares the same two columns as
`accepted_at || ' ' || id`, which is correct (a space sorts below every character an ISO instant or a
Crockford ULID can hold) and which SQLite cannot turn into a range constraint, because the left-hand side is
an expression. Measured with that form: page 1 read 207, page 11 read 717, page 20 read 1,176. That is
`OFFSET`'s cost curve reached by a different route, inside the change made to avoid it. The shipped form is
two predicates: `accepted_at <= ?` for the range the planner can seek on, then `(accepted_at < ? OR id < ?)`
for the tie. `test/explain.test.ts` prints all four plans, and the difference between the first three is one clause wide:

```
inbox page one (newest, no cursor)
  SEARCH r USING INDEX ir_org_accepted (org_id=?)
inbox page two (the cursor as two predicates — the shipped form)
  SEARCH r USING INDEX ir_org_accepted (org_id=? AND accepted_at<?)
inbox page two (the cursor as one concatenation — rejected)
  SEARCH r USING INDEX ir_org_accepted (org_id=?)
inbox page two (the cursor behind a null guard — also rejected)
  SEARCH r USING INDEX ir_org_accepted (org_id=?)
```

The fourth plan is why `messagePageQuery` assembles its `WHERE` instead of parameterising a fixed one.
`(? IS NULL OR accepted_at <= ?)` is the shape `exports.ts` uses for optional predicates and it reads better,
and a disjunction whose first branch does not mention the column is not a constraint, so the optional form
plans as a scan even when a cursor *is* present.

No `USE TEMP B-TREE FOR ORDER BY` on any of the three, which is the other half of what the index buys: the
order is read out of it rather than sorted afterwards.

## Sized

**`messages.page_size = 50`**, from the tighter of two ceilings:

- **The list budget** allows a little under 200. That is the cost ceiling, and 50 sits 4.8× inside it (210
  rows against 1,000).
- **One supervised query, one audit entry** allows **57**, measured by asking `buildSupervisedQuery` where it
  splits rather than by arithmetic. §7 records each listing as an act; a page whose id list will not fit
  `audit.max_detail_bytes` is *split* into continuation entries rather than truncated, so a larger page is
  correct and costs more audit rows. Keeping the page under the fill keeps one act to one row, which is the
  property `docs/supervised-access.md` already claims and `test/supervised-recording.test.ts` asserts.

50 is under both with margin, and it is what shipped, so no reader's page changes size and the change is
purely that older mail became reachable. **Seven rows of margin under the audit fill is the thin one**, and it
is the reason `stale_when` names a sibling field added to that entry's detail: one more field lowers the fill,
and if it fell below 50 the page would start splitting its record. That splits correctly and records
everything; what it stops being is one row per act.

**Cost if wrong.** Too large: a listing that breaches the list budget on every inbox load, which is a D1 bill
rather than a failure. Nothing refuses, so nothing tells anybody. Too small: more round trips to reach the
same mail, which is visible and annoying rather than expensive. The asymmetry is why the number is sized
against the ceilings rather than against how much a person likes scrolling.

## What this does not fix, with the number so nobody has to guess

**A page bounded to a quiet mailbox is bounded by the archive, not by the page.** Measured: a mailbox holding
the 3 oldest deliveries of 1,200 answers its 3 rows correctly and reads **2,412**, the whole corpus twice,
because the ordering is `accepted_at` and the mailbox is reached through `addresses`.

This is **not** something the mailbox filter introduced. The authorization predicate has the same shape, so a
reader who may see one mailbox out of ten has always paid this on an unfiltered listing; #91 made it possible
to ask for it deliberately, and measured it. What would fix it is a per-mailbox ordering to drive the listing
from (`mailbox_items` is already indexed `(org_id, mailbox_id, time_bucket, sent_at)` and is exactly that),
and moving the inbox onto it is a change to what the listing reads rather than to how it pages. It is not in
#91 and it is not pretended away: the figure is printed by the measurement on every run.

**Search is not in #91 either** (the ticket says so). Pagination is what makes the existing list honest;
reaching a specific old message by content is a different question with its own indexing decisions, and an
FTS index over subjects would land in `message-metadata-bytes.md`'s per-message figure as well as here.
