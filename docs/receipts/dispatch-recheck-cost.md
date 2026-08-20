---
id: dispatch-recheck-cost
kind: measured-tripwire
measured_on: 2026-08-20
stale_when: >
  the recheck gains or loses a subject — a seventh withholding reason, or an envelope member that needs its own
  read; getEvidence stops costing one R2 get plus one vault RPC, which is what makes the two body hashes four
  subrequests; the vault starts caching an opening key across two reads in one invocation, which would take two
  of them off; policy evaluation changes how many derived inputs it fetches (policy-evaluation-cost.md owns
  that figure and this one contains it); a D1 batch() stops being one round trip; the unapproved path gains any
  read at all, which is the whole asymmetry #62 decided; dispatch stops being its own invocation and moves onto
  the Butler step path, which is where #62 expected it and is not where it landed; or somebody asks for
  per-policy approval expiry, which would make the deadline a policy column and this file's sized constant its
  default
values:
  send.dispatch_approved_max_subrequests: 28
  send.dispatch_unapproved_max_subrequests: 20
  approval.send_expiry_seconds: 345600
---

**Measured:** `apps/node/worker/test/outbound-recheck.test.ts`, in the real `workerd` runtime against a real D1
and a real R2, counted with `src/cost-meter.ts` — which counts **executions** rather than `prepare`, prices a
`batch()` as the one round trip it is, and sees Durable Object RPCs. Not counted by reading: this repository has
had a read-off count be wrong three times this month in ways only execution revealed, and #62's own prediction
is the fourth (see below).

## Observed

Both rows are `dispatchOne` end to end — the manifest read, the checks, the claim, the render, the transport and
the terminal state — so they are comparable and the difference between them **is** what the recheck costs.

| Scenario | Subrequests | D1 executions | batches | R2 ops | DO RPCs |
|:--|--:|--:|--:|--:|--:|
| unapproved send, handed over (ADR 39's authority re-check only) | **16** | 12 | 1 | 2 | 2 |
| approved send, every check passes, handed over | **24** | 16 | 1 | 4 | 4 |
| approved send, refused at the first check (`approval_revoked`) | **6** | 6 | 1 | 0 | 0 |
| the shipped adapter's capability read, `EMAIL` bound | **1** | 1 | 0 | 0 | 0 |
| the shipped adapter's capability read, no `EMAIL` binding | **0** | 0 | 0 | 0 | 0 |

**The recheck costs 8 subrequests, and 9 on a Node running the shipped adapter.** The unapproved path costs
**0** for it.

The eight, named, because a total nobody can break down is a total nobody can dispute:

1. the approval of this manifest, through `apr_subject`;
2. its decisions — who approved, who withdrew — one read serving both the revocation check and the eligibility
   check;
3. the `approval.decide` holders on the mailbox, teams resolved and people de-duplicated (`decidersOf`);
4. the current policy's published versions (`evaluate`, with no derived condition in play here —
   `policy-evaluation-cost.md` owns the one-to-three range and this figure contains its floor);
5. the typed body — one R2 get;
6. its opening key — one vault RPC, uncached by design;
7. the normalized body — one R2 get;
8. its opening key — one vault RPC.

The **ninth** is the transport capability, and it is 9-on-a-deployed-Node rather than 9 here because every
dispatch test uses a fake transport whose `capability()` performs no I/O. The shipped adapter reads
`node_capabilities`, measured at exactly **1** with an `EMAIL` binding and **0** without one — both measured
in the same file rather than reasoned about, because "it depends on the binding" is the kind of claim that turns
out to be about something else.

**Free, and worth saying why:** the manifest row, because ADR 39's authority check was already reading it and
`ENVELOPE_COLUMNS` only widens that `SELECT`; deciding *which* path a send is on, because it is a comparison on
`policy_outcome` in that row; and the withholding itself, because the audit entry, the manifest update and the
recipient update ride in one `batch()`.

**A refusal costs 6, less than a third of a pass**, because the two body hashes are checked last: a send that
is already refused pays no R2 operation and no vault RPC at all, and `submitClaimed` never runs. That is the
whole reason the check order is what it is.

