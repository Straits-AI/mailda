# The Butler engine

How a published Butler runs (#50, Layer 4, blueprint §16). The AST, the checker and the draft-publish
lifecycle are [`docs/butler-ast.md`](./butler-ast.md)'s; this is what executes one.

---

## One generic Workflow class, and why that is the whole design

`ButlerRun extends WorkflowEntrypoint` — **one class for every Butler on the Node**, handed
`{ orgId, butlerId, butlerVersionId, trigger }` and interpreting whatever `ast_json` it reads.

That is forced rather than chosen. #49 made publication the versioning event with no deploy anywhere in the
lifecycle, and a Workflow class is code in a bundle — so a class per Butler would have made publishing one
require a deploy. Three consequences fall out of the generic form and each is worth more than the tidiness:

- **Retiring or deleting a Butler leaves no residue.** `workflow-provisioning.md` measured that deleting a
  Worker leaves its workflow behind and it takes `wrangler workflows delete` to remove it — the same
  asymmetry the R2 reconciler and the Queues subscription already have. With a class per Butler, every
  published Butler would have left one orphaned account-level resource behind it for ever, invisible to the
  Worker. There is exactly **one** workflow no matter how many Butlers come and go, and the only thing a
  teardown has to name is the Node's own.
- **An in-flight run survives a publication.** The payload names a *version*, so a run that started under v3
  goes on reading v3's frozen AST while v4 is live.
- **A Butler with no channel is still runnable.** Nothing about the run is compiled, so the day an authoring
  route exists, nothing here changes.

### Where the code is

| file | what it owns |
|:--|:--|
| `src/butler/run.ts` | the `WorkflowEntrypoint`. Four lines and an adapter — see below |
| `src/butler/interpret.ts` | the walk: load, re-check, forecast, interpret, close |
| `src/butler/effects.ts` | the five nodes that touch storage, each calling what a human calls |
| `src/butler/expr.ts` | the expression language and the JSON Schema subset `validate` honours |
| `src/butler/authority.ts` | reading storage as a Butler: one bounded query per read |
| `src/butler/principal.ts` | what a Butler *is* to every path that takes a principal |
| `src/butler/gate.ts` | the human-release gate: the one send state this layer adds |
| `src/butler/trigger.ts` | what starts a run, and the instance id that dedups it |
| `src/butler/release.ts` | the human half of the gate |
| `src/butler/record.ts` | the run record in D1 |

**The entrypoint is four lines and the interpreter is a function**, because `run()` receives `this.env` from
the platform while `metering()` wraps an env a *caller* passes in. An entrypoint that did the work could
never be measured — and this layer's cost is exactly the thing #54's arithmetic has to be checked against.
The same seam lets a test drive `wait` and the release gate without waiting for either.

---

## A Butler's principal is the Butler

`principal.userId` is the `btl_<ulid>` from `butlers.id`. Not a person, not the publisher, not the Node.

This is the decision with the most reach in the whole layer, because a Butler is the first **non-human**
caller of `maySend`, `sealManifest`, the policy plane's `actor` condition, the approval planner's actor
exclusion, and the audit chain. Getting it wrong in the permissive direction means a Butler doing something
no human could authorise.

Why not the publisher, which is the obvious alternative:

1. **It grants everything that person can do, for ever.** A published version is immutable and a tuple is
   not, so §16's own guarantee — *"new grants do not silently expand a published Butler"* — would be false
   the moment anybody granted that person anything.
2. **It puts a person's name on mail they never composed and never saw.**
3. **It excludes a real human from a gate they never asked for.** The approval planner excludes the actor
   from deciding their own request, so publishing a Butler would silently remove that person from the
   approver pool for every send it ever proposes. With the Butler as actor, every human decider stays
   eligible — which is what a Butler's proposal *wants*.
4. **A policy could not tell a Butler's send from that person's own.** The `actor` condition compares
   `actorUserId`, so *"anything a Butler proposes requires approval"* is expressible only this way. That
   single rule is the governance lever this layer needs, and it costs nothing.

**Authority attaches to the `btl_`, attribution names the `btv_`.** A tuple granted to a version id would
lapse on the next publish; and `audit_by_actor` is indexed on `(org_id, actor_user_id, at)`, so a Butler id
as the actor makes *"every effect this Butler has ever had"* one index scan across its whole version history.

**It fails closed and it costs the schema nothing.** `relationship_tuples` has no row for a `btl_` until an
administrator writes one, and authority is re-read per call — so a published Butler can do nothing at all
until it is granted something, and revoking stops it on the next node. `0001_init.sql` has no `subject_type`
column by design (identifiers are typed-prefix ULIDs) and `grant` validates the *object*, never the subject,
so this needed no migration.

**The audit trail says `actor_kind = butler`**, and that is derived from the id's own prefix rather than
passed by each call site. `node` and `installer` exist as kinds because they have **no id**; a Butler has
one, so `kindOfActor` in `src/audit.ts` reads it. That is what makes attribution structural: every Layer 5
function a Butler calls takes an `actorUserId` and knows nothing about Butlers.

**§16's six ownership kinds are still not built and this is not them.** `metadata.owner` stays an opaque
string. This is the *runtime* identity — whose tuples are checked and who the effects are attributed to —
which is a different question from who owns the program.

---

## The interpreter, in the order it runs

1. **Load.** One `batch()` reads the version's `ast_json` and inserts the `butler_runs` row: a read and a
   write for one round trip. Inside a `step.do`, so a resumed instance pays for neither again.
2. **Re-check.** `checkButler` over the stored AST. Costs no subrequest and re-establishes everything
   publication established.
3. **Forecast.** The checker's own price for the graph plus the engine's fixed overhead, against one
   instance's pot. Refuses before any effect.
4. **Walk** from `entry`, one edge at a time.
5. **Close** with a terminal state, a reason and the counts.

### What is a step and what is not

A `step.do` per node that performs I/O — the four effects and `lookup`. **Nothing else.** That is the line
`butler-step-cost.md` already draws: `guard`, `switch`, `map`, `foreach`, `join`, `wait`, `stop`, `transform`
and `validate` cost **0** subrequests, so wrapping them would buy a durable record of arithmetic and pay for
it in step storage.

That is only sound because the expression language is **pure** — it reads the run's state and nothing else,
with no clock, no randomness and no I/O. A Workflow re-runs the whole body on every resume and replays cached
step results, so a pure node recomputes to the same answer. A node that read `Date.now()` would give two
answers across a sleep and the run would take a different edge on either side of it.

Step names are `<nodeId>#<visit>`, because a loop enters the same node many times and Workflows key a step by
name and occurrence. The counter comes from the walk, which is the same walk on every replay.

### Replay safety, which is where the bookkeeping lives

Anything inside `step.do` happens once per **run**; anything outside it happens once per **invocation**. So
the D1 write of an effect row is inside — it is the durable record — and the in-memory counters and the
effect list are **outside**, rebuilt from scratch on every replay. A run that resumed after a sleep would
otherwise close with a count of the effects performed since the sleep and no others.

### Terminal states

| state | means |
|:--|:--|
| `finished` | the graph ran out of nodes |
| `stopped` | a `stop` node ended it, or a release gate timed out — the reason says which |
| `refused` | **the run stopped itself**: the stored AST no longer checks, a `validate` did not hold, its version is no longer published, or it could not afford to go on |
| `failed` | a fault: an unresolvable path, a schema this engine cannot honour, a loop over more items than its bound |

A *policy* denial, a breaker, an unsatisfiable approval, a held case — none of those is any of the above.
They are recorded per effect and the run carries on, because **being refused is the system working**.

---

## The expression language, in full

Three forms and nothing else. Small enough to be analysable matters more here than expressive enough to be
convenient, because #52's taint checker has to understand the inside of one.

| form | example | result |
|:--|:--|:--|
| a **path** | `event.subject` | the value at that path |
| an **interpolation** | `"Re: ${event.subject}"` | a string — or the value itself when the whole expression is one `${…}` |
| a **comparison** | `event.security.malware != "clean"` | a boolean |

Three operators: `==`, `!=`, `contains`. No arithmetic, no function calls, no indexing, no boolean
combinators, and exactly one operator per expression. **Anything else is refused by name at runtime**, so an
author who writes `event.count > 3` is told that `>` is not in the language rather than having it silently
evaluate as a string comparison.

Three roots: `event` (what the trigger carried), `steps` (what `as` bound), `butler` (`id`, `versionId`,
`name` — which is how a `case.assign` names the Butler itself). **A path that does not resolve throws**,
because the alternative is `"undefined"` interpolated into a subject line and sent.

`validate` honours `type`, `enum`, `const`, `required`, `properties`, `additionalProperties`, `items`,
`minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum` — and **refuses a schema using
anything else, by name**. A validator that ignored a keyword it did not understand would be a `validate` node
that passes everything while reading as though it checked something. `pattern` and `format` are absent
deliberately: a regular expression compiled from a stored AST is a denial of service with an author's name on
it.

### The one asymmetry worth knowing about `map`

`collectAs` collects what the body bound **under that same name**, per iteration: inside the body
`steps.<collectAs>` is this iteration's result, and after the loop it is the array of them. One name, one
concept. A body that bound nothing under it is **refused** rather than collecting nulls — a name that gathers
a list of nothing is a name that lies about what the loop did. `foreach` is the node that collects nothing,
and it says so.

---

## Effects go through Layer 5, not around it

`case.assign` is `claim`. `case.close` is `close`. `draft` is `saveDraft`. `mail.send.propose` is
`sealManifest`. **Not a copy of any of them** — so every policy decision, every approval gate, every circuit
breaker, every authority check and every audit entry happens because the same function ran, with a different
principal. `test/butler-step-cost.measure.test.ts` priced those four functions before this engine existed *on
that basis*, and the figures only mean anything while it holds.

What the engine adds around each call is three things: it resolves the node's expressions, it checks **the
Butler's own** authority where the function checks somebody else's, and it turns the answer into a row of the
run record.

| node | who the Layer 5 function checks | so the engine checks |
|:--|:--|:--|
| `case.assign` | the **assignee**'s `send.propose` | the Butler's `send.propose` on the case's mailbox |
| `case.close` | that the closer **holds** the case | the Butler's `send.propose` on the case's mailbox |
| `draft` | the author's `send.propose` | nothing — the author *is* the Butler |
| `mail.send.propose` | the author's `send.propose` | nothing — same reason |
| `lookup` | nothing: it is a row read | the Butler's read relation, folded into the statement |

The first row is the one that matters. `claim` checks whether the **assignee** may work the case, which is
right for a human clicking Reply and not enough for a program: without the extra check a Butler holding
nothing anywhere could assign any case in the organization to anybody who may work it.

**`case.close` closes only a case the Butler is holding**, because that is what `close` requires of a person
too. The shipped way to reach it is a `case.assign` whose assignee is `"${butler.id}"`. Widening `close`
would change what closing means for people, and the one thing this engine must not do is give a program a
path a human does not have.

**A `lookup` returns a projection, not a row.** `SELECT *` would put `blob_key` and `blob_sha256` into the
run's state, where `"${steps.m.blob_key}"` interpolates an internal storage key into a subject line and sends
it. Each entity declares the fields its expressions may name, exhaustively over `LOOKUP_ENTITIES` by
construction.

**A refused lookup binds nothing, so a later expression reading it faults the run.** The refusal is recorded
first, so the record reads refusal-then-fault and a person meets the reason before the symptom. The shipped
AST has no failure edge for a node to branch on, which is what makes this the only available answer short of
substituting a value. A second edge is a change to #49's node shapes.

---

## The human-release gate

A Butler-proposed send is sealed **`awaiting` with `butler_release_required`**, and the run parks on
`step.waitForEvent`.

**Both halves are necessary and neither is sufficient.** A parked run on its own is not a gate: a manifest
sealed `held` is picked up by `dispatchDue` the moment its hold window elapses, so a Butler that sealed and
parked would have had its mail sent by the sweeper while the run waited for a person who was never needed.
And a gated manifest with no parked run cannot be resumed. So the **gate is in D1** — `movableNow` refuses to
move an `awaiting` send whose reason is not a breaker's — and the **waiting is in the Workflow**, which costs
no concurrency, so a Node with ten thousand proposed sends holds ten thousand sleeping instances and no
capacity.

It also means a send stays releasable **after its run is gone**: instance state is retained 3 days on Free
and 30 on Paid, a manifest is kept for ever, so `releaseButlerSend` acts on the manifest first and tells the
instance second, tolerating one that has expired.

### Where it sits in §18's total order

```
policy deny  >  domain pause  >  require_approval  >  policy hold  >  butler release  >  rate gate  >  allow
```

Below every policy gate, because a policy gate is a rule somebody wrote about *this send* while this is a
property of who proposed it — and because `require_approval` already **is** a human gate, so adding a second
ask would mean two people clearing one send for one reason. Above the rate gate, on `sealManifest`'s own
rule: a rate gate needs *time* and this needs a *person*, and when both apply the reason a reader must act on
is the human one.

**Why not simply require an approval.** It was the tempting answer and #49 already refused it: `approval.request`
is a *reserved* node because approvals are requested by the policy plane at seal, and a second way to create
one is the correspondence problem ADR 35 rejected. And it is already expressible, better, as a policy naming
the `btl_` as actor — governed, versioned, staged, auditable. This gate is the *default* for a program with no
human present, not a replacement for that rule.

### Releasing

`POST /api/sends/:id/release`, gated on **`send.propose`** — the authority that would have been needed to
compose the message, which is what #60 gave a policy hold's release to. The gate exists because no person had
*seen* it, not because a stricter authority is owed; `approval.decide` would have made this the approval
machinery with none of its guarantees.

The gate is named in three predicates — the read, the conditional `UPDATE`, and the `AuditGate` beside it —
and **widening any two changes nothing observable**. That is a mutation measurement rather than something a
test can hold, since widening a predicate means editing the source; what the test pins is the outcome, which
is that a `policy_hold` send answers `not_found`, stays `awaiting` and appends no entry. The audit entry names the
**person**, never the Butler: `send.sealed` already records the Butler with `actor_kind = butler`, and
`send.released` records who agreed it could go.

A timeout ends the **run**, never the send. The manifest stays `awaiting`, still releasable and still
cancellable. Letting a clock hand mail over would make this a delay rather than a gate. The timeout is
`approval.send_expiry_seconds`, reused rather than invented: a release is a person agreeing to a Butler's send
in substance, and this Node must not hold two opinions about how long somebody has to decide about one send.

---

## The trigger, and the instance id

`<butlerVersionId>-<triggerKey>`, where the trigger key is the `msg_` id of the delivery.

`create({ id })` **throws `instance.already_exists`** on a duplicate within the retention window, so the same
delivery cannot start two runs of the same version — and the refusal comes from the platform rather than from
a check we wrote. §16's `forbid` overlap policy is therefore free. It matters because the trigger is called
from an **at-least-once** pipeline: `materialiseReceipt` is driven by an outbox event, and a handler will see
the same event twice.

Three things that must not be conflated:

- **The run id is not an ADR 9 effect key.** It dedups the *trigger*; every sending step still mints its own
  effect key. One intent, one run, many effects.
- **The dedup window is 30 days**, being the instance retention — a property of the platform. After it the
  same id is creatable again, and `butler_runs`' primary key is what refuses the second *record* for ever.
- **`createBatch` is not used and must not be.** It silently skips a duplicate id and excludes it from the
  returned array — measured at 4 requested, 1 returned, no error.

**Miniflare does not reproduce the throw.** Measured: its `create` resolves and swallows the initialisation
failure, so locally a duplicate returns a handle and starts no second run. The *outcome* holds and the
*refusal* is invisible, so the two are tested separately — the outcome against real storage, the handling of
the throw against a binding that throws.

Matching is a **JSON parse per published Butler**: a trigger lives inside `ast_json`, which is a blob, so no
index can answer *"which Butlers listen on this address"*. The alternative is a projected trigger column,
which is a second copy of a fact inside the frozen AST and therefore a thing that can disagree with the
program. The day the cost matters, the fix is an index built *from* the AST at publication, not a column an
author can set.

The trigger's cost is charged to the **sweeper's** invocation, never to a run's pot.

---

## The run record, and the ledger seam

`butler_runs` (one row per run) and `butler_run_effects` (one row per effect, and per refusal). Migration
0028.

**Why D1 at all, when the Workflow has state:** instance state is retained 3 days Free / 30 Paid, so an
instance is *execution state that expires*, not a record. The Workflow owns execution, D1 owns the record, and
they are different things rather than duplicates. A ledger built as a view over instance state would have gone
blank at 30 days for every send a Butler ever proposed.

**One row per effect, not per step.** A run's pure nodes cost 0 and are answerable to nobody, so a row each
would be storage bought for arithmetic. What a person needs is what the run *did* to the world and what
stopped it, and that is bounded by the affordability checker.

**Each row is written inside the same step as the effect it records**, in one `batch()` with the accumulated
spend and — for a send that parks — the park. Batching every row at the end of a run would be one subrequest
for all of them and would leave a killed invocation with a record of nothing, which is the state this table
exists to prevent.

**This is not #53's ledger, and the seam is named rather than discovered.** No step inputs, no recorded LLM or
connector output, no cached step result, and therefore none of the four replay modes — and none of those
columns exist, because a column whose only value is NULL is a placeholder. A ledger is additive over these two
tables, keyed on `butler_runs.id`.

`GET /api/butler-runs` and `GET /api/butler-runs/:id` read them, gated on **`org.admin`** — the same authority
authoring a Butler takes. A run's effect list names ids across every mailbox the Butler touched, so bounding
it per mailbox would mean either a partial answer that reads as complete or a query deciding visibility row by
row. There is deliberately no route that *creates* a run: a Butler that could be fired by a request would be an
automation with a manual override nobody governed.

---

## The budget, and where the checker and a real run disagree

This is the finding of the whole ticket, and it is recorded in
[`docs/receipts/butler-run-cost.md`](./receipts/butler-run-cost.md).

**#54 prices the *functions*; a run costs the *nodes*.** Measured against the checker's prediction for the
same AST:

| AST | checker's prediction | measured run |
|:--|--:|--:|
| `draft` → `mail.send.propose` (a reply) | 30 | **32** |
| `transform` → `case.assign` → `case.close` | 11 | **12** |
| `lookup` alone | 4 | **5** |
| `stop` alone | 0 | **3** |

Per node, as the engine performs it, against the bound `butler-step-cost.md` carries for the function:

| node | function's bound | measured node |
|:--|--:|--:|
| `draft` | 10 | 6 |
| `case.assign` | 8 | 7 |
| `case.close` | 3 | 2 |
| `lookup` | 4 | 2 |
| `mail.send.propose` | **20** | **23** — `readDraft` 5, the seal 16, the record batch 1, the gate's resume 1 |

Four of the five nodes fit inside the headroom `butler-step-cost.md`'s bounds already carry. The fifth does
not: `mail.send.propose` measures **23** against that receipt's **20**, because the node reads the draft back
before sealing it. At this size the gap is a rounding error. **At loop scale it is not**: a `foreach` of 500
sends prices at exactly the Paid pot and really costs 11,503, so the instance would be killed at about item
434 having already sealed 434 manifests — precisely the failure #54's refusal exists to prevent.

**#54's arithmetic is not quietly changed.** Its figures are correct measurements of the functions they name,
and its receipt is the thing that would have to move. What is done instead:

- **The engine meters itself.** `src/cost-meter.ts` wraps the run's env, `butler_runs.subrequests_spent`
  carries the total across invocations, and the run **refuses an effect it cannot afford before performing
  it** — with AGENTS.md §3's four parts in the operational log. So the 500-send loop stops at item 357 with a
  refusal a person can read, rather than dying with 434 sends performed and nothing saying why.
- **The reservation comes from `butler-run-cost.md`**, not from #54's table, because where they differ the
  difference is real and reserving the smaller one would reserve too little for the one node it matters for.
- **The start-time forecast stays a cheap pre-check and is a floor, not a total** — `priceButler(nodes).total
  + butler.run_cost_engine_fixed`, costing no subrequest, catching the boundary case where a graph priced at
  the whole pot cannot pay for the machinery around it. It is deliberately not a re-pricing of the graph
  against the run-cost table: that would be a second implementation of `priceButler`'s multiplier arithmetic,
  and the live guard needs no graph arithmetic at all.

Three numbers, and the distance between the first and the last is the finding:

```
500  admitted at publication, dividing the pot by the function's bound
434  affordable at the measured node cost of 23
357  permitted by the runtime guard, reserving the receipt's bound of 28
```

The guard being the strictest is the correct direction: refusing one send too early costs a Butler a run it
could have finished, and refusing one too late means it has already been sent.

**Whether the pot resets across invocations is unmeasured.** A resumed instance gets a fresh meter; the
accumulated column enforces the stricter of the two readings, because over-counting refuses a run that would
have fitted while under-counting kills one that has already sent mail.

---

## The reserved nodes, and what happens if one appears anyway

`checkButler` refuses every reserved node at publication, and `butler_versions` freezes what was published
with two database triggers. So `llm.classify` in a stored AST is unreachable through every path this Node
has — **and a stored AST is still data, which somebody with direct database access can edit.**

That is why the interpreter re-checks. It costs no subrequest, and a reserved node makes the run **refuse
itself before performing any effect**, with the checker's own finding — *"reserved in the AST and refused at
publication"* plus the sentence saying what is missing — in the run's reason and the operational log. Not a
crash, and not silently skipped. The same re-check catches the other three things a hand-edited row could
introduce: a cycle, a dangling edge, and a graph that cannot afford itself.

---

## What is unenforced, said plainly

**A loop whose body performs no I/O.** `packages/butler-ast/src/cost.ts` admits any `maxItems` for it and says
so, naming CPU as the boundary of that pass because CPU cannot be metered from inside a Worker. A `foreach` of
a billion pure `transform`s is publishable, and **this engine does not refuse it either**: it runs until the
platform's CPU limit kills the invocation. The alternative is an iteration ceiling with no measurement behind
it.

What an operator sees when that happens is a run stuck at **`running`**, and that is worth stating exactly
because the plausible sentence is wrong twice over. A pure loop is not inside a `step.do` at all, so there is
no step to retry; and a CPU kill is a termination rather than a thrown error, so neither the interpreter's
`catch` nor its terminal write runs. The row keeps `state = 'running'` with a NULL `finished_at`, which
`GET /api/butler-runs` shows and nothing reaps. What the platform does with the instance afterwards is
**unmeasured**. Not repaired, because a reaper needs a staleness figure and the honest answer to "how long may
a run legitimately run" is that a `wait` node reaches 365 days.

**The workflow's name is account-scoped and cannot be omitted.** A `[[workflows]]` entry without `name` is
refused by the config parser, and wrangler substitutes nothing into config values — so #72's fix for the queue
(declare the binding, let the deploy derive the name) is unavailable. What is enforced instead is that the
name is the Worker's own name plus a suffix, so renaming the Worker renames the workflow in the same edit. The
residual: Workers Builds pins its own Worker name and overrides the config, so a second install into one
account gets a different *Worker* name and the same *workflow* name. What happens then is **unmeasured** — the
queue case collided silently, and this one is not known to.

**No failure edge.** A node carries one `next`, so a Butler cannot say *"if the send was denied, assign the
case to a human instead"*. What it can do is read the outcome from the run record afterwards.

**Still fog, unchanged from #50's resolution.** `queue_one` and `parallel_bounded` (they need a different id
shape), the full §16 schedule semantics, the trigger catalogue beyond `mail.received`, the capability ceiling
at publication, static taint tracking (#52), the run ledger and its four replay modes (#53), and simulation.
