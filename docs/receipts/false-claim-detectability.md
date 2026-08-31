---
id: false-claim-detectability
kind: measured-tripwire
measured_on: 2026-08-31
stale_when: >
  the repository stops carrying its evidence in prose; a documentation generator begins resolving comment
  references at build time, which would make the shipped check redundant; the exemption list is pushed above
  the cap below by a class of legitimately-absent path this measurement did not anticipate; or one of the
  three rejected detectors becomes cheap for a reason recorded here as the reason it was not — in
  particular, if counts in prose start being written in a parseable form, the rejection of that detector no
  longer holds
values:
  prose.references.min_scanned: 2000
  prose.references.max_exemptions: 26
---

# Which false claims in prose can be caught mechanically

Issue [#103](https://github.com/wms2537/mailda/issues/103). The ticket asked for an investigation, not a
build: *"The honest possible outcome — that no automated check is worth its cost … should be concluded, not
assumed."* This is the conclusion, with the measurement behind each half.

The corpus was 7 instances found by audit plus roughly 8 produced in a single session of *fixing* the first
7 — the most useful part of the sample, because their text was known and their authorship was not in doubt.

## Shipped: a path named in prose must exist

`apps/node/worker/test/node/prose-references-world.test.ts`, which **generalises a check that already
existed**. `test/node/receipt-references.test.ts` was written for this same issue and resolves citations of
the form `docs/receipts/<id>.md` in the worker's `src`, `test` and `scripts`. The question here was whether
that idea pays when widened to every path in every prose region of the repository. It does, and the four
defects below are all outside the older check's scope — three of them outside the worker's source tree
entirely.

**Measured.** 2,931 path references extracted from comments and paragraphs across the repository; 33 do not
resolve; 26 are legitimately not files, each listed with its reason; **0 remain unexplained.**

Building it found four stale references that no reviewer had caught, and covered the audited instance
directly:

```text
docs/receipts/authz-check-rows-read.md:19   apps/node/workers/state/test/authz.measure.test.ts
    line 140 of the same receipt named the real path: apps/node/worker/test/authz.measure.test.ts
src/client/app/types/session.d.ts:2         ../externals-note.md   — exists nowhere
src/client/app/types/delivery.d.ts:2        ../externals-note.md   — the same claim, copied
src/auth/session.ts:41                      client.ts              — it is src/client/session.client.js
[audited]                                   test/composer.test.ts  — it is test/drafts.test.ts
```

**A convention this check both needs and enforces.** The block above is fenced, and the extractor skips
fenced blocks in markdown. That is not a dodge around the check — it is the distinction the check depends
on. An inline `` `path` `` is a **citation**, something a reader is expected to follow and therefore
something that must resolve. A fence holds a **literal**: an illustrative tree, an example receipt name, or
as here, a wrong path quoted as evidence. Without that line every document explaining a broken reference
would have to be exempted from the rule it explains. Source comments have no fence, which is why the six
exemptions in the check's own two files exist.

**Why the scan is restricted to prose.** Code that names a path is already checked: a bad import fails to
build. Sweeping code as well raised the candidate set from 2,931 to 3,851 tokens and the unresolvable set
from 33 to 86 — and **every one of the 53 extra was false**: template holes, property reads and package
specifiers, of the shapes

```text
`${gate.sql}`   query.sql   ajv/dist/2020.js   axe-core/axe.min.js
```

A check whose new findings are all false is a check that gets muted, so the scan stops where the toolchain
starts.

**Two holes found by measuring rather than by reasoning.** The first resolver built the suffix match as
`"/" + path` without stripping a leading `./`, so `./butler/run.ts` did not match the live
`src/butler/run.ts` — reporting a real file as missing. The token pattern then allowed only one leading
`../`, which silently skipped every `../../../../../docs/…` reference in the repository; because the
lookbehind also blocks a mid-string match, those references were not mis-resolved but never extracted at
all, and the scan reported clean. Both are the defect this check exists to catch, in the check itself.

**A third hole, found by CI.** The control proving the walk had reached the whole repository asserted a file
count above 500 — a bare number nobody had measured. It passed locally at 5xx and failed CI at **499**, the
difference being build artefacts a clean checkout does not have. A count of files on disk is a property of
the machine, not of this repository, so the control now names three files the walk must have reached: the
root, the deepest directory it must descend into, and a package outside the worker. Environment-independent,
and it still dies when the walk is broken.

## What this does not catch, and cannot

A wrong claim *about a real file*. The `session.ts` reference above was caught only because it resolved
nowhere; had the comment cited a real-but-unrelated module, the check would have passed it.

Sharper, from this session: while fixing the two declarations listed above, the first attempt
**deleted** a correct reference to `session.client.js`, after an `ls` of the wrong directory concluded the
file did not exist. A false claim introduced by the act of removing one — and structurally invisible here,
because a reference that is gone is never unresolvable. Existence mechanises. Accuracy does not.

## Rejected, with the measurement that rejected each

**Counts in prose.** 261 statements name a number of a countable thing (67 about routes, 27 relations, 18
gates, 16 capabilities, and so on). This is the class most of the session's own errors fell into — *"Fifty-
eight routes declare no authority"* when it was 53; *"there are six"* when the filter yielded seven.
Rejected anyway: verifying a count requires knowing **which set** it counts, and nothing in the prose says.
`58 routes` could mean the whole table, the undeclared ones, or the ones in one file. The two places the
repository already checks a documented count — the agent-exposure and route-authority tables — work because
somebody deliberately put the number in a **parseable table row labelled by its set**. That does not
generalise to a paragraph; it is a convention that has to be adopted per number, and the recommendation
below is to adopt it rather than to scan for it.

**Release gates in prose.** 14 statements match `does not ship without` and its variants. Of these, 9 name
ADR 28's escrow gate and all 9 sit within six lines of an issue reference; the other 5 are false positives
turning on a second sense of the word — *"needs a corpus this Node does not ship"* is about a wordlist, not
a release. **Zero genuine orphans**, and a detector with no findings and a polysemous trigger is not worth a
build step. An earlier, broader phrase list (`TODO`, `for now`, `not measured`, `unmeasured`) produced 36
apparent orphans, but reading them showed the list was conflating two different things: `unmeasured` in this
repository is overwhelmingly a *deliberate honest-limit statement* — the receipt discipline working — not
uncarried backlog. Flagging it would punish the practice it was meant to protect.

**Prose citing a test by name.** The form

```text
outbound.test.ts > reading a mailbox does not confer sending
```

is mechanically checkable: the file must exist and must contain the name. It appears **once** in the entire
repository, and it resolves. A tripwire over a single instance cannot fail for the reason it was built, so
it would be an assertion that cannot fail — the thing `AGENTS.md` §2b forbids.

## Recommended as convention, not as a check

Cite a test as the file and the test name separated by `>`, and put a load-bearing count in a labelled table
row rather than in a sentence. Both turn a claim a reader has to trust into one a check can resolve. Neither is worth
scanning for today — the first has one instance, the second no way to find its set — but each additional
instance is free to verify, and the third detector becomes worth writing once the form is common enough to
fail.

## The cap

`prose.references.max_exemptions: 26` is the number of legitimately-absent paths at this measurement, and
the test fails if the list grows. Six of the 26 are in the shipped check's own files, where the explanation
above quotes the bad paths as examples — the file that documents the defect is necessarily exempt from it.
The remaining 20 are runtime module names, build outputs, payload entries inside an export archive,
customer-authored config, layout files these instructions tell a *consuming* repository to create, and four
paths that are absent on purpose because the prose is about a file that was deleted or never existed.
