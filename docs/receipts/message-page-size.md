---
id: message-page-size
kind: measured-tripwire
measured_on: 2026-08-26
stale_when: >
  the ir_org_accepted index is dropped or reordered; messagePageQuery gains a join, a correlated subquery or
  a predicate, since the per-row cost below is four index seeks and each one of those adds another; a sibling
  field is added to the supervised.query entry's detail, which lowers how many ids one entry holds;
  audit.max_detail_bytes moves; or authz.list.max_rows_read moves
values:
  messages.page_size: 50
---

**How many messages `GET /api/messages` returns in one page, and what decides it.**

`listMessages` returned `LIMIT 50` from Layer 1 until #91, with no cursor — so the fifty-first message was
not slow to reach, it was unreachable. The fifty was also unmeasured, which is why this file exists: the
number stays 50 and now has a reason, a ceiling above it, and a condition that would move it.

**Measured:** `apps/node/worker/test/message-page.measure.test.ts`, under
`@cloudflare/vitest-pool-workers` in the real Workers runtime against a seeded D1. It imports
`messagePageQuery` from `src/authz-read.ts` rather than restating the statement, so the figures describe the
query that ships. `authz-check-rows-read.md` records what happens when they do not: it says of this very
listing *"gained a `UNION` inside its mailbox sub-select and is not separately priced here"*.

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
| 25 | 108 | 132 | 12,351 |
| **50** | **208** | **258** | **24,226** |
| 100 | 408 | 508 | 47,976 |
| 200 | 808 | **1,008** | 95,473 |

Four seeks per returned row — the receipt, its address, its message, its case — plus the page's one probe
row and the tuple sub-select. So `rows_read ≈ 4 × (size + 1) + 4`, and `authz.list.max_rows_read = 1000`
puts the cost ceiling a little under **200**: at 200 a page bounded to one mailbox already reads 1,008.

**These figures were not reproducible when first recorded**, and the fix was in the corpus rather than in
the table. The keyset order is `(accepted_at, id)`, every fourth delivery in the fixture shares a timestamp
on purpose, and the receipt ids came from `ctx.id("rcpt")` — random ULIDs. So the id decided every tie, which
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
| page 1 | 208 |
| page 20 | 210 |
| page 1, **without** `ir_org_accepted` | 6,004 |
| page 5, without `ir_org_accepted` | 5,204 |

**The index is load-bearing and it did not exist.** `ingress_receipts` has been ordered by `accepted_at`
since Layer 1 and carried no index on it — only the primary key and `ir_derived_key` on `(org_id,
provider_event_id)`. So *every inbox load already scanned the whole table and sorted it*: 6,004 rows read on
1,200 deliveries, against a 1,000-row budget, on the first page. That was invisible because the fixtures have
three messages in them. Migration `0038_inbox_page_order.sql` adds `(org_id, accepted_at, id)`, and the
measurement above is with and without it in the same run.

**The obvious cursor spelling does not use the index either.** `exports.ts` compares the same two columns as
`accepted_at || ' ' || id`, which is correct — a space sorts below every character an ISO instant or a
Crockford ULID can hold — and which SQLite cannot turn into a range constraint, because the left-hand side is
an expression. Measured with that form: page 1 read 207, page 11 read 717, page 20 read 1,176. That is
`OFFSET`'s cost curve reached by a different route, inside the change made to avoid it. The shipped form is
two predicates — `accepted_at <= ?` for the range the planner can seek on, then `(accepted_at < ? OR id < ?)`
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
`(? IS NULL OR accepted_at <= ?)` is the shape `exports.ts` uses for optional predicates and it reads better
— and a disjunction whose first branch does not mention the column is not a constraint, so the optional form
plans as a scan even when a cursor *is* present.

No `USE TEMP B-TREE FOR ORDER BY` on any of the three, which is the other half of what the index buys: the
order is read out of it rather than sorted afterwards.

## Sized

**`messages.page_size = 50`**, from the tighter of two ceilings:

- **The list budget** allows a little under 200. That is the cost ceiling, and 50 sits 4.8× inside it (208
  rows against 1,000).
- **One supervised query, one audit entry** allows **57**, measured by asking `buildSupervisedQuery` where it
  splits rather than by arithmetic. §7 records each listing as an act; a page whose id list will not fit
  `audit.max_detail_bytes` is *split* into continuation entries rather than truncated, so a larger page is
  correct and costs more audit rows. Keeping the page under the fill keeps one act to one row, which is the
  property `docs/supervised-access.md` already claims and `test/supervised-recording.test.ts` asserts.

50 is under both with margin, and it is what shipped — so no reader's page changes size and the change is
purely that older mail became reachable. **Seven rows of margin under the audit fill is the thin one**, and it
is the reason `stale_when` names a sibling field added to that entry's detail: one more field lowers the fill,
and if it fell below 50 the page would start splitting its record. That splits correctly and records
everything; what it stops being is one row per act.

**Cost if wrong.** Too large: a listing that breaches the list budget on every inbox load, which is a D1 bill
rather than a failure — nothing refuses, so nothing tells anybody. Too small: more round trips to reach the
same mail, which is visible and annoying rather than expensive. The asymmetry is why the number is sized
against the ceilings rather than against how much a person likes scrolling.

## What this does not fix, with the number so nobody has to guess

**A page bounded to a quiet mailbox is bounded by the archive, not by the page.** Measured: a mailbox holding
the 3 oldest deliveries of 1,200 answers its 3 rows correctly and reads **2,410** — the whole corpus, twice,
because the ordering is `accepted_at` and the mailbox is reached through `addresses`.

This is **not** something the mailbox filter introduced. The authorization predicate has the same shape, so a
reader who may see one mailbox out of ten has always paid this on an unfiltered listing; #91 made it possible
to ask for it deliberately, and measured it. What would fix it is a per-mailbox ordering to drive the listing
from — `mailbox_items` is already indexed `(org_id, mailbox_id, time_bucket, sent_at)` and is exactly that —
and moving the inbox onto it is a change to what the listing reads rather than to how it pages. It is not in
#91 and it is not pretended away: the figure is printed by the measurement on every run.

**Search is not in #91 either** (the ticket says so). Pagination is what makes the existing list honest;
reaching a specific old message by content is a different question with its own indexing decisions, and an
FTS index over subjects would land in `message-metadata-bytes.md`'s per-message figure as well as here.
