---
id: untranslated-scan-timeout
kind: measured-tripwire
measured_on: 2026-09-30
stale_when: >
  the client program the checker types (every file under apps/node/worker/src/client, the React types and the
  contract's schemas it imports) grows by half, TypeScript's major version changes, or the file's beforeAll takes
  more than a quarter of the bound on any recorded run
values:
  test.untranslated_scan_timeout_ms: 120000
---

## The scan that types the whole interface

`apps/node/worker/test/node/untranslated.test.ts` (ADR 46) asks the TypeScript checker for the contextual type of
every string literal in the interface, so it has to type the whole client program first: the React types, the
contract's zod schemas, every screen. Building the program is about 4.5 s; the first contextual-type query that
reaches the contract costs about 6 s on its own; the rest is the remaining files. The per-case assertions then take
milliseconds. So the work runs once, in the file's `beforeAll`, and the hook carries its own bound rather than the
global one.

Measured on 30 September 2026, 12-core Linux machine, which was already loaded by other work (load average 21 to
26, roughly 2x oversubscribed) for every run:

| condition | the file |
| --- | --- |
| the scan alone, as a script (user CPU 12.3 s) | 24,568 ms wall |
| the file alone | 20,391 ms |
| under the full node suite | 14,388 ms |

Not measured: an idle machine, and CI. The worst figure here is already two-thirds of `test.hook_timeout_ms`, so
the global bound would time the file out on a busier machine. `test.untranslated_scan_timeout_ms: 120000` is its
own bound, about 5.9x the worst observed, separate from the two exemptions in `docs/receipts/test-timeout-headroom.md` because it measures a
different cost. The cases themselves stay under the global timeout and the headroom ceiling, which read their durations,
not the hook's. If the interface doubles, this is the number that moves: remeasure it then.

Split out of `docs/receipts/test-timeout-headroom.md` on 30 September 2026, where it had been added under that
receipt's 5 August date and `stale_when`, neither of which described it. Rechecked the same day after the scan
learned to read component props and literals inside `<NodeWords>`: the file's cases took 5.9 to 8.1 s over two runs, inside
the figures above.
