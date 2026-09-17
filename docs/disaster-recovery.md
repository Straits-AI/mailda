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
inventory.jsonl   every R2 object with the hash its plaintext should have. For raw mail, drafts and
                  sends that hash is the row that references the object; for an export's staged
                  copies, which no row names, it is the hash the export stamped on each object
                  (#216). An object with neither is `unaccounted` — an orphan, and one the
                  reconciler collects.
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

**The search index has to be rebuilt.** Only its contents are missing: the destination's own migrations
create the virtual tables, and the backfill repopulates them from the evidence.

> **Corrected 15 September 2026.** This paragraph used to open *"and `d1_migrations` will lie about it"*,
> describing a hazard where the restored catalog claims the search migrations ran while their tables are
> absent, `migrations apply` believes it and skips, and search fails the first time somebody uses it. That
> hazard does not exist, and the paragraph directly below already said so — the two contradicted each other
> across a single page of a runbook somebody reads during an incident.
>
> Settled from an artifact rather than by argument: a backup taken today against the live Node contains
> **663 `INSERT` statements across 28 tables, zero `CREATE TABLE`, and no `d1_migrations` row at all.** The
> exclusion is real, so nothing lies and no migration needs re-running by hand. The instruction to re-run
> them would have cost an operator manual work in the middle of a disaster, for a problem they did not have.

The backup is **data only** and excludes `d1_migrations`, so nothing here conflicts with the schema the
destination's own migrations created — measured against a fresh destination whose 53 tables already existed
and whose 51 migration rows were already correct, and re-confirmed against a real backup on 15 September 2026.

**The destination's migrations must be applied first**, which follows from the same fact and is worth stating
as a step rather than leaving as an inference: the export carries no schema, so importing it into a database
whose migrations are behind fails on the first column the data has and the schema does not. Measured:
importing this backup into a stale scratch database answered `table messages has no column named
body_indexed_at: SQLITE_ERROR`.

```sh
npx wrangler d1 execute CATALOG --remote --env "" --file=../../../backup-<date>/catalog.sql -y
```

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

**Two things a long-deferred upgrade hits, both measured on 5 September 2026 taking a Node from schema 0034
to 0054 — twenty migrations at once.**

*D1 timed out.* `D1 DB storage operation exceeded timeout which caused object to be reset [code: 7429]`, on a
batch ending with a full FTS rebuild. Nothing was lost — one migration had landed, the rest had not, and a
plain re-run applied the remaining nineteen. So a timeout here is a **retry**, not a repair: `d1 migrations
apply` is resumable by construction because it records what it applied.

*The canary refused, and it was wrong to.* `The RPC receiver does not implement the method "ensureKey"` — the
canary carries new code at 0% traffic while the Durable Object namespace still runs the **deployed** version's
class, so a canary calling a method its own release added is calling it on the old object. A Node upgrading
across a release that changed a DO's interface will see this, and it is an artifact of version pinning rather
than a regression: promoting with `wrangler versions deploy <id>@100%` resolves it, because the class updates
with the deployment. Judge it against what the incumbent says, not against the canary alone.

**`mailda deploy --plan` now says which of these steps an account actually needs** (#162), and it is the
better place to start: it reads the four lists, reports each resource as create / linked / cannot-adopt /
orphaned / stolen, and prints only the unwind steps that apply. This section stays because it is the record of
*why* the order is the order, and because a plan is not much use to somebody whose `wrangler` will not run.
The order itself lives in one place in code — `UNWIND_ORDER` in `packages/cli/src/deploy-plan.mjs` — and if
the two ever disagree, the code is the one that ran. See [`cloudflare-grant.md`](./cloudflare-grant.md).

**A temporary preview account is not a destination.** `wrangler deploy --temporary` creates an account and then refuses part way through provisioning — `Authentication error [code: 10000]` on the R2 bucket, after D1 has already been created — because temporary accounts do not support R2, Workflows or Email Sending, and are created on Workers Free where ADR 25 requires Paid ([receipt](./receipts/temporary-account-provisioning.md)).

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
  to the zone's MX, and DNS propagation — the last of which is not the product's to control. **Measured on
  the third drill**, 16 September 2026, below: the restored Node accepted a message from outside the account
  through a rule its own restored grant wrote.

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

**Restore-to-receiving was unmeasured here**, and is measured on the third drill below.

### A second backup, 15 September 2026 — and what it caught

Run against the same Node, now holding **86 evidence objects** rather than the drill's three: 8 received
messages, 27 send manifests with their arms, drafts and exports.

| | |
|:--|:--|
| `mailda backup` | **29.4 s** end to end, including wrangler's D1 export round trip |
| catalog | 366,788 bytes — 663 `INSERT`s across 28 tables |
| inventory | 20,617 bytes, 86 objects, 2 named by no live row |
| `mailda verify-backup` | **0.5 s** |

**The same command failed an hour earlier**, against the same Node running the previous release:

```text
/api/evidence/inventory answered 500, so the backup is incomplete and was not indexed.
11 object(s) had been listed.
```

`hashesFor` bound `referents.length × (1 + keys.length)` parameters against D1's limit of 100, at a page
size of 150 — so `mailda backup` failed on any Node with mail in it. Fixed in #202, and this run is the
confirmation against real data rather than a fixture.

**That is what "run once, over three objects" was actually costing.** It was recorded on #92 as a gap in the
record — something still to be measured. It was a gap in the *coverage*, and a shipped defect was sitting in
it. Eighty-six objects is still not a mailbox, and the next wall above it is unknown; what this establishes
is that the first one is gone.

These figures are here rather than in `docs/receipts/backup-and-restore-cost.md` because they are
observations of one run. That receipt carries the two facts that are receipt-shaped — what the export does
and does not contain — and nothing a stopwatch produced.

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

## The third drill, 16 September 2026 — same account, a real domain, and mail arriving at the restored Node

The two things the second drill could not establish were **restore-to-receiving** and **anything about
scale**. This drill took the first and measured the shape of the second. It ran inside one Cloudflare account
(`Swmengappdev`), which Email Routing forces: a rule can only name a Worker in the zone's own account, so a
cross-account restore cannot receive on a zone it does not own. Cross-account was drilled on 2 September;
this one is the same sequence with a second Node beside the live one, and `mailda.site` — registered into
this account the day before, carrying no mail — as the domain.

### The sequence, timed

| step | measured | notes |
| --- | --- | --- |
| backup with `--verify`: 756 rows (411 KB), 86 objects | **65 s** | 84 verified, 0 faults; 2 stranded draft bodies reported as unaccounted, correctly |
| first install of the destination (`mailda-drill`: deploy, 54 migrations, consumer) | **95 s** | the config edited in two places, as `deploy-drill-live-account.md` says a second Node costs |
| catalog restore, `d1 execute --file`, 4,207 rows written | **5 s** | the second drill's 40 s for 395 rows was wrangler start-up, not rows |
| evidence copy, 86 objects / 376 KB, `wrangler r2 object get \| put` | **461 s — 5.4 s per object** | start-up-bound, not byte-bound: two wrangler invocations per object. A 10,000-message mailbox this way is about fifteen hours |
| redeeming one recovery code (typed by a person) | seconds | `2 key generation(s) installed, 2 of them replacing a generation this Node had reserved and never sealed under` |
| `verify-evidence`, 84 objects in 3 batches | **64 s** | 0 faults; the restored Node signed the source's administrator in |
| receiving onboarding through the restored grant | four runs, see below | |
| a message from outside the account to `inbox@mailda.site` | **accepted** | 7,032 bytes, `accepted_at 16:54:08Z`, the ninth receipt on a Node restored with eight |

**RPO** is the backup's age, as before. **Restore-to-readable RTO**, for a Node this size and with no defects
in the way, is the sum of the rows above: about **twelve minutes**, of which eight are the per-object copy.
**Restore-to-receiving RTO** adds the receiving onboarding and DNS — the rule was live within a minute of the
onboarding completing, and the message arrived within the hour it was sent. Neither figure is a promise: the
copy scales with objects at a rate the tool decides, and the onboarding on this drill took four runs because
of the defects it found.

### What it found — four defects in the receiving step, none visible from reading

The receiving onboarding (#209, #210) had never been run through a grant. Each run found one thing:

1. **The routing rule needs `email-routing-rule.write`.** The reach table carried the rules endpoint under
   `zone-settings.write` by inference; a grant holding that and `dns.write` wrote the MX records and was
   refused the rule with `10000 Authentication error`. The scope was not on the OAuth client either, and the
   re-consent answered `invalid_scope` until it was added in the dashboard. The ceremony asks for it now.
2. **A half-done onboarding refused to resume.** The next proposal read the MX this Node had just written and
   said *"already has MX, so it is already pointed at a mail host"*. Cloudflare's own routing hosts now read
   as this Node's earlier attempt: kept, not rewritten. The same for the address row and the rule, each met
   one run later.
3. **Nothing registered the address on the Node.** The rule named `inbox@mailda.site`; ingress resolves a
   recipient against `addresses` before reading a byte, and no product path had ever inserted a row — the
   live Node's two were put there by hand. The message would have been rejected as `unknown_recipient` by
   the very rule that delivered it. The onboarding writes the row now, before Cloudflare is asked.
4. **The enable did nothing.** `PATCH /email/routing { enabled: true }` answers `success: true` and leaves
   the zone `enabled: false, status: unconfigured`; only `POST /email/routing/enable` enables it. The Node
   sends the `POST` and reads the zone back, refusing if it is still off.

Two more, outside receiving: the deploy gate's version override did not reach a freshly created Worker
within its fifteen-second retry (the canary was promoted by hand, as the gate's own `fix` says to), and the
consent state a URL carries expires faster than a URL handed across a chat gets clicked.

**The first of those was not propagation.** Found on 17 September (`deploy-drill-live-account.md`, the
fifth drill): the override header named `mailda` as a literal, whatever the Worker was called, so on a Node
named `mailda-drill` it could never apply. Fixed, and measured reaching a named Node on the first attempt.
The three `wrangler.jsonc` edits this drill made by hand and reverted are `mailda deploy --name` now.

### Torn down

In the runbook's unwind order, with the drill's names: the routing rule on `mailda.site` first, because a rule
to a deleted Worker is the inert rule this whole layer exists to avoid; then consumer, Worker, the 86 copied
objects plus the one the restored Node had received, the bucket, the database, the queue, the Workflow. The
live Node's plan reads *redeploy, nothing to do* afterwards and its `doctor` is `ok`. `mailda.site` keeps
Email Routing enabled with its MX at the apex and no rule — mail to it is refused by Cloudflare rather than
routed anywhere — and keeps the sending subscription the live Node created for it.

### What this drill still does not establish

- **The copy at scale.** 5.4 s per object is the cost of the tool, not of R2; an S3-API copy (`rclone`, or an
  R2 bucket-to-bucket job) was not measured, and is the number a mailbox-sized restore actually needs.
- **The catalog import's wall — measured on 17 September, and it is not near.** On scratch databases in the
  live account, seeded with the byte receipt's corpus and exported with `d1 export --no-schema` — the shape
  the backup writes — then `execute --file` into a fresh database with the schema:

  | messages (+ one item each) | export | export size | statements | import | rows read back |
  |--:|--:|--:|--:|--:|--:|
  | 10,000 | 11 s | 15.6 MB | 20,000 | **22 s** | 10,000 |
  | 50,000 | 33 s | 78.1 MB | 100,000 | **107 s** | 50,000 |

  Linear, about 1,000 statements a second. `wrangler d1 execute --file` uploads the file once and processes it
  server-side, so a laptop's link is paid once per restore rather than per row. The wall it does have is per
  **statement**: a hand-built 150 KB `INSERT` was refused with `SQLITE_TOOBIG`, which an export never produces
  (one row a statement). So the catalog half of a mailbox-sized restore is minutes, and the copy above is the
  hours — the order to fix them in is the one already stated.
- **Cross-account receiving.** Structurally impossible for a zone the destination does not own; a customer
  moving accounts moves the zone first, and that move was not drilled.

