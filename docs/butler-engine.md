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
| `src/butler/replay.ts` | `inspect` and `re-run`: the ledger's two run-scoped replay modes (#53) |
| `src/outbound/retry.ts` | `retry-effect` and `resend-may-duplicate`: the two send-scoped ones |
| `src/butler/record.ts` | the run record in D1 |
| `src/butler/pause.ts` | the latched pause and the loop that places it — **read-only**, because `doctor` imports it |
| `src/butler/pause-acts.ts` | the two writes: the machine placing a pause, a person resuming one |

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
convenient — which #52 then made a stronger argument for rather than a weaker one: with no sink for an
expression to reach, the language's smallness is what keeps it that way as nodes are added.

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

A `mail.received` run's `event` carries exactly: `message_id`, `conversation_id`, `case_id`, `mailbox_id`,
`mailbox_address`, `subject`, `from`, `return_path`, `received_at`, `parse_error`. Two of those name a sender
and the distinction is load-bearing — `from` is the `From:` **header**, content the sender chose, readable so
a guard can match on it; `return_path` is the **envelope** sender, and it is the only one anything addresses
mail with. See "Who a Butler's reply goes to" below.

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

What the engine adds around each call is four things: it resolves the node's expressions, it checks **the
Butler's own** authority where the function checks somebody else's, it turns the answer into a row of the
run record, and — for `draft` — it **supplies the recipients the node does not carry** (below).

| node | who the Layer 5 function checks | so the engine checks |
|:--|:--|:--|
| `case.assign` | the **assignee**'s `send.propose` | the Butler's `send.propose` on the case's mailbox |
| `case.close` | that the closer **holds** the case | the Butler's `send.propose` on the case's mailbox |
| `draft` | the author's `send.propose` | nothing — the author *is* the Butler. It does supply the recipients, which the node cannot name |
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

## Who a Butler's reply goes to

