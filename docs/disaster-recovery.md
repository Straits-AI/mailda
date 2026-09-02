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

**A copy that loses custom metadata is survivable, and it did not used to be** (#142). `putEvidence` records
which key sealed an object in R2 custom metadata; `wrangler r2 object get | put` has no flag for it, so a copy
made that way arrives with every byte intact and — until this was fixed — no way to decrypt it. The
destination fell back to generation 0 and every object read `E_EVIDENCE_AUTH_FAILED`. Measured on this drill,
having made exactly that mistake.

A Node now recovers: when an object carries no label the read tries the generations its vault holds, which is
sound because AES-GCM authenticates — a wrong key fails rather than producing wrong plaintext. **So the copy
tool no longer decides whether the mail is readable**, which is the property that matters during a disaster,
when nobody is going to have used the blessed tool.

It is still worth preserving. An unlabelled object costs one extra decrypt per candidate generation on every
read until something re-seals it, and `keyGeneration` in the inventory is how to tell: compare the two Nodes'
inventories, and the field that got lost is the one that differs. That check itself reported `0` for
everything until #141 — the list was never asking R2 for the metadata, so both sides agreed and the agreement
meant nothing.

`wrangler r2 object get` is also simply the wrong tool at size: one request per object, from a laptop.

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

> **Redeeming a code installs the escrow, and this is what it now answers** (#138):
>
> ```text
> {"restored":{"content":[1],"credential":[1]},"conflicted":{"content":[],"credential":[]},
>  "adopted":{"content":[1],"credential":[1]}}
> ```
>
> `adopted` means the escrowed key took a generation this Node had **reserved and never sealed under**. A
> fresh Node mints generation 1 the first time `doctor` initialises the vault — sealing nothing — and the
> escrow carries generation 1 too. Keeping the live key there used to cost the whole organization's mail to
> protect a key that protected none, so the redeem installed nothing, spent a code, and answered `200`.
>
> A generation that **has** sealed is still refused, and that refusal is the safety property: a code redeemed
> against a healthy vault by mistake must not replace live keys with older copies. If you see `conflicted`
> rather than `adopted`, this Node had already sealed under that number, another code will not change it, and
> the answer says so in words.
>
> Measured on the drill's destination: after redeeming, sign-in returned `200` for the first time — the
> restored Node authenticated the source's administrator, with the source's user id.

## Standing a destination up clean, and tearing one down

A restore must go into a Node that has never been restored into. **A second restore on top of a first fails
with `{"D1_RESET_DO":true}`** — no table, no constraint, no explanation, and wrangler's log says only
`d1 execute import polling failed`. D1 rolls the whole file back, so nothing is damaged, but a retry is the
first thing anybody does and it is not the way forward. Start clean instead.

The order matters, and every step of it was found by getting it wrong:

```sh
export CLOUDFLARE_ACCOUNT_ID=<the account>
cd apps/node/worker

# 1. The Worker cannot be deleted while it consumes a queue (`code: 10064`).
pnpm exec wrangler queues consumer worker remove mailda-sending-events mailda
pnpm exec wrangler delete --env "" --force

# 2. Every provisioned resource, because auto-provisioning **creates or fails and never adopts** — it will
#    not reuse an existing `mailda-catalog`, and it fails *after* creating whatever came before it in the
#    list, so a leftover from one attempt breaks the next.
pnpm exec wrangler r2 object delete mailda-evidence/<key> --remote   # per key; a non-empty bucket refuses
pnpm exec wrangler r2 bucket delete mailda-evidence
pnpm exec wrangler d1 delete mailda-catalog -y
pnpm exec wrangler queues delete mailda-sending-events

# 3. The Workflow **survives the script's deletion** and keeps pointing at a script that no longer exists.
#    It is also the one name that collides between Nodes (#99), so leaving it behind leaves the name taken:
#    the next install either refuses on `mailda deploy`'s guard or silently takes it over.
pnpm exec wrangler workflows delete mailda-butler-runs
```

Then `mailda deploy` takes the first-install path, provisions all three bindings, and applies the migrations.

**Verify the teardown rather than assume it.** `wrangler d1 list`, `wrangler r2 bucket list`, `wrangler queues
list` and `wrangler workflows list` should each show nothing named `mailda`, and the Worker's URL should answer
404. The Workflow was the one that did not, which is why this check is written down rather than implied.

**Do not use `wrangler deploy` to repair a Node whose D1 was deleted.** The binding is linked server-side —
Cloudflare's changelog says resources *"stay linked across future deploys even without adding the resource
IDs"* — so the deploy inherits a binding to the dead database and provisions nothing, while
`wrangler d1 … CATALOG` resolves the same name to a different, live one. The two disagree silently, and
`wrangler d1 migrations apply CATALOG --remote` then reports success having applied every migration to a
database the Worker does not read. Delete and redeploy, as above.

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

- **restore-to-readable**: how long until the mail can be decrypted and verified in the new account. Measured
  below, with the caveat that makes the figure worth less than it looks.
- **restore-to-receiving**: how long until the Node accepts new mail again. Needs a domain, Email Routing bound
  to the zone's MX, and DNS propagation — the last of which is not the product's to control. **Unmeasured**,
  and it should stay unmeasured rather than be estimated.

## What this runbook has established, and what it has not

Issue [#92](https://github.com/Straits-AI/mailda/issues/92), step 5: *"prove a sampled set of raw messages
decrypt and hash-verify against the manifests. Step 5 is the one that makes the rest true. An export nobody
has restored is a claim, and this ticket exists because of a claim."*

It has now been run, on 2 September 2026. This records what was measured, including the **five** defects that
made the first two attempts fail — those are the part a future operator needs, and none of them was visible
from reading.

### What was restored, and to where

| | |
| --- | --- |
| source | `mailda.mystraits-ai.workers.dev`, account `dc8d1b7d…` |
| destination | `mailda.arbuilder-app.workers.dev`, account `e842216b…` — a **different** Cloudflare account, no shared resources |
| catalog | 36,124 bytes, data only, 395 rows across 64 tables |
| evidence | 3 objects (three drafts; this Node has no domain, so it has never received mail) |
| backup taken | 2026-09-01T18:27:29Z |

The destination was provisioned from nothing by `mailda deploy`'s first-install path: Worker, D1, R2 bucket,
queue and Workflow.

### The result

```text
== checking stored evidence against the hashes taken at ingress
   batch 1: 3 checked, 0 fault(s)
   batch 2: 0 checked, 0 fault(s)

   3 message(s) checked in 2 batch(es), 0.0 MiB read. Every one opened and
   hashed to what was recorded when it arrived.
```

And the same draft, read through the API on both Nodes:

```text
source       'The first draft body, written to exercise evidence sealing.\n'  (180 chars, row says 180)
destination  'The first draft body, written to exercise evidence sealing.\n'  (180 chars, row says 180)
```

Sign-in at the destination answered `200` for the source's administrator, with the source's user id, after a
recovery code reinstated the vault.

### Timings, and what each one is worth

Measured on this drill. **Three objects is not a sample from which to extrapolate**, and the numbers are
recorded as what they are — the shape of the sequence, not a promise about a full mailbox.

| step | measured | extrapolates? |
| --- | --- | --- |
| first install, including provisioning and 51 migrations | ~2 min | yes, it is fixed work |
| catalog restore, 395 rows via `d1 execute --file` | ~40 s | with the catalog's size |
| evidence copy, 3 objects | ~4 s | **no** — this was one request per object from a laptop, which is the wrong tool at any real size |
| `verify-evidence` over 3 objects, 2 batches | 2 s | with the object count, at 200 objects per invocation |
| redeeming one recovery code | < 1 s | yes |

**RPO** is the age of the backup, so it is a schedule decision rather than a product limit. On this drill the
catalog and the inventory were taken in one command, so there is no window between them to record.

**Restore-to-readable RTO — the figure #92 asks for — is not honestly available from this drill**, and saying
so is worth more than a number. The steps above total about three minutes. The actual elapsed time was
**several hours**, spent on four defects that no longer exist and one that is a Cloudflare behaviour rather
than ours. A three-minute figure would describe a run nobody has had; a several-hour figure would describe
bugs that are fixed. The honest statement is: the sequence is about three minutes of work on a Node this
size, and it has been run successfully exactly once.

**Restore-to-receiving remains unmeasured.** It needs a domain, Email Routing bound to the zone's MX, and DNS
propagation, and the last is not the product's to control.

### What the drill found, which is the part worth keeping

Four defects sat on this path, each of which made the restore fail while reporting success.

1. **The claim granted no `org.admin`** (#129) — a bootstrap deadlock; nothing could authenticate to take a
   backup at all.
2. **`wrangler d1 export` refuses any database containing an fts5 virtual table** (#132), so the export was
   unusable from the day it shipped. The backup now names its tables, derived from `sqlite_master`.
3. **The ten recovery codes were minted, escrowed, and discarded by the interface** (#134). Nobody could ever
   have held one, so the escrow could not be spent.
4. **The escrow could not be installed even when held** (#138). A fresh Node mints generation 1 the first time
   `doctor` initialises the vault — sealing nothing — and the escrow carries generation 1 too. The redeem
   answered `200`, installed nothing, and spent a code. An escrowed key may now take a generation nothing has
   sealed under; one that has sealed is still refused.
5. **The evidence copy silently dropped the metadata naming each object's key** (#142). `wrangler r2 object
   get | put` has no flag for custom metadata. Every byte arrived and nothing could be opened.

The fifth is the one that changed a design rather than fixing a bug. The first answer was a runbook warning
and a list of approved copy tools; the answer that shipped is that a Node no longer depends on the label. The
generation is a hint, and when it is missing the read tries the generations the vault holds — sound because
AES-GCM authenticates, so a wrong key fails rather than producing wrong plaintext.

**And the check that would have caught it was already built and silently returning a constant** (#141): the
inventory reported `keyGeneration: 0` for every object, because `list()` was never passed
`include: ["customMetadata"]`. Both Nodes agreed, and the agreement meant nothing.

### What a clean sweep here still does not establish

Printed by the command rather than left implied: an R2 object no receipt names, and anything that never
reached ingress. Neither is visible to a row-driven verifier, and the inventory is the other half.

This drill also says nothing about scale. Three objects and 395 rows exercise every step in the sequence and
none of the limits — a mailbox-sized restore has a D1 import size to respect and a bucket copy that must not
be one request per object.
