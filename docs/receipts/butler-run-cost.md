---
id: butler-run-cost
kind: measured-tripwire
measured_on: 2026-08-21
stale_when: >
  a node's implementation gains or loses an I/O operation; the engine's fixed overhead changes, meaning the
  three statements listed below become two or four; `sealManifest`, `readDraft`, `claim`, `close` or
  `saveDraft` gains an operation, since every figure here is one of those plus what the engine adds around it;
  the run record stops riding in one `batch()` with the effect that caused it; the vault key fetches become
  cached, which would remove one to two subrequests from every evidence read and write; or
  `butler-step-cost.md`'s figures are re-measured, since the whole point of these is the difference between
  the two
values:
  butler.run_cost_max_draft: 10
  butler.run_cost_max_send_propose: 28
  butler.run_cost_max_case_assign: 10
  butler.run_cost_max_case_close: 4
  butler.run_cost_max_lookup: 4
  butler.run_cost_engine_fixed: 3
---

**Measured:** `test/butler-run-cost.measure.test.ts`, in the real `workerd` runtime against a real D1, R2 and
KeyVault, using `src/cost-meter.ts` — the same instrument `butler-step-cost.md` used, driving the real
`interpret` over real published `butler_versions` rows.

## The finding, first, because it is worth more than any number here

`butler-step-cost.md` priced the four **functions** a Butler node calls, before an engine existed to call
them. #54 then built a publication-time refusal on those figures. This is the first measurement of the
**nodes**, and a node is strictly more than its function:

| node | `butler.step_cost_max_*` (the function) | measured as a node | difference |
|:--|--:|--:|--:|
| `draft` | 10 | **6** | fits |
| `case.assign` | 8 | **7** | fits |
| `case.close` | 3 | **2** | fits |
| `lookup` | 4 | **2** | fits |
| `mail.send.propose` (a reply) | 20 | **23** | **+3 over** |

Four of the five fit inside the headroom their bounds already carry. The fifth does not, and
`butler-step-cost.md` predicted exactly this in as many words: *"One figure has no headroom left and that is
worth saying twice… It is one operation away from being permissive."* It was three operations away, and the
operations are not in the seal — they are the engine's, around it.

**What that means for #54's refusal, stated plainly: the publication-time total is a floor, not a total.** A
whole-graph comparison on the same AST:

| AST | checker's prediction | measured run | difference |
|:--|--:|--:|--:|
| `draft` → `mail.send.propose` (a reply) | 30 | **32** | +2 |
| `transform` → `case.assign` → `case.close` | 11 | **12** | +1 |
| `lookup` alone | 4 | **5** | +1 |
| `stop` alone | 0 | **3** | +3 |

At this size the gap is a rounding error. **At loop scale it is not.** A `foreach` of 500 sends prices at
exactly 10,000 — the whole Paid pot — and really costs `500 × 23 + 3 = 11,503`, so the instance would be
killed at about item 434 **having already sealed 434 manifests**. That is precisely the failure #54 exists to
prevent, arriving through the difference between a function and a node.

## What is done about it, and what is deliberately not

**Not done:** #54's arithmetic is not quietly changed. Its figures are correct measurements of the functions
they name, its receipt is the thing that would have to move, and editing a closed ticket's numbers from
inside another ticket's work is how a receipt stops describing what it says it measured. The disagreement is
recorded here and pinned by a test, so a later re-measure of `butler-step-cost.md` starts from the real
number rather than rediscovering it.

**Done:** the engine **meters itself** and refuses an effect it cannot afford, reserving the figure from this
receipt rather than from that one. `src/butler/interpret.ts` wraps its env in `src/cost-meter.ts`, carries the
running total on `butler_runs.subrequests_spent` across invocations, and stops with `budget_exhausted` before
the effect that would overspend — with AGENTS.md §3's four parts in the operational log. So the 500-send loop
above stops at item 434 with a refusal a person can read, instead of dying with 434 sends performed and
nothing saying why.

The publication-time forecast stays as a cheap pre-check — `priceButler(nodes).total +
butler.run_cost_engine_fixed`, costing no subrequest — and catches the boundary case where a graph priced at
the whole pot cannot even pay for the engine. It is a floor and the live guard is the enforcement; that split
is stated in the file rather than implied.

## Observed

