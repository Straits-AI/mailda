---
id: butler-step-cost
kind: measured-tripwire
measured_on: 2026-08-14
stale_when: >
  a node's implementation gains or loses an I/O operation; the vault key fetches become cached, which would
  remove one to two subrequests from every evidence read and write; either per-instance subrequest budget in
  butler-step-budget.md changes, the Paid one or the free sibling, both of which the loop arithmetic below
  divides; a batch stops being one round trip; or a node type is added to the shipped set without a
  measurement here
values:
  butler.step_cost_max_case_assign: 8
  butler.step_cost_max_case_close: 3
  butler.step_cost_max_draft: 10
  butler.step_cost_max_send_propose: 20
---

**Measured:** `test/butler-step-cost.measure.test.ts`, in the real `workerd` runtime against a real D1 and R2,
using `src/cost-meter.ts`. Not counted by reading — the counts were read first, and one of them was wrong.

## Why a new instrument was needed before a number

`doctor.ts` already had a cost meter and it could not do this job. It counts **`prepare`** rather than
execution, prices a `batch()` at its statement count rather than as one round trip, and cannot see Durable
Object RPCs at all. For `mail.send.propose` it would have reported **6** against a measured **10** — a 40%
undercount, and a `maxItems` derived from it would have been 40% too permissive, which is the direction that
fails under load.

`test/node/doctor-meter-honesty.test.ts` pins why doctor's own figure is nonetheless true, and says the meter
must not be reused. `src/cost-meter.ts` is what to use instead.

## Observed

| Node | Subrequests | D1 executions | batches | R2 ops | DO RPCs |
|:--|--:|--:|--:|--:|--:|
| `case.close` | **1** | 1 | 0 | 0 | 0 |
| `case.assign` | **5** | 5 | 0 | 0 | 0 |
| `draft` | **5** | 3 | 0 | 1 | 1 |
| `mail.send.propose`, new thread | **10** | 6 | 1 | 2 | 2 |
| `mail.send.propose`, reply | **14** | 8 | 1 | 3 | 3 |
| `guard`, `switch`, `join`, `wait`, `stop`, `transform`, `validate` | **0** | — | — | — | — |

Three results worth more than the totals.

**Fifty recipients cost exactly what one costs — 10 either way, measured.** The per-recipient inserts ride
inside a single `batch()`, so recipients are free. The old meter would have counted fifty, and a loop sized
against that would have been wrong by a factor of fifty in the *conservative* direction, which is its own
problem: an unusably small bound gets raised by whoever hits it, without re-measuring.

**A reply costs 14, not the 13 that was counted by reading.** One operation was missed. The gap is small and
the lesson is not: a figure read off the source is a hypothesis, and this is the second time today that
counting-by-reading has been off by one in a way only execution revealed.

**Both vault key fetches are uncached, and they are visible now.** `openingKey` on every evidence read,
`sealingKey` on every write, each a fresh Durable Object RPC — 2 of the 10 for a new-thread send and 3 of the
14 for a reply. This is the single most promising thing to change if a Butler ever needs a cheaper send, and
it was invisible to the previous instrument.

## The arithmetic a checker has to do

`butler-step-budget.md` establishes **one subrequest pot per Workflow *instance*** — for the whole run, not
per step — and the size of that pot **depends on the customer's Cloudflare plan**. At the reply-send bound of
20, there are two rows and a checker needs both:

```
Workers Paid   10,000 / 20  =    500 sends exhausts an entire run
Workers Free    1,000 / 20  =     50 sends exhausts an entire run
```

**A Node cannot tell which row it is on.** `doctor`'s plan check is `severity: "report"`, `ok: true`, detail
*"Not checkable from inside a Worker"* — there is no account API from inside a Worker, so the plan is not
observable at runtime and a bound cannot be selected by looking. ADR 25 refuses Workers Free at install and
`mailda deploy` enforces it with an account token, but `deploy-button-install.md` measured the one-click path
and it verifies no plan at all, so a Free Node is unsupported rather than impossible.

