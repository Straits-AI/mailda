---
id: react-shell-bundle
kind: measured-tripwire
measured_on: 2026-10-02
stale_when: >
  react, react-dom, @tanstack/react-router or @tanstack/react-query change major version; the esbuild
  target moves below es2022; a fourth runtime dependency is added to the authenticated application; the
  pre-authentication surface starts loading the bundle rather than importing it on sign-in; the built
  bundle moves more than 10% from the recorded figure for any reason, including screens being added —
  the clause above watched only the dependencies, and the number is mostly application code; or a
  webfont face is added, removed or reweighted, since those bytes are served per Node and are counted
  separately below; a locale is added; either catalog moves more than 10%, which every migrated screen does
  until the interface is migrated; or `/app/locale.js` starts carrying an `app` table, which
  `test/catalog-served.test.ts` refuses
values:
  shell.bundle_bytes: 763056
  shell.bundle_gzip_bytes: 216488
  shell.pre_auth_bundle_bytes: 0
  shell.font_bytes: 96744
  shell.pre_auth_locale_bytes: 15900
  shell.catalog_bytes_en: 92778
  shell.catalog_bytes_zh_hans: 93122
---

The authenticated application's bundle, measured because ADR 30 traded a build step and a bundle for the
composer and nobody had priced either half.


## Re-measured 2 October 2026: the interface's languages, layers 2b and 3

Layer 2b (every other React screen) did not remeasure, so this one measurement carries both layers. Layer 3 migrated
the framework-free scripts before sign-in (`app.client.js`, `session.client.js`, `theme.client.js`), which emptied
`UNMIGRATED`; keyed the Doctor's check titles, a capability's description and a body's problem by the contract's
lists; and gave every locale's `preauth` table the claim, recovery, sign-in, invitation and passkey screens and the
eighteen headlines of `PREAUTH_ERRORS`. `pnpm build:client` (the build step `wrangler deploy --dry-run` runs) printed,
on branch `i18n-l3` from `f876780`, after the layer's last change (the four defects T4 and the screenshots found
included, and round four's two screen changes, "Claim secret" and a Butler run's state keyed, which moved the shell 117
bytes and the app tables about 210 each):

| | 1 October (layer 2a) | 2 October (layers 2b and 3) | delta |
|:--|--:|--:|--:|
| shell bundle | 761,502 raw / 219,307 gzip | **763,056 / 216,488** | +1,554 (+0.20%) / −2,819 (−1.29%) |
| `/app/locale.js`, loaded before sign-in | 3,348 / 1,657 | **15,900 / 6,472** | +12,552 (4.75×) |
| the `en` app table | 49,074 / 13,559 | **92,778 / 25,766** | +43,704 (1.9×) |
| the `zh-Hans` app table | 49,428 / 15,778 | **93,122 / 29,415** | +43,694 (1.9×) |

`/app/locale.js` moved past the 10% clause, and is the one the pre-authentication pages pay for: it now carries every
pre-sign-in word in both locales, where layer 1 carried the wordmark and the language section's few. 6.5 KB gzip,
fetched once per content tag, before any framework and with none (ADR 30 and ADR 46, amended in Blueprint §29 with this
measurement). The app tables moved past it too, as the 1 October projection said they would; they are near the 100 KB
raw it extrapolated, and the interface is now migrated, so a further move is a wording change, not a migration. The
shell did not move past the band: its words left it while its code grew.

## Re-measured 1 October 2026: the interface's languages, layer 2a

Layer 2a migrated the reader, the composer and Drafts, the Queue, the Outbox, Audit, Log and Doctor, and the
sending vocabulary that `/app/delivery.js` used to hold, 669 of the untranslated scan's findings. `pnpm build:client`
(the build step `wrangler deploy --dry-run` runs) printed, on branch `i18n-l2a` from `ee9bec5`, after the layer's
last catalog change:

