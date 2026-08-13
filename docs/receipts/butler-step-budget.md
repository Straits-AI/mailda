---
id: butler-step-budget
kind: platform-limit
measured_on: 2026-08-13
stale_when: >
  Cloudflare changes the per-invocation subrequest ceiling again; a Workflow instance stops being one
  invocation for the purposes of that ceiling, which would make the budget per step and invert this
  result; the Worker starts declaring a limits.subrequests block, which overrides the platform default;
  or D1 gains a query ceiling of its own, which this measurement shows it does not currently impose
values:
  workflow.subrequest_budget_per_instance: 10000
  workflow.budget_unit_is_instance: 1
---

**Measured:** a scratch Worker (`mailda-budget-probe`) with a `[[workflows]]` binding and a scratch D1,
running a generic workflow whose steps each perform a counted number of sequential D1 queries. Deployed,
escalated until it broke, and deleted. Steps **report** rather than throw, because a thrown step is retried
and the retry spends from the very budget under test.

This exists because [What one Butler step costs](https://github.com/Straits-AI/mailda/issues/54) cannot pick
a `maxItems` without it, and because the resolution of *What executes a Butler run* asserted the answer from
the documentation and asserted it **wrongly** in its first form.

## The budget is per instance, not per step

Three runs settle it.

| Run | Requested | Completed | Outcome |
|---|---:|---:|---|
| 30 steps × 100 queries | 3,000 | **3,000** | complete |
| 1 step × 1,500 queries | 1,500 | **1,500** | complete |
| 1 step × 12,000 queries | 12,000 | **10,000** | `Too many API requests by single Worker invocation` |
| 20 steps × 1,000 queries | 20,000 | **9,991** | same error, at step 9 of 20 |

The last row is the decisive one, and its arithmetic closes exactly. Nine steps completed 1,000 queries each
(9,000), each wrote one progress row (9 more), and the tenth step managed 991 before the ceiling — **9,000 +
9 + 991 = 10,000**. Every step stayed far below any per-step limit and the run died anyway, at a total.

So a Workflow instance is **one invocation** for this ceiling, however many steps it spans and however long
it lives. `step.do` does not reset it.

**What this corrects.** *What executes a Butler run* originally recorded "each `step.do` is its own invocation
with its own budget", was corrected to per-instance from the documentation, and is now corrected from a
measurement. The engine choice is unaffected — the reasons for Workflows were the 365-day sleep, waiting
instances costing no concurrency, and Cloudflare re-driving instances, none of which depend on this.

**What it means for a Butler.** At the counted per-node costs — `case.assign` 5, `draft` 5–6,
`mail.send.propose` 10, and 3 more for any node reading a message body — a run has room for roughly **1,000
to 2,000 nodes' worth of work in total**, not per step. That is generous for an ordinary Butler and
**restrictive for a bounded loop that sends**: a `foreach` of 200 items each proposing a send costs ~2,000,
which is a fifth of the whole run's budget for one step. `maxItems` therefore has to be checked against
what the **rest of the AST** already spends, not against the loop alone.

## The error names the escape hatch, and it is not free

The failure is `Too many API requests by single Worker invocation`, and it points at wrangler's `limits`
configuration. `limits.subrequests` raises the ceiling to 10 million on Paid.

**Not recommended without a decision, for a reason this repository has already measured.** Adding a `limits`
block means adding a field to `wrangler.jsonc`, and `workflow-provisioning.md` measured what wrangler at this
repo's declared floor does with a field it does not recognise: a warning, the field discarded, and **exit code
0**. A customer resolving `^4.68.0` would deploy a Node whose budget is the default while its configuration
says otherwise. `test/node/deployability.test.ts` already carries the conditional-floor pattern for exactly
this shape and would need extending to cover `limits`.

## D1 imposes no query ceiling of its own

One step performed **10,000 D1 queries** before failing, and it failed on the *subrequest* limit rather than a
D1 limit. Had a 1,000-query-per-invocation D1 ceiling applied, the run would have stopped at 1,000 with a
different error. It did not.

**So `d1.paid.max_queries_per_invocation: 1000` and `d1.free.max_queries_per_invocation: 50` in
`d1-platform-limits.md` were never a D1 limit.** They are the *subrequest* limit restated under a
D1-flavoured name — 1,000 was the old paid per-invocation subrequest ceiling and 50 is the free plan's
*external* subrequest allowance, which does not apply to D1 at all, D1 being an internal service with its own
1,000 on free. That is why both moved when the subrequest ceiling moved, and why nothing noticed: the name
attributed the limit to the wrong subsystem, so the changelog that invalidated it did not look relevant.

Corrected in that receipt rather than silently: the paid figure becomes 10,000 and the free figure 1,000,
both pointing here for the method, and both named as what they are.

## Sized

- `workflow.subrequest_budget_per_instance = 10000` — **measured**, twice, from two directions: a single step
  stopped at exactly 10,000, and a twenty-step run stopped at a total of exactly 10,000. Not a documented
  figure taken on trust; the documentation says 10,000 but says it against a unit ("/request") that this
  measurement had to disambiguate.
- `workflow.budget_unit_is_instance = 1` — recorded as a value rather than prose so that a change in it trips
  something. If this ever becomes per-step, every `maxItems` derived from it is wrong in the permissive
  direction, which is the direction that fails under load.

**Deliberately not recorded as values:** the per-node subrequest costs. They were counted by reading shipped
code, not measured, and the only instrument available cannot verify them — `doctor`'s cost meter counts
`prepare` rather than execution, ignores `batch` entirely, and cannot see Durable Object RPCs, so it would
price `mail.send.propose` at 6 against a real 10. `test/node/doctor-meter-honesty.test.ts` pins why that
meter's own figure is nonetheless true, and says it must not be reused. A step-cost tripwire needs an
instrument first.
