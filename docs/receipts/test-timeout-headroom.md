---
id: test-timeout-headroom
kind: measured-tripwire
measured_on: 2026-08-05
stale_when: >
  the PBKDF2 round count changes (see password-hash-cost), a new test exceeds the recorded
  slowest-under-load figure, the number of packages running under `turbo test` changes
  materially, the suite moves to CI hardware with a different core count, a new vitest config
  is added, or a suite's report stops being read by .github/scripts/test-headroom.mjs
values:
  test.timeout_ms: 30000
  test.hook_timeout_ms: 30000
  test.slowest_test_ms_idle: 1417
  test.slowest_test_ms_under_load: 5790
  test.config_resolution_timeout_ms: 120000
  test.migration_hook_ms_under_load: 77
  test.slowest_test_ms_ci: 753
  test.headroom_ceiling_percent: 50
---

## What was actually wrong

The suite failed intermittently — five tests across four unrelated files, on a run where nothing
in those files had changed. The reported durations were the evidence:

| Test | Idle | On the failing run |
|:--|---:|---:|
| `sign-in locks out after the measured number of failures` | 1,417 ms | 8,030 ms |
| `cost does not grow with organisation size` | 1,367 ms | 14,946 ms |
| `stores the submitted bytes as evidence for an authored send` | ~500 ms | 5,275 ms |
| `reports html, with its blocked count` | 4 ms | 5,110 ms |

Nothing was flaky in the logical sense. Vitest's **default `testTimeout` is 5,000 ms**, and it was
never chosen by anybody — it was inherited. The tests are slow because PBKDF2 at 600,000 effective
iterations is slow *on purpose* (see [password-hash-cost](./password-hash-cost.md)), and that cost is
the product behaviour, not test overhead.

The `reports html` row is the tell: a test that takes 4 ms cannot itself time out. It failed because
an **earlier timeout in the same file left the isolated-storage undo stack unbalanced**, so tests after
it failed for reasons of their own. One breach cascades, which is why the failures looked scattered
and unrelated — and why the suite looked flaky rather than slow.

## A hypothesis that measurement killed

The first explanation was that `applyD1Migrations` in the `beforeAll` hook was breaching the
10,000 ms default `hookTimeout` — it fit the scattered, whole-file shape of the failures. It was
wrong. Instrumenting the hook directly:

| Condition | `applyD1Migrations` |
|:--|---:|
| idle | 42–52 ms |
| `turbo test` + 12 spinning CPU hogs | 60–77 ms |

Two orders of magnitude below the hook budget. Recorded here because the story was plausible enough
to have been built on, and this is the second time in this project that a confident inference from
absence turned out to be wrong.

## The measurement

MacBook, 8 cores (`hw.ncpu`), darwin 25.2.0. Load applied with 12 spinning shell loops — a ~2.5x
oversubscribed machine, which is what a developer running the suite alongside a deploy, a browser and
an agent session actually looks like. `testTimeout` was lifted to 120,000 ms for the measurement so
slow tests report their true cost instead of being cut off at the very limit under test.

| Condition | Slowest test |
|:--|---:|
| single `vitest run`, idle | **1,417 ms** |
| `turbo test` (6 packages in parallel) | ~2.4x inflation on comparable tests |
| `turbo test` + 12 CPU hogs | **5,790 ms** |

5,790 ms against a 5,000 ms budget. The default was not merely tight, it was already breached on a
machine doing ordinary work.

Five consecutive idle runs and four consecutive `turbo test` runs all passed, which is the point:
this reproduces under load and hides at rest. A fix accepted because "the suite is green now" would
have been the same non-measurement that produced the bug.

## The chosen number

**30,000 ms**, which is 5.2x the measured worst case under load. Deliberately generous: the cost of
being wrong upward is that a genuinely hung test takes 30 s to report, and the cost of being wrong
downward is a cascading failure that reads as flakiness and gets muted. Those are not symmetric.

`test.hook_timeout_ms` is set to the same value for one fewer number, not because hooks need it —
77 ms worst measured means the hook budget is nowhere near binding.

## CI hardware, which this receipt asked for and now has

`stale_when` named "the suite moves to CI hardware with a different core count", so the CI workflow
reports the number rather than assuming it. First run on `blacksmith-4vcpu-ubuntu-2404` (6 cores as the
runtime reports them):

| | Slowest test | % of the 30,000 ms timeout |
|:--|---:|---:|
| 8-core laptop, under load | 5,790 ms | 19.3% |
| 8-core laptop, idle | 1,417 ms | 4.7% |
| **Blacksmith CI, idle** | **753 ms** | **2.5%** |

CI is roughly **nine times faster** at the thing that dominates this suite. The lockout test spends
almost all of its time deriving PBKDF2 at 600,000 iterations about ten times over; at ~70 ms a
derivation that is ~750 ms, against ~500 ms a derivation locally.

The useful conclusion is the direction: **the timeout is sized by local development, not by CI.** A
laptop running the suite beside a deploy and a browser is the binding case, and CI has 39.8x headroom.
Anyone tempted to tune this number for CI would be tuning against the wrong machine.