| Measurement | Subrequests | notes |
|:--|--:|:--|
| engine fixed (a `stop`-only Butler) | **3** | 3 D1, of which 1 is a `batch` |
| `draft` node | **6** | `saveDraft` at 5 plus its record batch |
| `mail.send.propose` node (a reply) | **23** | decomposed below |
| `case.assign` node | **7** | the authority query, `claim` at 5, the record batch |
| `case.close` node | **2** | the authority query and the record batch; `close` itself refused here |
| `lookup` node (a message) | **2** | the bounded read and the record batch |
| the whole `draft` → `propose` run | **32** | 22 D1 (4 batches), 5 R2, 5 vault RPCs |
| the trigger, per delivery, one published Butler | **3** | 2 D1 and one `create` |

The per-node figures are the whole-run measurement minus the engine's fixed three, and — for the second node
of a two-node graph — minus the first node's figure. Isolating them that way rather than by instrumenting the
interpreter internally is deliberate: what a node costs is what a *run containing it* costs more than a run
without it, which is the quantity the pot is actually spent in.

### Where the engine's three go

1. **One `batch()`** that reads the version's `ast_json` and inserts the `butler_runs` row. A read and a
   write for one round trip, which is what D1 does and what the meter prices it as.
2. **One read** of `butler_runs.subrequests_spent`, per **invocation**. Deliberately not inside a `step.do`:
   a cached step would return the first invocation's figure for ever, and that is the one value that must
   not be cached.

   **Amended 21 August 2026 (#75): this statement now also asks whether the run's Butler is paused**, as three
   more scalar sub-selects. The figure is unchanged — still one statement, still `butler.run_cost_engine_fixed
   = 3`, re-measured at 3 in `test/butler-pause-cost.measure.test.ts` — and the reason the question was put
   *here* rather than anywhere else is the sentence above it: a per-invocation read that must not be cached is
   exactly what a run resuming from a thirty-day sleep needs, and #75's pause has to reach an instance that
   was already in flight when it was placed.
3. **One write** of the terminal state and the counts.

**Amended 21 August 2026 (#53): a run that is a *replay* pays one more, and the figure below is unchanged.**
The extra is the single statement that reads the replayed run's sends so the content rule can reuse their
idempotency keys, issued once per invocation on the replay path only. It is not a measurement and gets no
value here — it is `1` because it is one statement, which is AGENTS.md's own exemption for a number that means
none or one. `butler.run_cost_engine_fixed` stays **3**, pinned as an equality for an ordinary run and
re-measured as 3 by `test/butler-run-cost.measure.test.ts` and `test/butler-pause-cost.measure.test.ts`.

The read is deliberately in the engine rather than inside `mail.send.propose`, and that placement is what keeps
this receipt's per-node figures true: asking the question per send node would have made a replay's send cost one
more than `butler.run_cost_max_send_propose` reserves for it, which is the guard reserving too little for
exactly the node it matters for. On a replay whose content is identical the node costs **less** than the figure
below, because it seals nothing at all — no R2 writes, no vault key, no manifest transaction.

`draft` on a replay pays one more than the **6** measured below, against its bound of 10: `drafts_one_per_reply`
forbids a second reply draft by the same author to the same message, so a replay resumes the draft it already
wrote and one scalar read is what finds it.

A run that sleeps or parks pays (2) again on each resume. That is why the *fixed* figure is per invocation
while the *guard* is per instance: the pot is per instance (`workflow.budget_unit_is_instance = 1`, measured),
a resumed instance gets a fresh meter, and whether the platform's pot resets with it is **unmeasured** — so
the accumulated column enforces the stricter of the two readings. Over-counting refuses a run that would have
fitted; under-counting kills one that has already sent mail.

### Where the engine's per-node additions go

- **Every effect node: one `batch()`**, carrying the `butler_run_effects` row, the accumulated spend, and —
  for a send that parks — the park. Three statements, one subrequest. The alternative, batching every effect
  row at the end of the run, is one subrequest for all of them and leaves a killed invocation with a record
  of nothing, which is the state that table exists to prevent.
- **`case.assign` and `case.close`: one query**, checking the **Butler's own** `send.propose` on the case's
  mailbox and reading the case in the same statement. `claim` checks the *assignee's* authority, which is
  right for a person clicking Reply and not enough for a program — without it a Butler holding nothing
  anywhere could assign any case in the organization to anybody who may work it. Folded into one statement
  rather than a `maySend` call beside a case read, which would have been three.
- **`mail.send.propose`: 23, decomposed by measurement rather than by reasoning.**

  | part | subrequests |
  |:--|--:|
  | `readDraft` — a row read, an authority re-check at 2, an R2 get, a vault opening key | **5** |
  | `sealManifest`, a reply, no policy published | **16** |
  | the record batch: effect row + accumulated spend + park, one round trip | **1** |
  | un-parking the run when the release arrives | **1** |

  Two of `readDraft`'s five are a second read of a relation `sealManifest` checks again a moment later, and
  they are kept: §7 wants authority re-read per operation, and a second read path for drafts would be a
  second thing to keep in step with the first. It is the largest single item and the one to attack first if a
  Butler ever needs a cheaper send.

  The last row belongs to the **release gate** rather than to the node, and the subtraction above attributes
  it here because this node is what parks. Stated rather than hidden, because it is the one part of the
  figure that a Butler with no proposed send never pays.

  **And the seal is not where the difference from `butler-step-cost.md` comes from either**, which is worth
  saying because it was the obvious hypothesis and it is wrong: a reply seals at 16 here against that
  receipt's 14, measured against the same shape of fixture. Attribution of *that* two belongs to whoever
  re-measures that receipt; what is settled here is that the node's extra 3 over its 20 is `readDraft`, the
  record and the resume, not the seal growing under it.
- **`lookup`: nothing.** The bounded read *is* the node, and the tuple check is a subquery inside it rather
  than a second round trip — which is what `butler-step-cost.md`'s headroom of 4 against a measured 1 was
  reserved for, in its own words, *"an authority re-check at authz.check.max_queries=2"*.

## Sized

Bounds with headroom, not the measured figures, for the reason `butler-step-cost.md` gives: an equality
assertion on an I/O count fails on every harmless refactor and gets deleted, and these exist to catch a node
becoming an order of magnitude dearer.

- `butler.run_cost_max_draft = 10` — measured 6.
- `butler.run_cost_max_send_propose = 28` — measured 23. The headroom is deliberately the largest here
  because this figure is the one that decides a sending loop's bound: at 28 the Paid pot buys 357 sends,
  against 434 at the measured 23 and 500 at #54's 20. Sized above the measurement rather than at it, because
  this is what the *runtime guard* reserves and a guard that refuses one send too late has already sent it.
- `butler.run_cost_max_case_assign = 10` — measured 7.
- `butler.run_cost_max_case_close = 4` — measured 2.
- `butler.run_cost_max_lookup = 4` — measured 2, and left equal to the step figure because the node and the
  function are the same operation.
- `butler.run_cost_engine_fixed = 3` — **measured 3 and pinned as an equality**, because it is not a
  measurement of anything external: it is a count of three statements in `src/butler/interpret.ts`, listed
  above. A bound with headroom would be a tripwire on our own arithmetic, which is what a test is for.

**Cost if wrong, in the permissive direction:** a run empties its instance's pot and the platform kills the
invocation wherever it is, after the effects it has already performed — sealed manifests with no record of
what was going to happen next. That is the exact shape `butler-step-cost.md` describes and the reason both
the publication refusal and the runtime guard exist.

## What is deliberately not here

**CPU**, for `butler-step-cost.md`'s reason: it cannot be metered from inside a Worker at all
(`authz-check-rows-read.md` records `performance.now()` reporting `p50 = 1.000 ms` for every scenario,
including the pathological one). Which limit binds first for a Butler run — CPU or subrequests — is still
unestablished, and it matters more here than it did there, because a `foreach` whose body performs no I/O
costs **zero** subrequests at any bound and is therefore admitted by every check in this system. Such a loop
runs until the platform kills the step. Named rather than bounded: an iteration ceiling would be a number
with no measurement behind it.

**The cost of a run through the real Workflow engine rather than through `interpret` directly.** Measured
incidentally at **30** for the acknowledgement graph in `test/butler-run.test.ts` — read off
`butler_runs.subrequests_spent`, which is written at the last effect and so excludes the terminal write — and
not recorded as a value, because it is the same code under a different caller and the two agreeing is what
that test asserts rather than what this receipt measures.

## Correction — 21 August 2026: the three-term intersection joined every node's authority check (#51)

`stale_when`'s first clause — *"a node's implementation gains or loses an I/O operation"* — **fired**. #51's
decision 4 makes a Butler's effective authority

    effective(step) = pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor

where before there was one term, the Butler's own tuples, folded into a statement each node was already
issuing. So every node that touches a mailbox now pays for two more terms, and the clause said to re-measure
rather than to reason. It was re-measured before anything shipped.

**Every value above is unchanged, and that is the finding rather than a relief.** Each node's measurement
went up by exactly the two round trips #51 derived, and every one of them was already inside its bound. The
frontmatter is therefore untouched — the idiom this file already uses for a clause that fired and was
answered without moving a number — and the clause a future reader needs is the one that is already there,
read with this correction beside it: **a node's I/O count now includes the intersection**, so re-measure the
day `effective(step)` gains or loses a term as well as the day a node gains an operation.

**Measured:** `test/butler-run-cost.measure.test.ts`, unchanged instrument — `src/cost-meter.ts` in the real
`workerd` runtime against real D1, R2 and KeyVault, driving the real `interpret` over real published
`butler_versions` rows.

| node | before #51 | measured now | bound | headroom |
|:--|--:|--:|--:|--:|
| `lookup` (a message) | 2 | **3** | 4 | 1 |
| `case.close` | 2 | **3** | 4 | 1 |
| `case.assign` | 7 | **8** | 10 | 2 |
| `draft` | 6 | **8** | 10 | 2 |
| `mail.send.propose` (a reply) | 23 | **25** | 28 | 3 |
| engine fixed (a `stop`-only Butler) | 3 | **3** | 3 | pinned |
| the trigger, per delivery, one published Butler | 3 | **3** | — | — |

Whole-run figures, against the checker's own prediction for the same AST:

| AST | prediction | before #51 | measured now |
|:--|--:|--:|--:|
| `draft` → `mail.send.propose` (a reply) | 30 | 32 | **36** |
| `transform` → `case.assign` → `case.close` | 11 | 12 | **14** |
| `lookup` alone | 4 | 5 | **6** |

### Why some nodes grew by one and others by two, which is the part worth reading

The intersection is **two queries** — #51 derived it and this measured it — but only the second is always
new:

1. **The sponsor's subjects**, through `readableSubjects`. One query, every check, no exceptions.
2. **The ceiling and both tuple terms in one statement.** For `lookup`, `case.assign` and `case.close` that
   statement is the one the node was already issuing, with a sub-select and a second `EXISTS` folded in — so
   those nodes grew by **one**, not two. For `draft` and `mail.send.propose` the mailbox is named rather than
   discovered, so the check is a statement of its own and they grew by **two**.

**The ceiling itself costs nothing**, which is the first half of #51's derivation and is what the equality on
`butler.run_cost_engine_fixed = 3` proves: it lives on the version row the run already loaded to get its AST,
and the addresses it declares are resolved by a sub-select inside a statement that was already being made.
The three statements that figure counts are the same three.

### The decomposition of the send node, re-measured

| part | subrequests |
|:--|--:|
| `readDraft` — a row read, an authority re-check at 2, an R2 get, a vault opening key | **5** |
| **the three-term intersection (#51)** | **2** |
| `sealManifest`, a reply, no policy published | **16** |
| the record batch: effect row + accumulated spend + park, one round trip | **1** |
| un-parking the run when the release arrives | **1** |

The 2 is asserted as an equality rather than a bound in that test, because #51 derived two round trips and a
third arriving here is the N+1 `authz.check.max_queries` exists to catch.

### What this does to a sending loop, stated because it is the only figure that moved for a user

A `foreach` of sends is bounded by the runtime guard, which reserves `butler.run_cost_max_send_propose = 28`
and is **unchanged**, so the guard still permits **357**. What moved is the arithmetic beside it: the
affordable count at the measured figure falls from 434 to **399**, because a send now costs 25 rather than 23.
Publication still admits 500 — the floor is still a floor, and the gap it names is now wider by 35 sends,
which is the direction that matters least because the runtime guard is what actually stops the run.

### What is deliberately not re-sized

Nothing. Every bound already carried enough headroom for the growth, and raising one because the measurement
moved *inside* it would be widening a tripwire nothing touched. `butler.run_cost_max_case_close` and
`butler.run_cost_max_lookup` now sit one above their measurement, which is the thinnest margin in this file
and is recorded here rather than quietly absorbed: the next operation added to either of those nodes lands on
the bound, and the honest response then is to re-measure and re-size rather than to discover it at a refusal.
