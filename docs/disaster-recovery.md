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
# 1. Forget the search migrations, so the next step re-runs them and recreates the virtual tables.
npx wrangler d1 execute CATALOG --remote --env "" \
  --command "DELETE FROM d1_migrations WHERE name IN ('0040_message_search.sql','0041_body_search.sql')"

# 2. Re-apply, which creates the index's tables and nothing else — the rest are already there.
npx wrangler d1 migrations apply CATALOG --remote --env ""
```

Then rebuild the index itself: the backfill repopulates it from the evidence, and `mailda search list` reports
what it could not parse.

**The vault is the part that needs a person.** Content keys live in a Durable Object, which is *not* in the D1
dump — that is ADR 28 working as designed, and it is why the escrow exists. Redeem one of the ten ADR 29
recovery codes against the destination Node to install the keys the catalog's evidence was sealed under. Ten
codes, single-use: a mistyped one is spent.

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

**The backup half has now been run against a real Node** — claim, deploy, drafts, `backup --verify`,
`verify-backup`, all green, and it found the fts5 limit, a bootstrap deadlock (#129), three CLI commands that
could not authenticate, and two vacuous success messages. What follows the backup has **not** been run.

**The restore half of this runbook has not been run end to end.** Every command in it exists — the `mailda` verbs are checked
against the CLI's dispatch by `test/node/runbook.test.ts`, and the `wrangler` subcommands were confirmed
against 4.118.0 — but a sequence of real commands is not a sequence that has worked. The three deploy drills
that preceded this each found something reading could not have found, and there is no reason to expect this to
differ.

What is known to work, from the fourth deploy drill on 31 August: the deploy sequence itself, including the
canary gate, against a live account. What is known not to have been exercised: `mailda backup` against a real
Node, and every step after it.
