---
id: contrast-tokens
kind: measured-tripwire
measured_on: 2026-09-26
stale_when: >
  any value in THEMES (apps/node/worker/src/theme.ts) changes in either theme; a ninth ground is added to
  GROUNDS, since every worst case below is the minimum over eight; a token is used as a text colour outside
  TEXT_TOKENS; a text size above 24px is set in --text-muted, which would move it into AA's large-text
  threshold; a theme choice beyond dark, light and system, or a fourth theme block, is added; or WCAG
  revises the 4.5:1 normal-text or 3:1 non-text ratio
values:
  contrast.aa_normal_ratio: 450
  contrast.aa_nontext_ratio: 300
  contrast.text_primary_dark_worst: 1192
  contrast.text_primary_light_worst: 1433
  contrast.text_secondary_dark_worst: 586
  contrast.text_secondary_light_worst: 704
  contrast.text_muted_dark_worst: 461
  contrast.text_muted_light_worst: 478
  contrast.accent_text_dark_worst: 554
  contrast.accent_text_light_worst: 519
  contrast.accent_hover_dark_worst: 644
  contrast.accent_hover_light_worst: 654
  contrast.success_dark_worst: 616
  contrast.success_light_worst: 476
  contrast.warning_dark_worst: 614
  contrast.warning_light_worst: 457
  contrast.danger_dark_worst: 464
  contrast.danger_light_worst: 534
  contrast.accent_dark_worst: 554
  contrast.accent_light_worst: 360
  contrast.control_edge_dark_worst: 315
  contrast.control_edge_light_worst: 314
  contrast.on_accent_dark: 806
  contrast.on_accent_light: 653
---

**Every ratio here is stored ×100**, because the receipt pipeline emits integers and a contrast ratio
needs two decimal places to be checkable: `450` is AA's 4.5:1, `451` is the measured 4.51:1. The scale
has to be uniform across the whole block. The first draft of this receipt mixed ×10 for the
thresholds with ×100 for the measurements, which made the test's AA assertion compare against 0.45 and
pass vacuously. `contrast.test.ts`'s margin assertion is what caught it, which is the argument for
asserting the margin rather than only the pass.


## Re-measured 26 September 2026: the redesign palette, Dark by default, Light and System by choice

The `stale_when` above fired on every token at once. The interface moved to the redesign memo's palette, and
four things changed structurally, not only in value.

**The tokens live in a registry, not in the stylesheet's text.** `apps/node/worker/src/theme.ts` holds both
themes as `Record<TokenName, string>`, so a token missing from either theme is a compile error, and
`contrast.test.ts` imports it and the served sheet (`SHELL_CSS`) rather than reading `src/ui.ts` as text. The
old test found each theme by the position of a media query in a source file; it would have read a doc comment
holding `--x: value;` as a token.

**Eight grounds, not three**, so every worst case below is a minimum over eight surfaces, and every text token
is checked on every one of them: 8 text tokens × 8 grounds × 2 themes. That matrix is what replaced the rail
tests. The rail was an Ink island in a light page, with seven tokens of its own, and the tests held that no
rail rule reached for a page-tuned colour. The sidebar is `--bg-sidebar` in both themes now, one of the eight
grounds, so a text token that clears every ground clears the sidebar, and the question those tests
approximated with a selector scan is answered for every surface at once. What a token table cannot see is
where a token is *used*, so the test also parses the served sheet: no `color:` takes a non-text token or a
divider, no field is edged with a divider, and every selected state carries the accent.

**Dark is the default, and the theme is the viewer's choice.** Dark is the unqualified `:root`; Light is
`:root[data-theme="light"]`; System is `:root[data-theme="system"]` inside the one
`@media (prefers-color-scheme: light)`. Following the OS alone would have shown Light to everyone whose OS
states no preference, since browsers report `light` then. The light declarations appear twice, once for
Light and once for System, and the test holds both copies equal to the registry.

**Solid surfaces only.** The gradient, the grain and every translucent `color-mix()` surface are gone, so
there is nothing to composite: each pair below is two opaque colours, and axe can resolve every background it
meets on a rendered screen.

### The measured figures (WCAG 2.2 formula, identical to `contrast.test.ts`)

| token | dark | worst ground (dark) | light | worst ground (light) | needs |
|:--|--:|:--|--:|:--|--:|
| `--text-primary` | **11.92** | surface-active | **14.33** | surface-active | 4.5 |
| `--text-secondary` | **5.86** | surface-active | **7.04** | surface-active | 4.5 |
| `--text-muted` | **4.61** | surface-active | **4.78** | surface-active | 4.5 |
| `--accent-text` | **5.54** | surface-active | **5.19** | surface-active | 4.5 |
| `--accent-hover` | **6.44** | surface-active | **6.54** | surface-active | 4.5 |
| `--success` | **6.16** | surface-active | **4.76** | surface-active | 4.5 |
| `--warning` | **6.14** | surface-active | **4.57** | surface-active | 4.5 |
| `--danger` | **4.64** | surface-active | **5.34** | surface-active | 4.5 |
| `--accent` *(non-text)* | **5.54** | surface-active | **3.60** | surface-active | 3.0 |
| `--control-edge` *(non-text)* | **3.15** | surface-active | **3.14** | surface-active | 3.0 |
| `--on-accent` on `--accent-text` / `--accent-hover` | **8.06** / 9.37 | | **6.53** / 8.23 | | 4.5 |

