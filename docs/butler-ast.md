# The Butler AST

What a Butler *is* as a document, what the checker refuses and why, how a version is frozen, and which
guarantees deliberately live somewhere else. Decided in
[#49](https://github.com/Straits-AI/mailda/issues/49) and its correction; Layer 4; blueprint §16.

**A Butler can be published on this Node and cannot be run.** The engine is
[#50](https://github.com/Straits-AI/mailda/issues/50)'s — one generic `ButlerRun extends
WorkflowEntrypoint` interpreting whatever `ast_json` it reads — and no Workflow binding exists in this
bundle. That is the intended end state for this piece rather than a gap: an AST that nothing executes is
still what the run ledger, the taint checker and simulation are all written against, and shipping the store
and the checker first gives each of them something to be checked against. `mailda doctor` reports it as
`butler_execution` so an operator who publishes a Butler and waits is told why nothing happened, and
`test/node/butler-execution-world.test.ts` fails the day a Workflow binding or a `WorkflowEntrypoint`
appears — which is what stops that sentence outliving its truth.

---

## Where each piece lives

| | |
|---|---|
| `packages/butler-ast/src/nodes.ts` | the node set: one declaration of shipped and reserved, read by the schema *and* the checker |
| `packages/butler-ast/src/ast.ts` | the Zod 4 schema, the generated discriminated union, the emitted JSON Schema |
| `packages/butler-ast/src/canonical.ts` | canonical serialization, and the two digests a version stores |
| `packages/butler-ast/src/check.ts` | the structural checker and its findings |
| `apps/node/worker/migrations/0027_butlers.sql` | `butlers`, `butler_versions`, and the trigger that freezes a published version |
| `apps/node/worker/src/butlers.ts` | draft, edit, publish; authorization; the one size bound |
| `packages/runtime/src/ids.ts` | the identifier-prefix registry — `btl_`, `btv_`, and the `case_`/`cas_` resolution |

Wired into the root runner the way every other package is: `test` and `typecheck` scripts, picked up by
`turbo test` and `turbo typecheck`, so a package nothing checks is not a state this can be in.

---

## The node set: shipped, reserved, and the line between them

The dividing line is **storage that exists today**, drawn by looking rather than by taste.

**Ships (14).** `guard`, `switch`, bounded `map`/`foreach`, `join`, `wait`, `stop`; typed `transform`,
schema `validate`, `lookup`; `case.assign`, `case.close`; `draft`; `mail.send.propose`.

**Reserved in the AST and refused by the checker (15).** `llm.classify`, `llm.extract`, `llm.summarize`,
`llm.draft`, `llm.evaluate`, `label`, `route`, `archive`, `quarantine`, `case.upsert`, `case.task`,
`case.note`, `connector.call`, `approval.request`, `template.render`.

Each reserved node's refusal carries **the reason**, and the reason names what is missing rather than saying
"unsupported": there is no label or tag concept in the schema, no archived state, no task or note on a case,
no connector catalogue, no LLM control plane. An author told a template subsystem does not exist can choose
`draft`; an author told "unsupported" can choose nothing.

**`template.render` is reserved, and it was written down as shipping first.** The groundwork for
[#54](https://github.com/Straits-AI/mailda/issues/54) found there is no template subsystem at all — no
`templates` table, and every occurrence of the word in the Worker's source is incidental — so §16's worked
example rendering `lead-acknowledgement@4` is unrepresentable. That correction is the ticket catching itself
making the exact mistake the dividing line was drawn to prevent, in the act of drawing it. **What it costs,
stated rather than glossed:** the automation this layer ships is *"assign it and draft a reply"*, not
*"assign it and send the standard acknowledgement"*. A Butler can still compose a reply, because a draft's
body is authored text; what it cannot do is render a versioned, reusable template.

**Typed case fields stay fog, deliberately.** `case.upsert` is reserved rather than built because typed
fields interact with Layer 5's proof line — editing an approval-bound field invalidates the approval — so
settling them inside an AST ticket would decide Layer 5's shape as a side effect. An untyped JSON bag was
rejected as the option most likely to be regretted rather than revisited: the taint checker's *"validated
against trusted organization state"* cannot mean anything without a schema, and Layer 5 would have no field
revision to bind an approval to.

### One declaration, not two lists

The *status* lives in `NODE_KINDS`. The schema builds its union from that object's own keys; the checker
classifies by reading that object's `status`. Neither can hold an opinion the other does not.

`NODE_KINDS` is declared `as const satisfies Record<string, NodeDeclaration>` and **not** annotated
`: Record<string, NodeDeclaration>`. The annotation compiles, runs identically, and widens `NodeKind` to
`string` — which makes every exhaustive map in the package vacuously satisfiable and lets `isShipped("typo")`
type-check. `test/nodes.test.ts` carries a type-level assertion that fails at `pnpm typecheck` if that ever
happens, because no runtime test can see the difference.

### Reserved means representable and refused, which is a deliberate distinction

A Butler naming `llm.classify` **parses** — it is a member of the discriminated union, with an envelope-only
payload that carries the author's own fields through untouched — and is then refused by the checker with a
reason naming the node. It does not fail to parse. An author writing tomorrow's node gets *"reserved, and
here is why"* rather than *"invalid discriminator value"*.

**The family boundary, stated rather than discovered.** `llm.*` and `connector.*` are families in §16's prose
and are **enumerated** here, because a discriminated union cannot be open. `llm.*` enumerates §16's five
exact names. `connector.*` has no catalogue to enumerate, so it is represented by the single name
`connector.call` — which means `connector.salesforce.upsert` fails at *parse* with "not a node type in
mailda/v1" rather than at *check* with a reserved reason. An open `type` field would fix that and would also
let `mail.send.propse` read as a future feature, which is the worse of the two failures.

---

## The document

```json
{
  "apiVersion": "mailda/v1",
  "kind": "Butler",
  "metadata": { "name": "sales-enquiries", "owner": "team:sales" },
  "trigger":  { "event": "mail.received", "mailbox": "enquiries@example.com" },
  "entry": "assign",
  "nodes": [
    { "id": "assign",      "type": "case.assign",       "caseId": "${event.case_id}",
      "assignee": "${org.rota.on_call}", "next": "acknowledge" },
    { "id": "acknowledge", "type": "draft",             "mailboxId": "${event.mailbox_id}",
      "to": ["${event.from}"], "subject": "Re: ${event.subject}",
      "body": "Thanks — somebody will reply.", "as": "reply", "next": "propose" },
    { "id": "propose",     "type": "mail.send.propose", "draft": "${steps.reply.draft_id}",
      "next": null }
  ]
}
```

A **graph**, not a list: nodes carry explicit successor edges, because §16 promises cycle detection and
cycle detection over a list is a check about nothing.

**`mail.received` is the only trigger.** §16 lists nine trigger families; one is representable, because it
is what `ingress.ts` already produces. A trigger enum admitting `mail.bounced` today would be a Butler that
publishes and never fires — the same failure `policy.ts` refuses for a condition backed by no data.

**`metadata.owner` is an opaque string.** §16's ownership table has six kinds and three of them name objects
that do not exist: there is no `teams` table, no agent delegation, no service identity. Calling it an enum
would make five of six values publishable and inert. Authorship is gated on `org.admin`, the authority
`policy.ts` requires and for the same reason: a program that proposes sends from other people's mailboxes is
governance.

**An expression is an opaque non-empty string.** This package does not parse `${event.message_id}` and does
not pretend to. The taint checker ([#52](https://github.com/Straits-AI/mailda/issues/52)) is what has to
understand the inside of one and the engine is what has to evaluate it; a grammar invented here would be a
third opinion about the same syntax, and the first two do not exist.

**`join` carries no `of` list.** Which branches converge on a node is already written in the graph — it is
every node whose edge points at it — and a second declaration of the same fact is the correspondence problem
ADR 35 rejected for the effect key. It is a **merge, not a barrier**: no fan-out node ships, so at most one
branch is ever live, and claiming it waits for several would be a name overclaiming what runs.

**`map` collects, `foreach` does not.** That is the whole difference and it is why both exist. A `map` that
discarded its results, or a `foreach` that quietly accumulated them, would be a name overclaiming what the
node does.

### No `.max()` anywhere

There is no `maxLength` on a node id, no ceiling on the number of nodes, and no upper bound on `maxItems` or
`wait.seconds`. AGENTS.md's rule is that you cannot write the number, only the receipt, and no measurement
exists behind *"a Butler may have 500 nodes"*. The one real bound is the one that already has a receipt:
`d1.max_row_bytes`, enforced in `src/butlers.ts` where the row is written, with an `E_BUDGET_EXCEEDED` that
names the budget, the limit, the ask and the receipt.

---

## Bounded loops: a bound that is exceeded fails, and never truncates

Every `map` and `foreach` declares its own `maxItems`. At runtime a collection larger than the declared
limit **fails the step and processes nothing.**

Truncation was rejected on the grounds that made conversation merge a refusal: *"replied to 100 of 340
customers and reported success"* is not lost work, it is a system reporting something untrue about work owed
to customers — and a `run.truncated` flag only helps somebody who reads it, while every downstream count
stays false about the world. Continuation across runs was rejected **for this ticket, not on the merits**:
it needs the run identity and step ledger [#50](https://github.com/Straits-AI/mailda/issues/50) and
[#53](https://github.com/Straits-AI/mailda/issues/53) own, and it makes effect keys harder because one
intent spans several runs.

**Iteration and acyclicity are compatible claims.** A loop's body is entered by a `body` edge and returns to
its own loop *implicitly* — the return is not an edge in the graph. So the graph a Butler declares is a DAG,
every cycle in it is a mistake, and repetition is expressible in exactly one place: where a bound is
mandatory. A body node whose `next` points back at its own loop header **is** a cycle and is refused, which
is the case that would otherwise be an unbounded loop wearing a bounded loop's clothes.

### Affordability is #54's, and no number from it is here

The checker verifies that `maxItems` is **present and well-formed**: an integer of at least one. It says
nothing about whether a particular bound can be afforded, and that absence is the decision rather than an
omission.

[#54](https://github.com/Straits-AI/mailda/issues/54) measured the arithmetic and it moved twice in one
week. The subrequest budget is **per Workflow instance, not per step** (a correction to #50), so a bounded
loop spends from the same pot as every other step in the run; and it is **plan-scoped** — 10,000 on Workers
Paid, 1,000 on Free ([#68](https://github.com/Straits-AI/mailda/issues/68)) — while nothing inside a Worker
can detect the plan. Of those two figures the Paid one is measured, twice and from two directions; the Free
one is **documented and not measured**, and `docs/receipts/butler-step-budget.md` carries that label. Both
are repeated here rather than re-derived, and neither appears in this package's code. The rule #54 arrived at is *sum the fixed cost of every non-loop node, add `maxItems ×
per-item cost` for each loop, and refuse publication if the total exceeds the budget with headroom*, which
depends on the whole graph rather than on the loop. Encoding a ceiling here would be a number with no
measurement behind it, in the permissive-looking direction that gets raised by whoever hits it.

---

## Canonical serialization

`JSON.stringify` fingerprints a *document*: it emits keys in insertion order, so the same Butler read from
two editors, or rebuilt by a refactor, hashes differently. Canonical bytes fingerprint the **program**. ADR
35 already mints the send manifest's id from canonical output and
[#60](https://github.com/Straits-AI/mailda/issues/60) already hashes a policy version's canonical
conditions; this is the same discipline applied to a tree.

**What it does not buy, because the obvious sentence here is wrong.** It is tempting to write *"a publish
that changes nothing is refused, and that refusal needs byte-identical to be decidable, which needs this"* —
and it does not. The refusal compares both digests against the published version's, and an AST is *derived*
from its source text, so identical source bytes already give an identical AST: the source digest is what
decides. Canonicalization earns its place on the other column, where it makes `ast_sha256` answer *"is this
the same program?"* independently of how the text was formatted — which is what lets a reformat mint a
version that states plainly that the program did not move.

Three rules:

1. **Object keys are sorted** by UTF-16 code unit.
2. **Arrays keep their order** — `switch.cases` is evaluated in order, `draft.to` is a recipient list.
3. **`null` and `undefined` are dropped**, so absent and null-valued keys serialize identically. They mean
   the same thing here (`next: null` and no `next` are both "the run ends"), and #60 settled that a publish
   changing `undefined` to `null` changed nothing.

Numbers are integers by schema, so a non-integer **throws** rather than being formatted: `0.1` and `1e-1`
are one value with two spellings, and quietly picking one would be the unreliable half of ADR 35's
discipline hiding inside the reliable half.

### Where this differs from `canonicalConditions`, and why

`src/policy.ts` writes its field order out by hand — six named fields in a fixed sequence — and gives the
reason: a hash whose input depends on property order changes when somebody reorders an interface. That works
for six flat fields and does **not** scale to a tree, because a hand-written writer per node kind has a
failure mode a flat record does not: *omission*. A field added to `draft` and not added to `draft`'s writer
would change the Butler without changing its hash — a frozen version whose content moved underneath its own
fingerprint.

So the order is derived from the key *names*. That keeps the property #60 actually wanted — the bytes do not
depend on how the object was built — and removes the omission mode, because every present key is written.
`test/canonical.test.ts` walks the fixture and mutates **every leaf**, asserting the bytes move for each
one, which is what makes "nothing is silently dropped" a check rather than a claim.

### A finding worth carrying forward

**Zod's object parse rebuilds its output in schema order.** So for every field the AST declares, two
documents written in opposite key orders are already identical by the time they are stored — which means a
key-order test routed through the schema passes with the canonicaliser deleted. Found by mutating it. The
load-bearing case is `validate.schema`, a record of unknown whose keys are whatever the author wrote, and
both the package test and the Worker test use one. Relying on that normalisation instead of canonicalizing
would also be a landmine: it is an implementation detail of somebody else's parser, load-bearing on whether
a frozen version is comparable to itself.

---

## Publication is the versioning event

Editing produces a **draft**. Publishing mints the version, whether or not the AST changed. A published
version cannot be edited at all — which *dissolves* the comment-only question rather than answering it:
there is no such thing as editing a published Butler, so the question is only ever about a draft, and
publishing is a deliberate second act.

| state | means |
|---|---|
| `draft` | editable, by replacement. Never executed. At most one per Butler (`btv_one_draft`). |
| `published` | the current program. |
| `superseded` | frozen history. Still readable, because a run binds the version it ran under. |

### What arrives, and why it is one field rather than two

A caller submits **`source`**: the JSON text they authored. The AST is *derived* from it. Accepting an
`(ast, source)` pair would admit a mismatched pair that nothing on this side could detect, so the row would
hold an author's record beside a program it does not describe. Deriving one from the other makes
correspondence a property instead of a hope.

**JSON today, and there is no `source_format` column.** §16's YAML arrives when a YAML parser arrives in the
bundle, with the same derivation and a column then. A column whose only value is `'json'` is the placeholder
shape `placeholder-columns.test.ts` exists to catch.

### Two digests, not one

`ast_sha256` over the canonical AST bytes; `source_sha256` over the source text. A publish is refused only
when **both** match the currently published version. One combined digest would answer the refusal and
nothing else; two answer the question a reader of the history actually asks — *did the program change
between v3 and v4, or only its formatting?* — from the columns, with no re-parse.

The consequence, stated so nobody reads it as a loophole: **reformatting the source mints a version whose
AST is unchanged.** That is #49's decision working as decided. **Changing only key order does not change the
AST bytes**, which is what canonicalization buys.

### Frozen means the database refuses

#60 enforced the same property by discipline plus a test: `src/policy.ts` never writes a content column
after insert, and `test/policy.test.ts` asserts a superseded version's bytes are byte-identical to what was
published. That is a real check and it is one class weaker than what is available here, because it proves
the code does not do it rather than that it cannot.

Migration 0027's **`btv_frozen`** trigger aborts any `UPDATE` that changes a published or superseded
version's `ast_json`, `source_text`, either digest, or its `version`. `test/butlers.test.ts` asserts it by
*trying* — including writing a `NULL` into a frozen column, which a `<>` comparison would have let through
and `IS NOT` does not. The write path still never touches those columns, so the trigger is a tripwire past
where any correct code goes.

**It took a second trigger, and the first version of this document did not know that.** `btv_frozen` names
no state column, so `UPDATE … SET state = 'draft'` committed on a published row — and the next `UPDATE`,
seeing `old.state = 'draft'`, rewrote the AST. Two statements, no error, version 1 a different program;
worse, `editButlerDraft` would then *delete* that row, because a demoted version is indistinguishable from a
draft to `btv_one_draft` and to the `state = 'draft'` predicate. The combined single statement was already
refused, which is exactly why splitting it was worth trying. **`btv_forward_only`** aborts any `UPDATE` that
moves a published or superseded version's state anywhere except `published → superseded`. Rollback in this
product is republication — an old version's source becomes a new version — so nothing good needs the
backwards edge, and `test/butlers.test.ts` asserts the one forward move still works so the clause cannot
be one clause too broad.

**Deletion is deliberately not prevented, and that is the honest statement rather than an omission.** A
matching `BEFORE DELETE` trigger was written and removed. Immutability and indestructibility are different
properties: retention runs through legal hold and the closed world in `content-deletion-world.test.ts`,
machinery no trigger can consult, and an organization-deletion path is a *good widget* that would hit the
tripwire with no override available from inside SQLite, ever. So: nothing in this Worker deletes a published
or superseded Butler version, and nothing prevents it either — exactly where `policy_versions` stands. The
one `DELETE FROM butler_versions` is bounded by `state = 'draft'` and is classified in that closed world,
which is what makes a second, unbounded one fail a test rather than pass unnoticed.

### The AST is a blob, and this is the one place a blob is right

`0019_policy.sql` rejected a JSON blob for policy conditions, and the load-bearing half of its argument was
that a blob **admits a sixth condition nothing evaluates**: any key is storable, so a policy naming `device`
would be publishable and silently inert. That argument does not transfer, and why it does not is the whole
of this ticket: an AST is a program rather than a set of conditions matched in SQL, and its vocabulary is
closed by a generated discriminated union plus a checker that refuses every node outside it. Nothing matches
on the inside of an AST — no query filters by node type, no index would help, and the engine reads the whole
program or none of it.

### Re-checked at publication, and that is not redundant

A draft is checked when written and checked again when published, and the two can legitimately disagree: the
node set is a declaration, and a node moving from shipped to reserved — which is exactly what happened to
`template.render` — makes a stored draft unpublishable. Failing closed at the second gate is the only
behaviour that does not publish a program the current checker refuses.

The re-check's derived digests are **compared, not discarded**. Everything after that point reads *stored*
digests — the no-op refusal and the audit detail — so a draft row whose `ast_json` and `source_text` disagree
would be frozen in that state forever, with the engine reading one column and a person reading the other.
Derivation makes correspondence a property at insert; re-deriving it makes it one at the moment it is frozen,
which is the moment that matters. `E_BUTLER_DRAFT_INCOHERENT` is that refusal, and it is a tripwire: only a
direct write to a draft row reaches it.

---

## The checker's findings

| code | what it catches |
|---|---|
| `E_BUTLER_MALFORMED` | not a `mailda/v1` Butler at all |
| `E_BUTLER_NODE_UNKNOWN` | a `type` nothing declares, with the shipped list in the fix |
| `E_BUTLER_NODE_RESERVED` | a reserved node, named, with `because` as the reason |
| `E_BUTLER_LOOP_UNBOUNDED` | a loop whose `maxItems` is absent or not an integer ≥ 1 |
| `E_BUTLER_NODE_MALFORMED` | a shipped node that does not match its declared shape |
| `E_BUTLER_DUPLICATE_NODE_ID` | two nodes with one id, which makes every edge ambiguous |
| `E_BUTLER_NO_ENTRY` | an `entry` that names nothing |
| `E_BUTLER_EDGE_DANGLING` | an edge pointing at nothing |
| `E_BUTLER_CYCLE` | a cycle, with the path |
| `E_BUTLER_SCHEMA_DIVERGED` | every node checked and the document did not — a bug in this package |

**Every finding is collected, not thrown.** One call reports every problem a Butler has, because a checker
that stops at the first is one somebody runs eleven times — and the reader is an agent fixing its own
mistake, which is the standard AGENTS.md §3 sets.

**Cycles are detected from every node, not only from the entry.** Acyclicity is a property of the graph, and
a cycle in a component nothing reaches today is one the next edit connects.

**Unreachable nodes are not refused,** deliberately. A draft under construction routinely has one, and the
checker refuses what cannot run correctly rather than what is untidy. `E_BUTLER_EDGE_DANGLING` covers the
dangerous half.

### What the checker does not do

- **The taint rules.** §16's *"untrusted content cannot select or construct policy, sender identity, To/CC/BCC…"*
  is [#52](https://github.com/Straits-AI/mailda/issues/52). It needs the inside of an expression, which this
  package does not parse.
- **The capability ceiling.** §16's *"capability ceiling computed at publication"* is
  [#51](https://github.com/Straits-AI/mailda/issues/51), and #54 already noted that the three-term
  intersection it needs would **invalidate** `authz.check.max_queries` rather than fit inside it.
- **Affordability.** #54's, above.
- **Fixtures and simulation.** Still fog.

---

## The `case_` / `cas_` divergence, resolved

`packages/contract/src/send-mail.ts` required `/^case_[0-9A-HJKMNP-TV-Z]{26}$/`. `src/cases.ts` minted a
three-letter case prefix. **A case id this Node produces could not pass its own contract's validation** —
latent only because `caseId` is optional on `mail.send` and nothing populates it. `case.assign` and
`case.close` are shipping Butler nodes that name case ids, which is where latent stops.

**The runtime won and the contract moved**, for a reason about live data rather than taste: the runtime
prefix is on every `cases.id` in every installed Node, so changing it is a rename under live data — a
migration over a primary key, its indexes and every case id a client already holds. The contract's spelling
had never matched anything. One side had a cost and the other had none. **So there is no migration
consequence: no data moves, and no backfill is needed.**

`packages/runtime/src/ids.ts` now holds the registry — `mailbox`, `sendManifest`, `case`, `butler`,
`butlerVersion` — and both the contract and the Worker read it. The pattern is built **from
`ULID_ALPHABET`** rather than written beside it, so a change to what `ctx.id` emits changes what validates
it in one edit.

### What makes a third divergence impossible

`apps/node/worker/test/node/id-prefix-world.test.ts` is a closed world over hand-written identifier
patterns. The rule is not "prefixes must agree" — that is the symptom — it is **no file may write an
identifier pattern at all**, and no file outside the encoder may spell the Crockford alphabet. A pattern
that is not written cannot disagree with anything. It also refuses a registered prefix minted as a literal,
so the registry cannot become a second spelling of its own subject.

`ctx.id(prefix: string)` stays open on purpose: it mints about thirty-five prefixes and the registry names
five. A prefix spelled in one place cannot diverge from anything, so the registry covers exactly the
*validated* set — and the closed world is what keeps that set complete. The test asserts the gap so nobody
reads the registry as total.

### It found a second one the day it was written

`senderIdentityId` required `snd_`, and `snd_` is the **send manifest** — `0007_outbound.sql` says so on the
column itself, *"snd_&lt;ulid&gt;; this IS the effect key"*. A sender identity is a real product concept
(§5, §18) with **no table**, so that field was validating one object's id space against another's.
Registering it as `senderIdentity` would have written the collision down as though somebody had decided it;
two objects sharing one prefix is what typed prefixes exist to prevent. So the entity registered is
`sendManifest`, which is what the runtime mints, and the contract's field lost a shape constraint it was
never entitled to. Nothing can say what a sender identity's id looks like until a sender identity exists.

---

## The SQL splitter grew a parser, because a trigger needed one

`src/migrate.ts` applies the Node's own schema by splitting each migration into statements.
`test/node/migrations.test.ts` used to assert that **no migration contained a trigger**, with the standing
instruction that the moment one was genuinely needed, `statementsOf` should become a real parser rather than
gain a rule about how to write SQL.

`btv_frozen` needed one: a trigger body's inner semicolon is mandatory in SQLite's grammar, so "write it as
one statement with no inner semicolon" was not available. `statementsOf` now carries a **depth counter over
block keywords** — `BEGIN` and `CASE` open, `END` closes, and a `;` at depth > 0 is inside a statement.
`CASE` is counted because SQLite terminates a `CASE` expression with `END` too: a counter that knew only
`BEGIN` would see a `CASE`'s `END`, drop to zero, and cut a future trigger body in half at the next
semicolon — the exact failure the old guard existed to prevent. `END` at depth 0 does nothing rather than
going negative. Keywords are recognised only outside strings, quoted identifiers and comments, which the
tokenizer already consumes.

---

## Audit

Two actions, both riding inside `auditedBatch` so a published version with nothing in the trail is not
representable.

- **`butler.drafted`** — a draft was written or replaced. `detail.replacedDraft` distinguishes the two,
  because a second action for one transaction would make *"who changed this Butler"* answerable from two
  places that can disagree.
- **`butler.published`** — a draft became an immutable version. `detail.runnable` is `false`, said in the
  trail rather than only in a comment, so a reader of the log is not left wondering why nothing happened
  next.

There is no `butler.ran`. A declared action nothing emits is a category of one, which is what
`audit-coverage.test.ts` fails on; the run actions arrive with the engine.

---

## What has no channel yet, and why that is parity rather than a gap

There is no HTTP route, no CLI verb and no UI for any of this. AGENTS.md calls a capability present in one
channel and absent from another a parity bug; **zero channels is parity**, and an authoring surface for a
program nothing executes would advertise a capability that cannot act. The channels arrive with the engine,
generated from the contract rather than hand-written per surface.

A Butler's effects, when there is an engine, pass through Layer 5 unchanged: `mail.send.propose` seals a
manifest, which is where `policy.ts` decides, `approvals.ts` gates and `breakers.ts` trips. Nothing in
`src/butlers.ts` re-implements any of it, and nothing in it may — a Butler is an author of sends, not an
exception to the rules about them.
