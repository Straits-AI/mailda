# The Butler AST

What a Butler *is* as a document, what the checker refuses and why, how a version is frozen, and which
guarantees deliberately live somewhere else. Decided in
[#49](https://github.com/Straits-AI/mailda/issues/49) and its correction; Layer 4; blueprint §16.

**A Butler can be published on this Node, and since [#50](https://github.com/Straits-AI/mailda/issues/50) it
runs.** This document stops at the document: what an AST *is*, what the checker refuses, and how a version
freezes. What executes one — the interpreter, the Butler's own principal, the human-release gate on a
proposed send, the run record, and where a real run's cost disagrees with this package's prediction of it —
is [`butler-engine.md`](./butler-engine.md).

Two things decided here that the engine leans on hardest, so they are worth naming before you leave: an
`Expr` is an **opaque non-empty string** to this package and the engine is what evaluates it, and a
**reserved node parses and is refused with a reason**. The engine re-runs `checkButler` at the start of every
run, at no subrequest cost, because a stored AST is data and data can be edited by whoever holds the
database — so the refusals below are enforced twice, at publication and again before any effect.

---

## Where each piece lives

| | |
|---|---|
| `packages/butler-ast/src/nodes.ts` | the node set: one declaration of shipped and reserved, read by the schema *and* the checker |
| `packages/butler-ast/src/ast.ts` | the Zod 4 schema, the generated discriminated union, the emitted JSON Schema |
| `packages/butler-ast/src/canonical.ts` | canonical serialization, and the two digests a version stores |
| `packages/butler-ast/src/graph.ts` | the successor edges and reachability, read by the checker *and* the cost pass |
| `packages/butler-ast/src/cost.ts` | the price list, the whole-graph arithmetic, and which plan's pot it divides |
| `packages/butler-ast/src/check.ts` | the checker and its findings |
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

## No node takes a recipient (#52)

§16's sink sentence names eleven things untrusted content may not select or construct: *"policy, sender
identity, To/CC/BCC or forwarding destination, attachment, integration/egress URL, connector
operation/target record, financial/account identifier, secret reference, model profile or permission."*

Exactly one of them landed on a real parameter of a shipped node. `draft` took `to: z.array(expr).min(1)`, an
`Expr` may read `event.*`, and `event.*` **is** the inbound message. So a published Butler could send to an
address chosen by the mail it was answering — §16's redirection sink, open. Nothing objected, because the
guard that would have objected is the tripwire #52 asked for and it did not exist yet: the absent guard and
the open sink were one omission.

**The parameter is gone rather than checked.** A check has to stay right for ever; an absent parameter has
nowhere for a value to arrive. The Node derives a Butler's recipients from the delivery that triggered the
run — see [the engine doc](butler-engine.md#who-a-butlers-reply-goes-to) for where the address comes from and
what happens when there is none.

**The cost, stated here rather than in a commit message: a Butler cannot CC a colleague, cannot add a
supervisor, and cannot forward anything.** Each of those means naming a recipient who is not the
correspondent, which needs a *trusted* recipient — a contacts table, an allowlist, a suppression list — and
no such store exists anywhere in the schema. They arrive with that store, not with a parameter that would
accept whatever an expression produced.

Two things keep the sink closed, and neither knows a forbidden word:

- **A shipped node's shape is strict.** `z.object` *strips* an undeclared key, so removing `to` on its own
  would have made a Butler naming `to` publish with the field silently discarded — an author certain they had
  chosen who this Node writes to. `z.strictObject` makes it `E_BUTLER_NODE_UNKNOWN_PARAMETER` instead, and
  that one refusal covers `to`, `cc`, `bcc`, `recipients`, `escalateTo` and `forwardTo` alike, because none of
  them is a parameter of anything. A list of forbidden names would be a guard against the spellings whoever
  wrote it thought of.
- **The parameter surface is pinned by a test.** `test/sinks.test.ts` asserts two properties: every parameter
  of every shipped node is built from a *named* schema in `FIELD_KINDS` — so a fresh `z.array(expr)` at a call
  site fails — and the whole surface equals a written-out list, so **any** new parameter on **any** shipped
  node fails, whatever it is called. Said plainly: that does not prove a new parameter is safe. No
  schema-level rule can tell an `Expr` holding a case id from an `Expr` holding an email address, because
  they are the same type. What it proves is that nobody can add one without being told to answer §16's
  question about it.

### The other ten sinks, re-verified

The list of "already unreachable" was written before the engine existed, so it was re-read against the code
rather than trusted. Nine hold. Two need correcting, and one of the corrections matters.

| sink | where it stands |
|:--|:--|
| **sender identity** | **Correction.** *"Closed structurally, `From` is derived from `addresses`"* is half the story: `From` is derived from the **mailbox**, and `draft.mailboxId` is an `Expr`, so untrusted content can reach it. Closed by *validation against trusted organization state* — §16's own escape clause — rather than by construction: `saveDraft` and `sealManifest` both bound the choice to mailboxes an administrator granted this Butler `send.propose` on. Asserted in `test/butler-run.test.ts`, both arms. |
| **policy** | **Correction.** *"Policy has no table"* is out of date — `0019_policy.sql` exists and `recipient_external` and `mailbox_id` are live conditions. So policy *selection* rode on the recipient parameter, and closing that closed this too; what remains is the mailbox, bounded as above. |
| To/CC/BCC | Closed by construction — no parameter (this section). |
| forwarding destination | No node, and no forwarding code anywhere in the Worker. |
| attachment | No attachment field on `DraftInput` or `Composition`; the only attachment concept in the Worker is the audit name for a raw-evidence read. |
| integration/egress URL | `connector.call` is reserved. `validate`'s inline schema is the only URL-shaped thing a node carries, and `$ref` and `format` are refused by name — nothing fetches. |
| connector operation / target record | `connector.call` is reserved. |
| financial/account identifier | No such column in any table. |
| secret reference | Nothing in `src/butler/` reaches the key vault; encryption picks its own generation. |
| model profile | Every `llm.*` node is reserved. |
| permission | `grant`/`revoke` are `org.admin` HTTP routes no node calls. `case.assign`'s assignee is validated by `claim` against the assignee's own tuples, which is the escape clause again. |

Two smaller things found in the same pass, recorded because they are easy to mistake for holes. `is_reply` is
a policy condition and `inReplyTo` is an expression, so content can in principle select it — but only by
naming a message id it would have to guess *and* that the Butler may read, and a miss is `E_NO_SUCH_PARENT`
rather than a silent flip. And a Butler on a **multi-address mailbox cannot send at all**: `senderAddress` is
not a node parameter, so `sealManifest` refuses with `E_SENDER_AMBIGUOUS` rather than picking one. That is the
sender-identity sink closed by refusal, and it predates this ticket.

**`inReplyTo` stays an author's expression, and that is a decision.** Threading is not one of the eleven, and
it is already bounded by authority: `sealManifest` refuses a parent the author cannot read
(`E_NO_SUCH_PARENT`), which is the check the reply-parent hole was closed with. So a Butler may thread a reply
onto any message in a mailbox it may read — exactly what a person may do — while the addressing still comes
from the trigger. Where the two disagree the addressing wins, because the trigger is the delivery the run is
provably about.

**The human path is untouched, and that was verified rather than assumed.** `saveDraft` stores the caller's
recipient list and derives nothing from `inReplyToMessageId`; the API hands it `body.to` straight from the
request. A person may still reply to a colleague, CC records, and thread it onto a customer's message.
`test/drafts.test.ts` pins that, so a later change that made the store derive recipients would fail there —
and would silently hand every Butler a recipient again, since a Butler's draft goes through the same
function.

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
      "subject": "Re: ${event.subject}",
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

**A node's own fields may not be called `id` or `type`, and that is a compile error.** Found by
[#54](https://github.com/Straits-AI/mailda/issues/54), which needed a `lookup` fixture in order to price
one and could not write a usable `lookup`. Its schema was `{ entity, id: expr, as, next }`, and the helper
that builds a shipped node spreads a node's own fields *after* the envelope's — so that `id` silently
replaced the node's identifier. The node had **four** fields where it should have five, one `id` doing two
jobs: a `lookup` could not both be pointed at by an edge and say which row to read, and its identifier had
escaped the `nodeId` pattern entirely, making `id: "${event.case_id}"` a legal node name that every other
node type would have refused. The field is `entityId` now, and the helper's signature (`id?: never`) makes
the collision fail `pnpm typecheck` rather than depending on anyone remembering. `test/nodes.test.ts` also
asserts at runtime that every node type's `id` is the same `nodeId` schema object, so a shape that shadowed
it with anything at all — even another `nodeId` — fails twice.

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

### Affordability: a second refusal, over the whole graph

The checker verifies that `maxItems` is **present and well-formed** — an integer of at least one — and then
prices the graph. [#54](https://github.com/Straits-AI/mailda/issues/54)'s rule, from
`docs/receipts/butler-step-cost.md`: *sum the fixed cost of every non-loop node, add `maxItems × per-item
cost` for each loop, and refuse publication if the total exceeds the budget with headroom.*

This section used to say the opposite — that no number from that arithmetic was here, and that the absence
was the decision. It was, for as long as the arithmetic was moving: the pot is **per Workflow instance, not
per step** (a correction to #50), so a loop spends from the same pot as every other step in the run, and it
is **plan-scoped**, 10,000 on Workers Paid and 1,000 on Free
([#68](https://github.com/Straits-AI/mailda/issues/68)), while nothing inside a Worker can detect the plan.
Both figures stopped moving and the plan question was answered, so the seam is filled.

**Where the numbers live: `@mailda/budgets`, and that seam was checked rather than assumed.** The costs are
Worker measurements — `metering()` in `workerd` against real D1 and R2 — and this package cannot import the
Worker, being a dependency of it. `@mailda/budgets` is generated from `docs/receipts/*.md` and has no
dependencies of its own, so what `src/cost.ts` imports is the compiled form of the **receipts**, not of the
Worker. `pnpm receipts:check` fails on any hand edit, and one figure serves both the measurement test that
produced it and the checker that divides it. The two alternatives are named in that file with what each
costs: injecting the table as a parameter lets two callers disagree about what a Butler costs and makes the
pinned tests pin nothing; writing the numbers in this package is the thing AGENTS.md forbids outright.

**The pot divided is Workers Paid, chosen rather than inherited.** A Node cannot ask which plan it is on —
`doctor`'s check is `severity: "report"`, *"Not checkable from inside a Worker"* — so this is a decision, and
`src/cost.ts` carries the argument at the point of use. Three reasons: on the Free row a `foreach` of 200
sending items costs 4,038 and is refused four times over, which puts the limit *before* where a good Butler
goes and AGENTS.md says that makes the limit wrong rather than the widget; the permissive direction lands only
on a plan ADR 25 refuses at install and `mailda deploy` enforces with an account token; and an unusably small
bound has a named failure mode in that receipt — it *"gets raised by whoever hits it, without re-measuring"*.

**What the rejected row would have bought is stated, not glossed.** A Free Node is unsupported but not
impossible: `deploy-button-install.md` measured the one-click path and it verifies no plan. On one, a Butler
this pass admits can die at item 50 of a 200-send loop, having already sealed 50 manifests. So every refusal
prints **both** pots and the affordable `maxItems` under each.

**Headroom is per node and already receipted.** The four cost figures are *"bounds with headroom, not the
measured figures"* — `case.assign` 8 against a measured 5, `case.close` 3 against 1, `draft` 10 against 5,
`lookup` 4 against 1 — so summing the bounds over-prices every graph by construction. There is deliberately
no second global margin, because 80% of a pot would be a literal ceiling with no measurement behind it, in
the one file whose whole subject is numbers that have one.

**`butler.step_cost_max_send_propose` is the exception and its headroom is zero.** 20, against a worst
realistic seal measured at 20 — a reply, both derived policy conditions, an approval gate and the breaker
query. It holds, and it is exactly right for the worst path rather than permissive. It is one operation away
from being permissive, and the day a send gains one the measurement test fails, which is the intended
behaviour.

**The price list is exhaustive over the shipped set by construction.** `src/cost.ts` maps every
`ShippedKind` to a receipt key or an explicit `null`, so a node moving from reserved to shipped with no
entry does not compile. That is the enforcement behind the receipt's `stale_when` clause *"a node type is
added to the shipped set without a measurement here"*, which was an unenforced sentence — and already
violated by `lookup`, `map` and `foreach` at once. `lookup` is measured now at 1 subrequest for every one of
`LOOKUP_ENTITIES`; `map` and `foreach` are **0**, and that is an argument rather than a measurement, labelled
as such: a loop evaluates an expression already in the run's state and enters an edge, and
`butler-step-budget.md`'s probe measured 30 steps of 100 queries closing at exactly 3,000, so a `step.do`
costs no subrequest of its own.

**So a loop whose body performs no I/O is affordable at any bound, including a million.** In subrequests that
is true, and subrequests are the only currency here with a measurement behind them: CPU cannot be metered
from inside a Worker at all, which is why the receipt records *"which limit binds first, CPU or subrequests,
is unestablished"*. `test/check.test.ts` asserts that case **publishes**, so the boundary of the claim is
pinned in the same place as the claim. Inventing a per-iteration cost to make a million look handled would
have been exactly the defect this mechanism exists to prevent.

**The arithmetic an author reads is 498, not 500.** The receipt's headline `10,000 / 20 = 500` is what a
sending loop costs *alone*, and no loop is alone — the four other nodes of the worked example have already
spent 38:

```
E_BUTLER_UNAFFORDABLE  this Butler costs 10018 subrequests per run against
                       workflow.paid.subrequest_budget_per_instance=10000;
                       6 node(s) outside a loop cost 38;
                       foreach fan_out costs maxItems=499 × 20 per item = 9980
                       (dearest inside it: send_one, a mail.send.propose at
                        butler.step_cost_max_send_propose=20)
  node     fan_out
  why      a Workflow instance has one subrequest pot for the whole run rather than one per step
           (workflow.budget_unit_is_instance=1, measured), so a run that asks for more does not fail
           a step and carry on — the invocation is killed wherever it has got to, mid-loop, after the
           sends it already performed. ...
  fix      lower fan_out's maxItems to 498 or fewer, which is what is left of the pot after the rest
           of the graph, or take work out of the loop's body. This Node prices against Workers Paid
           because ADR 25 requires it; on Workers Free the pot is
           workflow.free.subrequest_budget_per_instance=1000 and fan_out's affordable maxItems there
           is 48. receipt docs/receipts/butler-step-cost.md
```

**The two failures it sits between are different, and the refusal says which is which.** An exceeded
`maxItems` fails the step and processes nothing. An overspent pot is the platform killing the invocation
wherever it had got to, after the effects it already performed — which is precisely why this one is a
publication-time refusal and the other is a runtime one.

**Nested loops multiply.** A node's cost is multiplied by the bounds of every loop whose body reaches it, so
a loop of 200 inside a loop of 200 is priced at 40,000 iterations rather than 400. Written as a multiplier
rather than a recursion over bodies because the recursive form has to subtract nested bodies out of their
parents to avoid double counting, and that subtraction is the arithmetic this repository has been off by one
in twice. Products saturate at `Number.MAX_SAFE_INTEGER` and the refusal then says *"at least"*, because a
total that silently lost precision would be a wrong number in whichever direction the rounding fell.

**The breakdown adds up to the total, and the node it names is one that is actually at fault.** Two things
follow from that and neither is cosmetic. *"Outside a loop"* means **not in any loop's body**, rather than
"runs once": a `maxItems: 1` loop runs its body once, so pricing by multiplier put that body in the fixed sum
*and* in the loop's own line, and the parts of the refusal stopped summing to the total printed beside them.
And a loop that contributes **0** — a `foreach` over pure transforms — is described but never blamed: it is
not the `node` the finding points at and it does not turn a chain's overspend into a death *"mid-loop"*. That
is the same rule as the 3,334-`case.close` case, which names no node because the "dearest" of 3,334 identical
nodes is whichever the scan reached first, applied to the one node that is provably not the reason.

**It runs last, and only on an otherwise clean graph.** A dangling edge means a node the sum cannot find; an
unbounded loop means a `maxItems` there is nothing to multiply by; a reserved node means an operation nobody
has priced. A cost computed over any of those is a fabricated number in a refusal, which is worse than a
missing one — it ends the reader's question instead of prompting it. The cost is still returned on the
**success** path, so an author who fits can see the bill rather than only hearing about it when it is too
much.

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
2. **Arrays keep their order** — `switch.cases` is evaluated in order, `nodes` is a list. (`draft.to` was
   the third example here and is gone: a Butler names no recipients — see the section above.)
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
| `E_BUTLER_NODE_UNKNOWN_PARAMETER` | a parameter the node's kind does not declare — which is how "no node takes a recipient" is enforced against every spelling (#52) |
| `E_BUTLER_DUPLICATE_NODE_ID` | two nodes with one id, which makes every edge ambiguous |
| `E_BUTLER_NO_ENTRY` | an `entry` that names nothing |
| `E_BUTLER_EDGE_DANGLING` | an edge pointing at nothing |
| `E_BUTLER_CYCLE` | a cycle, with the path |
| `E_BUTLER_UNAFFORDABLE` | a graph whose whole-run cost exceeds one Workflow instance's subrequest pot, with the arithmetic |
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

- **Dataflow analysis.** §16's *"untrusted content cannot select or construct policy, sender identity,
  To/CC/BCC…"* is [#52](https://github.com/Straits-AI/mailda/issues/52), and #52 **reversed** the plan to
  build a checker for it at this layer. The reason is stated in "No node takes a recipient" above: with the
  sink closed by construction there is nothing a dataflow checker could refuse, so a green suite would prove
  only that the analysis never fired — a shape this repository was bitten by three times in one day. What
  this package does instead is refuse a parameter no node declares, which is testable today because it is a
  property of the node schema rather than of a dataflow. The analysis arrives with the first node that has a
  real sink: `connector.*` or `llm.*`, both Layer 6.
- **The capability ceiling.** §16's *"capability ceiling computed at publication"* is
  [#51](https://github.com/Straits-AI/mailda/issues/51), and #54 already noted that the three-term
  intersection it needs would **invalidate** `authz.check.max_queries` rather than fit inside it.
- **CPU.** Unmeterable from inside a Worker, so which of CPU and subrequests binds first is unestablished
  and this package claims nothing about it. See the affordability section.
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
