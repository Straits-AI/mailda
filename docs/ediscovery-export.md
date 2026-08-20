# eDiscovery export — the bulk copy, the manifest, and the door that was already open

What §7 asks for when it says *export*, and what this Node builds. Issue #65, Layer 5. Read
`docs/supervised-access.md` first: an export is a **supervised act** and inherits that frame — a matter, a
bounded scope, two people who are not the actor, and a record — rather than inventing a second one. Read
`docs/approvals.md` too: an export is the fourth approval subject, and everything about stages, eligibility
and the races lives there.

Two acts are built, of deliberately different grain:

| | `message.export` | `ediscovery.export` |
|:--|:--|:--|
| what | one message's original `.eml` | a bounded set of messages, staged as sealed objects |
| who | anybody holding the relation on the mailbox, or a supervised grant of scope `content` | somebody an administrator granted it to |
| ceremony | none | a matter, and two approvers who are not the requester |
| record | `message.exported`, per download | `supervised.export_requested`, then `_completed` or `_aborted` |

---

## The door that was already open, and why it is half the ticket

The bulk export is ceremony-heavy and rare. `GET /api/messages/:id/raw` is available today to anybody
holding ordinary `mailbox.content.read`, produces a **complete RFC822 copy** with
`content-disposition: attachment`, and — until this change — recorded **nothing**.

So *"has anybody taken a copy of this message off the Node?"* had no answer. That is the exact question §7
exists to make answerable, and it was unanswerable through the reachable door while the unreachable one was
being fortified.

The retrofit is two things:

- **A permission.** `message.export` on the mailbox, satisfied by a standing relation *or* by a supervised
  grant of scope `content`. The supervised arm is not a courtesy: an investigator who could read a body but
  not produce the original would be an investigator told to screenshot it.
- **A record.** `message.exported`, appended **before** any byte moves, for every download — not only
  supervised ones. `supervised.attachment` answers *who was let in*, keyed on the grant; this answers *what
  left*, keyed on the receipt. A holder of the ordinary relation produces exactly one entry and previously
  produced none.

### What this changed for people who already use the Node, said plainly

The route now requires a relation that did not exist yesterday. Every existing install keeps working because
`migrations/0025_ediscovery_export.sql` **backfills** `message.export` to every subject already holding
`mailbox.content.read` on the same mailbox, and `claimNode` grants it to a new Node's owner. Layer 1's own
proof is *"original `.eml` exportable"*, and shipping the check without the grant would have broken that
everywhere — a regression with a roadmap attached, which the ladder rule in `AGENTS.md` forbids outright.

What genuinely changes: an administrator can now revoke exporting **without** revoking reading, which was
not expressible before, and every download appears in the trail.

**The sibling door is still open and is named rather than half-closed.** `GET /api/sends/:id/submitted`
streams the submitted bytes of an outbound message, which is also a complete `.eml`, and it is not governed
by `message.export`. #65 ruled on the inbound route; the outbound one needs its own decision about what the
entry's subject is, because a manifest is not a receipt. It is listed under *Still not built* below rather
than fixed in passing.

---

## Where an export goes, and why three of the four candidates were impossible

Most of the design of the bulk act is a consequence of what this Worker **cannot** do:

- **Presigned URLs do not exist here.** The Workers R2 binding has no presign method at all.
- **Pushing to a customer destination is unreachable.** This Worker makes zero outbound `fetch()` calls.
- **There is exactly one bucket** — `EVIDENCE`, with no `bucket_name` in `wrangler.jsonc`.

So the reachable destinations are an object in that bucket or an HTTP response, and streaming to a response
was rejected on the budget: an export past one invocation's subrequests dies mid-stream leaving a partial
file, with nothing staged to resume from and no way to hash what was never kept.

```
${orgId}/exports/${exportId}/<receipt id>.eml   sealed with putEvidence (§12: an export at rest is encrypted)
${orgId}/exports/${exportId}/manifest.json      sealed the same way; its plaintext hash is the export's hash
download → GET /api/exports/:id/objects/:name, re-checking the grant on every object
```

**Mediating the download is what makes §7's *"revocation terminates export jobs"* enforceable rather than
asserted.** Nothing is presigned and nothing is cached, so revoking `ediscovery.export` stops the next page
of a run and the next object of a download. Bytes already downloaded stay downloaded — that is the honest
boundary, and no mechanism un-copies a file.

---

## The approval binds a hash **and** a count

§18 binds an approval to *"referenced artifact hashes"*, and #62 made the pre-execution recheck re-hash every
bound object. An export's target is a **query**, and a query has no version. That was the collision this
ticket had to resolve.

A predicate *can* be canonicalised and hashed — mailbox, date window, subject substring, in a fixed key
order. What it cannot do is bound what it **matches**: the same predicate returns more next week, so
approving a predicate alone approves an unbounded future disclosure with a recheck that passes cleanly.

`max_messages` closes that, and it **fails closed**:

