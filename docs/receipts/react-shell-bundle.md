---
id: react-shell-bundle
kind: measured-tripwire
measured_on: 2026-08-08
stale_when: >
  react, react-dom, @tanstack/react-router or @tanstack/react-query change major version; the esbuild
  target moves below es2022; a fourth runtime dependency is added to the authenticated application; the
  pre-authentication surface starts loading the bundle rather than importing it on sign-in
values:
  shell.bundle_bytes: 331949
  shell.bundle_gzip_bytes: 103792
  shell.pre_auth_bundle_bytes: 0
---

The authenticated application's bundle, measured because ADR 30 traded a build step and a bundle for the
composer and nobody had priced either half.

## What it costs

| | Raw | Gzip |
|:--|---:|---:|
| React + react-dom alone | 194,035 | 60,530 |
| **with TanStack Router and Query** | **331,949** | **103,792** |

Reproduce it by running the build, which prints both numbers:

```sh
pnpm --filter @mailda/worker run build:client
# app bundle: 331949 bytes raw, 103792 bytes gzip -> ./generated/app.bundle.client.js
```

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
