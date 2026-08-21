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

## Starting a message (#79)

Every outbound path this product had ran through **somebody else having written first**. The composer was
reachable only from a message's reply button, and `replyContext` was its one caller.

The composer itself was never the obstacle — `inReplyToMessageId` has always been optional and it renders
"New message" in two places. What was missing was a caller that left it out. `newMessageContext(mailboxId)`
is that caller, and it is three fields shorter on purpose: no `to`, no `subject`, no `body`. `replyContext`
derives all three from the message being answered, and a composer that opens pre-addressed to a guess is
how a message goes to the wrong person.

It also claims **no case**, which is the substantive difference rather than an omission. Reply claims the
case in the same act (#42) because two people answering one correspondent is the collision that matters. A
message nobody sent has no case to claim and no collision to lose.

The mailbox is **chosen, never inferred**: From is the mailbox (ADR 36) and `send.propose` is held per
mailbox, so which one this goes from is a decision with a governance consequence. `useMailboxes` already
returns exactly the mailboxes the caller holds `send.propose` on, so the options need no separate authority
check and cannot offer one they may not use. Nothing renders when they hold none.

The control lives in the heading, which precedes every branch of the screen — so it is present while the
inbox is loading, when it is full, and, most importantly, when it is **empty**. That screen says "Nothing
has arrived yet — send one to an address routed here", which until now was advice the product could not
take: a fresh Node could receive before it could speak.

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

## Policy, and the two states it added to the outbox (#60)

A policy decision now runs inside `sealManifest`, so a send's state is a policy outcome and not only a
transport outcome. The shell's outbox therefore renders two states it did not before, and one column it did
not have.

- **`awaiting`** — a policy gated the send. Rendered with `--signal`, the same colour as `held`, because in
  both cases the send is waiting on a person and a fifth chip colour would need its own contrast measurement
  for no new meaning.
- **`withheld`** — this Node declined. It already existed for withdrawn send authority; a policy denial is the
  second thing that produces it.
- **`state_reason`**, a machine token beside the state, rendered as its own unpainted chip. The state says what
  happened to the send; the reason says **who can act**. `awaiting` a hold and `awaiting` an approval are the
  same state with different answers to that question, and the whole point of a reason column is that they do
  not render identically.

**The reason words live in `delivery.client.js`, not in `policy.ts` and not in `ledgers.tsx`**, which is the
same placement rule the send-state words follow and for the same reason: `src/policy.ts` mints the token, one
client module owns the prose, and a test evaluates that module rather than a copy of it. Two copies of one
sentence means the authoritative one is whichever file the reader opened.

The split is **enforced in both directions**, because a placement rule nothing checks is a placement rule that
drifts on the first token somebody adds. `test/node/delivery-summary.test.ts` evaluates the served module and
fails if any send *state* has no words; `test/policy.test.ts` reads the same bytes and fails if any *reason*
this Node can write has none — driven off `POLICY_REASONS`, which is derived from the outcome-to-state mapping
rather than written out, so a renamed or added token arrives at the check without anybody remembering to bring
it. Without that second check the outbox would fall back to rendering `policy_approval_required` at a person,
which is the failure the first check exists to prevent, reached through the other column.

**The stop button now offers itself on `awaiting` as well as `held`**, and that is not a convenience. Nothing
in this build clears a policy gate — releasing a hold and deciding an approval are #61's acts — so without it
the only thing a person could do with their own gated send is watch it. `cancelSend` bounds the authority to
`send.propose`, which whoever sealed it holds by definition, so nothing widened.

**There is deliberately no screen for authoring a policy.** Four routes exist — create, edit the draft,
publish, list — because a rule nothing can write is dead code, and `org.admin` is the only principal for all
four. A screen for writing rules is a design question this ticket does not settle. What the shell does show is
the *consequence*, because a state a person cannot explain is worse than one they cannot set.

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
  somebody's writing to a seal that then failed. **The row is deleted here; the R2 object is collected by the
  reconciler** (#67), and that division is deliberate rather than a leftover. `deleteDraft` issues one
  `DELETE FROM drafts` and touches R2 not at all, because ADR 32 makes reconciliation asymmetric — a
  reference with no blob may only be *reported* — so an inline delete that failed after the row was gone
  would create an object nothing could reach. Routing it through the existing collector also means **no new
  R2 delete site**: `EVIDENCE.delete` in `reconcile.ts` is still the one call in the product that destroys
  content bytes, which is the property `test/node/content-deletion-world.test.ts` exists to protect.
  What this bullet said for two months was that the object was "left for the reconciler, because ADR 32 makes
  an orphan blob collectable" — true of ADR 32 and false of the prefix, because the reconciler listed
  `${orgId}/raw/` only and a draft body lives at `${orgId}/drafts/{draftId}.txt`. Since a draft is deleted on
  the *ordinary* send path, that made a Node's R2 usage grow with composer use, with nothing able to say so.
  The pass now scans that prefix under its own referent rule — a `drafts` row keyed by `body_key`, past the
  same grace window — and collects **the residue every existing Node already has** in the same run, with no
  migration and no separate sweep. It is gated on the org-wide legal hold (#64) and stays report-only while
  one stands, so residue in `doctor`'s `draft_bodies_stranded` finding now means the collector has not been
  run or a hold is suppressing it. `docs/evidence-lifecycle.md` has the predicate, the costs and the
  severity argument; `test/stranded-draft-bodies.test.ts` is what keeps this bullet from going stale a
  third time.
- **A legal hold refuses the deletion** (#64). A draft is addressed from a mailbox, so a hold on that mailbox
  covers it: `deleteDraft` reads the row first, tests the hold against the draft's `created_at`, and refuses
  with `E_LEGAL_HOLD` while recording the attempt as `hold.blocked`. Two consequences a reader should not have
  to discover: pressing **discard** on a held draft answers 409 with the reason, and **sending** from a held
  mailbox succeeds and keeps the draft — the seal happened, so the send route reports `draftRetained: true`
  rather than failing a message that has already left. The composer's draft list then shows a draft for a sent
  message, which is the correct state under a hold and not a bug to tidy away.
- **The composer reads that 409 rather than closing over it.** `apiFetch` *resolves* for a non-ok response,
  so the first version of `discard` closed the dock as though the draft had gone while it was being preserved,
  throwing away the message the route deliberately declines to swallow. It now renders the Node's words
  verbatim in the same `role="alert"` region `seal` uses and leaves the dock open, because a person owed a
  reason has to still be looking at the thing it is about. A 404 still closes: that means the draft is already
  absent, which is what discard asked for, and the route answers it with no message for §5C's reason. Both the
  route's 409 body and the handler's reading of it are asserted — `test/legal-hold-routes.test.ts` and
  `test/node/content-deletion-world.test.ts` — the second lexically, and it says so.

Nothing about a draft's own lifecycle is audited. A draft is the only write path a person triggers by *typing*
rather than by deciding, and an entry per autosave would put dozens behind one human action —
`audit-and-log-retention.md`'s sizing, falsified as a side effect of a convenience. The act that *is*
audited is `send.sealed`.

The one exception is not about the draft: a deletion **refused by a legal hold** records `hold.blocked`, whose
subject is the draft id. That is an entry about an attempt to destroy held content, not about somebody's
writing, and it is at most one per send from a held mailbox — inside the same sizing.

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

Seven routes now: `/`, `/queue`, `/butlers`, `/outbox`, `/audit`, `/log`, `/doctor`.

### `/butlers` (#78)

The whole Layer 5 engine — interpreter, checker, run ledger, pause machinery, replay — shipped with **no
interface whatsoever**; `grep -ric butler src/client/app/` returned 0. The observation API was already
built and already careful, and nothing called it: `inspectRun` gates fact disclosure on `mayReadMetadata`
and classifies every fact as content or operational (#53), an access decision written for a screen that did
not exist, while `doctor` reported a paused Butler and gave an operator nowhere to look.

The screen carries both halves, because *"why did it do that"* is answered by the program and the run
together and splitting them would make the common diagnosis a two-screen navigation:

- **Author** — the list, the draft source, save and publish. Findings come back from the route and are
  shown verbatim. The browser deliberately does **not** validate: `checkButler` runs on the Node, and a
  second copy here would be a second opinion about what publishes.
- **Observe** — recent runs with state, the reason they ended, nodes, effects, refusals and spend; the
  pauses in force, each with the detector's own sentence and a resume that requires a written reason.

Three things it refuses to do, each one a decision made elsewhere that a screen could quietly undo: it does
not fetch around `redactFacts`, it does not offer resume as a bare button over a machine's judgement, and
it does not hide the rail link from non-administrators — the screen answers 404 by §5C, and a hidden link
would be a second, weaker copy of that authority decision living in the navigation.

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

  It **imports `APP_ROUTES`** rather than keeping its own list, and that changed because the copy had
  already drifted: its comment read "kept in step with `src/app-routes.ts` by hand — five paths" above an
  array of six. A route missing from that list is not a wrong answer, it is a screen nobody checked, which
  reads as a clean accessibility run over an unaudited page. `pnpm axe` therefore runs under
  `--experimental-strip-types` so a `.mjs` script can import the `.ts` list.

**Audited on 21 August 2026**, against a seeded local Node with content on every screen: 7 routes × 2 themes,
**0 AA violations, 0 advisories**. It found one thing on the way — `empty-table-header` over the Butler
screen's action column — which is exactly the class of defect this check exists for and would have shipped
otherwise. The house rule that every `<th>` carries `scope="col"` came from the same pass.

**What axe still does not see is interaction state.** It visits each route and audits what renders on load,
so the composer dock, the Butler editor and the resume form — the largest interactive surfaces here — are
never in the DOM when it looks. Those were audited separately and are clean, but by a throwaway script rather
than by anything that runs again. Wiring opened states into `scripts/axe.mjs` is the obvious next move and is
not done.

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