**Which row a publication-time refusal should use is deferred, not chosen here.** The Paid row admits a
Butler that dies mid-run on Free — permissive, the direction that fails under load. The Free row imposes a
bound a tenth the size on the supported configuration, which is the failure named below: an unusably small
bound *"gets raised by whoever hits it, without re-measuring"*. No code holds either bound today — the AST
checker does not exist — so the honest state is both rows recorded, plan-named, and the choice made in the
open by whoever writes it. The Paid figure is measured; the Free figure is documented and not measured, and
`butler-step-budget.md` labels it as such.

So on Paid **a `foreach` of 500 sending items consumes the whole budget**, and a loop of 200 — the number this
repository reaches for elsewhere — spends 4,000, which is 40% of the run in one step. On Free that same loop
of 200 is **four times the entire run**: the pot is empty at item 50 and the instance dies mid-loop, having
already sent 50 messages it cannot finish accounting for.

**This is why the checker cannot price a loop in isolation.** `maxItems` must be checked against what the
rest of the AST already spends, and the AST ticket's publication-time refusal therefore needs the whole
graph's cost, not the loop's. Stated as a rule: *sum the fixed cost of every non-loop node, add
`maxItems × per-item cost` for each loop, and refuse if the total exceeds the budget with headroom.*

## Sized

The four values are **bounds with headroom, not the measured figures**, and deliberately so. An equality
assertion on an I/O count fails on every harmless refactor and gets deleted; these exist to catch a node
becoming an order of magnitude more expensive, which is what makes a derived `maxItems` unsafe.

- `butler.step_cost_max_case_assign = 8` — measured 5.
- `butler.step_cost_max_case_close = 3` — measured 1.
- `butler.step_cost_max_draft = 10` — measured 5.
- `butler.step_cost_max_send_propose = 20` — measured 10 new-thread, 14 reply. The bound covers the reply
  with room, and is the figure the loop arithmetic above uses.

## What is deliberately not here

**CPU.** It cannot be metered from inside a Worker: `authz-check-rows-read.md` records that
`performance.now()` is Spectre-clamped and reported `p50 = 1.000ms` for every scenario including the
pathological one. The one measured CPU cliff in this repository is in the render path —
`body-render-bounds.md` measured 34,952 ms for 50,000 attributes, past the limit, request killed — and no node
in the shipped set reaches it, because `template.render` was moved to reserved-and-rejected on finding that
no template subsystem exists. **Which limit binds first, CPU or subrequests, is therefore unestablished**, and
the two CPU figures in circulation for a Workers invocation (5 minutes, 30 seconds) have not been reconciled
either. The subrequest bound is the one with a measurement behind it, so it is the one the checker uses.

## The instrument's coverage is a property, not a claim

Added 15 August 2026, and the reason is worth as much as the change.

The meter originally proxied `CATALOG`, `EVIDENCE` and `KEY_VAULT` and **said so in its own header**: that
`env.EMAIL.send` and the queue producer were uncovered, that nothing priced reached them, and that widening
would be needed first. Every part of that was true and it was still the wrong shape. **A gap named in a
comment is a gap nothing enforces**, and pricing a node that reached the transport would have under-reported
in the **permissive** direction — the direction that fails under load rather than in review.

So the world is closed. Every binding `wrangler.jsonc` declares is classified in `src/cost-meter.ts` as
metered or free; reading an unclassified one **throws**, naming what to do; and
`test/node/cost-meter-coverage.test.ts` reads the binding list **from the config** and fails at test time if
one is unaccounted for. Proved by declaring a binding the meter does not know and watching both guards fire.

`OUTBOX_SWEEPER` is metered despite nothing priced reaching it, because *"nothing reaches it today"* is
precisely the assumption that expired for the transport the moment a Butler node was going to hand bytes over.

**The figures above are unchanged by the widening**, which is the expected result and is now demonstrated
rather than assumed: `transportSends` and `queuePublishes` measure **0** for every node in the table.

This is the same correction, in miniature, that `doctor-check-cost.md` needed when its `stale_when` named the
exact condition that had already invalidated it. A documented limitation and an enforced one are different
kinds of object, and this project keeps finding that out.

### Correction, 18 August 2026: "reads the binding list from the config" was half of it

