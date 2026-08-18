# The application shell

How the interface is put together, and why it is two interfaces rather than one.

## Two surfaces, and the seam between them

ADR 30 splits the interface at authentication:

| | Framework | Loaded |
|:--|:--|:--|
| Sign-in, first-run claim, a locked-out `doctor` | none — DOM constructed node by node | always |
| The authenticated application | React + TanStack Router/Query (§25) | on sign-in only |

The split is not a staging decision that will be tidied away. The pre-authentication screens are the ones
an operator sees **when the Node is broken**, and #23 was that case literally: a dropped binding made
sign-in return 500 and left the diagnostic the only reachable surface. A screen that needs a bundle to
render cannot be the screen you debug a broken bundle from.

So `app.client.js` — now about 360 lines, down from 938 — owns claim, sign-in and the session machinery,
and reaches the application through a dynamic `import("/app/shell.js")` at the moment somebody is signed
in. `shell.pre_auth_bundle_bytes: 0` in `react-shell-bundle.md` is that property as a number, and
`test/shell-split.test.ts` is what keeps it true: it fails if the served page ever references the bundle,
including via a modulepreload, and separately if the import stops being dynamic.

On sign-out the shell is unmounted before the sign-in form renders. A React root left alive over that form
keeps issuing requests that now 401 and eventually renders itself back on top of it.

## What the shell looks like: variant B

Chosen in #32 over two alternatives, on Layer 3 rather than on taste. The next layer is *share* — shared
mailboxes, assignment, reply-collision, cases — and that needs a persistent list of mailboxes with
per-item counts and claim state. That is what a rail is. Route tabs are not, so choosing them would have
meant bolting a rail on at Layer 3 and rewriting the chrome. **The rail therefore exists now with one row
in it, and Layer 3 adds rows rather than a shape.**

- **Rail** — mailboxes, then the ledgers, with `doctor` at the foot because it is what you want when
  something else has stopped working.
- **Split list and reading pane** for mail. The composer is **docked**, not a route: replying must not move
  the original off screen, because for invoice and shipment mail a reply exists to quote a reference from
  it.
- **Full-width tables** for the outbox, audit trail and log. For a ledger a table genuinely is the right
  form — the one thing variant A got right, and it is kept.
- **A bottom instrument bar** carrying the session countdown, the `doctor` verdict and the outbound counts.
  Layer 1's top status strip does not survive: with a rail present the top-right corner stops being where
  a reader's eye rests, and the counts belong beside the mailboxes they describe.

## The honesty rules live outside React

`delivery.client.js` is DOM-free, served at `/app/delivery.js`, and imported by the shell **at runtime
rather than bundled**. It holds the delivery vocabulary and one rule: never suppress an outcome because
the recipients agree, because they agree when everything bounced too.

It is a separate module because that rule was previously inside `app.client.js`, which touches `document`
at load and therefore cannot be imported by any test — and the rule was wrong for months. A send whose
every recipient bounced rendered as green `handed over`. `test/node/delivery-summary.test.ts` evaluates the
**served bytes** of that module, so what is tested and what a browser runs cannot drift.

`session.client.js` is external for a different reason: it holds the token lifecycle in module scope, so a
bundled copy would put two refresh timers on a page that also loads the framework-free script.

## The composer's From selector, and why the words live outside React

A mailbox may have several addresses, and From used to be chosen by `ORDER BY created_at LIMIT 1` — the
oldest — so adding `billing@` to a support mailbox sent billing replies as `support@` with nothing saying so.
The Node now refuses a send from a multi-address mailbox that does not name which address, listing them, and
the composer renders a **From selector when and only when there is a choice**: a select with one option is
furniture, and almost every mailbox has one address.

Two things about it were wrong on first render and were found by opening the composer rather than by the
suite. It sat **below the message body**, so somebody wrote the whole reply and only then met a required
field — From is identity and belongs at the top of a letter. And it was an unstyled full-width native select
among bare-underline inputs, which read as belonging to another application.

**The send-state words live in `delivery.client.js`, not in the React screen**, and that placement earns its
keep. They were a literal map in `ledgers.tsx` keyed on `state` alone, which made `outcome_unknown` read *"We
do not know whether it left"* even in the one case where the Node can prove otherwise: on the authored path
the submitted bytes are stored **before** the transport is asked, so a terminal authored send with no
submitted key never reached it. That is a reading of three fields rather than a lookup on one, and it belongs
where a test can import it — `ledgers.tsx` touches `document`, which is why the outbox's previous honesty
defect (a unanimous all-bounced send rendering as "handed over") lived there uncovered until somebody looked
at the page.

## Drafts

A draft survives a reload, which is what earns the composer's middle phase — *saved on your node* — after
shipping deliberately without it.

- **The body is in R2, encrypted, not in a D1 column.** Every other piece of customer content on this Node
  is; a draft body is content, so a column would be an exception to the product's one promise for the
  convenience of the feature that needed it least. D1 holds the pointer and the metadata.
- **One object per draft**, under a stable key, so an autosave overwrites rather than accumulating an object
  per pause in typing.
- **`send.propose` authorizes it, re-checked on every save and every read.** A draft is addressed from a
  mailbox (ADR 36), so holding one is proposing a send as that mailbox — and a long-lived draft is exactly
  where "withdrawn authority stops working immediately" quietly becomes "next time you sign in".
- **Nobody reads anybody else's**, including other members of the same mailbox. Not because that is settled
  — Layer 3 decides what sharing unfinished work means — but because a guess here is a guess about who reads
  a half-written sentence about a customer.
- **One draft per reply**, enforced by a partial unique index, so replying twice resumes instead of forking
  and leaving the first to rot. The index is partial because SQLite treats every NULL as distinct: as many
  unrelated new messages as somebody likes.
