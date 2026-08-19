---
id: audit-and-log-retention
kind: measured-tripwire
measured_on: 2026-08-05
# Prose-only, like `re_measured_on:` in message-metadata-bytes.md — `packages/receipts/src/parse.ts` reads
# neither, so neither reaches `generated.ts`. It is here because `measured_on` is one date for a whole file,
# and the two `*_detail_bytes` values were never *derived* on 5 August: they were a round number, which #69
# found and the `**Sized:**` section below now reasons. Without this the generated metadata attributes those
# two values to a measurement that did not happen.
sized_on: 2026-08-18
sized_values: [audit.max_detail_bytes, log.max_detail_bytes]
stale_when: >
  the audit or log row shape changes, D1's 10 GB per-database ceiling changes, or the measured bytes
  per entry move materially
values:
  audit.max_detail_bytes: 2048
  log.max_detail_bytes: 2048
  log.retained_entries: 50000
  log.trim_batch: 500
  audit.verify_batch: 1000
---

## The entry commits with the act it records

An audit trail added as a second write has a hole that verification cannot see. The first version of
this wrote the state change, then appended the entry:

```
await env.CATALOG.batch(statements);   // the act
await audit(env, ctx, orgId, {...});   // the record
```

If the isolate dies in between, the act is committed and nothing records it. The hash chain does not
help — it proves that what *was* written is unaltered and says nothing about what was never written.
Sequence numbers stay contiguous, `verifyChain` still reports `intact: true`, and the missing act is
undetectable **by construction**. That is a worse failure than a broken chain, because a broken chain
announces itself.

So the entry travels inside the caller's `batch()`. D1 runs a batch as a single transaction, which is
the assumption everything here rests on and is therefore asserted rather than believed: a test commits
an entry alongside a state change and a statement that must fail, then checks that the state change
was rolled back too (`test/audit.test.ts`, "rolls the state change back with the entry").

Two consequences worth stating plainly:

- **`auditedBatch` throws where `audit` does not.** The contracts are opposite on purpose. `audit`
  records something that already happened and must never fail its own request. `auditedBatch` gates an
  act that has *not* happened, so if the Node cannot record it, the Node does not do it.
- **Appends serialise per organisation.** Two concurrent auditable changes contend for the same next
  sequence number; the loser re-reads the tip and retries the whole batch, bounded at five attempts.
  This is inherent to hash-linking rather than a defect of the implementation — a chain is an order,
  and an order is a serialisation. At mail volumes it is a fair trade; at high write rates it would
  not be, and that is the number to watch if this design is ever reused elsewhere.

Conditional acts use a gate: `INSERT ... SELECT ... WHERE EXISTS (<predicate>)`, so a cancellation that
loses its race records nothing and consumes no sequence number. The gated entry must be ordered
**before** whatever changes the predicate, or it can never fire.

## Audit is kept; logs are bounded. That asymmetry is the point

**Audit entries are never trimmed.** A hash chain with a hole in it is not a chain, and "we deleted the
old evidence to save space" is precisely the sentence an audit exists to make impossible. Growth is
therefore a real cost and is accounted for rather than waved away.

Sized against `message-metadata-bytes.md`, which measured **1,505 bytes per message** on real remote D1
and derived §11B's shard thresholds from it. An audit entry is far smaller — no blob keys, no hashes of
content, a bounded `detail` — and a Node writes a handful per message at most: accepted, materialised,
and whatever a human then does with it. Audit is not what fills a shard; mail is.

**Log entries are trimmed at 50,000 per Node.** Different reasoning, because logs have a different job:
the fiftieth-thousandth most recent error is not diagnostic, it is archaeology. At roughly 400 bytes an
entry that is ~20 MB — noise against a 10 GB ceiling, and small enough that trimming is about keeping
queries fast rather than about space.

Trimming happens **opportunistically on write, 500 at a time**, rather than on a schedule. A scheduled
job is a second thing that can fail silently; a bounded trim on a path that is already writing cannot
drift out of step with the thing it is trimming.

## Both details are bounded at 2 KiB

`detail` is JSON and it is capped, for a reason that is about disclosure rather than storage: **the
audit trail is read by whoever may audit, which is a wider set than whoever may read the mail.** An
unbounded detail field is an invitation to put a subject line, a recipient list, or an error string
containing a token into a table with different access rules than the content it came from. The cap is
a reminder that this is a *record of actions*, not a copy of the thing acted on — §12 keeps content in
R2 and it stays there.

**Counted, 18 August 2026 — every `detail` the Worker builds today.** Method: `boundedDetail` and `log`
were temporarily made to print the UTF-8 length and the key names of each `detail` they were handed, and
both suites were run (`pnpm vitest run`, 30 files / 419 tests, and `-c vitest.node.config.ts`, 12 files /
80 tests). **172 details were recorded; 166 of them come from real call sites** and the other 6 are the
oversize fixtures in the cap's own tests. Of the 166:

| | bytes | shape |
|---|---|---|
| largest | **335** | `{cause, error}` — a reconciliation failure carrying a provider error string |
| widest routine shape | **111** | `{mailboxId, recipients, fidelity, inReplyTo}` (73 occurrences) |
| most common others | 19–87 | `{transportMessageId, reason}` (30), `{email}` (17), `{method}` (14), `{relation, objectType, objectId}` (6) |