`--border` (1.00 to 1.48) and `--border-soft` (1.00 to 1.27) are dividers only, which WCAG 1.4.11 exempts, and
are never a control's only edge.

### The adjustments, each forced by a measurement

- `--text-muted` `#6F7D8D` → `#8E9BAA`. The memo's value is 4.51 on `--bg-app` and **3.10 on
  `--surface-active`**, the selected row, where the row's time and preview sit.
- `--danger` `#E46B72` → `#E8797F`. The memo's value is **4.13** on `--surface-active`.
- `--control-edge` is new in dark (`#717E8C`) and kept in light (`#77818D`): the memo's borders are 1.00 to 1.45,
  so a field outlined in one is a shape somebody has to guess at.
- `--accent-text` is split from `--accent` in light: brand Flow Blue `#4C77B8` is 3.60 on the light selected row,
  a fill and an indicator but not text. The previous light `--accent-text` `#436BA8` is **4.27** there, so it
  darkens to `#2F5E9E`.
- `--on-accent` is new: light text on the dark theme's `#78A9FF` is **2.15**, so Compose's label is dark in dark
  mode and white in light.

Each defect is kept in `contrast.test.ts` as an inequality with its reason, so a later "simplification" back to
a memo value fails with the number that ruled it out.

### Selection is carried by an indicator, not a fill

The selected-row fill is 1.38:1 against the list in dark and 1.19 in light, and the hover fill 1.24 / 1.14. So
the fill does not carry selection: the 2px `--accent` bar does (5.54 dark, 3.60 light against
`--surface-active`), with the element's ARIA state. The same holds for the current sidebar row, the selected
list tab, the current section tab and the active palette option, and the test holds each of them. The focus
ring is 2px `--accent`, at least 3:1 on every ground in both themes.

### What this receipt does not cover

A token on a surface that is not one of the eight grounds, such as the message body frame's own sheet, which
uses these tokens on `--bg-reader` (so its pairs are in the table) but whose content is a sender's markup. And
it reads tokens against grounds, not a rendered page: axe over the rendered screens is the other half.

**`contrast.aa_large_ratio` is withdrawn**, with `dim_*`, `accent_ui_worst`, `rail_text_worst` and
`rail_dim_worst`: nothing in the interface is measured at the large-text threshold, and the tokens those
figures described are gone. The sections below are the history of those figures, kept as written.

## Re-measured 28 August 2026: the Mailda brand palette

The `stale_when` above fired on every token at once. The interface moved from the instrument-panel palette
to the brand's Ink / Flow Blue / Sky / Mist / White. Three things changed structurally, not just in value.

**There are three grounds now, not two.** `--sky` joined `--ground` and `--ground-2`, so every worst case
below is a minimum over three surfaces rather than the two endpoints of a gradient. Sky is the darkest of
the light grounds and it is where every figure bottoms out, which is the point of adding it to the test
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
4.58 on Mist and **4.48 on Sky**, a fail on the brand's own third ground by two hundredths, which is
exactly the kind of miss that having Sky in the test exists to catch. .66 clears all three.

### Flow Blue cannot carry small text, and the palette now says so

The finding worth keeping. **Flow Blue `#4C77B8` is 4.53:1 on white**, passing AA for normal text by
**0.03**, and **4.11 on Mist, 3.87 on Sky**, which fail. The brand's accent is not a body-text colour on
two of the brand's own three grounds.

So the token was split by *use* rather than compromised by value:

- `--accent` is `#4C77B8`, the brand hex, for fills, borders, focus rings, icons and the mark's dot. Those
  need 3:1 and the worst case is 3.87.
- `--accent-text` is `#436BA8` for anything a person reads. Same hue (216°) and same saturation (0.432);
  only lightness moves, 0.510 → 0.460. That buys 4.59 at worst.

The alternative was to use one token everywhere, which means either failing AA on Mist and Sky or shipping a
blue that is not the brand's. Splitting keeps the brand hex where it is visible and legal, and keeps text
readable, and the receipt is where the difference is written down so nobody "simplifies" them back together.

**Dark theme lifts the accent rather than keeping the hex.** Flow Blue is 3.99:1 on Ink, fine for a border and
short of AA for text, so dark uses `#6E93CC` for both accent tokens (5.76 on Ink, 4.77 at worst).

### What this receipt still cannot prove

Unchanged from below and worth repeating against a new palette: this measures **tokens against grounds**. It
does not know which token any given element actually uses, so a heading that took `--dim` by accident, or an
`--accent` fill used behind small text, passes here and fails a person. axe cannot see it either. It reads
computed styles on a rendered page, and the failures it catches are the ones a token table cannot.

## axe-core cannot prove contrast on this interface, and reports that as a pass

ADR 30 requires WCAG 2.2 AA **proven** by axe-core per screen. Run against the deployed sign-in page,
axe returns **zero violations**, and that number means almost nothing:

