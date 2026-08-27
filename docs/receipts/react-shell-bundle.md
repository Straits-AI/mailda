---
id: react-shell-bundle
kind: measured-tripwire
measured_on: 2026-08-28
stale_when: >
  react, react-dom, @tanstack/react-router or @tanstack/react-query change major version; the esbuild
  target moves below es2022; a fourth runtime dependency is added to the authenticated application; the
  pre-authentication surface starts loading the bundle rather than importing it on sign-in; the built
  bundle moves more than 10% from the recorded figure for any reason, including screens being added —
  the clause above watched only the dependencies, and the number is mostly application code; or a
  webfont face is added, removed or reweighted, since those bytes are served per Node and are counted
  separately below
values:
  shell.bundle_bytes: 529617
  shell.bundle_gzip_bytes: 153915
  shell.pre_auth_bundle_bytes: 0
  shell.font_bytes: 72368
---

The authenticated application's bundle, measured because ADR 30 traded a build step and a bundle for the
composer and nobody had priced either half.


## Re-measured 28 August 2026: the brand's webfonts, and 2.8% of drift the 10% clause did not catch

Two changes, and only one of them is a new number in the sense the receipt was written for.

### The interface now serves fonts, which it never did before

`shell.font_bytes: 72368` — four faces, Latin subset, served from this origin at `/app/fonts/*.woff2`:

| face | weight | bytes |
|:--|--:|--:|
| Inter | 400 | 23,096 |
| Inter | 500 | 24,296 |
| Plus Jakarta Sans | 600 | 12,236 |
| Plus Jakarta Sans | 700 | 12,740 |

**Not part of the bundle and deliberately counted apart from it.** They are separate requests with the
opposite cache policy — `max-age=31536000, immutable` against the bundle's 60 seconds — because a font file
never changes: the name carries the family and the weight, so a new weight is a new URL. So the 72 KB is paid
once per viewer per year, where the bundle's 154 KB gzip is paid on every deploy. Adding them to the bundle
figure would have made a one-off look like a recurring cost.

`font-display: swap`, so the page is never blank waiting for them. On a Node whose job is showing somebody
their mail, text that arrives in a fallback and then settles beats text that is briefly absent.

**Why they are served at all**, given `ui.ts` said for months that the interface loads no webfont: the
reasoning was never about webfonts, it was about *third parties*. "A page that fetches a font from a third
party hands that third party every viewer's IP address on every load" — and these are same-origin, under a
`font-src 'self'` directive that `test/security-headers.test.ts` now asserts is exactly that and nothing more.
The mechanism changed; the rule did not.

**Satoshi is in the brand and is not in the table.** Its licence permits self-hosting and forbids modifying
and redistributing, and this repository *is* the distribution channel — ADR 24 has customers clone and merge
from it, so committing Satoshi would redistribute it from a public URL to every customer, and subsetting it
for size is the modification the licence names. It is first in the type stack and never shipped;
`apps/node/worker/fonts/README.md` carries the full argument.

### The bundle drifted 2.8% and the tripwire did not fire