| | 30 September | 1 October | delta |
|:--|--:|--:|--:|
| shell bundle | 759,600 raw / 220,486 gzip | **761,502 / 219,307** | +1,902 (+0.25%) / −1,179 (−0.53%) |
| `/app/locale.js` | 3,347 / 1,655 | **3,348 / 1,657** | +1: a content tag one character longer |
| the `en` app table | 17,707 / 4,891 | **49,074 / 13,559** | +31,367 (2.8×) |
| the `zh-Hans` app table | 18,374 / 5,976 | **49,428 / 15,778** | +31,054 (2.7×) |

Both tables moved past the 10% clause, as every migrated screen was expected to make them; the shell did not move
past it. The words left the bundle and its gzip fell, while the code the migration added (`delivery-words.ts`, the
`format.ts` functions, the `Said` plumbing) kept its raw size about level. Nothing new loads before sign-in.

**The projection above is low.** 1,140 findings remain in `UNMIGRATED`. At this layer's rate, about 47 raw bytes of
English table per finding, the whole interface's English table would be near 100 KB raw and 28 KB gzip, not the
60 KB and 19 KB projected on 30 September. That is a provisional extrapolation, not a value here: findings include
non-words registered in `NOT_PROSE`, and the screens left differ in how wordy they are. A viewer still downloads one
table, once per content tag.

## Re-measured 30 September 2026, later: the owner's review of the Chinese words

The same build, after the owner's glossary review changed words in both tables (Trash 回收站, Butler 管家, the
rail's count, "Outbound mail" / 出站邮件, the `org.admin` grant sentence): the `en` table **17,707 raw / 4,891
gzip** (−4), the `zh-Hans` table **18,374 raw / 5,976 gzip** (+25). Word changes only, inside the 10% band; the
shell (759,600 / 220,486) and `/app/locale.js` (3,347 raw) did not move. Printed by `wrangler deploy --dry-run`,
whose build step is `scripts/build-client.mjs`.

## Re-measured 30 September 2026: the interface's languages (ADR 46), after 2.7% of drift measured first

**The drift first, so the i18n work is not blamed for it.** On `i18n-l1` at `146cfaa`, before one line of the
language work existed, the build printed **757,990 raw / 220,625 gzip**: +20,218 (+2.74%) and +7,124 (+3.34%)
over the 27 September figure. That is the tree growing since, not attributed here, and it is inside the 10% band.

**Then layer 1 of the language work**, the mechanism and the screens it migrated (the chrome, the palette, the
shell context, health, the shortcuts, the inbox's list pane, Settings, and `api.ts`'s own sentences), measured
with the same command after its last catalog change, which now prints four lines:

| | before (`146cfaa`) | after layer 1 | its own cost |
|:--|--:|--:|--:|
| shell bundle raw | 757,990 | **759,600** | +1,610 (+0.21%) |
| shell bundle gzip | 220,625 | **220,486** | −139 (−0.06%) |
| `/app/locale.js`, loaded before sign-in | 0 | **3,347 raw / 1,655 gzip** | new |
| the `en` app table, served per viewer | 0 | **17,711 raw / 4,892 gzip** | new |
| the `zh-Hans` app table, served per viewer | 0 | **18,349 raw / 5,965 gzip** | new |
| React before sign-in | 0 | **0** | 0 |

`/app/locale.js` is the runtime (plural choice, placeholder filling, negotiation, storage) and every locale's
pre-sign-in words, esbuild-built from `src/client/locale.ts` with `charset: "utf8"`: the default escapes each Han
character as six bytes. Its last 262 bytes (3,085 before) are the Han-Latin space the runtime puts where a filled value
meets a Chinese template, added after the screenshots showed `前往Butler`. **No dependency was added**: the runtime is `Intl` plus this repository's own
`src/i18n/format.ts` and `src/client/locale.ts`. The shell leaves `/app/locale.js` external, so its growth is the Settings language block,
the per-route title, the IME guard and the two small modules the migration will use (`format.ts`, `words.tsx`).

