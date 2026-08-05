---
id: test-timeout-headroom
kind: measured-tripwire
measured_on: 2026-08-05
stale_when: >
  the PBKDF2 round count changes (see password-hash-cost), a new test exceeds the recorded
  slowest-under-load figure, the number of packages running under `turbo test` changes
  materially, or the suite moves to CI hardware with a different core count
values:
  test.timeout_ms: 30000
  test.hook_timeout_ms: 30000
  test.slowest_test_ms_idle: 1417
  test.slowest_test_ms_under_load: 5790
  test.migration_hook_ms_under_load: 77
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

## What was deliberately not done

- **`retry` was not enabled.** Vitest will re-run failing tests on request and the suite would have
  gone green immediately. A retried test is a muted test, and AGENTS.md is explicit that a muted
  receipt check still reads as verified. The timeout was wrong; retries would have hidden that it was
  wrong rather than fixed it.
- **PBKDF2 cost was not lowered for tests.** It would make the suite several times faster and it is
  the wrong trade here: the 100,000-iteration platform ceiling reached production precisely because a
  local run and a deployed run disagreed about cost. Tests that pay the real cost are the reason that
  landmine is now visible.

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

If the worst case has moved above `test.slowest_test_ms_under_load`, update that value and reconsider
`test.timeout_ms` — do not raise the timeout alone, because the interesting number is the headroom
between them, and raising only the ceiling erases the evidence that the floor moved.