## The ceiling is enforced, because a printed number is a muted check

`test.headroom_ceiling_percent: 50` — CI fails if any single test exceeds half the timeout
(`.github/scripts/test-headroom.mjs`).

The threshold is derived, not chosen by taste: against 753 ms observed it leaves ~20x margin, which is
looser than any plausible noisy-neighbour variance on a Firecracker microVM and still tight enough to
catch a test that has genuinely grown. It was reported without gating for exactly one run — long enough
to have a measurement to set it from, which is this repository's rule and would have been violated by
picking a number in advance.

It fails with the reason rather than the number, because the reflex it needs to interrupt is raising the
timeout: a test near the ceiling starts timing out under ordinary load, and one timeout cascades through
the rest of its file. Verified by forging a 21,000 ms entry into the report and confirming a non-zero
exit that names the test.

## What was deliberately not done

- **`retry` was not enabled.** Vitest will re-run failing tests on request and the suite would have
  gone green immediately. A retried test is a muted test, and AGENTS.md is explicit that a muted
  receipt check still reads as verified. The timeout was wrong; retries would have hidden that it was
  wrong rather than fixed it.
- **PBKDF2 cost was not lowered for tests.** It would make the suite several times faster and it is
  the wrong trade here: the 100,000-iteration platform ceiling reached production precisely because a
  local run and a deployed run disagreed about cost. Tests that pay the real cost are the reason that
  landmine is now visible.

## The other kind of load flake: a wall-clock window that was not a timeout at all

This receipt's whole subject is that a slow suite reads as a flaky one. #87 found the same class in a
different disguise, and it is recorded here because the next one will look like this rather than like a
timeout.

`test/butler-pause.test.ts` raced an `interpret` call against a **250 ms** timer to establish that the run
was still parked. That much was sound: the promise not settling proves the invocation did not finish. The
next line then read the run row and asserted `awaiting_release` — **a different claim**, and one 250 ms does
not establish. On a loaded machine the walk had genuinely not reached its park yet, so the row said
`running` and the assertion failed on a run that was about to do exactly the right thing.

It surfaced when #87 added six fixture-heavy tests to `butler-run.test.ts`, which runs in parallel with that
file: roughly one failure per five full-suite runs, and green every time the file ran alone. **The new tests
did not break anything.** They moved the machine far enough along the load curve for an existing wall-clock
assumption to stop holding — which is this receipt's thesis, arriving from the direction it did not predict.

Fixed by waiting for the state instead of assuming a window was long enough. Polling is sound there
*because* the promise never settles — `waitForEvent` blocks for ever on a parked instance — so there is no
race between the poll and the run completing.

Two things about the bound, both of which are the reason this is written down rather than just fixed:

- It is **half** `test.timeout_ms`, derived rather than chosen, so the file holds no opinion of its own about
  how long slow is.
- The halving is not caution. `testTimeout` is that same budget, so a poll bounded by the *whole* of it never
  gets to speak: vitest kills the test first and reports its own generic timeout, losing the one fact worth
  having — which state the run actually reached. The first version of the fix had this wrong, and the symptom
  was a mutation test that hung instead of failing with a message.

The lesson for the next one: **`retry` would have hidden this**, exactly as this receipt already says it
would have hidden the timeout. A wall-clock constant in a test is a budget with no receipt, and the ones that
are not called `timeout` are the ones that survive review.

## The same bug again, in the two configs written after this receipt

Three weeks after the fix above, `test/node/attach-queue-consumer.test.ts` started failing under
`turbo test` and passing in isolation. The measured breach:

| | Slowest case in that file |
|:--|---:|
| idle | **364 ms** |
| beside a full concurrent workerd suite | 384 ms |
| under `turbo test`, on the failing run | **5,481 ms** |

The middle row is why this took a measurement rather than an inference. The obvious story — the file
spawns four Node processes per case, so it is slow under load — predicts steady inflation, and running
it alongside the entire workerd suite moved it 5%. It is not steadily slow. It is occasionally stalled,
for multiples of its own runtime, and the same run took `test/node/delegated-authority-world.test.ts`
down with it.

5,481 ms is **below** the 5,790 ms already recorded above. Nothing had got slower and no number here
needed re-measuring. The budget simply was not applied: `vitest.node.config.ts` and
`vitest.client.config.ts` were both created after this receipt, and **neither set `testTimeout`**, so
both ran at the 5,000 ms default this receipt exists to reject.

The detail worth keeping is how they explain themselves. Each header says it is a separate file rather
than a `projects` block *because `vitest.config.ts` is the one carrying the measured timeouts* — a
sentence naming the exact thing it drops, in the file dropping it. A comment describing an invariant
reads as evidence the invariant holds, which is the trap this repository keeps walking into.

### Every package, not only the worker's three

The first pass fixed `apps/node/worker`'s three configs and left **six packages running `vitest run` with no
config at all** — `butler-ast`, `contract`, `evidence`, `receipts`, `runtime`, `sdk` — each therefore on the
5,000 ms default this receipt exists to reject. The tripwire named them in a `NO_CONFIG` list described as one
that "can only shrink", which is the weaker form of the invariant: it tolerates the omission and asks people to
be honest about it. `packages/evidence` then flaked once under `turbo test` at ~1.2 s idle, which is the same
shape as the `attach-queue-consumer` failure that started this.

