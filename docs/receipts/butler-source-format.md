---
id: butler-source-format
kind: measured-tripwire
measured_on: 2026-08-21
stale_when: >
  the `yaml` package's bundle cost changes materially, Workers gains a native YAML parser, esbuild
  gains code splitting for Workers so a deferred module's bytes stop shipping in the one script, or
  #87 decides Butler source is authored somewhere other than this Node
values:
  butler.yaml_parser_bundle_kib: 246
  butler.yaml_parser_gzip_kib: 51
  butler.yaml_max_alias_count: 100
---

## The deferral this closes

`docs/butler-ast.md` and `src/butlers.ts` both said the same thing: *"§16's YAML form arrives when a
YAML parser arrives in the bundle."* That is a condition no one can evaluate. It names no cost, no
threshold and no decider, so it could be repeated in every review forever — which is what it did for
three layers. AGENTS.md calls that shape a landmine: correct today, with nothing to notice.

So the sentence is replaced by a number.

## Measured

`yaml` 2.9.0, imported from the Butler authoring path and actually invoked, so nothing is tree-shaken
away. `wrangler deploy --dry-run` against the deployed Worker's own bundle:

| | Raw | Gzip |
|---|---:|---:|
| Worker without it | 1842.07 KiB | 473.23 KiB |
| With `yaml` invoked, nothing else changed | 2088.24 KiB | 523.98 KiB |
| **The parser's cost** | **+246.2 KiB** | **+50.8 KiB** |
| Shipped: #87 complete, parser and feature | 2099.16 KiB | 526.44 KiB |
| **What a deploying operator actually pays** | **+257.1 KiB** | **+53.2 KiB** |

Both rows, because they answer different questions and quoting one for the other is how a receipt
starts lying. The middle figure is what the *decision* was made on — a probe that changed one import
and nothing else, so it prices the dependency. The last is what a Node's bundle does after the whole
feature lands: the parser plus the format column's code paths, the YAML starter template, the
selector and its styles. The extra 11 KiB is Mailda's own, and it is mostly the comments that are the
reason for the feature.

