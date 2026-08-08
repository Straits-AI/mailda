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

Current state: **10 screens, 0 AA violations, 0 advisories, 10 unproven** — the unproven being the gradient
contrast that the computed check covers instead.
