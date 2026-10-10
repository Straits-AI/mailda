# Contributing

Read [`AGENTS.md`](./AGENTS.md) first. It is the working agreement, it is short, and it binds humans and
agents equally. This file only adds the mechanics.

Conduct is in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Where work is tracked

Issues on this repository. [Issue #1](https://github.com/Straits-AI/mailda/issues/1) is the map: one issue
holds the route, each child issue holds one decision and the argument for it. Closed issues record what was
rejected and why. Read the closed ones before proposing something that looks new.

## Before you open a pull request

```sh
pnpm install
pnpm test          # every workspace, three runtimes; this is the gate CI runs
pnpm lint
pnpm typecheck
```

Then the list under **Before you call it done** in `AGENTS.md`. The two that trip newcomers most:

- **Every number needs a receipt.** A limit, a timeout or a budget enters the code only through a file in
  `docs/receipts/`; `packages/budgets` is generated from those files and never hand-edited.
- **Every assertion has to be able to fail.** Break the line a new test covers, watch it go red, restore it.
  `pnpm --filter @mailda/worker mutants <source> <test>` automates that for one file pair.

## What a pull request looks like

One decision per PR, with the argument in the description. The title is a sentence that says what changed
and why, in plain words, because it becomes the commit on `main`. Documentation moves with the code in the
same PR: `README.md`, the relevant file under `docs/`, and any receipt whose claim the change touches.

CI runs `check`, and a PR merges only when it passes. Squash merges only.

## Publishing the SDK

`@mailda/sdk` goes to npm with `@mailda/contract` and `@mailda/runtime`, which it imports, at one version. Bump
`version` in all three `package.json` files together, then, signed in to npm as a member of the `mailda` scope:

```sh
corepack pnpm -r --filter @mailda/runtime --filter @mailda/contract --filter @mailda/sdk publish
```

pnpm publishes them in dependency order, replaces `workspace:*` with the version, and runs each one's `prepack`,
which builds `dist`. `pnpm pack` in a package directory makes the same tarball without publishing it.

## Security problems

Not here, and not in a public issue. See [`SECURITY.md`](./SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under [Apache-2.0](./LICENSE), the licence of
the project. No contributor licence agreement is asked for.