**A Butler does not name recipients. The Node derives them from the parent delivery** (#52). `draft` has no
`to`, and no `cc` or `bcc` either: §16 forbids untrusted content selecting or constructing them, an `Expr` may
read `event.*`, and `event.*` **is** the inbound message. So the parameter is gone rather than checked, and
`src/butler/parent.ts` is what replaced it. [The AST doc](butler-ast.md#no-node-takes-a-recipient-52) carries
why the parameter is absent instead of guarded, and what that costs.

### The parent delivery, and which of its three addresses is used

A Butler is triggered by `mail.received`: one message, delivered into one mailbox, carrying an SMTP envelope.
The parent delivery is that message, and a reply to it is addressed to its **return path** — the envelope
sender, `ingress_receipts.envelope_from`, RFC 5321's reverse path. Three addresses were available and the
choice is written down rather than left to the next reader:

| candidate | what it is | |
|:--|:--|:--|
| the `Reply-To:` header | content | **Refused.** A header is content, so honouring it is the sink under another name: `Reply-To: victim@example.com` would aim this Node's reply at a third party. |
| the `From:` header (`messages.from_addr`) | content | **Refused**, same reason. It is what a *person's* mail client offers, and a person is a check on it; a program running unattended is not. |
| the envelope sender | transport | **Used.** The address the transport itself treats as the return path, the one SPF authenticates, and the one RFC 3834 requires an automatic responder to answer. |

Both facts are in the run's state under different names, because they are different things: `event.from` is
the header, readable so a guard can *match* on it, and `event.return_path` is the envelope, which is what the
reply is addressed to. Nothing addresses mail with `event.from`.

**What this buys and what it does not, without dressing it up.** It closes the sink: no value an author wrote
and no part of the message can decide who the mail goes to. It does **not** make the envelope sender
trustworthy — a spoofed reverse path aims a reply at whoever it names, which is ordinary backscatter and a
property of email rather than of this design. What bounds that today is the human release gate every Butler
send carries; what will bound it properly is the trusted-recipient store that CC, forward and
supervisor-notify are also waiting on. Not claimed as closed, because it is not.

### A delivery with no return path is refused, never defaulted

A bounce arrives with a null reverse path — `MAIL FROM:<>` — and RFC 3834 forbids answering one
automatically. There is no honest default: the `From:` header would reopen the sink, the mailbox itself would
be a loop, and a manifest with no recipients is not a send. So the `draft` node **faults**, the run ends
`failed` with `E_BUTLER_PARENT_HAS_NO_RETURN_PATH`, and no draft and no manifest are written. An author who
expects such deliveries guards on `event.return_path` before drafting, which is why that fact is in the run's
state and why the refusal's `fix` line says so.

The same fault covers a run with **no parent at all**, and neither shape is hypothetical:

- **A trigger that is not a delivery.** The trigger enum has one member and #49 says it will grow. The day a
  schedule fires a Butler there is no correspondent, and `E_BUTLER_NO_PARENT_DELIVERY` says that rather than
  inventing one.
- **A run started before this Node was upgraded.** Workflow instances outlive a deploy — a `wait` reaches 365
  days — so a payload created before `return_path` existed does not carry one. Its `draft` refuses, which is
  the safe direction: the alternative is guessing a recipient for mail that leaves the building.

### A reply to the address the delivery arrived at is refused, because it is a loop

The sentence above gives "the mailbox itself would be a loop" as a reason not to default to it. Nothing
enforced that, and driving the derivation adversarially rather than reading it found the case where it
happens: a message whose reverse path **is** `support@acme.example`, delivered to `support@acme.example`,
sealed a manifest with that address in `From:` and in `To:`. That is delivered back into the same mailbox,
fires the same Butler, and does it again. Forging `MAIL FROM` is all it takes, so it starts from outside.

So `parentDelivery` refuses it: `E_BUTLER_REPLY_WOULD_LOOP`, before a draft is written, comparing the derived
return path against `event.mailbox_address` case-insensitively. RFC 3834 §2 states the same rule — an
automatic responder must not answer its own address. A trigger carrying no `mailbox_address` refuses under the
same code, because a check that switches itself off when its input is missing is absent on exactly the runs
nobody tested. An author can pre-empt it: `when: event.return_path == event.mailbox_address` is a comparison
of two bare paths, which the expression language resolves, so the guard the refusal recommends is one this
engine can run.

**It compares one address against one address, and what that does not catch is in "What is unenforced" below.**

### The one sink that is still an expression

`draft.mailboxId` is an `Expr`, so untrusted content *can* reach it — and the mailbox decides two of §16's
eleven: `From` is the mailbox's address (ADR 36) and `mailbox_id` is a policy condition. Found by re-verifying
the other ten rather than trusting the list, and recorded because *"sender identity is closed structurally"*
was only half true.

It is closed by **validation against trusted organization state**, which is §16's own escape clause, and the
asymmetry with the recipient is the reason the two are handled differently: a recipient had nothing to be
validated against, while a mailbox has `relationship_tuples`, which only an administrator writes. `saveDraft`
and `sealManifest` both bound the choice to mailboxes this Butler was granted `send.propose` on, and the test
asserts **both** arms — content naming a mailbox the Butler does not hold is refused, and content naming one it
does hold works, which is the residual stated rather than implied.

A related consequence, verified rather than reasoned: `senderAddress` is not a node parameter either, so a
Butler on a **multi-address mailbox cannot send at all** — `sealManifest` refuses with `E_SENDER_AMBIGUOUS`
rather than letting a `created_at` decide what every recipient sees.

### The cost

**A Butler cannot CC a colleague, cannot add a supervisor, and cannot forward anything.** Every one of those
means naming a recipient who is not the correspondent, which needs a *trusted* recipient, and there is no
contacts table, allowlist or suppression list anywhere in the schema. `effects.ts` passes no `cc` or `bcc` to
`saveDraft` at all rather than passing empty arrays, so there is no field there for a later edit to start
filling in quietly.

**A person is not constrained by any of this.** `saveDraft` stores the caller's recipient list and derives
nothing from the message being replied to; the API hands it `body.to` from the request. The composer's reply
button prefills the envelope sender *in the browser*, as a suggestion the person can change — which is the
difference between a default and a derivation.

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

**The seam #50 named is now closed, and it closed on these two tables rather than beside them.** #53's ledger
is four columns (migration 0030), for the reason 0028 gave when it named the seam: a second set of run tables
would be two accounts of one run that can disagree. `trigger_facts` holds what the run was **given** — mail content, read only through `triggerFactsOf` and disclosed only behind `inspect`'s per-mailbox gate;
`replay_of` and `replayed_by` say whether it is a replay and whose decision that was; `send_manifests.resend_of`
says that one send deliberately repeats another. What is still absent is a row per **step**, for 0028's own
reason, and recorded LLM or connector output, which has nothing to record until Layer 6 has either.

`GET /api/butler-runs` and `GET /api/butler-runs/:id` read them, gated on **`org.admin`** — the same authority
authoring a Butler takes. A run's effect list names ids across every mailbox the Butler touched, so bounding
it per mailbox would mean either a partial answer that reads as complete or a query deciding visibility row by
row. There is deliberately no route that *creates* a run: a Butler that could be fired by a request would be an
automation with a manual override nobody governed.

---

## Replay: four modes, and the one sentence they all rest on (#53)

§16 names the replay modes and this Node builds four of them. Migration 0030; `src/butler/replay.ts` owns the
two run-scoped modes and `src/outbound/retry.ts` the two send-scoped ones.

> **A replay inherits the input and re-asks the judgement.**

Getting that backwards in the permissive direction is the whole hazard: a replay is the first act in this
product that deliberately repeats an effect on the outside world, and every safety property Layer 5 built
assumes a first attempt.

### What each mode reads and writes

| mode | route | reads | writes |
|:--|:--|:--|:--|
| `inspect` | `GET /api/butler-runs/:id/inspect` | the run row, the version's frozen `ast_json` and publication state, the pause in force, the effect rows in order, each send's current state and offer, any replays already made, and — gated per mailbox — what the run was **given** | **nothing**, except the `supervised.opened` entry §7 owes when a supervised grant is what opened the run's content fields |
| `re-run` | `POST /api/butler-runs/:id/replay` | the source run's `trigger_facts` (through `triggerFactsOf`, the column's one reader), then everything the live path re-asks | a new `butler_runs` row carrying `replay_of`/`replayed_by`, in one transaction with `butler.replayed` |
| `retry-effect` | `POST /api/sends/:id/retry` | one manifest's `state`, `fidelity`, `submitted_key` | that manifest back to `held`, audited `send.retried`; then dispatch, under the **original** key |
| `resend-may-duplicate` | the same route, named mode | the same three, plus the envelope and the author's **typed** body | a **new** manifest under a **new** key with `resend_of` set, audited `send.resent` |

`inspect` performs no effect — it creates no run, seals no manifest, writes no evidence and touches no state —
and it appends no entry of its own, because an entry per glance at a screen is the per-row frequency this Node's
trail keeps out. The one row it can write is not its own: §7 owes `supervised.opened` before a **grant**-
authorized reader is shown the run's content fields, and that is a precondition of the read rather than a
record of the mode. It also states in its own answer what is **not** recorded: the
pure nodes of the walk left no rows, so which branch a guard took is not recoverable.

#### `org.admin` is the floor on `inspect`, and not the whole check

A run's recorded input is the `event.*` root, and that carries the triggering message's `subject`, `from`,
`return_path` and `parse_error` — **mail content**, which `src/butler/trigger.ts` says of `from` in as many
words. `org.admin` is a relation on the *organization*: it appears nowhere in `authz-read.ts`'s table of who may
read a mailbox, and §7 is explicit that no relation implies `message.read`. So gating `inspect` on it alone made
this route a way for an administrator holding nothing anywhere to read the subject line and the sender of every
message any Butler ever processed, with nothing recorded — the pair #63 exists to prevent.

Three things close it, and each is a decision rather than a defence:

- **`FACT_DISCLOSURE`, beside `DeliveryFacts`** — a *total* map classifying every fact as `content` or
  `operational`, so a tenth fact does not compile until somebody classifies it, and an **unknown** key in a
  stored blob is treated as content. A list of fields to hide would guard only the spellings its author thought
  of, and the fact set is the thing that grows: #52 grew it by `return_path`.
- **`mailbox.metadata.read` or `mailbox.content.read` on the mailbox the delivery landed in, or a live
  supervised grant of either scope** — `mayReadMetadata`, whose own contract is *"subject lines, sender
  addresses"*, which is exactly and only what a fact set discloses. Requiring `mailbox.content.read` instead
  would refuse a subject line to the holder of the relation that exists for nothing else, and would refuse
  nobody extra. A grant opens it because #63 built that ceremony for precisely this case, and refusing it here
  would push an investigator to `GET /api/messages` for the same subject lines through a door already sanctioned.
- **Redaction that is stated, not silent** — the content fields come back `null` and `triggerFactsRedacted`
  names them and says what authority would open them. A redacted `parse_error` reading `null` would otherwise
  claim the headers parsed cleanly, which is a *false* answer rather than an absent one.

`parse_error` is classified content, which is stricter than it looks: two of its three spellings are this Node's
own sentences, but `E_HEADERS_UNPARSED  <parser message>` interpolates the failure to read the sender's bytes.

**What is recorded:** a supervised grant produces `supervised.opened` before the facts are returned, and
`recordDisclosure` throws, so a Node that cannot write its trail does not hand over the subject line. A
**standing** relation records nothing, which is the product's settled rule for metadata rather than an exception
carved here. `queueFor` is the precedent to the letter: it gates on this same `mayReadMetadata`, returns for a
standing relation having appended nothing, and calls `recordDisclosure` only when `metadata.grantId` is
non-null. `listMessages` records only its supervised arm, and even `mayRead` — which reaches a *body* — returns
on a standing relation before its append and records only when a grant answered. The one path that records
unconditionally is `authorizeExport`, whose reason is that an export takes a **copy off the
Node**; `inspect` produces no copy and no bytes.

**`butler_runs.trigger_facts` is not on `RunRow` at all.** `RunRow` is serialized into three responses gated on
`org.admin`, so the blob has exactly one reader — `triggerFactsOf` — named for what it returns. That is the
total shape rather than three route-level omissions: a fourth route cannot leak a column its row does not carry,
and the per-mailbox gate on the parsed facts cannot be defeated by the raw column sitting beside it.

The two send-scoped modes are on `/api/sends/:id` and not on a run because the states they turn on are states of
a **manifest**, and a manifest outlives every run — most were never proposed by a Butler at all. Hanging them
off a run would have made a person's refused send unretryable and a Butler's retryable.

### Materially new is decided by content, never by identifier

`contentIdentity` hashes the envelope — the mailbox, To, Cc, Bcc, the subject and the threading parent — plus
`body_normalized_sha256`, one of the three hashes `sealManifest` already computes. Same identity means the same
effect: the replay records the **old** manifest id as its subject, seals nothing, writes no R2 object and sends
no mail, with `replay_identical_content` as the reason. Different identity means a new manifest and a new key,
which by construction moots any approval bound to the old one.

**Reusing the key is right on every state; claiming success is not.** `replay_identical_content`'s justification
is *"this message exists and is on its way"*, and that is false of an incumbent the world has decided **against**
— a `withheld` manifest is never going anywhere and a `cancelled` one was stopped by a person. Before this was
fixed, "a policy wrongly denied a Butler's send; fix the policy and re-run" — the single most obvious use of
`re-run` — was a no-op reporting `ok`. `incumbentStands` is the total `Record<SendState, boolean>` that decides
it: `cancelled` and `withheld` do not stand, an unrecognised state does (standing performs nothing, so it cannot
invent a decision nobody made), and an incumbent that does not stand records `replay_send_decided`, **refused**,
against the incumbent's own id.

The fix is a refusal and not a re-seal on purpose. Recomposing on a `withheld` incumbent would open a genuine
duplicate path, because the content rule's scope is the source run's own effects: two replays of one run would
each find only the original and each mint a manifest. Composing again is `resend-may-duplicate`, which takes a
person, a reason and an acknowledged risk.

**The tempting reading is exactly backwards.** #53's own body proposed *materially new means a different
manifest id*, citing ADR 35. That property is **directional**: the id is a time-and-random ULID and nothing
constrains content uniqueness, so same id implies same content and a different id implies nothing. A replay
reproducing a message byte for byte always gets a new id — so an id-based rule would call it materially new,
mint a fresh key and hand the same message over twice.

Three properties of the rule worth stating because each was a decision:

- **Derived, not stored.** A `content_sha256` column would have been NULL for every manifest sealed before it
  landed, and a NULL that cannot match is the *permissive* failure. Derived, the rule works on every manifest
  this Node has ever sealed.
- **It errs on the side of *identical*.** Identity means *send nothing*, so collapsing two near-identical sends
  is a refusal and separating them is a duplicate delivery. Addresses are therefore lower-cased, deduplicated
  and sorted; the subject, the parent and the body hash are compared exactly.
- **It is scoped to a replay of a run.** A person composing the same words twice is a new intent, and
  *"please resend that"* stays representable — that is what `resend-may-duplicate` is.

An incumbent whose manifest row has been **deleted** refuses the whole replay with `replay_send_unprovable`,
because content that cannot be compared must not be assumed new.

### `retry-effect` is offered iff non-acceptance is proven, and absent otherwise

Absent, **not failing**: a mode unavailable because the Node cannot prove its precondition is a different thing
from a mode that errors. What can be proven is narrow, and all four are first-party facts about this Node's own
attempt rather than reconciliation results — §16's sentence named a reconciler that does not exist, and the
blueprint now says so.

| proof | why it is one |
|:--|:--|
| `refused` | the API boundary rejected the submission |
| `throttled` | rate-limited before the bytes were taken |
| `suppressed` | this Node declined to hand over, by its own rule |
| `outcome_unknown` + `fidelity = 'authored'` + `submitted_key IS NULL` | the bytes are rendered, stored and recorded on the row **before** the first submit, so an absent key means none was attempted |

`send_recipients.attempts = 0` is **not** a proof and is not consulted: it is updated only after the call
resolves, so a dead isolate leaves it at zero with the bytes already gone. And provider observation can only
ever *disprove* non-acceptance — `transport_message_id` is written only on `handed_over`.

The rule is a `Record<SendState, …>` rather than a list of states to exclude, and that shape is load-bearing:
`outcome_unknown` is the **default** for anything unrecognised, so the unprovable population is the one that
grows and a denylist would guard only the spellings its author thought of. A tenth send state does not compile
without a classification, and a state string the code has never seen offers nothing at all.

It is expressed twice — in TypeScript for the offer and in SQL for the conditional `UPDATE` that performs the
act — and `test/butler-replay.test.ts` drives both over every state crossed with both fidelities and both key
states, because two expressions of one rule need a check rather than care.

`E_RETRY_NOT_PROVEN` has **three** arms and not two, and the third is a correction. A `reconstructed` send
reaches the refusal with `submitted_key` NULL, so it inherited the *authored* explanation and was told
*"an absent submitted_key is the only durable proof of non-submission and this send has one"* — about a column
holding nothing. An agent reading that is sent to check the wrong thing, which is worse than a vague reason: a
false explanation ends the question a blank one would have started. It now says what is actually true of that
path, which is that it never writes the column at all (ADR 33).

### Two names, because two epistemic states

`retry-effect` reuses the old key: the effect provably did not happen, so the intent is unchanged.
`resend-may-duplicate` mints a **new** one: the old key may already have been handed over, and reusing it would
claim these are the same effect — the one thing nobody can say about that case. It is human-only, refuses without
`acceptDuplicateRisk: true`, refuses without a reason, enters the hold window rather than dispatching, and its
audit entry names the **person** who accepted the risk rather than the author, which on a Butler's message is a
`btl_`.

Collapsing them into one act with a flag would put the safe case and the duplicate-risking case behind one
button. What makes both safe against a partially delivered send is that `submitPerRecipient` already skips a
recipient reading `handed_over`, citing ADR 40.

### What a replay re-asks, and what it inherits

| input | decision | why |
|:--|:--|:--|
| the trigger facts | **inherited** | re-deriving them describes *now*: a case created since, a conversation merged since, an address re-routed since. A run over different input is not a replay |
| policy | **re-asked** | the seal evaluates current policy and dispatch re-evaluates it; §18's *"stricter policy fails closed"*. There is no path to an old decision, because a replay either seals a new manifest or seals none |
| approval | **re-asked, structurally** | approval binds a manifest id, so new bytes get a new id and no old approval; identical content seals nothing, so there is nothing new to bind |
| legal hold | **neither** | it governs destruction, not sending. A hold placed after the fact does not stop a replay, and inventing a coupling would be a control nobody asked for |
| the hold window | **not inherited** | a replayed send gets its own `release_at`, so it is still cancellable |
| rate breakers, domain pause | **re-asked** | at the seal and again at hand-over, unchanged |
| the Butler pause | **re-asked, before any run exists** | a pause refuses rather than gates, so a paused Butler starts no run — and `interpret` asks again per invocation for a pause placed while a replay sleeps |
| the version's publication state | **re-asked** | a replay runs the **same** version, because a run is one walk of one program; a superseded or deleted one refuses |

### What a replay does to the run's cost counter: nothing

`butler_runs.subrequests_spent` is accumulated **per instance**, because the pot is per instance. A replay is a
new instance with a new id, so it opens its own row at zero and the original's figure is untouched. There is no
double count — and the case that would have mattered now works: a run killed with `budget_exhausted` is
replayable and gets a whole pot, rather than inheriting an exhausted one and being refused a replay that is in
fact affordable. The two send-scoped modes spend nothing against any run's pot: they run in the request's
invocation, the way `triggerButlers` runs in the sweeper's.

A replay pays **one** subrequest more than the engine's fixed three — the single read of the replayed run's
sends. It is `1` because it is one statement, `butler.run_cost_engine_fixed` stays pinned at 3 for an ordinary
run, and the read is deliberately outside the send node so `butler.run_cost_max_send_propose` keeps describing
what it names.

### A replay's id is `<butlerVersionId>-<replayId>`

Not `<butlerVersionId>-<triggerKey>`. 0028 made the instance id the primary key precisely so one delivery cannot
produce two records of one version, so keying a replay on the delivery would collide with the record it is
replaying. The second half becomes the replay's own `brp_` ULID: the same shape — *the version, and what made
this run happen* — the same length to the character (61 against `workflow.instance_id_max_chars = 100`), and ADR
9 intact, because for a replay the **intent is a person's decision** rather than a delivery. Two clicks are two
runs; what stops the second sending a second copy is the content rule, not the id.

That holds for the case people will hit and is bounded rather than absolute. The content rule compares against
the *source run's own* effects, so two replays whose content still matches the original both reuse the
original's key and both seal nothing. Two replays whose content is materially new relative to the original and
identical **to each other** are not compared to one another, so each seals. The widening is one predicate on
`interpret`'s incumbent read; it is not built because *"what have this run's siblings done"* is a different
question and deserves deciding rather than arriving as a side effect. `src/butler/replay.ts` carries it.

### One Layer 2 invariant that assumed a first attempt

`drafts_one_per_reply` is `UNIQUE (org_id, author_user_id, in_reply_to_message_id)` — *"replying to the same
message twice should resume the draft that already exists"*. Written about a person, and it binds a program
too: a replay drafting the same reply as the same author violated it, and the run died with a constraint error
before its first effect row, recording `engine_fault` and nothing else. The fix is the index's own sentence —
on a replay, `writeDraft` resumes this Butler's existing draft for that parent. The argument against an upsert
on the ordinary path survives, because the lookup is bound to the Butler's own `author_user_id`, so the widest
thing it can find is a draft the same program wrote.

### `simulate-recorded` is not built, and the reason is not that it is hard

Its purpose is to reuse immutable recorded **LLM and connector** outputs, and both are Layer 6. At Layer 4 the
expression language is pure and every effect node calls the same function a person's request would, so there is
no non-deterministic step to record: a `simulate-recorded` here would replay deterministic output and its
interesting case would be untestable. It arrives with `llm.*` or `connector.*`, and arrives with something to
reuse.

---

## The pause, and the loop that places it

#66 designed a Butler pause and named it **absent**, because there was no `butlers` table to key one on
and no run record to place one from. #75 is the same design against the substrate #49, #50 and #54 built.
Receipt: [`docs/receipts/butler-pause.md`](./receipts/butler-pause.md). Migration 0029.

### Keyed on the Butler, never on a version

A published version is frozen in both AST and source by two database triggers, so auto-disabling **cannot** be
a mutation of the version — invariant 9 forbids it. That rules out one implementation. What decides the key is
the consequence: **republishing a fixed Butler must not silently clear a pause the machine placed.** With a
version-keyed pause, an operator who changed one comment and published would have re-armed a Butler the machine
stopped, with nobody deciding it was safe.

The cost is accepted deliberately: a fix needs an **explicit resume** as well as a publish. That is the act
somebody should have to perform, and it is this feature's loudest test.

An enablement pointer on `butlers` was rejected in #66 for conflating *not deployed* with *stopped by a
breaker*: the reason a Butler is not running would stop being recorded in the thing that stopped it, and
recovery would look like an ordinary deploy in the trail.

### It refuses rather than gating, so what it looks like is silence

#66's split: a **rate** breaker is a question re-asked per act, so it gates and clears when the window slides;
an **abuse** breaker latches and refuses. A paused Butler does not run at all — not a run that starts and
refuses itself, not a queue somebody releases later. So its observable is **no runs**, which is what a Butler
nothing has triggered also produces, which is why `doctor` grew three findings in the same change.

### Two evaluation points, and both cost nothing

`butler.pause_check_added_subrequests` is **0**, pinned as an equality rather than bounded, because it is a
count of the statements the check adds and the count is none:

| Point | Rides on | What it covers |
|:--|:--|:--|
| trigger time | the read of published versions `triggerButlers` already issues | a paused Butler starts no run |
| once per invocation | the read of `butler_runs.subrequests_spent` the interpreter already issues | a run that was **already in flight** |

The second is not symmetry. A workflow outlives the Worker that declared it and a `wait` node reaches 365 days,
so a pause that stopped new triggers and let ten thousand parked instances wake up and act would be a pause in
name only. That read is already outside a `step.do` because it must not be cached — which makes it exactly the
hook a run resuming from a thirty-day sleep needs.

A run that finds its Butler paused ends `refused` with `butler_paused` through **`abandonRun`, not
`closeRun`** — it writes the state and the reason and states no counts, because the refusing invocation does
not know what earlier ones did.

**And the limit of that is stated rather than implied, because the obvious reading of it is wrong.**
`nodes_executed`, `effects` and `refusals` are written by `closeRun` **alone**, and `abandonRun` can only match
a run that has never closed — so on this path those three columns read **zero either way**, and calling
`abandonRun` rescues no figure. It is the right call because it does not *state* one. What a suspended run
actually performed is its `butler_run_effects` rows, which are written with each effect in one transaction and
returned beside the run row by `GET /api/butler-runs/:id`. Measured, not reasoned: `test/butler-pause.test.ts`
suspends a run for real, places the pause under it, and finds the row reading `effects = 0` next to two effect
rows. #53 closes that gap by pointing a reader at the rows rather than by writing a count nothing computed:
`inspect` returns the effect list beside the run row, and says in the answer itself that the count columns are a
projection only a close computes.

Measured, `docs/receipts/butler-pause.md`: the trigger is **3** subrequests with a live Butler and **2** with a
paused one — a pause makes the ingress path *cheaper*, because the `create` never happens. Placing one costs
**4**, once in a Butler's life.

### Which loop this is, exactly, and which one is absent

**A causal loop**, not a runs-per-window count, and the two are not the same problem. The link #66 said did not
exist turns out to have been complete since Layer 2, and it was checked rather than assumed:

```
messages.in_reply_to  =  send_manifests.rfc_message_id   the Message-ID this Node emitted, brackets stripped
send_manifests.id     =  butler_run_effects.subject      the manifest a mail.send.propose sealed
butler_run_effects.run_id -> butler_runs.butler_id       whose run sealed it
```

So a **self-provoked run** is a run of Butler B whose triggering delivery is a reply to a manifest a run of *B
itself* sealed. The reading is the count of those inside the window plus one when the delivery being decided is
itself self-provoked — *how many links of a chain this Butler made itself, counting the one in front of it*.
Over `butler.loop_max_self_provoked_runs` and the Butler is paused before the run starts.

The query is all index seeks, read from the planner rather than asserted:
`sm_by_rfc_message_id` then `bre_by_subject`. That index leads on `rfc_message_id` and **not** on `org_id`,
breaking this schema's convention, because written the usual way round it displaced `sm_evidence_changed` in
the planner for `doctor`'s evidence check — turning a seek into an empty partial index into a scan of every
manifest ever sealed. Migration 0029 records the observed plan.

**Named absent, three of them, each with its reason:**

- **An unthreaded reply.** No `In-Reply-To`, or headers that would not parse, means no link back. The detector
  catches a loop with a correspondent that threads properly and misses one that does not.
  `doctor`'s `butler_loop_detection` reports whether this Node is seeing threaded replies at all, rather than
  reporting a reassuring zero.
- **A loop through two Butlers.** A → B → A counts for neither, because each counts only what it sealed itself.
  That needs a chain walk rather than a windowed count.
- **A runs-per-window breaker**, and *not* for want of substrate: `butler_runs` supports it in one `COUNT(*)`.
  It has no threshold anybody can defend, because a Butler's legitimate run rate **is** its mailbox's inbound
  mail rate and nothing here has measured that.

**And what the detector's teeth are today, because the obvious reading overstates them.** `proposeSend` sets
`releaseRequired: true` unconditionally, so a Butler's send is sealed `awaiting butler_release_required` and
**cannot leave without a person releasing it**. A self-provoked chain therefore cannot extend itself: every
link needs an administrator to click release. What this catches now is a *human-assisted* chain — an operator
releasing a stream of near-identical replies, which is the muted-check failure this repository names in three
other places — plus the runs and instances behind it. What it exists for is the day that gate is removed or
outranked by a policy, because at that moment a chain with nothing counting it is a sending loop with no bound
at all.

### Who places, who resumes

|  | Domain pause (#66) | Butler pause (#75) |
|:--|:--|:--|
| **Places** | a person asks; **two** administrators agree; mandatory reason | the **machine**, automatically. No human path exists |
| **Resumes** | **one** administrator, alone, reason optional | **one** administrator, alone, reason **mandatory** |
| **What a wrong one costs** | a customer's mail stops | a customer's mail is *unautomated* — still filed, still visible, still answerable by hand |

Both are the same principle producing different answers, and both halves of the premise differ. Placement is
automatic because *a breaker that waits for a person is not a breaker*. Resume is **one** administrator because
*an automatic pause nobody can resume is an outage* — placement needs no administrators at all, so requiring
two to undo it would make the machine strictly more powerful than the organization, and a Node with one
administrator could never restart a Butler. It is `org.admin` and not *anybody*, because *one anybody can
resume is not a pause*, and because that is the authority publishing a Butler already takes.

The reason is **mandatory here and optional on a domain lift**, which is the inversion worth the paragraph: a
domain pause was placed by two people who wrote down why, so lifting needs no second justification and delay is
the harm. A Butler pause was placed by a machine — this resume is the *only* human judgement anywhere in its
lifecycle, so a blank reason would mean nobody recorded a decision at any point in it. And delay here costs a
convenience rather than somebody's mail.

Nothing lets a person *place* one, and there is no `placed_by` column either — the machine is the only placer,
so its only value would be NULL, and an always-NULL column is the placeholder shape this repository has a test
for. The actor is recorded where an actor belongs: the `butler.paused` entry carries `actor_kind = node`. What a
person can do to stop a Butler is revoke the relations granted to its `btl_` id — which stops it at its next
effect, since a Butler's principal is the Butler — or publish a policy denying its sends. Both are audited and
neither needs this table. The column arrives with the act the day a human placement is wanted, which is cheaper
than carrying an empty one until then.

### What `doctor` says, and the hard one

`butler_paused` is the easy finding: which Butlers are stopped, since when, what tripped them, the figure
behind it, and the exact command to resume one. `degraded`, never `refuse` — the mail still arrives.

`butler_run_silence` is the hard one, and it is #66's `no_observations` reasoning one layer along. From
`butler_runs` alone, *stopped* and *never triggered* are the same reading. What separates them is whether **mail
arrived at the address the trigger names** — the address parsed out of the frozen AST, the arrivals from one
grouped read of `ingress_receipts`:

| | |
|:--|:--|
| mail arrived after publication, no runs | **degraded** — it should have run and did not |
| no mail arrived after publication | **report** — nothing triggered it, which is not a fault |
| the stored AST will not parse | **degraded** — it can never run, and the trigger agrees |

Anchored on `published_at` rather than on a window, because a window would need a figure for *how long may a
Butler legitimately go without running* and a Butler on a quiet mailbox may honestly go a month. A **paused**
Butler is excluded from it: its silence is already explained, and a check that fails on every Node with a pause
is a permanent WARN, which is a muted check.

`butler_loop_detection` is the third: `armed=false (no_threaded_replies)` when nothing inbound carries an
`In-Reply-To`, `degraded` only when a Butler has also proposed a send — because `ok: false` on every freshly
installed Node forever is the other way to get a check muted.

Cost: **+1** subrequest on a claimed Node with no Butlers, **+2** when it has one — the delivery scan is issued
only when the first read found something. Measured before and after in
[`docs/receipts/doctor-check-cost.md`](./receipts/doctor-check-cost.md).

### Surface

```
GET  /api/butler-pauses               every Butler this Node has stopped, with the figure behind it
POST /api/butler-pauses/:id/resume    restart one. One org.admin, alone, with a mandatory reason
```

There is deliberately **no endpoint that pauses a Butler** — one would contradict the asymmetry above.

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

**A spoofed envelope sender.** Recipients are derived from the parent delivery's return path (above), which
closes the sink — nothing an author wrote and nothing in the message can *select* a recipient — and does not
make the return path itself trustworthy. A message forged to claim a third party as its reverse path gets a
reply aimed at that third party. This Node does not authenticate the envelope sender and does not claim to;
what stands between that and an unattended exfiltration path is the human release gate every Butler send
carries, which #75's resolution named as a gate that may later be outranked. The proper answer is the
trusted-recipient store, and it is the same missing store that CC, forward and supervisor-notify wait on.

**A mail loop with more than one hop in it.** The refusal above compares the derived recipient against the
address the delivery arrived at, which breaks the one-hop loop and nothing longer. A reply that lands in a
*second* mailbox on this Node whose Butler answers it, or two Nodes answering each other, is not caught: each
hop passes its own check. The standard answer is `Auto-Submitted: auto-replied` on what a Butler sends plus a
rule about what ingress does with one, and **neither exists anywhere in this repository** — nothing emits that
header, and nothing reads it. Until they do, a Butler's send carries no marker saying a program wrote it, and
what bounds a multi-hop loop is the human release gate on each send and the latched self-provoked-run pause,
which counts a Butler's runs rather than the loop's hops.

**Still fog.** `queue_one` and `parallel_bounded` (they need a different id shape), the full §16 schedule
semantics, the trigger catalogue beyond `mail.received`, the capability ceiling at publication,
`simulate-recorded` and simulation generally — and **how long a run ledger is kept**.

That last one is #53's own open question and it stays open rather than being defaulted. Audit entries are never
trimmed and `log_entries` are bounded; a run ledger is neither, and the honest answer needs
`audit-and-log-retention.md`'s row-size arithmetic against D1's 10 GB per-database ceiling. What #53 changed
about it is only the size of the row: `trigger_facts` is the one column that grows it measurably.

**The run ledger and its four replay modes are no longer on that list** — see the replay section above.

**Static taint tracking is no longer on that list, and it is not because it was built.** #52 reversed it for
this layer: with the one reachable sink closed by construction there is nothing a dataflow checker could
refuse, so its tests could only prove that the analysis never fired. The structural guard that replaced it —
no shipped node exposes a sink parameter — is testable today because it is a property of the node schema.
The dataflow checker arrives with `connector.*` or `llm.*`, both Layer 6, and arrives with something to
refuse.