- **A save that changes nothing writes nothing.** `updated_at` is shown as "saved on your node · HH:MM:SS",
  so it has to mean when the draft last *changed*, not when somebody last opened it. Guarded in
  `saveDraft` — the layer that owns the column — as well as in the composer.
- **Deleted when the message is sealed**, by the Node rather than the browser, and *after* the seal: the
  residual is a draft for a message already sent, which is visible and takes one click, rather than losing
  somebody's writing to a seal that then failed. **The row is deleted; the R2 object is not, and nothing
  collects it.** This sentence used to say the object was "left for the reconciler, because ADR 32 makes an
  orphan blob collectable" — every clause of that is true about ADR 32 and false about this prefix.
  `deleteDraft` issues one `DELETE FROM drafts` and touches R2 not at all, and the reconciler's only
  listing is `${orgId}/raw/`, which is also the only listing its `EVIDENCE.delete` ever sees. A draft body
  lives at `${orgId}/drafts/{draftId}.txt`, so it is not collected late — **no code path deletes it at
  all.** Since a draft is deleted on the *ordinary* send path, a Node's R2 usage grows with composer use.
  `doctor`'s `draft_bodies_stranded` finding lists that prefix and now **counts** them, which is the part
  that was missing: the
  residue was previously absent from every report rather than reported as unexamined. **Collection is
  deferred** to the legal hold that every content-destroying call site must consult (#64) — a cleanup sweep
  is itself such a path, so it must not land before the hold exists. Tracked by #67.

Nothing here is audited. A draft is the only write path a person triggers by *typing* rather than by
deciding, and an entry per autosave would put dozens behind one human action —
`audit-and-log-retention.md`'s sizing, falsified as a side effect of a convenience. The act that *is*
audited is `send.sealed`.

## The build

React needs a build step, and it hangs off `wrangler.jsonc`'s `build.command` rather than our `deploy`
script — because a one-click install runs `npx wrangler deploy` directly (measured:
`deploy-button-install.md`), so anything hung off `pnpm run deploy` is absent on the install path most
customers take. Declared in wrangler's own config, the button, the CLI and `wrangler dev` all run it.

The output is `apps/node/worker/generated/` and is **not committed**; `react-shell-bundle.md` records both
why and what it costs. It lives outside `src/` with `watch_dir` set to `src`, because an artifact inside
the watched tree makes each build trigger the next — which looped `wrangler dev` into unresponsiveness
before it was pinned down.

Two TypeScript programs, not one: the browser half needs `lib: DOM` and JSX, and the Worker must **not**
have them, or `document` resolving inside `src/index.ts` becomes a runtime error in somebody's mailbox
instead of a type error. `pnpm typecheck` runs both.

The stylesheet is CSS inside a TypeScript template literal in `src/ui.ts`, which has two hazards worth
naming because they have cost real time. A **backtick in a CSS comment** ends the literal; the build fails
loudly, so the cost is diagnosis rather than a defect. A **stray comment terminator** is the dangerous one:
the prose after it sits outside any comment, CSS error recovery consumes that prose as a selector up to the
next `{…}`, and **the rule immediately following it is silently discarded**. That shipped once. It put
`width: 100%` on the queue's subject column into the served bytes and out of
`document.styleSheets[0].cssRules`, so four consecutive layout attempts were measured honestly against a
stylesheet that never contained the rule under test. `test/node/stylesheet-hazards.test.ts` now fails on
either, and names the line.

## Routes

`src/app-routes.ts` is imported by both `index.ts` and `main.tsx`, so a route is added once. The Worker
serves the page for each of them — a bookmarked `/outbox` must not 404 — and it is a **list rather than a
catch-all**, so a mistyped URL still gets a real 404 instead of an interface claiming that page exists.

`main.tsx` types its screen map as `Record<AppRoute, …>`, so adding a route and forgetting the screen is a
compile error rather than a path that serves HTML and renders nothing.

## Accessibility

ADR 30 requires WCAG 2.2 AA **proven**, and it takes two checks that neither replaces:

- **Contrast is computed** from the design tokens in `test/node/contrast.test.ts`, which runs in CI and
  needs no browser. axe cannot do this job here: against this design language it files almost every text
  node as `incomplete` — "background color could not be determined due to a background gradient" — and
  returns zero violations, so "proven by axe" would once have meant one node in fourteen examined
  (`contrast-tokens.md`).
- **Structure and ARIA are checked by axe**, manually, via `pnpm --filter @mailda/worker run axe`. It runs
  every route in both themes, signs in with `MAILDA_AXE_EMAIL` / `MAILDA_AXE_PASSWORD`, and refuses to
  report a run as clean when it checked nothing.

It runs the WCAG tags as the gate and **best-practice rules as advisories**, because the gate provably
misses things: the duplicate `main` landmark this shell shipped is `landmark-one-main`, which is tagged
`best-practice` and so invisible to an AA-only run. On the first advisory run it immediately found that the
Inbox had no level-one heading at all, and that `/log` and `/doctor` lost theirs while loading.

Current state: **12 screens, 0 AA violations, 0 advisories, 12 unproven** — the unproven being the gradient
contrast that the computed check covers instead. The queue screen is in that count with its clock column,
its inline response-target field and its merge selection present, which is the point of running it against
a seeded fixture rather than an empty one.

**One caveat worth keeping in view:** the harness measures whatever state the fixture happens to be in. The
first clean run had an empty inbox, so the message list did not exist to be checked; the moment a message
was seeded it found two serious violations in it — `nested-interactive` from a `role="option"` wrapping a
button, and a target-size failure on the list itself. A screen is only checked in the states somebody
thought to put it in.
