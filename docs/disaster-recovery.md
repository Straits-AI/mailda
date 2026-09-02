# Disaster recovery: taking a backup, and restoring into a different account

Issue [#92](https://github.com/Straits-AI/mailda/issues/92). This is the runbook for the drill that ticket
asks for, written **before** the drill so it can be followed rather than improvised — which is the failure
mode of the three deploy drills that preceded it, each of which spent its time rediscovering a precondition.

## What this is for, and what it is not

Cloudflare gives every account thirty days of D1 Time Travel and Durable Object point-in-time recovery. Both
restore **into the account that failed**. They answer *"somebody ran a bad migration on Tuesday"*. They do not
answer *"the account is gone"*, *"the account is locked"* or *"we are moving"* — and ADR 7's premise is that
the customer owns the account, so losing it is a scenario the product has to survive.

So this is about files an operator holds, and about proving they are enough.

## What each piece establishes

| step | establishes |
| --- | --- |
| `mailda backup` | there is an artifact, and it names what should be in the bucket |
| `mailda verify-backup` | the artifact is the one that was taken — no truncation, no edit |
| a restore into another account | the catalog and the keys are enough to stand a Node up elsewhere |
| `mailda verify-evidence` **there** | the mail decrypts and hashes to what was recorded, in the new account |

The last row is the one #92 calls *"the step that makes the rest true. An export nobody has restored is a
claim."* Everything above it is preparation.

## Preconditions, each of which has bitten something

**The source Node must be claimed.** An unclaimed Node has no organization, therefore no users, therefore
nobody holding `org.admin` — and both `mailda backup` and `mailda verify-evidence` need it. They refuse by
name now rather than asking for credentials that cannot exist. Claiming is also where the first password is
set, so it is an operator's act.

**The destination account must have R2 enabled.** It is a dashboard action with a billing dimension, and it is
not something a deploy can do for you: the Worker declares an `EVIDENCE` bucket binding, and a deploy into an
account without R2 fails outright. Checked before choosing an account, not after:

```sh
# `success: false` with "Please enable R2 through the Cloudflare Dashboard" means this account cannot host a Node.
curl -s -H "Authorization: Bearer $CF_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/r2/buckets"
```

**`CLOUDFLARE_ACCOUNT_ID` must be set** if the token can see more than one account. `mailda preflight` refuses
with the list and the export line when it cannot tell — see #98, where the ambiguity silently skipped the
Workflow-theft guard.

**A destination free of name collisions.** The Workflow's name is written in config because Cloudflare requires
it on the binding, and a Workflow belongs to exactly one script — so a second Node in an account that already
has `mailda-butler-runs` takes it. `mailda deploy` refuses on that, but it is cheaper to know first.

## Taking the backup

```sh
export CLOUDFLARE_ACCOUNT_ID=<the source account>
export MAILDA_EMAIL=<an administrator> MAILDA_PASSWORD=<their password>

node packages/cli/src/mailda.mjs backup \
  --url https://<source-node> --out ./backup-$(date +%F) --verify
```

`--verify` sweeps every object against its recorded hash before writing the index, and records what it found.
Without it the index says `verified: null`, which `verify-backup` reports as **not asked** rather than as
clean. On a first drill, use it: a backup of a state nobody checked is the thing the drill exists to stop
being routine.

**The export names its tables rather than asking for the database**, and the reason is a platform limit found
on the first real run:

```text
D1 Export error: cannot export databases with Virtual Tables (fts5)
```

This catalog has two — the message and body search indexes — so a whole-database export produced nothing and
`mailda backup` was unusable from the day it shipped. A selective export is accepted, so the command reads
`sqlite_master`, excludes the virtual tables, their fts5 shadow tables, `_cf_KV` and `sqlite_*`, and names the
rest. The list is **derived**, so a table added by a later migration is in the next backup without anybody
remembering.

Excluding the index is not a workaround. This repository already says search indexes are rebuildable
derivatives, and it is derived from evidence that *is* in the backup — carrying it would be backing up a
cache. The limit pushed the design where the rule already pointed.

Three files come out:

```text
catalog.sql       the D1 dump. The thing you restore — and it carries the composition manifests, the
                  audit chain and the wrapped vault escrow, because all three are rows.
inventory.jsonl   every R2 object with the hash its plaintext should have.
index.json        what the other two should contain, with a SHA-256 of each.
```

**The evidence bytes are not in the backup.** Streaming a mailbox's worth of R2 through a laptop is not a
backup strategy. The inventory is what makes somebody else's copy checkable — see the bucket copy below.

Then, on the copy you keep, from anywhere:

```sh
node packages/cli/src/mailda.mjs verify-backup --in ./backup-<date>
```

This reads the artifact and nothing else. It catches a truncated copy, a partial download and a directory
somebody edited — most of how a backup is found to be useless, and all of it findable before the day it is
needed. It does **not** establish that the evidence decrypts or that the catalog restores; both are properties
of the restore below, and the command says so in its own output.

## Copying the bucket

Not a Mailda command, deliberately. Either an R2 bucket-to-bucket job or `rclone` with both accounts
configured. The keys are listed in `inventory.jsonl`, so a copy can be checked afterwards rather than trusted.

`wrangler r2 object get` exists and is the wrong tool for a whole bucket: one request per object, from a
laptop.

## Restoring

```sh
export CLOUDFLARE_ACCOUNT_ID=<the destination account>

# 1. Stand up the Worker. The deploy provisions D1, R2, the queue and the Workflow — ADR 24 declares no ids.
#    A first install deploys directly: there is no previous version to protect and nothing a canary could
#    roll back to.
node packages/cli/src/mailda.mjs deploy --url https://<destination-node>

# 2. Restore the catalog. There is no `wrangler d1 import` — `execute --file` is the path.
cd apps/node/worker
npx wrangler d1 execute CATALOG --remote --file=../../../backup-<date>/catalog.sql --env ""
```

**The destination does not need claiming.** The catalog carries the organization and its users, so the restored
Node arrives already claimed, with the source's administrators and their password hashes. That is also why the
restore has to come before anything that needs `org.admin` there.

**The search index has to be rebuilt, and `d1_migrations` will lie about it.** That table is exported like any
other, so the restored catalog says the search migrations were applied while the virtual tables they create are
absent — and `migrations apply` believes it and skips, leaving an index that exists in the bookkeeping and
nowhere else. It fails the first time somebody searches. The backup's own index names the migrations to re-run, read
from the backup rather than from whatever checkout is restoring:

```sh
npx wrangler d1 execute CATALOG --remote --env "" --file=../../../backup-<date>/catalog.sql -y
```

The backup is **data only** and excludes `d1_migrations`, so nothing here conflicts with the schema the
destination's own migrations created — measured against a fresh destination whose 53 tables already existed
and whose 51 migration rows were already correct.

The search index's tables exist for the same reason; only their contents are missing. The backfill repopulates
them from the evidence, and `mailda search list` reports what it could not parse.

**The vault is the part that needs a person.** Content keys live in a Durable Object, which is *not* in the D1
dump — that is ADR 28 working as designed, and it is why the escrow exists. Redeem one of the ten ADR 29
recovery codes against the destination Node to install the keys the catalog's evidence was sealed under. Ten
codes, single-use: a mistyped one is spent.

```sh
# Typed at a prompt, and it refuses a pipe: a code in a shell history is a code in a backup of one. So this is
# the one step in this runbook that cannot be scripted — by design, and it is worth knowing before the day.
node packages/cli/src/mailda.mjs recovery-codes redeem --url https://<destination-node>
```

Unauthenticated on purpose, and this is the reason: the state it exists for is one where the signing key cannot
be unwrapped, so the Node can issue no session and nobody can prove they are an administrator. Requiring
credentials would put the door behind the lock it opens. Measured — the destination answered 500 to every
sign-in while its own `doctor` said `signing_key: E_EVIDENCE_AUTH_FAILED`.

> **This step does not currently work, and it is [#138](https://github.com/Straits-AI/mailda/issues/138).**
> Run on a clean destination, it answered `200` and installed **nothing**:
>
> ```text
> {"restored":{"content":[],"credential":[]},"conflicted":{"content":[1],"credential":[1]}}
> ```
>
> A Node mints its own content and credential generation 1 before it is ever claimed — `mailda deploy`'s own
> closing `doctor` reports `content key generation 1, credential key generation 1. Generated by this Node` on
> a brand-new unclaimed install. The escrow carries generation 1 too, one number cannot hold both, and the
> Node keeps its live key. So the sequence this runbook prescribes collides **by default**, and the escrow
> cannot be installed by the path documented here.
>
> Do not spend more codes trying: all ten carry the same generations, so each one buys the same answer. The
> redeem now says all of that rather than answering with two arrays, which is the part that is fixed.

## Proving it worked

```sh
export MAILDA_EMAIL=<an administrator from the restored catalog> MAILDA_PASSWORD=<their password>

node packages/cli/src/mailda.mjs verify-evidence --url https://<destination-node>
```

This opens every object in the destination's bucket and compares the plaintext hash against what the restored
catalog recorded at ingress. Three faults are distinguished because they need different responses: `missing`
(the copy did not bring it), `unreadable` (the vault does not hold the generation it names — the escrow did not
restore) and `altered` (the bytes changed).

A clean sweep here is #92's step 5. It is the only step that establishes the backup was worth taking.

**What a clean sweep still does not cover**, printed by the command rather than left implied: an R2 object no
receipt names, and anything that never reached ingress.

## Numbers, and which ones this can honestly produce

#92 asks for measured RPO and RTO.

**RPO** — how much would be lost — is measurable without a domain: it is the age of the backup.

**RTO** splits, and the split has to be stated or the number means whatever the reader assumes:

- **restore-to-readable**: how long until the mail can be decrypted and verified in the new account. Fully
  measurable, and it is what this runbook times.
- **restore-to-receiving**: how long until the Node accepts new mail again. Needs a domain, Email Routing bound
  to the zone's MX, and DNS propagation — the last of which is not the product's to control. **Unmeasured**,
  and it should stay unmeasured rather than be estimated.

A receipt recording restore-to-readable and saying plainly that restore-to-receiving is unmeasured is worth
more than one number covering both.

## Not verified

**The whole sequence has now been run twice, and it stops in the same place.** Backup, deploy into a second
Cloudflare account, restore the catalog, copy the evidence — all green — and then the destination refuses:

```text
refuse  signing_key  Could not use the current signing key:
                     E_EVIDENCE_AUTH_FAILED  frame 0 of 1 failed authentication
```

The signing key came across as a row and is wrapped under the source's credential KEK, which lives in the
Durable Object and not in a D1 export. So the restore leaves a Node that knows who everybody is and cannot let
anybody in. **Redeeming a recovery code is not a step to remember — it is the step the rest depends on**, and
this drill is the measurement that says so.

**And the redemption does not clear it (#138).** On the second run — a genuinely clean destination, with the
Worker, D1, R2 and queue all provisioned from scratch — the redeem answered `200`, installed nothing, and spent
a code. A fresh Node mints its own generation 1 before it is ever claimed, so the escrow's generation 1
collides by default. See the box under **Restoring** above. **So the escrow has never been installed on any
Node, and no restored Node has ever read a message.**

### What the second run measured on the way

Six things stood between "the destination exists" and "the destination is clean", none of them in this runbook
before:

- **A second restore onto an already-restored Node fails with `{"D1_RESET_DO":true}`** — no table, no
  constraint, no explanation (wrangler's log says `d1 execute import polling failed`). D1 rolls the whole file
  back, so nothing is damaged. **Do not retry a restore on top of a restore**: stand the destination up clean.
- **Once a D1 has been deleted, `wrangler deploy` will not re-provision it.** The link is stored server-side —
  Cloudflare's own changelog says resources *"stay linked across future deploys even without adding the
  resource IDs"* — so the deployed Worker stayed bound to the dead id while `wrangler d1 … CATALOG` resolved by
  name to a different one. The two disagreed silently, and 51 migrations were applied to the database the
  Worker does not read. `EVIDENCE` is bound by **name** and recovers; `CATALOG` is bound by **id** and does
  not.
- **`/health` calls a missing database "no schema"**, and the fix it names cannot work.
- **`mailda deploy` lists migrations before the deploy that provisions them.** A Node whose script exists but
  whose D1 does not is not a first install, so it takes the canary path and stops at `could not list
  migrations`.
- **Auto-provisioning never adopts an existing resource — it creates or fails**, and it fails *after* creating
  the earlier ones. Three attempts died on D1, then R2, then the queue, each leaving behind what the last had
  made. Every retry needs the leftovers deleted by hand.
- **A Worker cannot be deleted while it consumes a queue** (`code: 10064`), so even the blunt reset needs
  `wrangler queues consumer worker remove <queue> <worker>` first.

### The reset that works, when a destination has to be stood up clean

```sh
export CLOUDFLARE_ACCOUNT_ID=<the destination account>
cd apps/node/worker
pnpm exec wrangler queues consumer worker remove mailda-sending-events mailda
pnpm exec wrangler delete --env "" --force
# Every provisioned resource, or the next deploy fails on whichever one is left.
pnpm exec wrangler d1 delete mailda-catalog -y
pnpm exec wrangler r2 bucket delete mailda-evidence     # objects first; a non-empty bucket refuses
pnpm exec wrangler queues delete mailda-sending-events
```

Then `mailda deploy` takes the first-install path, provisions all three, and applies the migrations.

**What is known to work**, from this drill: `mailda backup --verify` and `verify-backup` against a real claimed
Node; a data-only catalog restore into a fresh account in a different Cloudflare account (395 rows, and the
Node reports `claimed: true` from the catalog alone); and a cross-account evidence copy checked against the
inventory's byte counts.

**What is known not to work**: the redemption, and therefore everything downstream of it — `verify-evidence` on
the destination, and the restore-to-readable RTO this runbook says it times. The sweep itself is no longer the
blocker (#131 is fixed): it would now open all three of this Node's drafts rather than none of them, if the
vault could open them at all.

**What remains unmeasurable here**: restore-to-receiving, which needs a domain and DNS propagation.

**A backup's `--verify` sweep could check nothing and say so — and now it cannot (#131).** On this Node it
reported `0 checked, 0 fault(s)` over three objects, because the evidence is three drafts and the sweep read
`ingress_receipts` alone. Every number honest, and the conclusion drawn from them false; `verify-backup` was
the only thing in the chain that said so — *"the sweep that ran when this backup was taken checked
**nothing** … That is not a clean bill of health."*

The verifier now sweeps all four prefixes, taking its tables from the inventory's referent list rather than a
second one. So a sweep pages **table by table**: `resumeAfter` hands on to the next table when one runs out
and is null only when every one has been walked. A caller that stops at the first null after receipts is back
to the defect, which is why both the CLI and the runbook page until null rather than counting batches.

**The restore half of this runbook has now been run end to end** — and it does not complete. Every command in it
exists (the `mailda` verbs are checked against the CLI's dispatch by `test/node/runbook.test.ts`, and the
`wrangler` subcommands against 4.118.0), and the four deploy drills that preceded this each found something
reading could not have found. This one found eight.