**The shell barely moved because the words left it.** The mechanism added code (the runtime calls, the language
block, the per-route title, the IME guard, `format.ts`, `words.tsx`), and the migrated screens took their English
out of the bundle into the tables, so the gzip figure fell. The tables are about 30% of the interface, the screens
this layer migrated; every later migration moves more words from the bundle into both, so the catalog figures go
stale on each by design (`stale_when`), and each layer's last change remeasures them. An earlier draft of this
receipt recorded 1,208 and 1,182 bytes, measured before the screens were migrated, and was corrected in the same
change. The design's projection for the whole interface, from the words counted in the tree, is an English table
of roughly 60 KB raw and 19 KB gzip; that is a provisional estimate, not a value here. A viewer downloads one table, at a content-tagged URL cached for
a year (`src/i18n/served.ts`), so it is paid once per deploy that changes it, not once a minute.

The gzip figure is within a byte of itself: the shell carries `@mailda/budgets`, so this very value is in the
bytes it measures, so recording a figure can move the next build's by a byte.

`shell.pre_auth_bundle_bytes` stays **0**: `test/shell-split.test.ts` holds the page, and
`test/node/shell-preload.test.ts` holds that the shell is preloaded only when it is handed the page.

## Re-measured 26 and 27 September 2026: the interface redesign, and 28.6% of drift found before it started

Two measurements, **before** and **after** the redesign, so its own cost is visible and not folded into the
drift that had already happened. Both with `pnpm --filter @mailda/worker run build:client`, whose printed line is
the figure (`gzipSync` at its default level):

| | recorded (28 Aug) | before the redesign (`dcda05c`) | after the redesign | redesign's own cost |
|:--|--:|--:|--:|--:|
| bundle raw | 529,617 | 680,900 | **737,772** | +56,872 (+8.4%) |
| bundle gzip | 153,915 | 195,380 | **213,501** | +18,121 (+9.3%) |
| fonts | 72,368 | 96,744 | **96,744** | 0 |
| before sign-in | 0 | 0 | **0** | 0 |

**The receipt was already stale before the redesign.** 529,617 → 680,900 is +28.6%, past the 10% clause, with
no remeasure: the application grew between 28 August and 26 September, and no single change was the one that
noticed. That is the ratchet the section below predicted in so many words. The fonts clause had fired too: on 21 September the
interface went to one family (Inter 400/500/600/700, 23,664 + 24,272 + 24,452 + 24,356 bytes) and Plus Jakarta
Sans left, and nothing was remeasured then.

**The redesign itself cost 8.4% raw and 9.3% gzip**, under the 10% band on its own, and it is recorded anyway,
because this receipt's 10% was measured from a figure that was already a month out of date. The gzip figure is
close to the band, so the next screen added is likely to be the one that trips it. *After the redesign* is the
tree as finished on 27 September: the first measurement of the redesign, on 26 September, was 731,737 / 211,745,
and the review's fixes after it added 6,035 raw and 1,756 gzip (focus return, the roving list, the popover and
menu rules, the draft retire rule, the Doctor's preview requeue). Where it went:
the sidebar, status bar and Health popover (`chrome.tsx` 9,659 → 13,394 bytes in the output), the shell's
shared state (`shell-context.tsx`, 4,835), the six primitives (menu, popover and dialog, shortcuts, palette,
section tabs and the local SVG icons, 12,107 together), the health mapping (2,177), and the Inbox's split into
a list pane, a reader and next steps with Drafts and Settings added (`screens/` 155,452 → 184,747). **No
runtime dependency was added**: icons are local SVG components, and popovers, menus and the palette are
React state plus the native `<dialog>`. `/app/theme.js` joined the three external modules (it is served by the
Worker and applies the viewer's theme before anything renders), so the theme code is not in these bytes.

Where the 737,772 bytes are, from esbuild's metafile with identical options (bytes in output): app `screens/` 184,747 · react-dom 180,730 · zod
78,908 · `@mailda/contract` 75,604 · `@tanstack/router-core` 53,394 · `@tanstack/query-core` 31,406 · `api.ts`
18,718 · `@tanstack/react-router` 16,665 · `chrome.tsx` 13,394 · `@mailda/budgets` 12,924 · `ui/` 12,107 · react
8,125 · `onboarding.tsx` 5,542 · `shell-context.tsx` 4,835.

`@mailda/budgets` at 12,924 is worth a line: `scripts/build-client.mjs` says importing it "bundles the whole
table for one integer", and that is what the Inbox does (`BUDGETS["messages.max_lookback"]` for the lookback's
sentence, and it already read `messages.page_size` the same way before the redesign, at 12,452). It was in the
bundle at `dcda05c` too; the redesign did not add it, and moving the two integers to `/app/config.js` is the
upgrade if the 13 KB is ever worth a change. It also makes this figure move with unrelated receipts: the first
build of the finished tree printed 731,843 / 211,792, and the 106 bytes it lost before the final build are the
three `shard.plan_*` budgets withdrawn from `message-metadata-bytes.md` the same day.