## The audit detail fits, measured, because a truncation would take the reason with it

The `send.withheld` entry carries the envelope's record form: **1,372 bytes** against
`audit.max_detail_bytes = 2048`. Measured in the same file, because `boundedDetail` replaces an over-cap detail
**wholesale** with a truncation record — so an envelope one field too large would delete the reason as well as
itself, silently. That is why the record carries ids, hashes, counts and header *names* rather than addresses,
subjects or bodies.

## #62's prediction, checked, and it does not hold — in two different ways

The ticket predicted *"~6 extra subrequests"*, and that making the recheck universal *"would take a Butler's
`mail.send.propose` from ~10 to about 16, cutting a run from ~500 sends to ~310"*.

**The magnitude is wrong: the measured extra is 8, or 9 on a Node that can send.** The prediction was counted by
reading and under-counted in two places at once. It priced the two body hashes at *"≈6 subrequests — R2 get
plus a vault RPC each"*, which is **4**; and its prose figure of 6 does not even agree with its own table, which
lists 1 query for approval validity, 2 for approver eligibility and up to 3 for policy — 6 before the hashes are
counted at all. The two halves of one resolution disagreed by roughly a factor of two, in opposite directions,
and neither was the answer.

**The location is wrong, and that matters more.** `mail.send.propose` is the **seal** —
`butler-step-cost.md` measures `sealManifest` — and the recheck is in `dispatchOne`, which runs from the
`OutboxSweeper` alarm or from `POST /api/sends/dispatch`. That is a **separate Worker invocation with its own
subrequest budget**, so the recheck spends nothing from a Butler step's pot and `butler.step_cost_max_send_propose`
does not move. `butler-step-cost.md` names *"#62's dispatch-time recheck landing on the same path"* as one of the
things that would force its bound up; it did not land there, and that receipt now says so.

**What the figure actually bounds** is how many sends one dispatch invocation can carry. `dispatchDue` takes at
most 20 manifests per sweep, so a sweep is 20 × 16 = 320 subrequests of unapproved sends, or 20 × 24 = 480 of
approved ones and 500 on a Node running the shipped adapter — all three
inside the 1,000-per-invocation ceiling on Workers Free and far inside the 10,000 on Paid
(`doctor-check-cost.md` owns those two figures). So the honest statement is: **the recheck does not threaten
today's sweep, and it halves the headroom for raising the sweep's limit on Free.**

**The decision the prediction was drawn for stands, on better evidence than the prediction had.** Eight to nine
subrequests and two SHA-256 passes over real bytes, on every send rather than on the ones somebody asked for
assurance about, is a 50% increase in what a dispatch costs to buy a guarantee nobody requested. That is the
argument; it did not need the Butler arithmetic, and the Butler arithmetic was not true.

## Sized

Both cost figures are **bounds with headroom, not equalities**, for the reason `butler-step-cost.md` states: an
equality assertion on an I/O count fails on every harmless refactor and gets deleted, while a bound catches an
operation becoming an order of magnitude more expensive.

- `send.dispatch_unapproved_max_subrequests = 20` — measured **16**. **This is the load-bearing one.** A future
  reader who "tidies" the two paths into one puts the recheck's 8 operations on every send, taking this row to
  24, and the bound is what fails. Four subrequests of headroom is enough for an ordinary change to the dispatch
  path and not enough to hide the recheck.
- `send.dispatch_approved_max_subrequests = 28` — measured **24** in the harness, **25** on a Node running the
  shipped adapter. Headroom for the derived policy conditions, which add up to two more when a live policy
  constrains them (`policy-evaluation-cost.md`), and nothing beyond that: a new envelope member that needs a
  read of its own is meant to fail this and land in the `stale_when` above.

## `approval.send_expiry_seconds = 345600` is sized, not measured

Four days. **There is no measurement behind it and that is deliberate**, in the same way and for the same reason
as `send.hold_window_default_seconds` in `cloudflare-email-sending.md`: it is a statement about how long a human
decision stays good, and no measurement of this system could settle it. Recorded here so a reader does not
conclude the receipt rule was skipped.

