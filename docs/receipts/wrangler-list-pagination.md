---
id: wrangler-list-pagination
kind: platform-limit
measured_on: 2026-09-04
stale_when: >
  wrangler r2 bucket list gains a pagination flag, a continuation marker in its output, or a --json mode;
  its page size changes from 20; the other three list commands gain page sizes small enough to truncate a
  real account; or the per-name info commands stop distinguishing not-found from every other failure, which
  is what makes asking about one resource safe
values:
  wrangler.r2_bucket_list_page_size: 20
  wrangler.r2_bucket_list_marks_truncation: 0
---

# `wrangler r2 bucket list` returns twenty buckets and does not say so

#162's `deploy --plan` decided whether a resource existed by scanning `wrangler d1 list`,
`r2 bucket list`, `queues list` and `workflows list` for its name. On the first live account it ever met, it
was wrong — in the worst direction available to it.

## Measured

An account holding **41** R2 buckets, 4 September 2026, wrangler 4.118.0:

```text
$ wrangler r2 bucket list | grep -c '^name:'
20

$ wrangler r2 bucket list | grep '^name:' | tail -1
name:           cardkeeper-storage

$ wrangler r2 bucket list | grep -c mailda-evidence
0

$ wrangler r2 bucket create mailda-evidence
✘  The bucket you tried to create already exists, and you own it. [code: 10004]

$ wrangler r2 bucket info mailda-evidence
name:                   mailda-evidence
created:                2026-08-03T16:08:34.256Z
object_count:           86
```

**Exactly twenty, ordered alphabetically, stopping at `cardkeeper-storage`.** There is no continuation
token in the output, no `--page` flag, no count, and no indication that anything was omitted. `mailda-evidence`
is past the boundary by alphabet alone.

## What that cost, before it was caught

The plan reported the bucket **absent** on an account whose Worker exists, which is the `orphaned`
disposition — the one `deploy-plan.mjs` documents as *the worst of the five, because the deploy succeeds*.
It printed, against a healthy Node:

> **MISSING, and the Worker exists.** The binding is linked server-side, so deploying again reports success
> and changes nothing while the Worker keeps reading a resource that is gone.

Every word of that is true of the state it described and false of the account. The Node had been running
since 3 August with 86 objects in the bucket the plan called missing, and the remedy the finding implied is
either a teardown or a repair of something that needed neither.

**This is the failure this repository keeps finding, one layer along: a layer's honest output read as the
layer above's complete answer.** `r2 bucket list` answered the question it was asked — *the first page* — and
the caller took it for the account.

## The fix is to stop reading lists

Every kind has a per-name `info` command, and each says *this thing does not exist* in its own words:

| kind | command | what absence looks like |
|:--|:--|:--|
| D1 | `wrangler d1 info <name>` | `Couldn't find a D1 DB with name or binding` |
| R2 | `wrangler r2 bucket info <name>` | `The specified bucket does not exist. [code: 10006]` |
| Queues | `wrangler queues info <name>` | `Queue "<name>" does not exist. To create it, run:` |
| Workflows | `wrangler workflows describe <name>` | `workflows.api.error.workflow.not_found [code: 10200]` |

Asking about one resource removes the whole class of error rather than the instance of it:

- **no pagination**, so no page boundary to fall past;
- **no substring collision** — the list version matched names with hand-rolled boundaries because
  `mailda-catalog` is a prefix of `mailda-catalog-2`;
- **absence is asserted by the provider** rather than inferred from something not appearing.

`workflows describe` also prints `Script Name:` as its own field, which is #99's ownership question answered
directly instead of by parsing a `│`-separated row.

**The markers are matched specifically, and an unrecognised failure answers `unknown`.** That is the property
that makes this safe rather than merely better: a permission error, a network failure or a reworded message
must not read as a missing resource, because doing so is the bug this receipt is about.

It held immediately. The first version of the per-name probe omitted `wrangler` from its argv and produced
`npm error could not determine executable to run` — status 1, no kind marker — so all four probes answered
`unknown` and the plan printed four gaps. A broken probe could not become a claim about the account.

## What is not established

**The other three list commands' page sizes.** `d1 list` returned 68 rows and `r2 bucket list` truncated at
20, so they are not the same limit — but no account here has enough queues or Workflows to find theirs. They
are no longer read, so the figures are not needed; recorded as unmeasured rather than assumed generous.

**Whether the 20 is per-account or global.** One account, one reading. The `stale_when` names the page size
changing because that is the fact being relied on not to matter any more, not one being tracked.