`shell.pre_auth_bundle_bytes` is still **0**: `test/shell-split.test.ts` holds that, and it passed on this
tree. The Worker as a whole was not re-measured with `wrangler deploy --dry-run` here.


## Re-measured 28 August 2026: the brand's webfonts, and 2.8% of drift the 10% clause did not catch

Two changes, and only one of them is a new number in the sense the receipt was written for.

### The interface now serves fonts, which it never did before

`shell.font_bytes: 72368`: four faces, Latin subset, served from this origin at `/app/fonts/*.woff2`:

| face | weight | bytes |
|:--|--:|--:|
| Inter | 400 | 23,096 |
| Inter | 500 | 24,296 |
| Plus Jakarta Sans | 600 | 12,236 |
| Plus Jakarta Sans | 700 | 12,740 |

**Not part of the bundle and deliberately counted apart from it.** They are separate requests with the
opposite cache policy (`max-age=31536000, immutable` against the bundle's 60 seconds), because a font file
never changes: the name carries the family and the weight, so a new weight is a new URL. So the 72 KB is paid
once per viewer per year, where the bundle's 154 KB gzip is paid on every deploy. Adding them to the bundle
figure would have made a one-off look like a recurring cost.

`font-display: swap`, so the page is never blank waiting for them. On a Node whose job is showing somebody
their mail, text that arrives in a fallback and then settles beats text that is briefly absent.

**Why they are served at all**, given `ui.ts` said for months that the interface loads no webfont: the
reasoning was never about webfonts, it was about *third parties*. "A page that fetches a font from a third
party hands that third party every viewer's IP address on every load", and these are same-origin, under a
`font-src 'self'` directive that `test/security-headers.test.ts` now asserts is exactly that and nothing more.
The mechanism changed; the rule did not.

**Satoshi is in the brand and is not in the table.** Its licence permits self-hosting and forbids modifying
and redistributing, and this repository *is* the distribution channel. ADR 24 has customers clone and merge
from it, so committing Satoshi would redistribute it from a public URL to every customer, and subsetting it
for size is the modification the licence names. It is first in the type stack and never shipped;
`apps/node/worker/fonts/README.md` carries the full argument.

### The bundle drifted 2.8% and the tripwire did not fire

515,386 → **529,617** raw, 149,676 → **153,915** gzip. The cause is the search UI (#107), a search field, a
third empty state and the surrounding wiring, and the `stale_when` clause that should have caught it says
*"moves more than 10% from the recorded figure for any reason, including screens being added"*. 2.8% is
inside 10%, so nothing fired.

That is the clause working as written rather than failing, and it is worth a paragraph anyway: a 10% band on
a figure that only ever grows is a ratchet that lets nine consecutive 1% additions through and then reports
one 11% addition as the problem. The honest reading of this receipt's number is *"about 530 KB, drifting
upward with every screen"*, not 529,617 exactly. Recorded here rather than tightening the band, because a
band narrow enough to catch a screen is a band that fails on every legitimate feature and gets muted, which
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
waiting for it. The recorded figure was **331,949** and the build was producing **515,386**, a drift of
**+55%**, eighteen days old.

Nothing was wrong with the measurement. What was wrong is what the `stale_when` clause watched. Every
condition in it named a **dependency** (a major version, the esbuild target, a fourth runtime dependency),
and the bundle grew because the *application* grew: twelve screens, the composer, passkey registration, the
Butler editor, the transport form. So the clause could not fire, and a number sat here reading as current
while the thing it measured moved by half again.

The clause now also fires on the figure itself moving 10%, which is the only condition that could have
caught this. A receipt whose triggers all point away from its own number is a receipt that goes stale
quietly, and that is worse than no receipt because it still reads as verified.

Two things that did **not** change, and they are the load-bearing halves:

- `shell.pre_auth_bundle_bytes` is still **0**. Sign-in, first-run claim and a locked-out `doctor` load
  none of it, and `test/shell-split.test.ts` is what holds that rather than this file.
- The argument below still holds at the new size, because it never depended on the figure being small. It
  depended on nobody paying it before they are signed in.

**No automated drift check exists for these three values.** Benchmarks re-run nightly per AGENTS.md, but
these are build outputs rather than timings and nothing compares them to the build. That absence is why
this went unnoticed for eighteen days, and it is the real gap here rather than the number.

The Router and Query halves cost **137,914 raw / 43,262 gzip** between them, more than the whole of
React's runtime in gzip terms, which is worth knowing before treating either as free. They are §25's
specified choices rather than a preference, and the alternative was a hand-rolled router that ADR 30's
"no stopgaps" sibling rule would have made us replace.

For scale against a number this repository already measured: `postal-mime` was **deferred** at +106.6 KiB
raw / +25.6 KiB gzip (`mime-header-parse.md`). This bundle is three times that and was accepted, which is
only consistent because of the line below.

Against the Worker as a whole: `wrangler deploy --dry-run` reported **411 KiB / 108 KiB gzip** before and
**723 KiB / 208 KiB gzip** after. Recorded as the tool's own rounded figures rather than as constants,
because a byte count retyped from a rounded display is a false precision. The exact bundle figures above
are the ones a check can use. Either way it is far inside the Workers script limit, which was never the
constraint; the constraint is what a person waits for, which is the next section.

## The number that makes it acceptable: nothing before sign-in

**`shell.pre_auth_bundle_bytes: 0`.** Sign-in, first-run claim and a locked-out `doctor` load none of it.
`app.client.js` reaches the bundle through a dynamic `import()` at the moment somebody is signed in, so an
operator staring at a broken Node (#23's case, where a dropped binding made sign-in return 500 and left
the diagnostic the only reachable surface) waits on 0 bytes of React.

That is the whole of ADR 30's split expressed as a measurement. If the pre-authentication page ever loads
this bundle, the split has quietly stopped existing and this receipt is stale, which is why it is in
`stale_when`.

## Where the bytes live, and why they are not in git

The output is `apps/node/worker/generated/app.bundle.client.js`, produced by `wrangler.jsonc`'s
`build.command` and **not committed**. Two facts decided that:

- **A one-click install ran `npx wrangler deploy` directly** (measured 6 August 2026,
  `deploy-button-install.md`), so a build hung off `pnpm run deploy` would have been absent on the install
  path most customers take. Declaring it as wrangler's own build command means the button, the CLI and
  `wrangler dev` all run it. *Corrected 30 September 2026:* on 19 August the button ran the root
  `deploy` script, which is `mailda deploy` since 21 August; the decision stands, because that detection
  moved once without notice and `mailda deploy` reaches the build through wrangler either way.
- Committing it was the other candidate and it works. `packages/budgets/src/generated.ts` does exactly
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

Fixed twice over, because one fix would have been enough only until somebody moved a path. The artifact
now lives outside `src/`, **and** `watch_dir` is `src`. The figures are printed instead, and this receipt
cites the command rather than a file.
