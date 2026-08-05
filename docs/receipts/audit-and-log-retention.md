---
id: audit-and-log-retention
kind: measured-tripwire
measured_on: 2026-08-05
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

## Verification is batched at 1,000

Re-hashing a chain is linear, and a Node that has been running for a year has more entries than one
request can verify inside the CPU limit. `verifyAuditChain` walks 1,000 at a time from a caller-supplied
position and reports **where** it broke rather than a bare pass/fail, because an investigation needs the
first bad link, not the news that one exists.