515,386 → **529,617** raw, 149,676 → **153,915** gzip. The cause is the search UI (#107) — a search field, a
third empty state and the surrounding wiring — and the `stale_when` clause that should have caught it says
*"moves more than 10% from the recorded figure for any reason, including screens being added"*. 2.8% is
inside 10%, so nothing fired.

That is the clause working as written rather than failing, and it is worth a paragraph anyway: a 10% band on
a figure that only ever grows is a ratchet that lets nine consecutive 1% additions through and then reports
one 11% addition as the problem. The honest reading of this receipt's number is *"about 530 KB, drifting
upward with every screen"*, not 529,617 exactly. Recorded here rather than tightening the band, because a
band narrow enough to catch a screen is a band that fails on every legitimate feature and gets muted — which
`doctor-check-cost.md` has already written a similar paragraph about, for the same reason, twice.

## What it costs

| | Raw | Gzip |
|:--|---:|---:|
| React + react-dom alone (8 Aug) | 194,035 | 60,530 |
| with TanStack Router and Query (8 Aug) | 331,949 | 103,792 |
| **the shell as it now is (26 Aug)** | **515,386** | **149,676** |

Reproduce it by running the build, which prints both numbers:

```sh
pnpm --filter @mailda/worker run build:client
# app bundle: 515386 bytes raw, 149676 bytes gzip -> ./generated/app.bundle.client.js
```

## Re-measured 26 August 2026, because it had rotted and something leaned on it

Found while reviewing #97, which cited this receipt as the authority for what the bundle costs somebody
waiting for it. The recorded figure was **331,949** and the build was producing **515,386** — a drift of
**+55%**, eighteen days old.

Nothing was wrong with the measurement. What was wrong is what the `stale_when` clause watched. Every
condition in it named a **dependency** — a major version, the esbuild target, a fourth runtime dependency —
and the bundle grew because the *application* grew: twelve screens, the composer, passkey registration, the
Butler editor, the transport form. So the clause could not fire, and a number sat here reading as current
while the thing it measured moved by half again.

The clause now also fires on the figure itself moving 10%, which is the only condition that could have
caught this. A receipt whose triggers all point away from its own number is a receipt that goes stale
quietly, and that is worse than no receipt because it still reads as verified.

Two things that did **not** change, and they are the load-bearing halves:

- `shell.pre_auth_bundle_bytes` is still **0**. Sign-in, first-run claim and a locked-out `doctor` load
  none of it, and `test/shell-split.test.ts` is what holds that rather than this file.
- The argument below still holds at the new size, because it never depended on the figure being small — it
  depended on nobody paying it before they are signed in.

**No automated drift check exists for these three values.** Benchmarks re-run nightly per AGENTS.md, but
these are build outputs rather than timings and nothing compares them to the build. That absence is why
this went unnoticed for eighteen days, and it is the real gap here rather than the number.

The Router and Query halves cost **137,914 raw / 43,262 gzip** between them — more than the whole of
React's runtime in gzip terms, which is worth knowing before treating either as free. They are §25's
specified choices rather than a preference, and the alternative was a hand-rolled router that ADR 30's
"no stopgaps" sibling rule would have made us replace.

For scale against a number this repository already measured: `postal-mime` was **deferred** at +106.6 KiB
raw / +25.6 KiB gzip (`mime-header-parse.md`). This bundle is three times that and was accepted, which is
only consistent because of the line below.

Against the Worker as a whole: `wrangler deploy --dry-run` reported **411 KiB / 108 KiB gzip** before and
**723 KiB / 208 KiB gzip** after. Recorded as the tool's own rounded figures rather than as constants,
because a byte count retyped from a rounded display is a false precision — the exact bundle figures above
are the ones a check can use. Either way it is far inside the Workers script limit, which was never the
constraint; the constraint is what a person waits for, which is the next section.

## The number that makes it acceptable: nothing before sign-in

**`shell.pre_auth_bundle_bytes: 0`.** Sign-in, first-run claim and a locked-out `doctor` load none of it.
`app.client.js` reaches the bundle through a dynamic `import()` at the moment somebody is signed in, so an
operator staring at a broken Node — #23's case, where a dropped binding made sign-in return 500 and left
the diagnostic the only reachable surface — waits on 0 bytes of React.

That is the whole of ADR 30's split expressed as a measurement. If the pre-authentication page ever loads
this bundle, the split has quietly stopped existing and this receipt is stale, which is why it is in
`stale_when`.

## Where the bytes live, and why they are not in git

The output is `apps/node/worker/generated/app.bundle.client.js`, produced by `wrangler.jsonc`'s
`build.command` and **not committed**. Two facts decided that:

- **A one-click install runs `npx wrangler deploy` directly** — measured, `deploy-button-install.md` —
  so a build hung off `pnpm run deploy` would be absent on the install path most customers take.
  Declaring it as wrangler's own build command means the button, the CLI and `wrangler dev` all run it.
- Committing it was the other candidate and it works — `packages/budgets/src/generated.ts` does exactly
  that, with CI failing on a regeneration diff. It loses on review: this file changes on *every*
  interface commit, so each one would carry a hundred kilobytes of minified diff that no reviewer can
  read. A generated file is worth committing when a human might need to read it.

If the build never runs, `ui.ts`'s import of the bundle fails at wrangler's bundle step, so the failure is
a **failed deploy** rather than a Worker that deploys green and serves a blank page. That direction was
chosen deliberately.

## The loop this cost on the way

The first version wrote `bundle-size.json` next to the bundle so this receipt could read the figures from a
file. `wrangler dev` watches the source tree to re-run the custom build, so each build triggered the next:
the dev server rebuilt in a loop until it stopped answering requests, which presented as a browser
timeout rather than as anything mentioning the build.

Fixed twice over, because one fix would have been enough only until somebody moved a path — the artifact
now lives outside `src/`, **and** `watch_dir` is `src`. The figures are printed instead, and this receipt
cites the command rather than a file.
