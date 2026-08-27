---
id: contrast-tokens
kind: measured-tripwire
measured_on: 2026-08-28
stale_when: >
  any of --text, --dim, --ground, --ground-2, --sky, --accent, --accent-text, --warn, --alarm or --live
  changes in either theme; a fourth ground is introduced, since the worst case below is the minimum over
  three; the interface adopts a text size above 24px for --dim-coloured text, which would move it into AA's
  large-text threshold; --accent starts being used for text rather than for fills, borders and focus rings;
  or WCAG revises the 4.5:1 normal-text ratio
values:
  contrast.aa_normal_ratio: 450
  contrast.aa_large_ratio: 300
  contrast.dim_dark_worst: 553
  contrast.dim_light_worst: 544
  contrast.accent_text_light_worst: 459
  contrast.accent_text_dark_worst: 477
  contrast.accent_ui_worst: 387
---

**Every ratio here is stored ×100**, because the receipt pipeline emits integers and a contrast ratio
needs two decimal places to be checkable: `450` is AA's 4.5:1, `451` is the measured 4.51:1. The scale
has to be uniform across the whole block — the first draft of this receipt mixed ×10 for the
thresholds with ×100 for the measurements, which made the test's AA assertion compare against 0.45 and
pass vacuously. `contrast.test.ts`'s margin assertion is what caught it, which is the argument for
asserting the margin rather than only the pass.


## Re-measured 28 August 2026: the Mailda brand palette

The `stale_when` above fired on every token at once — the interface moved from the instrument-panel palette
to the brand's Ink / Flow Blue / Sky / Mist / White. Three things changed structurally, not just in value.

**There are three grounds now, not two.** `--sky` joined `--ground` and `--ground-2`, so every worst case
below is a minimum over three surfaces rather than the two endpoints of a gradient. Sky is the darkest of
the light grounds and it is where every figure bottoms out — which is the point of adding it to the test
rather than trusting that a colour cleared on Mist will clear on Sky. It does not always.

**Light is the default theme and dark is the media query**, the reverse of before. The parsing in
`contrast.test.ts` keys off which theme is inside `@media`, so it was flipped with the stylesheet.

**`--signal` became two tokens**, and that is what the brand forced rather than a tidy-up. It was carrying
brand emphasis (the wordmark, focus rings, hover, selected rows) *and* warning states (a held send, a
degraded check) under one amber. The brand supplies an accent and no warning colour, so the two jobs had to
separate: `--accent` took the first and `--warn` kept the amber for the second.

### The measured figures

| token | light worst | dark worst | needs | over |
|:--|--:|--:|--:|:--|
| `--dim` | **5.44** | **5.53** | 4.5 | Mist / White / Sky |
| `--accent-text` | **4.59** | **4.77** | 4.5 | as above |
| `--accent` *(non-text)* | **3.87** | 4.77 | 3.0 | as above |
| `--text` | 15.41 | 12.69 | 4.5 | as above |

`--dim` is `rgba(15, 23, 32, .66)` in light and `rgba(232, 237, 243, .60)` in dark. The alphas differ and
that is not an oversight: dark text on a light ground is not the mirror of the reverse. In light, .60 gives
4.58 on Mist and **4.48 on Sky** — a fail on the brand's own third ground, by two hundredths, which is
exactly the kind of miss that having Sky in the test exists to catch. .66 clears all three.

### Flow Blue cannot carry small text, and the palette now says so

The finding worth keeping. **Flow Blue `#4C77B8` is 4.53:1 on white** — it passes AA for normal text by
**0.03** — and **4.11 on Mist, 3.87 on Sky**, which fail. The brand's accent is not a body-text colour on
two of the brand's own three grounds.

So the token was split by *use* rather than compromised by value:

- `--accent` is `#4C77B8`, the brand hex, for fills, borders, focus rings, icons and the mark's dot. Those
  need 3:1 and the worst case is 3.87.
- `--accent-text` is `#436BA8` for anything a person reads. Same hue (216°) and same saturation (0.432);
  only lightness moves, 0.510 → 0.460. That buys 4.59 at worst.

The alternative was to use one token everywhere, which means either failing AA on Mist and Sky or shipping a
blue that is not the brand's. Splitting keeps the brand hex where it is visible and legal, and keeps text
readable, and the receipt is where the difference is written down so nobody "simplifies" them back together.

**Dark theme lifts the accent rather than keeping the hex.** Flow Blue is 3.99:1 on Ink — fine for a border,
short of AA for text — so dark uses `#6E93CC` for both accent tokens (5.76 on Ink, 4.77 at worst).

### What this receipt still cannot prove

Unchanged from below and worth repeating against a new palette: this measures **tokens against grounds**. It
does not know which token any given element actually uses, so a heading that took `--dim` by accident, or an
`--accent` fill used behind small text, passes here and fails a person. axe cannot see it either — it reads
computed styles on a rendered page, and the failures it catches are the ones a token table cannot.

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
