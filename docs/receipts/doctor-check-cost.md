---
id: doctor-check-cost
kind: measured-tripwire
measured_on: 2026-08-04
stale_when: >
  Cloudflare changes the 1,000-subrequest per-invocation cap, R2 head stops counting as a
  subrequest, doctor gains a check that costs a subrequest per row, or the measured cost of a
  doctor run changes materially
values:
  doctor.evidence_sample_size: 200
  doctor.max_subrequests: 1000
  doctor.max_subrequests_per_run: 220
---

`doctor` verifies the runtime claims other decisions made. Most of its checks cost one query; one
of them — evidence integrity — costs **one R2 `head` per receipt examined**, which is why it has a
bound at all.

## The bound, and why it is a sample

A Worker invocation may issue at most **1,000 subrequests** (the same cap #4 sized service-binding
fan-out against). Both D1 queries and R2 operations spend one. `message-metadata-bytes.md` measured
that a 10 GB shard holds **~8.5 million messages**, so "check every receipt" is not a bounded
operation and never becomes one.

**200 receipts, most recent first.** Derivation rather than taste:

| | |
|---:|:---|
| 1,000 | subrequests available |
| ~10 | spent by every other check (schema, KEKs, keys, outbox, counts) |
| 200 | R2 `head` calls |
| ~790 | headroom, so adding a check never silently pushes this over the cap |

The bound is **visible in the output**, not just in this file. The finding's detail line reads
`200 of 8,500,000 receipt(s) checked, most recent 200` — because a check that examines 200 rows of
8.5 million and reports "ok" is a check that lies, and AGENTS.md forbids a cap the reader cannot
see. Most recent first because a blob that has just gone missing is the one a human can still act
on; older losses need the §24 reconciler, not a diagnostic.

## Measured cost of a full run

Measured against the deployed Node (`mailda.swmengappdev.workers.dev`, 4 August 2026) on a catalog
holding 1 receipt, 14 tables, 1 current signing key:

`doctor` **counts its own cost** and reports it as a finding, so this figure is read off a live run
rather than derived from the source. Measured on the deployed Node with 1 receipt, 14 tables and 1
current signing key:

| | |
|---:|:---|
| **7** | D1 queries |
| **1** | R2 read (one receipt exists) |
| **8** | subrequests total, against a cap of 1,000 |

Only **subrequests** are counted, and that is deliberate. `D1PreparedStatement.first()` returns its
row without `meta`, so a rows-read total would silently omit most of this file's queries — and a
partial figure presented as a total is exactly the kind of number this project refuses to write. The
cap is on subrequests anyway.

`doctor.max_subrequests_per_run = 220` is the tripwire: the fixed checks plus a full 200-receipt
sample, with room to spare. It fires if a check becomes proportional to mailbox size, which is how
the authorization path grew a full table scan unnoticed (`authz-check-rows-read.md`). A test asserts
the relationship directly — five more receipts cost five more R2 reads and **zero** extra queries.

## An edge cache served a stale report

Found while taking this measurement: `GET /api/doctor` came back from a Cloudflare edge cache with a
stale verdict, omitting a field the deployed code was already returning. §8 requires
`Cache-Control: no-store` on authentication, admin and content surfaces and nothing was setting it.
It is now applied centrally to every `/api/*` response, with `Vary: cookie`, rather than per-route —
a header each future handler must remember is a header that will be forgotten.

## Why it uses the credentials rather than inspecting them

Two checks deliberately perform a round trip instead of testing for presence:

- **Credential KEK** — wrap then unwrap a probe string. A Secrets Store secret is `pending` for a
  period after creation, so the binding exists and `.get()` throws. This presented as an HTTP 500
  on the first sign-in of a correctly configured Node.
- **Signing key** — mint a token and verify it. A row can exist while being unwrappable, if the
  credential KEK that wrapped it has changed.

Presence is not readability, and a diagnostic that tests presence would have passed in both cases.
