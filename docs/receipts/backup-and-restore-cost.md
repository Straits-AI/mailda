---
id: backup-and-restore-cost
kind: platform-limit
measured_on: 2026-09-15
stale_when: >
  `wrangler d1 export` starts carrying schema or the `d1_migrations` table; `mailda backup` stops
  excluding it; or D1 begins accepting an import against a schema the export predates
values:
  backup.export_carries_schema: 0
  backup.export_carries_migration_rows: 0
---

**Measured:** against the live Node `mailda.swmengappdev.workers.dev`, 15 September 2026, holding 86 evidence
objects — 8 received messages, 27 send manifests and their arms, drafts and exports.

**Two values, not nine.** A first draft of this receipt carried the object count, the catalog size and both
timings as budget values. They are observations of one run, and a budget value is something code or a test
reads — carrying them here would have made `budget-plan-scope.test.ts` classify a stopwatch reading and
`pnpm receipts` promise to keep it fresh.

What is receipt-shaped is the pair below: **properties of `wrangler d1 export` that the restore path depends
on**, both of which `disaster-recovery.md` asserted in two contradictory directions on one page. The run's
figures live in that runbook beside the drill they came from.

## What #202 actually fixed, confirmed against real data rather than a fixture

The same command, run twice within the hour against the same Node:

```text
   pre-#202 code   /api/evidence/inventory answered 500 … 11 object(s) had been listed
   main            86 object(s) listed          written in 29.4s
```

`hashesFor` bound `referents.length × (1 + keys.length)` parameters against `d1.max_bound_parameters` of
100, at a page size of 150. So `mailda backup` failed on any Node with mail in it, and **#92's own drill
could not see it because the drill had three objects.**

That is the value of this receipt beyond its numbers. *"It has been run once, over three objects"* was
recorded on #92 as a gap in the record. It was a gap in the **coverage**, and the defect was sitting in it.

## The figures

| | |
|:--|:--|
| objects inventoried | 86 |
| catalog | 366,788 bytes — 663 `INSERT`s across 28 tables |
| inventory | 20,617 bytes |
| `mailda backup` | **29.4 s** end to end, including wrangler's D1 export round trip |
| `mailda verify-backup` | **0.5 s** |

**RPO is not a product limit** and no figure belongs here: it is the age of the last backup, which is a
schedule decision.

**RTO splits, and only one half has a number.** `restore-to-readable` was measured once, on 2 September,
and this run did not repeat it — so that figure stands where `disaster-recovery.md` records it, with its own
caveat that the elapsed time described defects rather than the sequence. `restore-to-receiving` remains
**unmeasured**: `restore.to_receiving_measured: 0`.

## Two properties of the export, settled from the artifact

`backup.export_carries_schema: 0` and `backup.export_carries_migration_rows: 0`. Zero `CREATE TABLE`, and
`d1_migrations` appears nowhere in 366 KB of SQL.

Both were already claimed — and `disaster-recovery.md` also claimed the **opposite** a paragraph earlier,
warning that `d1_migrations` "will lie" and that the search migrations must be re-run by hand. Two
contradictory instructions on one page of a runbook somebody reads during an incident. The artifact settles
it: the exclusion is real, nothing lies, and the manual step was work an operator did not need.

The same fact has a consequence the runbook left as an inference and now states as a step: **the
destination's migrations must be applied before the import**, because the export carries no schema.
Measured — importing this backup into a stale database answers `table messages has no column named
body_indexed_at: SQLITE_ERROR`.

## What this does not establish

That the catalog restores into a real destination, or that the evidence decrypts there. Both are properties
of a restore, and a restore was not run today. `verify-backup` says so itself, which is why its output is
worth reading rather than its exit code:

> what that does not establish, said here rather than left implied:
>   - that the evidence decrypts. The objects are not in the backup; the inventory lists them.
>   - that the catalog restores.

And 86 objects is not a mailbox. It is twenty-eight times the drill and still small, so the next wall above
it is unknown — what this receipt establishes is that the first one is gone.

## Addition, 17 September 2026: the catalog half at 10,000 and 50,000 messages

Measured on two scratch databases in the live account (created, seeded, exported, imported, deleted), with the
byte receipt's corpus — real widths, one `mailbox_items` row per message — exported by `d1 export --no-schema`
exactly as `mailda backup` does and imported by `d1 execute --file` into a fresh database carrying the schema.
Prose, not values, for the reason the header gives: these are stopwatch readings from a laptop.

| messages | export | export size | statements | import | rows read back |
|--:|--:|--:|--:|--:|--:|
| 10,000 | 11.3 s | 15.6 MB | 20,000 | **21.6 s** | 10,000 |
| 50,000 | 32.8 s | 78.1 MB | 100,000 | **106.9 s** | 50,000 |

Linear at roughly a thousand statements a second in each direction, so the wall `disaster-recovery.md` said
this drill had not reached is not near: a 50,000-message catalog is under two minutes each way. The one limit
met was per statement — a hand-built 150 KB multi-row `INSERT` is refused with `SQLITE_TOOBIG` — and an
export writes one row per statement, so a restore never produces one.

Not measured here, still: the evidence copy at the same scale, which needs an S3-API copy (`rclone` with an
R2 API token, which the wrangler OAuth token cannot mint) and is the number a mailbox-sized restore turns on.