What it trades off, in both directions:

- **Long enough that a real approver is not defeated by a weekend.** A send proposed at 18:00 on a Friday and
  approved at 09:00 on the Monday is 63 hours; add one public holiday and it is 87. Four days clears both. An
  expiry that fires on legitimate mail is a tripwire a good widget touches, which AGENTS.md says makes the
  tripwire wrong rather than the widget.
- **Short enough that an approval is not a standing permission.** An approval is bound to exact bytes, and one
  that stays good for a month is closer to a grant than to a decision — which is what §18's expiry field is in
  the envelope for.

**Per-policy expiry was rejected for now, and is the named refinement if somebody asks.** #60's policy object
has no expiry column, and adding one with this ticket would invent a governance dimension no ticket has
decided — #60's own governing failure, a condition backed by no interface. The refinement, when it is asked
for: a nullable column on `policy_versions`, folded by **minimum** over the matching versions rather than by
maximum, because narrowing has to run one way and the shorter deadline is the stricter rule; this constant
becomes the default for a version that names none.

**It is enforced in exactly one place** — the recheck — and nothing sweeps for lapsed approvals, so a deadline
passing is not an event but a fact the recheck reads. `GET /api/approvals` carries `expires_at`, which is what
keeps "nothing sweeps it" from meaning "nobody can tell": the person being asked sees the deadline before they
answer.

## Miniflare, not a deployed Node

Measured under `vitest-pool-workers`, whose D1 is a local SQLite and whose R2 is local. So what is measured is
the **number of operations Mailda performs**, which is exactly what the subrequest budget is spent in — not
their latency, and not a deployed Node's behaviour. `approval-decision-cost.md`, `policy-evaluation-cost.md`
and `doctor-check-cost.md` draw the same line for the same instrument. **No deployed measurement is claimed
here**, and the one place the harness differs from a deployed Node in *operation count* — the fake transport's
free capability call — is named above rather than folded into the total.

## Correction — 20 August 2026 (#66)

**Two `stale_when` clauses fired at once, and one of them is the sentence this receipt was proudest of.**

*"a seventh withholding reason"* — `domain_paused` is it. And *"the unapproved path gains any read at all,
which is the whole asymmetry #62 decided"* — it did.

Re-measured in the same test, same instrument, same runtime:

| Scenario | Was | Now |
|:--|--:|--:|
| `dispatchOne`, unapproved, handed over | 16 | **17** |
| `dispatchOne`, approved, handed over | 24 | **25** |
| `dispatchOne`, approved, refused at the first check | 7 | **7** |
| recheck delta | 8 | **8** |

**No value in this file changed.** `send.dispatch_unapproved_max_subrequests` is 20 and
`send.dispatch_approved_max_subrequests` is 28, so the headroom on the cheap path narrows from 4 to 3 and on
the expensive path from 4 to 3. Recorded rather than quietly raised, which is what the bound is for.

### Why the asymmetry survives a read landing on the cheap path

#62's asymmetry is about **what an approval pays for**: the eight subrequests of approval validity, approver
eligibility, live policy and two body hashes are assurance somebody asked for, so they run only where somebody
asked. A circuit breaker is not assurance about *this send* — it is a fact about **this Node's own rate and
this Node's own sending domain**, and a breaker that fired only on approved sends would be a governance
control that a Node with no `require_approval` policy never had. So it runs on both paths, and the asymmetry
it does not touch is the one that was decided.

The single read is deliberate and measured: every question the breakers ask — the volume count, both bounce
counts, both complaint counts and whether this domain is paused — is a scalar sub-select inside **one**
`SELECT`. Four statements would have taken the cheap path to 20 and consumed this receipt's entire headroom in
one ticket. Detail and the per-scenario figures: `send-breakers.md`.

The recheck delta is unchanged at 8, which is the number this receipt exists to hold: the breaker read sits
*outside* it, before the branch, so making the recheck universal still costs the same half-again it always
did.