(Gzip drifts ~0.1 KiB between identical runs — 473.15 and 473.23 for the same tree. The figures are
recorded to the tenth and the budget values are integers, because a tenth of a KiB is below the
measurement's own noise and a budget carrying a digit it cannot reproduce is a false precision.)

Against a Workers Paid script limit of 10 MB compressed, this is about **1%** of a ceiling the Worker
is currently using 5% of. The limit is not what decides this.

### What deferring the import buys, stated exactly, because the obvious claim is wrong

The import is `await import("yaml")` inside the parse branch. The tempting sentence — *"so it stays
out of the bundle for everything that is not authoring"* — is **false here**, and checking it is why
this section exists.

`wrangler deploy --dry-run --outdir` emits **one** `index.js`. esbuild does no code splitting for the
Workers target, so a dynamic import is inlined and wrapped in its `__esm` lazy-init idiom. The bytes
ship in the single script either way; `postal-mime` is in it too, 37 times over.

What the wrapper actually buys is that the module's **top-level initialization does not run** until
something awaits the import. So an inbound message — the hot path, the one that runs on every
delivery — pays the parse-and-compile weight of a larger script and **not** the cost of constructing
`yaml`'s schema tables, resolvers and stringifier. That is a real saving and a smaller one than "not
in the bundle", and the difference is the whole reason to write it down.

## Decided: adopt it

Three reasons, in the order that decided it.

**1. JSON cannot hold a comment, and a Butler is a program.** This repository's entire practice is
that the argument lives next to the code — AGENTS.md requires it, every file here does it. A Butler
definition authored in JSON is the one program in this system that *structurally cannot* carry the
reason for a step next to the step. That is not a formatting preference; it is a class of knowledge
the current format destroys, and it is the reason §16 charts a YAML editor rather than a prettier
JSON one.

**2. The dependency is already here and already trusted.** `yaml` is a devDependency of this Worker
and `test/node/ci-policy.test.ts` parses the CI workflow with it. Adopting it at runtime adds bundle
weight, not a new supply-chain decision. The alternative — a small hand-rolled subset parser — is
the trap `mime-header-parse.md` names in its first paragraph: hand-rolling a format is how parser
bugs become security bugs, and it would be worse here than for MIME because the parsed result is a
*program* rather than a subject line.

**3. The cost is bounded and off the initialization path.** 51 KiB gzip, ~1% of the ceiling, with
`yaml`'s own construction deferred past every delivery.

Recorded plainly so it is not read as a loophole: this is a **larger** figure than the +25.6 KiB
`mime-header-parse.md` deferred in August, and it is being spent while that one was not. The
difference is not the number. It is that the earlier decision had a cheaper correct alternative for
what that layer needed — headers are tokens, and parsing them badly mis-threads a conversation —
whereas there is no cheap correct way to parse YAML, and no other way at all to let an author write
down why a step exists.

## One-way, by decision: YAML in, never YAML out

§16 gives the visual builder and the text editor "the same canonical definition", and blueprint:1850
says the canonical JSON AST is *generated by* the editors. Read together with what this Node already
does — the AST is derived from `source_text`, never sent beside it — the direction is settled:

**`source_text` → AST is the only conversion. There is no AST → YAML renderer, and there must not
be one.**

A renderer would be the feature that destroys the thing YAML was adopted for. Regenerating a
document from an AST cannot reproduce comments, blank lines or key order, because none of them are in
the AST — that is what canonicalization *means*. So a round trip would silently delete every reason
an author wrote down, and it would do it on the most ordinary act imaginable: open a Butler, change
one field, save. The author's text is the record; it is stored verbatim, frozen on publication by
`btv_frozen`, and the only thing derived from it is the program.

The consequence, said rather than discovered later: **the visual builder cannot edit a YAML Butler.**
A graph editor writes an AST, and writing an AST back out requires the renderer that does not exist.
Both editors reading one format is a §16 promise this Node keeps in one direction only, and the
column below is what makes which direction a fact rather than a guess.

## `source_format` earns its column now, and could not have before

`docs/butler-ast.md` refused this column in exactly the right words: *"A column whose only value is
`'json'` is the placeholder shape `placeholder-columns.test.ts` exists to catch."* That was correct.
It stops being correct in the same commit that adds a second value, and not one commit earlier.

It is `NOT NULL DEFAULT 'json'` with a `CHECK`, so every row written before this migration is
`'json'` — which is not a backfill guess but the truth: JSON is all this Node has ever accepted.

The column is in `btv_frozen`'s frozen set, for 0031's reason. A published version whose format could
be flipped is a version whose `source_text` would be re-parsed by a different parser than the one
that produced its frozen AST, and `E_BUTLER_DRAFT_INCOHERENT` — the refusal that exists to make
AST/source correspondence a property at the moment of freezing — would be the thing detecting it,
one publish too late.

## Bounds

- **`butler.yaml_max_alias_count = 100`** — the alias expansions one parse may perform.

  This is the one bound YAML needs that JSON does not, and the byte limit cannot stand in for it.
  `d1.max_row_bytes` prices the *stored* text and is checked **after** the parse; alias expansion is
  amplification, so a few hundred bytes of anchors and aliases can expand to gigabytes before any
  size check in `checked` is reached, against the 128 MB memory limit. The guard has to be inside the
  parse or it is not a guard.

  Sized rather than measured, and the size is `yaml` 2.9's own default — adopted **deliberately**
  rather than inherited. A Butler using more than a hundred alias expansions is a generator's output
  rather than something a person wrote to be read, and the format was adopted for the person.

  Recorded because it is the kind of thing a reader should not have to discover: **passing this
  option is behaviourally invisible today.** The library would apply 100 whether or not
  `parseSource` names it, so no test can distinguish the two, and this repository has twice deleted
  a defence in that position. It is kept because it is not a duplicate enforcement — it is the only
  thing that makes *this value* true. Delete it and `butler.yaml_max_alias_count` becomes a
  description of a dependency's default sitting in Mailda's own namespace, free to move on the next
  `pnpm update` with this receipt still claiming Mailda chose it.

  `test/butlers.test.ts` pins the literal against the budget, and that test earned its shape the hard
  way: the first version built its document *from* the budget and asserted `budget - 1` parsed while
  `budget` did not — true for every value, so raising the budget to 1000 left it green. It tested the
  library, not this Node. The counts are written out now.

  No matching bound is added for JSON. `JSON.parse` has no amplification: the output is bounded by
  the input, which is what makes the existing byte check sufficient there and insufficient here.

- Not bounded here, named so its absence is a decision: **input size before parse**. Both formats are
  parsed before `d1.max_row_bytes` is checked, so both are bounded only by the platform's request
  body limit. That is pre-existing, identical for JSON, and unchanged by this receipt — the new
  exposure YAML brings is amplification, and amplification is what the alias count bounds.
