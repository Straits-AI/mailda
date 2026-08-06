---
id: contrast-tokens
kind: measured-tripwire
measured_on: 2026-08-06
stale_when: >
  any of --text, --dim, --ground, --ground-2, --signal, --alarm or --live changes in either theme;
  the body gradient's endpoints change; the interface adopts a text size above 24px for
  --dim-coloured text, which would move it into AA's large-text threshold; or WCAG revises the
  4.5:1 normal-text ratio
values:
  contrast.aa_normal_ratio: 450
  contrast.aa_large_ratio: 300
  contrast.dim_dark_worst: 451
  contrast.dim_light_worst: 571
---

**Every ratio here is stored ×100**, because the receipt pipeline emits integers and a contrast ratio
needs two decimal places to be checkable: `450` is AA's 4.5:1, `451` is the measured 4.51:1. The scale
has to be uniform across the whole block — the first draft of this receipt mixed ×10 for the
thresholds with ×100 for the measurements, which made the test's AA assertion compare against 0.45 and
pass vacuously. `contrast.test.ts`'s margin assertion is what caught it, which is the argument for
asserting the margin rather than only the pass.

## axe-core cannot prove contrast on this interface, and reports that as a pass

ADR 30 requires WCAG 2.2 AA **proven** by axe-core per screen. Run against the deployed sign-in page,
axe returns **zero violations** — and that number means almost nothing:

| | Nodes |
|:--|---:|
| contrast **proven** to pass | **1** |
| contrast **failed** | 0 |
| contrast **unproven** (`incomplete`) | **13**, of which 12 for one reason |

> `Element's background color could not be determined due to a background gradient`

`body` carries a top-lit `linear-gradient` (`src/ui.ts`, deliberate — it gives the panel depth rather
than flat fill). axe will not guess a background it cannot resolve to a single colour, so it moves
almost every text node on the page into `incomplete` and reports no violations.

**A harness that reads only `violations` therefore reports AA green on this design language forever.**
That is the landmine shape AGENTS.md names: a check that reads as verified because it did not run. It
was found by building the harness with the first screen, which is exactly why ADR 30 requires that
order — a retrofitted harness would have inherited the false green.

## So the contrast check is computed, not observed

The gradient interpolates between `--ground-2` (top) and `--ground`. It never produces a colour
outside that range, so **if both endpoints pass, every point between them passes.** That turns an
unresolvable sampling problem into two deterministic sums, needing no browser at all:

| Theme | `--dim` alpha | vs `--ground` | vs `--ground-2` | Worst | AA 4.5 |
|:--|---:|---:|---:|---:|:--|
| dark | .52 | 4.56 | 4.51 | **4.51** | pass |
| light | .58 *(was shipped)* | 4.15 | 4.29 | **4.15** | **fail** |
| light | .68 *(now)* | 5.71 | 5.98 | **5.71** | pass |

Two findings, and they are different in kind.

**The light theme was failing.** Every `--dim` label on the authenticated surface — `.label` at
`.655rem`, `.hint` at `.7rem`, `.count`, every `td.dim` — is normal text under AA, needing 4.5:1, and
had 4.15:1. Fixed by raising the alpha to `.68`. The two themes need different alphas because dark
text on a light ground is not the mirror of light text on a dark one; assuming symmetry is what
produced the bug.

**The dark theme passes by 0.01.** 4.51:1 against a 4.5 threshold, at the `--ground-2` end. It is
compliant and is left alone — changing a shipped design on a pass is not justified — but a margin that
thin is a limit developers can hit without seeing it. Any future nudge to `--ground-2` breaks AA
silently. That is the whole reason this receipt exists rather than a one-line fix, and why
`test/node/contrast.test.ts` recomputes both endpoints from the tokens in `src/ui.ts` on every run.

## What this does not cover

Only `--dim` on the two grounds, which is the case that was broken and the case that dominates the
interface. `--signal`, `--alarm` and `--live` are used for state chips and headline figures whose
sizes vary by context, and the state chips also carry a border, so colour is not their only channel
(§16). Those need their own measurement when the real component system lands. Recorded so the gap is
visible rather than implied — this receipt proves one token, not the palette.