**No value in this receipt moves and no `stale_when` clause fired** — the correction is to the sentence above,
which overstated what the guard did. `test/node/cost-meter-coverage.test.ts` read the binding *names* from the
config, but the *block types* it looked in were a list of five inside the test itself (`d1_databases`,
`r2_buckets`, `send_email`, `kv_namespaces`, `secrets_store_secrets`), directly under a comment claiming the
names were read from the config precisely so no hand-maintained list could stop matching it. A `[[workflows]]`
block — Layer 4's Butler engine, and so the next block this config is likely to gain — was invisible to it, and
its binding would have been priced as **free** with nothing firing (#71).

Fixed by closing the world one level up, in the shape `src/cost-meter.ts` already used for binding names:
`test/node/wrangler-world.ts` classifies every top-level key of `wrangler.jsonc` as a binding block or a field
that binds nothing, and an unrecognised key fails. `test/node/deployability.test.ts` shares that module rather
than keeping its own second, differently incomplete rule. Counted on the day: 15 top-level keys, 5 binding
blocks and 10 non-binding fields. Proved by declaring a key nothing classifies and watching both guards fire,
then by declaring a real `workflows` block and watching the meter's guard name its unclassified `BUTLER`
binding — which is the failure this correction exists to have caused.

### Correction, 19 August 2026: the closed world stopped at the top level, and `env` was the hole

**No value moves and no `stale_when` clause fired here either.** Verifying the correction above re-counted its
figures by parsing `wrangler.jsonc` with `jsonc-parser` and grouping the keys: **15** top-level keys, **5**
binding blocks (`d1_databases`, `r2_buckets`, `send_email`, `durable_objects`, `queues`) and **10** non-binding
fields — unchanged, so that sentence stands. Both proofs reproduced: an unrecognised top-level key failed both
tripwires, and a declared `[[workflows]]` block made the meter's guard report *"BUTLER declared in
wrangler.jsonc but absent from src/cost-meter.ts"*.

What did not stand was the reach of "every top-level key". `env` was admitted as a non-binding field on the
stated grounds that each environment under it is "a scope classified in its own right", while both tripwires
only ever reached for `env.test` **by name** — so a second named environment declaring a binding block was
classified by neither. That is the same hole one level down, in the same permissive direction, and it was a
reason given in a comment that nothing enforced. `unclassifiedKeys` now descends into every value under `env`
by iteration, and a stranger key planted in an `env.staging` fails it. `env.test` today declares 5 keys, all 5
of them binding blocks, matching the top level exactly.

### Correction, 19 August 2026: the loop arithmetic had one row and needed two (#68)

**No value in this receipt moves and no `stale_when` clause fired** — the four bounds are properties of
Mailda's own nodes and no plan changes what the code does. What changed is the division above it. *"The
arithmetic a checker has to do"* divided **10,000** by the reply-send bound and stopped, and 10,000 is the
**Workers Paid** figure: `workflow.subrequest_budget_per_instance` carried no plan in its name, so the
arithmetic inherited a plan it never mentioned. On Workers Free the pot is 1,000 and the answer is **50, not
500** — a tenth, in the permissive direction, in the sentence that also states the rule a publication-time
checker is meant to apply.

Both rows are now shown, each says which plan it assumes, and the section says plainly that a Node cannot tell
which it is on and that the choice of row for a derived bound is deferred rather than made. The two budget keys
are `workflow.paid.subrequest_budget_per_instance` and `workflow.free.subrequest_budget_per_instance`; the
Paid one is measured twice from two directions, the Free one is documented and explicitly not measured, and
`butler-step-budget.md` carries both labels and the published sources.

`test/butler-step-cost.measure.test.ts` asserts both rows, so the arithmetic here cannot fall out of step with
the budgets it divides, and `test/node/budget-plan-scope.test.ts` fails if either key stops naming its plan.

### Correction, 20 August 2026: the `stale_when` fired — `mail.send.propose` now evaluates policy (#60)

**No value in this receipt moves.** The four bounds are unchanged and all four still hold. What moved is the
measured figure behind one of them, and the `stale_when` clause that fired is its first: *"a node's
implementation gains or loses an I/O operation."* Layer 5's policy object puts the policy decision inside
`sealManifest`, which is `mail.send.propose`, so the node gained one query — and up to three.

Re-measured on the day by `test/butler-step-cost.measure.test.ts` and
`test/policy-cost.measure.test.ts`, both in `workerd` against real D1 and R2 through `src/cost-meter.ts`:

| `mail.send.propose` | Before (14 Aug) | Now | D1 | batches | R2 | DO RPCs |
|:--|--:|--:|--:|--:|--:|--:|
| new thread, no policies published | 10 | **11** | 7 | 1 | 2 | 2 |
| reply, no policies published | 14 | **15** | 9 | 1 | 3 | 3 |
| new thread, both derived conditions in play | — | **13** | 9 | 1 | 2 | 2 |
| reply, both derived conditions in play | — | **17** | 11 | 1 | 3 | 3 |

**Why the increase is one and not three.** Evaluation reads the published policy set (one query) and then
fetches the two *derived* inputs — the organization's domain set for `recipient_external`, today's counter for
`org_daily_volume` — **only when some published policy constrains them**. A Node with no policies, or with
policies on mailbox, actor and reply only, pays one. Three is the ceiling.
`docs/receipts/policy-evaluation-cost.md` carries the full table and the argument for evaluating the predicate
in TypeScript rather than pushing it into SQL, which is what buys that.

**The worst realistic send is now 17 against a bound of 20**, so the headroom that made these bounds
comfortable has narrowed from 6 to 3 on the reply path. Stated rather than glossed, because it is the figure a
reader would want and because raising the bound is not free: `butler.step_cost_max_send_propose` is what the
loop arithmetic above divides, so 25 would take the Paid row from 500 sends to 400 and the Free row from 50 to
40. The bound is left at 20 — it still holds against the measurement, and moving it would change a published
figure to buy comfort rather than correctness. **What would force it up** is a sixth condition, a derived
condition needing more than one query, or #62's dispatch-time recheck landing on the same path.

**The other three nodes are unchanged and were re-measured rather than assumed**: `case.assign` 5,
`case.close` 1, `draft` 5. The fifty-recipient result also stands — 11 for one recipient and 11 for fifty,
because the per-recipient inserts still ride inside one `batch()` and policy evaluation is per envelope rather
than per recipient.

**The loop arithmetic above is unaffected**, both rows, because it divides the bound rather than the measured
figure and the bound did not move. `test/butler-step-cost.measure.test.ts` still asserts 500 and 50.

## Correction — 20 August 2026 (#61)

The `stale_when` fired on its first clause — *"a node's implementation gains or loses an I/O operation"* — for
`mail.send.propose`, and only on the path where a policy requires approval. Re-measured with the same
instrument in the same runtime (`test/policy-cost.measure.test.ts`, `test/approval-cost.measure.test.ts`):

| Path | 18 August | Now |
|:--|--:|--:|
| `mail.send.propose`, new thread, no policies | 11 | **11** |
| `mail.send.propose`, new thread, gated by a hold | 11 | **11** |
| `mail.send.propose`, new thread, gated by an approval | 13 | **15** with both derived conditions, **13** without |
| `mail.send.propose`, reply, worst realistic policy set | 17 | **19** |

The two extra operations are #61's: the stage set of the matching `require_approval` versions, and the eligible
approvers on the mailbox. They are lazy — a seal that no policy gated, or that a hold gated, pays nothing.

**`butler.step_cost_max_send_propose` stays at 20, and the headroom is now 1.** Said plainly rather than
smoothed over: the worst realistic seal measures 19 against a bound of 20, so this bound has stopped being a
tripwire *past where any good widget goes* and is now one operation above the widget. That is deliberate for
exactly as long as it takes somebody to add the next operation to the send path, and here is what they should do
when the assertion fails:

- **Do not raise the number to make a test pass.** Re-measure, then decide.
- Raising it changes the loop arithmetic above, and that arithmetic is what a publication-time refusal on a
  Butler `foreach` would divide. On Paid, 10,000 / 20 = 500 sends per run; at 24 it is 416, at 30 it is 333.
- The alternative to raising it is making a send cheaper, and the largest single item is still the **two
  uncached vault key fetches** this receipt already names as the most promising thing to change.

Choosing between those needs the AST checker that divides this bound, and it does not exist — so the honest
state is the measurement recorded, the headroom named, and the decision left in the open for whoever trips it.
That is the same shape this receipt already uses for the Free-versus-Paid row.