- the run asks for **one message more** than its remaining bound;
- if that extra row comes back, the predicate matches more than two people agreed to;
- the run **aborts with nothing further staged** and needs a fresh approval.

It never truncates to the bound. A partial copy carrying a manifest that reads as a complete account of the
predicate's matches is the worst of the three available outcomes — worse than refusing, worse than exporting
too much — because it is the only one that misleads.

Enumerating message ids instead was rejected on two grounds: it inverts the ceremony, since the investigator
would have to read the mail to decide what to ask permission to export, and #63 measured the audit detail cap
at about **59** typed-prefix ULIDs per entry, so a large export's own approval would need paginating.

**The approvers see all of it before they decide.** `GET /api/approvals` carries the predicate, its hash and
the bound — a queue that showed only *"somebody wants an export"* would be asking them to agree to nothing in
particular.

---

## The run is a page at a time

blueprint:1276 requires outright that *"search, export, retention, reindex and migration use resumable
cursors/checkpoints"*. So the driver is a cursor over `(accepted_at, receipt id)`, stored on the `exports`
row, and one invocation copies one page.

**Resumability dissolves the plan arithmetic**, which is the nicest result in this ticket. A checkpointing
run does not need to know its budget in advance: it works until the budget is spent and continues in a fresh
instance. So Workers Free versus Paid changes **how many invocations** an export takes, not whether it
finishes. #68 — the budget key that names no plan — is filed and does not block this.

Three things are re-read before **every** page, none of them cached anywhere:

1. the requester still holds `ediscovery.export` on the mailbox;
2. the approval is still `approved`;
3. the stored predicate still hashes to what the approval bound (#62's recheck, applied to the one artifact
   an export has).

A page shorter than it asked for is the last page, so an ordinary export completes in the same invocation
that emits its final message.

### States

```
requested → running → completed
     ↘         ↘
       aborted (max_messages)
```

`requested` is also where a denied or undecided export sits: **a run in that state produces nothing at all**
— not fewer objects, not a partial file. There is deliberately no `approved_at` column, because the approval
*is* the authority and a copy on the row would still say yes after a withdrawal.

---

## The manifest, and the boundary it names

The manifest is its own sealed object listing every staged message with its plaintext SHA-256, plus an
`exports` row carrying the manifest's own SHA-256. **The hash is over the manifest plaintext**, never over
the sealed bytes: sealing uses a random nonce, so a hash over the sealed object could not be re-derived by
anybody verifying the export later. `ingress_receipts.blob_sha256` makes the same choice for the same reason.

It is built by paging one `R2Bucket.list()` over the export's own prefix, with `include: ["customMetadata"]`
so each object's hash comes back with the listing instead of costing a `get`. Where that paging stops is
where the boundary lives:

> `export.max_messages_ceiling = 1000`, derived from `r2.list_max_keys_per_call`.

A request above it is refused **when it is asked for**, naming both numbers, rather than discovered as a
short manifest after a long run. That is blueprint:1280 applied literally — *"Mailda exposes that boundary
rather than building an unreliable workaround"*.

**The build was a single call when #65 shipped, and could not have been.** A listing that asks for
`customMetadata` returns at most `r2.list_max_keys_with_metadata` keys — a hundred, measured — while the
ceiling authorized a thousand, so every export above a hundred messages staged all of its bytes and then
threw `E_EXPORT_MANIFEST_TRUNCATED` for ever: no manifest, no completion entry, a hundred-plus copies of
somebody's mail in R2, and a refusal blaming whoever authorized a bound the code itself had permitted.
Paging is not the workaround the blueprint clause warns about — the cursor is the documented way to finish a
listing, and the build is idempotent, so an invocation that dies mid-manifest leaves the export `running` and
the next one rebuilds it from R2. It costs `ceil(objects / 100)` subrequests once, at completion.

---

## What the trail carries, and what it deliberately does not

Two entries for a whole export, plus one for a refusal:

| action | when | carries |
|:--|:--|:--|
| `supervised.export_requested` | the approval completes | the predicate hash, the bound, the matter, the destination, both approvers |
| `supervised.export_completed` | the manifest exists | the manifest's SHA-256, the emitted count, the destination, the matter |
| `supervised.export_aborted` | the bound was exceeded | the bound, what had been emitted, the reason token |

**Not one entry per page.** Page progress lives in the `exports` row. One entry per page would put hundreds
of rows behind one decision and falsify `audit-and-log-retention.md`'s *"a handful per message"* sizing —
the same per-row-versus-per-act reasoning that already exempts `send_recipients`.

**Not one entry per downloaded object either.** The manifest is the list of what was staged and
`supervised.export_completed` names its hash, so an entry per object retrieved would be the same mistake at
the other end of the pipe. Named here rather than left for a reader to notice.