| | Nodes |
|:--|---:|
| contrast **proven** to pass | **1** |
| contrast **failed** | 0 |
| contrast **unproven** (`incomplete`) | **13**, of which 12 for one reason |

> `Element's background color could not be determined due to a background gradient`

`body` carries a top-lit `linear-gradient` (`src/ui.ts`, deliberate; it gives the panel depth rather
than flat fill). axe will not guess a background it cannot resolve to a single colour, so it moves
almost every text node on the page into `incomplete` and reports no violations.

**A harness that reads only `violations` therefore reports AA green on this design language forever.**
That is the landmine shape AGENTS.md names: a check that reads as verified because it did not run. It
was found by building the harness with the first screen, which is exactly why ADR 30 requires that
order. A retrofitted harness would have inherited the false green.

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

**The light theme was failing.** Every `--dim` label on the authenticated surface (`.label` at
`.655rem`, `.hint` at `.7rem`, `.count`, every `td.dim`) is normal text under AA, needing 4.5:1, and
had 4.15:1. Fixed by raising the alpha to `.68`. The two themes need different alphas because dark
text on a light ground is not the mirror of light text on a dark one; assuming symmetry is what
produced the bug.

**The dark theme passes by 0.01.** 4.51:1 against a 4.5 threshold, at the `--ground-2` end. It is
compliant and is left alone, since changing a shipped design on a pass is not justified, but a margin that
thin is a limit developers can hit without seeing it. Any future nudge to `--ground-2` breaks AA
silently. That is the whole reason this receipt exists rather than a one-line fix, and why
`test/node/contrast.test.ts` recomputes both endpoints from the tokens in `src/ui.ts` on every run.

## What this does not cover

Only `--dim` on the two grounds, which is the case that was broken and the case that dominates the
interface. `--signal`, `--alarm` and `--live` are used for state chips and headline figures whose
sizes vary by context, and the state chips also carry a border, so colour is not their only channel
(§16). Those need their own measurement when the real component system lands. Recorded so the gap is
visible rather than implied. This receipt proves one token, not the palette.

## The rail is a fourth surface, and the existing worst cases could not see it (#128)

The brand sheet's product mockup puts the mail on a light page and the rail on a dark one, so the rail is
**Ink in both schemes**. Every measurement above is the minimum across `--ground`, `--ground-2` and `--sky`,
which are Mist, White and Sky in the light theme. The rail is none of them.

So a light-theme token used inside the rail was checked against three grounds it never sits on, and passed
while being unreadable on the one it does. That is not a hypothetical: `.rail-mine` used `--live`, which is
`#2F6F4E` and reads **3.01 on Ink**, a UI component's threshold, applied to text. It was found by measuring
the rail's *descendants* rather than the rules that name it, which is the check that did not exist.

| pairing | measured | wants |
| --- | --- | --- |
| `--rail-text` `#E8EDF3` on Ink | **15.33** | 4.5 |
| `--rail-dim` `rgba(232,237,243,.60)` on Ink | **6.15** | 4.5 |
| `--rail-accent` `#6E93CC` on Ink | 5.76 | 4.5 |
| `--rail-live` `#86C9A4` on Ink | 9.37 | 4.5 |
| Flow Blue `#4C77B8` on Ink, the current row's marker | 3.99 | 3.0 (a component) |
| the Sky selected pill against the Ink rail | 15.41 | 3.0 |
| `--live` `#2F6F4E` on Ink, **the defect** | 3.01 | 4.5 |

The rail's tokens are the dark theme's values, and that is the finding rather than a shortcut: a dark surface
wants the colours that were tuned for a dark surface. Naming them separately is what lets the rail keep them
in *both* schemes. At Ink on a Mist page it is a deliberate contrast, and at Ink on an Ink page the
right-hand rule is what separates them.

## Where the brand sheet and WCAG 1.4.11 disagree

The sheet draws the search field as a **Mist pill on a White header** with a hairline. Measured:

| the pill's boundary | ratio |
| --- | --- |
| Mist fill against White, the control's only edge | **1.10** |
| `--rule` `rgba(15,23,32,.10)` on White | 1.23 |
| `--rule-strong` `rgba(15,23,32,.22)` on White | 1.61 |
| `.34` | 2.18 |
| `.40` | 2.56 |
| **`.47`**, the first alpha clearing 3:1 on all three | **3.03** |

1.4.11 wants 3:1 for the visual information that identifies a control. The brand's fill identifies nothing,
and neither rule token gets close, so `--control-edge` is `rgba(15, 23, 32, .47)` in light and `.37` in dark,
the same asymmetry `--dim` carries, and for the same reason.

It is heavier than the mockup's hairline. That is the disagreement, recorded rather than resolved by
pretending: the field keeps the brand's fill and gains an edge that makes it a field rather than a shape
somebody has to guess at.

**`contrast.aa_nontext_ratio` is a separate value from `contrast.aa_large_ratio` even though both are 300.**
They are different rules, 1.4.11's non-text contrast and AA's large-text threshold, and one number serving
both is how a threshold gets revised for one and silently moves the other. The scale is still ×100.