All six carry a config now, and the allowlist is gone: the assertion is that the missing set is **empty**, so a
seventh configless package fails immediately instead of joining a queue.

`vitest.shared.ts` at the repository root is what made that affordable. It reads the value out of
`packages/budgets/src/generated.ts` by regex rather than importing `@mailda/budgets`, because one of the six is
`packages/receipts`, which **generates** that file — importing the package would point it at its own output,
and exempting it would have left the gap in the package hardest to reason about. Test infrastructure sits above
the package dependency graph; a config is not part of a package's dependency closure.

The module **throws** on a missing budget rather than defaulting, and that direction is the point: a budget
silently becoming `undefined` is how a config comes to carry vitest's default while looking like it carries a
measurement. Mutation-proven three ways — deleting a package's config, dropping the spread from one, and making
the module fall back to 5,000 — each fails the tripwire by name.

### Two holes, and the second one is why it stayed hidden

The timeout was missing, and **the ceiling could not see the suite either.**
`.github/scripts/test-headroom.mjs` read one report, `.vitest-report.json`, which only
`vitest.config.ts` emits. The check whose entire purpose is catching a test creeping toward the timeout
— the thing that would have flagged this file long before it failed — was not looking at `test/node/`
or `test/client/` at all.

So both were fixed, because either alone leaves the other:

- All three configs now take `testTimeout`/`hookTimeout` from these budgets.
- All three emit a json report on CI, and `test-headroom.mjs` reads all three, labels each test with its
  suite, and names any suite whose report is absent instead of quietly measuring fewer.
- `apps/node/worker/test/node/vitest-timeout-world.test.ts` **resolves every `vitest*.config.ts` in the
  repository** and asserts the value vitest would actually use, so a fourth config cannot repeat this.

That test is resolved rather than grepped, and its limits were measured rather than claimed: deleting
the line fails it, setting it to a literal `5000` fails it, and feeding `testTimeout` the *hook* budget
key **survives** — `test.timeout_ms` and `test.hook_timeout_ms` are both 30,000, and no check can
separate two keys holding one number. The gate was verified in the other direction too, by forging a
21,000 ms entry into the node report and confirming a non-zero exit naming the test and its suite.

## Re-measuring

```sh
cd apps/node/worker
for i in $(seq 1 12); do (while :; do :; done) & done   # oversubscribe the machine
npx vitest run --testTimeout=120000 --reporter=json --outputFile=/tmp/loaded.json
kill $(jobs -p)
node -e 'const r=require("/tmp/loaded.json");
  const t=r.testResults.flatMap(f=>f.assertionResults.map(a=>({n:a.fullName,d:a.duration||0})));
  t.sort((a,b)=>b.d-a.d); console.log(t[0].d,"ms", t[0].n)'
```

## One test is exempt, and the exemption is measured rather than assumed

`test/node/vitest-timeout-world.test.ts` imports every vitest config in the repository — nine of them — the
way vitest does, so that it reads the **resolved** timeout rather than the spelling, and so that a config
exported as a function of the vite env is read correctly. Each import makes vite transform a TypeScript file
and its transitive imports.

Measured on 1 September 2026, on the machine that runs the suite:

| condition | duration |
| --- | --- |
| the file alone | 7,636 ms |
| under the full node suite, run 1 | 25,185 ms |
| under the full node suite, run 2 | 30,392 ms — **timed out** |
| under the full node suite, run 3 | 42,526 ms |

So it exceeded `test.timeout_ms` in roughly one local run in two: a test asserting that every suite carries
the measured timeout, failing on one. Importing the configs concurrently rather than serially was tried first
and moved the figure by under a second — the cost is the transformation, not the sequencing.

`test.config_resolution_timeout_ms: 120000` is its own bound, at roughly 3× the worst observed. It is a
separate figure on purpose:

- **The global timeout stays at 30,000.** Raising it to accommodate this one test would slacken every test in
  the repository, so a genuinely hung Mailda test would take three times as long to fail. The receipt's own
  rule — do not raise the ceiling alone — argues against raising it *at all* here, because the floor that
  moved is not Mailda's.
- **`test.slowest_test_ms_under_load` is left at 5,790**, and that is deliberate rather than an oversight. It
  records a measurement of *CI* hardware; the figures above are a laptop under full parallel load. Overwriting
  one with the other would merge two different measurements into a number describing neither. CI's headroom
  gate reads the live report rather than this value, and has not flagged this test — on Blacksmith runners it
  comes in under the ceiling.

What this exemption is **not** is a licence for slow tests. It applies to one file, whose cost is the
toolchain rather than the Node, and which cannot be made cheap without giving up the property it exists to
prove: reading a config the way vitest reads it.

If the worst case has moved above `test.slowest_test_ms_under_load`, update that value and reconsider
`test.timeout_ms` — do not raise the timeout alone, because the interesting number is the headroom
between them, and raising only the ceiling erases the evidence that the floor moved.