Two things that count for more than the sizes. **No call site puts a mail Subject header or a body in a
`detail`** — the recorded shapes are identifiers, reasons and counts, and the one key literally called
`subject` (`audit.ts`, the `audit.append_failed` log line) carries the entry's own subject *column*, which
is an identifier like a manifest id. So the disclosure argument above is preventive rather than remedial,
which is what a tripwire is for.

**That claim is checked by a person, not by a test, and saying so is the point.** It was verified by reading
all 18 `detail:` sites and every value handed to `audit`'s `subject` on 18 August — all identifiers — but
nothing holds it. A source scan is the obvious enforcement and is not obviously safe: the honest predicate is
*"no mail-derived string reaches a `detail`"*, and the one key spelled `subject` is a counter-example to the
naive version, so a scan for the word would false-positive on the day it landed and be muted. Recorded as an
audited convention with a known gap rather than as an enforced property, because the alternative here is a
tripwire that gets switched off — the failure mode `DELIVERY_SILENCE_MS` already names. And the suite exercises the *shapes* the code builds, not a mail corpus:
it bounds what the code can produce and says nothing about volumes.

**Sized:** 2,048 **bytes** — 6.1× the largest real detail measured above and ~18× the routine one, so only
a new shape or a bug reaches it. It is chosen against three things pulling in different directions:

- **Disclosure, which sets the ceiling.** One entry at the cap is the same order as one message-metadata
  row (**1,632 bytes**, measured on real remote D1 in `message-metadata-bytes.md`; the 1,505 quoted
  earlier in this file is that receipt's 4 August figure, superseded there on 12 August) and orders below
  a message body, which §12 keeps in R2. At 4 KiB an entry could carry twice as much mail-derived text into
  the wider-access table; the cap does not *redact* — a single 998-character ASCII subject would still fit,
  and refusing that would make details useless — it stops an entry becoming a transcript.
- **Usefulness, which sets the floor.** A truncated detail is a record that has lost the thing it was
  recording, so the cap has to clear the largest legitimate shape with room for shapes not yet written.
  The concrete one is a list of ids: a typed-prefix ULID is **31 characters** (`packages/runtime/src/ctx.ts`
  mints prefix + 10 time + 16 random, e.g. `rcpt_`), which is 34 bytes as a JSON array element with its
  quotes and comma, so `JSON.stringify(Array(60).fill(id))` is **2,041 bytes** and 61 ids is 2,075 —
  **60 ids bare, about 59 once sibling fields share the object** (computed, not measured). At 1 KiB that
  halves to 29 — below the only listing page size in the budgets today, `reconcile.list_limit` = 200 — and
  an entry recording *which* ids it touched would routinely truncate.
- **Growth, which turns out not to bind.** Audit entries are never trimmed, so the worst case matters:
  even if every entry hit the cap, 10 GB / ~2.3 KiB per row (the capped `detail` plus the fixed columns,
  rounded) is ≈4.3 million entries, and a Node writes a handful per message. Mail fills the shard long
  before audit does, exactly as the section above says.

**Cost if wrong:** too low and the audit says less than it knows, in the one table that is supposed to be
checkable. Too high and it becomes a second copy of the mail under wider access rules.

## Correction, 18 August 2026: the cap was enforced in UTF-16 code units, not bytes

Both keys are named `*_bytes` and, until #69, both were compared against `String.length`, which counts
**UTF-16 code units**. A detail of 2,048 code units of CJK is ~6 KiB of UTF-8, so the bound could be
exceeded roughly threefold by writing in a non-Latin script — the one thing a mail system must assume its
users do. The truncation record then reported that code-unit count under the key `bytes`, and its `head`
was cut with `slice`, which can land between the halves of a surrogate pair.

`boundedDetail` and `log` now measure `TextEncoder().encode(text).length`, cut only between code points,
and price each code point at what it costs *escaped inside the record*, so the truncation record itself
also fits the cap. `test/audit.test.ts` holds both caps to the byte count with a non-ASCII fixture; an
ASCII fixture cannot tell the two units apart, which is how this survived.

**`values:` is deliberately untouched, and no clause of `stale_when` fired.** The row shape did not
change, D1's ceiling did not move, and the measured bytes per entry did not move: the change only *lowers*
the worst case an entry can reach, from ~3× the cap to the cap. Nothing measured here was priced on the
old unit — the counted maximum above, 335 bytes, is ASCII-dominated and identical under either reading.

One consumer's arithmetic to check rather than assume: #63 records that a page of returned ids fits in
this cap, at ~59 typed-prefix ULIDs per entry. Those ids are ASCII, where a byte and a code unit are the
same thing, so **that figure is unchanged** by this correction.

## Verification is batched at 1,000

Re-hashing a chain is linear, and a Node that has been running for a year has more entries than one
request can verify inside the CPU limit. `verifyAuditChain` walks 1,000 at a time from a caller-supplied
position and reports **where** it broke rather than a bare pass/fail, because an investigation needs the
first bad link, not the news that one exists.