The third action is a small departure from #65's resolution, which enumerated the two entries a *successful*
export produces and did not rule on the refusal. `supervised.export_completed` with `outcome: "refused"` was
the alternative and was rejected: "completed" is not true of an aborted run, and a name that overclaims is
the defect `AGENTS.md` §4 exists to name.

---

## Cost: measured, and lower than the figure the design was sized against

`docs/receipts/ediscovery-export-cost.md` carries the full table. In short, per message:

| | without the run-scoped key cache | with it |
|---:|---:|---:|
| R2 `get`, R2 `put` | 2 | 2 |
| vault RPC — opening key, sealing key | 2 | 0 |
| **total** | **4** | **2** |

#65 costed this at **6** from the re-seal shape in `evidence-lifecycle.md`. The export measures 4, and the
two missing terms are real differences rather than a better implementation: it does not `head` the source
(a `get` returns the metadata anyway, and it writes somewhere else), and it advances **one checkpoint per
page** rather than one index row per message. So the resolution's capacity arithmetic was conservative by
50%, not wrong — and its claim about the cache is exactly right: caching removes 2, which here is a halving.

**The cache is scoped to one run and discarded with it.** The cost of caching a content key is staleness
against revocation, and confining it to one run bounds that at one run — which is already the unit the
export's approval authorizes. An isolate-wide cache was rejected despite a good precedent (`auth/keys.ts`
caches signing keys with its TTL reasoned explicitly as a staleness bound): it would make content-key
revocation eventually-consistent **product-wide** to speed up one feature.

---

## The reconciler learned about `exports/` on the day the prefix was created

#67's finding was a prefix nothing listed, and the cost of that was invisible **because nothing reported
it**. So `${orgId}/exports/` went into the scan in the same change that created it, with its own referent
rule — an `exports` row identified by the id in the key's second segment, so *"no receipt"* is not the test
and neither is *"no `drafts` row"*.

Adding the third prefix moved the arithmetic that protects the pass, and the assertion caught it rather than
starting to lie. For `n` prefixes the worst case a collecting pass can reach is
`(n + 2) × reconcile.list_limit + (2n + 2)`; at `n = 3` and a limit of 200 that is **1,008**, over the
Workers Free ceiling of 1,000. `docs/receipts/evidence-lifecycle.md`'s 20 August correction lowers the limit
to **150**, sized so the fourth prefix — already known to be missing — does not force a third re-derivation.

**An export is held if its source is held.** #64 makes a hold a predicate over a mailbox and a date range,
and an export is a copy of the same material, so a stranded export object is enumerated but **not swept**
while any hold stands in the organization. A hold deliberately does **not** refuse the export itself: a hold
is placed *for* a matter, and refusing the eDiscovery that matter exists to serve would make the two
mechanisms fight.

---

## Still not built, named rather than implied

- **Authentication strength, and device/IP.** §7 requires an export record to carry both, and this Node
  records neither, anywhere. **Step-up authentication** is likewise required for exports (blueprint:884) and
  does not exist. None of it is invented here: it is an authentication-subsystem question that supervised
  reading needs too, and it is bigger than this ticket.
- **`GET /api/sends/:id/submitted`** is a complete `.eml` and is not governed by `message.export`. See above.
- **`${orgId}/sent/` is unscanned by the reconciler** — #74. Found while putting `exports/` into the scan,
  filed with its evidence rather than repaired here, because its referent question — a `send_manifests` row,
  and what a composition-evidence object with no manifest means under §12 invariant 2 — is its own decision.
  The arithmetic for it is already paid: `reconcile.list_limit` came down to 150 in this change *because* a
  fourth prefix is known to be coming.
- **No download entry.** See *What the trail carries*.
- **No UI.** The shell is Layer 1–3's surface, exactly as for policy, approvals and supervised reading. An
  export is a governance act performed by an investigator with a matter already open.
- **No expiry on a staged export.** Objects stay until a hold-free reconciler collects them after their
  `exports` row goes, and nothing removes that row. A retention rule for exports is §14's question.

---

## Where things are

| | |
|:--|:--|
| `migrations/0025_ediscovery_export.sql` | the `exports` table, its three indexes, and the `message.export` backfill |
| `src/exports.ts` | the predicate and its hash, the request, the run, the manifest, the download check |
| `src/authz-read.ts` | `authorizeExport` (the `.eml` retrofit) and `mayExportBulk` |
| `src/approvals.ts` | `ediscovery_export` as the fourth subject kind, and its completing effect |
| `src/reconcile.ts` | the `exports/` prefix and its referent rule |
| `src/access.ts` | `message.export` and `ediscovery.export` in the relation registry |
| `test/ediscovery-export.test.ts` | the behaviour: manifest, bound, revocation, hold, no approval, `.eml` |
| `test/export-cost.measure.test.ts` | the per-message cost, with and without the cache |
| `docs/receipts/ediscovery-export-cost.md` | the measurement and the two derived figures |
| `docs/receipts/r2-list-page-size.md` | the listing cap the manifest boundary is derived from |
