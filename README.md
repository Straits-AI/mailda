# Mailda

Shared inboxes that know who replied.

If two people have ever answered the same customer email, or nobody could tell you whether
`invoices@` got a response, or your shared inbox is a Gmail account four people know the
password to — that's the problem. Mailda turns email addresses into governed work
endpoints: assignment, collision detection, cases, approvals, audit, and deterministic
automation, with AI available only where you explicitly put it.

It runs entirely in **your own Cloudflare account**. You own the domains, the message data,
the encryption keys, the model keys and the bill. There is no Mailda service to depend on,
no licence server, and no telemetry. Disconnect us and nothing stops working.

---

## Installing it, and the honest state of that

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Straits-AI/mailda)

**Measured on 6 August 2026, and then fixed.** The install produced a green build and a dead Node:
Cloudflare runs `npx wrangler deploy` rather than this repository's `deploy` script, so the schema was
never applied — an empty catalog and every request answering 500. Depending on somebody else's script
detection to produce a working mail server is a hope with a 500 attached, so **the Node applies its own
schema now** (`POST /api/prepare`, or automatically as part of being claimed). The full log, and the four
defects the install exposed in Mailda itself, are in the
[receipt](./docs/receipts/deploy-button-install.md). It is here because the
only way to find out what a customer's first five minutes actually look like is to put the real button
on the real repository and click it — and because a button that appears once it already works teaches
nobody anything about why it took so long.

What the measurement settled:

- **The monorepo works.** The URL points at the repository root deliberately — Cloudflare
  [does not fully support monorepos](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
  and clones a *subdirectory* URL as the whole new repository, which would leave behind the three
  `workspace:*` packages the Worker depends on. Pointed at the root, `pnpm install` resolved all 7
  workspace projects and the build bundled.
- **Resources are provisioned, and no ids are written into your clone.** D1 and R2 are both created by
  the build, and `wrangler.jsonc` comes out byte-identical to upstream.
- **Your clone is not a fork.** It arrives as a single squashed commit with no shared history, so a
  `git pull` from upstream is not a fast-forward, and `.github/workflows/` is stripped — an installed
  Node has no CI until its first update restores it.

**Updating an installed Node.** Once, because the install left no shared history to build on:

```sh
git remote add upstream https://github.com/Straits-AI/mailda.git
git fetch upstream main
git merge upstream/main --allow-unrelated-histories
# One conflict, in package.json. Keep your own `name`, take upstream's everything else.
```

That merge creates the ancestor the install did not leave, so **every later update is an ordinary
`git pull upstream main`** with no conflict — and this first one also restores the CI the install
stripped. `package.json` is the only file that can conflict, and
`test/node/update-path.test.ts` fails if a second one ever joins it, because at that point these four
lines stop being true.

**Resetting a password.** There is no password-change flow in the product yet, which for a self-hosted
system is a gap rather than a simplification — a lockout has to be recoverable from outside the thing
that locked you out. `pnpm run set-password <email>` reads the new password from a terminal with echo
off, so it never reaches shell history or a process listing, derives the verifier with the *same*
chained PBKDF2 the Worker uses rather than a second copy of it, and revokes every existing session in
the same breath. It cannot appear in the audit trail: it runs outside the Worker, and an operator with
database access is outside what a hash chain can attest to.

**One step the install does not do, and what it costs you.** Delivery outcomes — whether a message was
`accepted` or `bounced`, per recipient — arrive on a Cloudflare queue. A queue name is *account-scoped*, so
this repository names none, and the deploy is expected to provision one per Worker the way it already does
for D1 and R2 — that much is **Cloudflare's documentation, which we have not measured**, so the command
below discovers the queue from the deployed Worker and refuses if the deploy created none, rather than
assuming a name ([receipt](./docs/receipts/queue-provisioning.md)). Naming none is not optional: the
committed name meant a **second** Node installed into the same Cloudflare
account bound its producer to the **first** Node's queue and had its sending events drained by the first
Node's consumer, across two separate catalogs, with nothing looking wrong on either
([#72](https://github.com/Straits-AI/mailda/issues/72)).

The cost is that a *consumer* cannot be declared in configuration at all — a consumer block must name its
queue, and the derived name is not knowable in a committed file — so attaching it is one command, after the
first deploy:

```sh
pnpm run queue:attach-consumer
```

It discovers the queue from the deployed Worker's own binding rather than guessing its name, and re-running
it is safe.

**This is not a cost the per-Node queue introduced, and saying otherwise would be the more flattering
version.** Delivery outcomes need *two* account-level objects: a consumer on the queue, and an
`email.sending` **event subscription** that publishes to it. The subscription has never been creatable by
wrangler — re-measured 19 August 2026, `--source` accepts `artifacts`, `artifacts.repo`, `images`, `kv`,
`r2`, `superSlurper`, `vectorize`, `workersAi.model`, `workersBuilds.worker` and `workflows.workflow`, and
**not** `email.sending`. So a button-only install has **never** observed a delivery outcome, before this
change or after it: the queue existed, the consumer was attached, and nothing was ever published to it.

What changed is the count. One out-of-band step became two, both in the same place, and neither is
scriptable end to end — so **running the command above is necessary and not sufficient**, and a reader who
stops there still has a blind Node. Until both exist every recipient stays `unobserved`, which is honest but
blind, and `mailda doctor` reports each missing half separately rather than letting silence read as
"nothing bounced" ([receipt](./docs/receipts/queue-provisioning.md)).

The CLI path escapes the button's caveats above but **not** this one: clone, `pnpm install`,
`pnpm run deploy` provisions D1 and R2 on first deploy ([receipt](./docs/receipts/r2-auto-provisioning.md))
and applies the schema — then `pnpm run queue:attach-consumer`, deliberately **not** chained into `deploy`:
the button's install path never runs our scripts anyway, and a discovery failure inside `deploy` would turn a
working install red for a Node that works in every respect but one.

---

## Status: designed, not built

**This is not deployable software yet.** Saying otherwise would be the kind of overclaim
the project's own working agreement forbids.

What exists today:

| | |
|---|---|
| **Product contract** | [`Mailda-Full-Engineering-Blueprint.md`](./Mailda-Full-Engineering-Blueprint.md) — 2,586 lines specifying the target state, with 41 locked architectural decisions |
| **Working agreement** | [`AGENTS.md`](./AGENTS.md) — how decisions get made and what counts as done |
| **Decisions taken** | 30 recorded with full reasoning and rejected alternatives, on the [issue tracker](https://github.com/Straits-AI/mailda/issues/1) |
| **Measurements** | 30 receipts in [`docs/receipts/`](./docs/receipts/) generating 169 verified constants |
| **Code** | A measurement harness and one Worker. 488 tests, checked on every push. Not a product. |

**It can send to more than one person, which it never could before.** `EmailMessage` takes one address, so
the old code joined recipients with commas into a single malformed one — a `Cc` refused the whole send.
Mailda now submits the same stored bytes once per recipient, which costs nothing extra (measured: Cloudflare
already counts one three-recipient send as three) and makes `Bcc` correct rather than merely possible, since
a real Bcc needs its own envelope. Proven live: one send, three recipients, three submissions, three
outcomes — **accepted, bounced, bounced** — each with its own message id.

**Two people can work one queue without colliding, and the mechanism is one line of SQL.**
`UPDATE cases SET assignee = ? WHERE assignee IS NULL` — no lock, no Durable Object, no timeout. Reply
performs that swap and opens the composer in one act, so a collision is unrepresentable rather than
detected. Lose the race and you are told **who** holds it and for how long, because the Node re-reads the
row instead of reporting a bare failure. There is no expiry: an expiry is a policy guess, a claim's age is a
fact, so the queue shows the age and a colleague decides. Taking a case from somebody is allowed and
audited — the design prevents accidents, not takeover, and says so.

**One clock, and it promises nothing until somebody says what to promise.** Time to first response: from
the oldest inbound message nobody has answered to the first outbound hand-over. No pause and no
`waiting-on-customer`, because a pause needs to know whose turn it is and this Node cannot observe that — a
clock that pauses wrongly measures nothing. The target is **per mailbox with no default**: NULL means no
service level, which is the shipped state, because how fast a business answers its customers is not a
platform limit and not ours to invent. It is set on the queue screen, beside the clocks it governs, so a
promise nobody can see the source of is not one anybody has to trust. A breach is recorded by a cron sweep —
a query over due rows, idempotent by construction, so a dropped invocation is repaired by the next minute's
rather than losing the breach — and it does **not** change the case's state: a case that is late is not a
different kind of case, so the fact is shown beside it rather than folded into it.

**Merging two conversations mostly refuses, and the refusal is the feature.** Twelve pair-states can occur
when merging A into B; two are safe to automate. The rest mean a single-winner merge destroys a claim
somebody is working, reopens something reported closed, or resets a breach that happened — and that last
class is the deciding one, because the failure of merge-by-picking is not lost text but a system reporting
something untrue about work it owes a customer. So it merges the two safe states and refuses the others
**naming the mailbox and the case pair to resolve first**. One contested pair refuses the whole merge, since
a partially merged conversation contradicts a conversation being one thing.

**A delivery is what gets filed, not a message.** §12 says a message may have many deliveries and access
is evaluated per delivery — and that was *assumed* rather than implemented. The ingress derived key was the
Message-ID alone, and Email Routing calls the handler once per recipient, so a customer who Cc'd two of
your addresses had the first filed and the second discarded as a duplicate. The mailbox that was addressed
received nothing, and nothing recorded that it hadn't. It looked exactly like deduplication working, which
is why it survived. Now the key is the Message-ID **and** the recipient: two deliveries file twice, the same
delivery twice still files once, and the retry-safety the key existed for is untouched.

**A Node that cannot see delivery outcomes says so.** *Two* account-level objects carry them and neither is
in the Worker's config: the queue consumer and the event subscription. Both can be absent, deleted, or
pointed at the wrong thing — and nothing about a Node in that state looks wrong: sends hand over, the outbox
fills, and every recipient sits unobserved forever. `doctor` reports the capability it cannot check from
inside a Worker, then compares what was handed over against what came back and names the silence, because
"no bounces" must not be able to mean "nothing heard".

**The authenticated application is React now, and the screens you need when it is broken are not.**
ADR 30 put React at this layer with the composer, where client state first outlives a request. The split is
the interesting half: sign-in, first-run claim and a locked-out `doctor` stay server-rendered with no
framework and load **zero bytes** of the bundle, because they are the screens an operator sees when the
Node has stopped working — once, literally, when a dropped binding made sign-in return 500 and left the
diagnostic the only reachable surface. That is a measured property rather than an intention, and a test
fails if the page ever references the bundle up front.

The shape is a rail, a list and reading pane, full-width ledgers, and a **docked** composer — docked
because replying must not move the original off screen, which for invoice and shipment mail is a defect
rather than a preference. The rail carries one mailbox today and exists so Layer 3 adds rows instead of a
new chrome. Its draft label says where the bytes actually are, and now it can say the true thing: a draft is
**saved on your node**, body encrypted in R2 like any other content rather than sitting in a database
column, one object per draft, and replying twice resumes the draft you already started instead of forking
it. Until that existed the label read *this browser only · a reload loses it*, which was the honest version
and the argument for building this.

Building it found what the old shape was hiding. Accessibility is checked two ways that neither replaces —
contrast **computed** from the tokens in CI, because axe cannot resolve a gradient background and reports
that as a pass; structure and ARIA by axe, run per screen in both themes, with best-practice rules as
advisories because the AA gate provably misses things. The first advisory run found the Inbox had no
level-one heading at all.

**And the outbox cannot summarise that silence away.** The row a person actually reads showed the
submission state — `handed over`, in green — and added the delivery outcome only when the recipients
*disagreed*. Reasonable for the case anyone pictures, and wrong for the two that matter: a send whose
every recipient bounced is unanimous, and a single-recipient send has nobody to disagree with. So a send
that reached nobody rendered identically to one that arrived, with the correct per-recipient table one
click underneath. It was found by rendering the page and looking at it. The suite had nothing to say,
because the rule lived in the one file that touches `document` and therefore cannot be imported. That
rule now lives in a module a test can evaluate, and the test fails by name when either guard returns.

**The state nothing retries always carries a reason.** A dispatch claims the send as `outcome_unknown`
*before* submitting, so that an invocation dying mid-flight leaves it in the one state that forbids an
automatic retry — the right pessimism, because a retry could deliver a second copy nobody can recall. But
the claim wrote only the state, and every other route to a terminal state records its reason and an audit
entry together. So anything that threw in between produced the only terminal state reachable with no
account of itself: no reason, no audit entry, never retried. An operator read "we do not know whether it
left" and could not find out why not. Now a throw records the cause against the send and appends the
entry, without claiming anything about whether the mail actually left — which remains genuinely unknown.
A killed isolate still runs no handler, and that limit is stated rather than papered over.

**A bounce reaches the right recipient of the right send, by key.** A Node cannot receive its own
bounces — `cf-bounce` belongs to Cloudflare for the lifetime of the domain — so delivery outcomes arrive
on a queue instead, one event per recipient. Proven end to end on the deployed Node: a send handed over,
and about a minute later that recipient read `bounced / hard` with the provider's own words
(*"Permanent: no available upstream: unknown public suffix"*), while a recipient nobody reported on stayed
**unobserved**. `accepted` comes the same way, from a 250 the receiving server actually returned — which is
an observation, not a claim. ([receipt](./docs/receipts/email-sending-events.md))

**Every recipient of a send has its own state.** A send to three people used to have one state column and
a JSON array of addresses, so "one bounced and two were accepted" was not representable — and that is the
distinction Layer 2 is judged on. There is now a row per recipient, written in the same transaction as the
manifest, with submission mirrored from the envelope and delivery left **NULL** until something is
actually observed. That NULL is load-bearing: any default would make "we have heard nothing" look like an
outcome.

**Sending is authorized, and the authority is re-checked before the message leaves.** Layer 2's first
named requirement was absent: any authenticated member could seal a send as any mailbox in the
organisation, including one they cannot read. Sealing now requires `send.propose` on that mailbox — a
distinct relation from reading it, because a shared mailbox several people read is exactly the kind whose
outbound identity should be held by fewer of them. The check runs *again* before hand-over, because a
send waits out a hold window and the sweeper that releases it has no principal in scope: revoking
authority mid-window now produces `withheld`, a state that says the Node declined rather than blaming a
mail service that was never asked.

**Being able to reply is not permission to read.** The queue was gated on `send.propose` alone and its rows
carry the subject line and the sender address, so anybody who could reply read the metadata of every message
in the mailbox — with no relation permitting it and nothing recording it. Found by asking what a *single*
relation discloses: every existing queue test granted `send.propose` because claiming needs it, and none
asked what somebody holding only that could see. `mailbox.metadata.read` — named in the blueprint's own
permission catalogue and implemented nowhere, one mention in a test seed — now gates those two columns,
either it or `mailbox.content.read` satisfies them, and a responder holding neither is shown the
restricted-content placeholder the contract already specified. The withheld columns are `NULL` in the SQL
rather than read and discarded, because a value in the result set is one line of code from being returned.

**A choice with consequences for every recipient is not made by a timestamp.** A mailbox may have several
addresses — `addresses` is unique on the address, not on the mailbox — and From was picked by `ORDER BY
created_at LIMIT 1`. So adding `billing@` to a support mailbox sent billing replies as `support@`, silently.
The authority is still the mailbox (ADR 36) and the finer `sender:` grain is still deferred; what changed is
that a mailbox with more than one address now **refuses** a send that does not name which, listing them, and
the composer offers the choice. Refusing rather than picking is the same move merge makes.

**Replying stopped the clock only in the tests.** The dispatch path joined `messages.rfc_message_id` against
`send_manifests.in_reply_to_message_id` — one is a `<…@domain>` header, the other our own `msg_` id, and their
schema comments say so. It could never match, so every case in a mailbox with a response target was reported
breached however fast the reply left. **Eighteen tests passed over it**, because every one called the clock
function directly with a conversation id it already knew; the only real caller is the one that has to *find*
the conversation. That is the shape of most defects found this way: the mechanism is tested exhaustively and
the wiring is not tested at all.

**A diagnostic that counted evidence of its own blindness as evidence of sight.** `doctor` decides "this Node
cannot see delivery outcomes" partly on there being no delivery events — and counted events it had failed to
attribute to anything. One unattributable event, which is proof that attribution is broken, was enough to
suppress the warning. Now blindness counts attributed events only, and unattributable ones raise their own
finding, because a Node receiving events it cannot place is neither blind nor healthy.

**"Deleted" meant dereferenced, and no report could say so.** A draft body is an R2 object; `deleteDraft`
removes the row and touches R2 not at all; a draft is deleted when its message is **sealed**, which is the
ordinary send path. The code and the shell doc both said the object was "left for the reconciler, because
ADR 32 makes an orphan blob collectable" — true of ADR 32, false of this prefix, because the reconciler
listed `${orgId}/raw/` only and draft bodies are written under `${orgId}/drafts/`. So every message ever sent
from the composer left an unreferenced copy of its draft, and no figure anywhere could reveal it: a scan of
one prefix printed `0 orphans` exactly as a scan of the bucket would. `reconcile` now **names the prefixes
it scanned**, so a prefix outside the scan appears in the output instead of being absent from it, and
`doctor` counts the stranded bodies. The deletion waited for the legal hold every content-destroying call
site must consult, because a cleanup sweep is itself one of those call sites — and now that the hold exists,
the sweep landed **on** that check rather than beside it.

**The collector was given the prefix, not a sweep of its own.** `deleteDraft` is still row-only: ADR 32 makes
reconciliation asymmetric on purpose, so an inline delete that failed after the row was gone would create
exactly the unreachable object being fixed. The reconciler scans `${orgId}/drafts/` under its own referent
rule — a `drafts` row keyed by `body_key`, not a receipt, past the same grace window, because `saveDraft`
writes R2 before the row and collecting inside that gap would delete somebody's writing mid-save — and both
prefixes drain **one** delete loop, so `EVIDENCE.delete` is still the only call in the product that destroys
content bytes and the closed world stays at one entry. Collection is refused org-wide while any hold stands,
for the orphan reason rather than by analogy: a stranded body has no row, so there is no mailbox to test a
hold against. The predicate is **one function** that `doctor` reads rather than reimplements, checked by
counting listings at the binding, because two definitions of "which objects are stranded" can disagree
silently in the direction where the diagnostic reports a count the collector declines to act on. The residue
every existing Node already has is collected by the ordinary pass — no migration. Measured: the second prefix
costs the pass **2 subrequests, flat at 0 and at 5 stranded bodies**, and `doctor`'s per-run cost did not move
at all (13 → 13) because the scan it used to perform itself is now the scan it reads. Two claims that had gone
stale in these exact comments for the third time — "nothing collects the body", "nothing to run yet" — are
now sentences a test fails on. A **third** claim was found unenforced while verifying this one: the referent
query "deliberately has no LIMIT", because a partial set of referents names a live draft's body as stranded
and under collection deletes somebody's unfinished writing — and `LIMIT 1` on that line passed all 481 tests,
since every fixture had exactly one live draft. It is now collected against three, and what that bounds
(any limit below three, not the absence of every limit) is written beside the claim rather than implied.
What did **not** change is the finding's severity: residue means the collector
has not run, not that something is broken, and the condition that would justify `degraded` is residue that
survives a collection run, which nothing records yet and so is named as the missing input rather than guessed.

**The lockout report opened for one of the two lockouts.** `doctor` is served unauthenticated, reduced to
findings whose contents are already public here, when the Node cannot authenticate anyone — and the test for
"cannot authenticate anyone" asked for a finding named `credential_kek`, which nothing has ever emitted. The
credential checks emit `credential_key`. So the disjunct covering *the scenario the function was written
for* — a credential key that cannot wrap while the signing key is fine — was permanently false, and the
`fix` text sent a locked-out operator to a finding that would not be in the report. `signing_key` is real,
which is why the commonest lockout worked and every test passed: one of two branches being dead is invisible
to a test that exercises the other. The name is fixed, that lockout now has its own end-to-end test, and a
tripwire derives the emitted check names from `doctor.ts` and fails on any name the file *refers to* —
in a comparison or in a `fix` naming "the X finding" — that no check emits. A wrong identifier is worse
than a wrong comment, because prose does not look like it is being checked.

**A cap named in bytes counted something else.** `audit.max_detail_bytes` and `log.max_detail_bytes` are
2,048, and the check was `JSON.stringify(detail).length` — UTF-16 code units. Measured: a detail of 700 CJK
characters is 714 units and **2,114 bytes**, so it passed a 2,048-*byte* cap untouched, and the truncation
record then reported `bytes: 714` — a wrong number under a key that ends the question a blank would have
prompted. The cap is a **disclosure** bound, not a storage one: it exists because the audit table is read by
a wider set of people than the mail it describes. One that can be exceeded threefold by writing in Chinese
is not that bound. Both now measure UTF-8, the truncated head is cut between code points so no lone
surrogate is stored, and the record's own envelope is measured rather than allowed for with a magic
constant. The 2,048 itself was a round number inside a receipt marked `measured-tripwire`; it now carries a
derivation, and the frontmatter says which of its values were sized rather than measured.

**Both binding guards were allowlists, and neither knew about Workflows.** Two tests exist so that a new
binding cannot arrive unpriced or unprovisionable: one asks whether the cost meter classifies every binding
the Worker declares, the other whether a customer's install can provision every binding block. Each
hand-maintained its own idea of what a binding block *is* — one iterated five block names it listed itself,
directly under a comment claiming it read them from the config; the other matched key suffixes plus six exact
names. Neither recognised `[[workflows]]`, which is the engine Layer 4 runs Butlers on and therefore the next
block this config will gain: a Workflow step touching an unmetered binding would have been priced as free,
with nothing firing. Both now share one **closed world** over the config's top-level keys — every key is a
declared binding block or a declared field that binds nothing, and anything else fails, naming the key and
what to do with it. That is the version that catches the binding nobody has thought of, which was the only
point of having the guards. An allowlist of the blocks somebody already thought of never could.

**A legal hold that a call site can forget to ask is not a hold.** Seven places in this Worker can destroy
something, and until now nothing anywhere said which of them destroy *content* — so preservation was a
property of whoever remembered. A hold is now a **predicate**, not a list: a mailbox and two optional date
bounds, evaluated at the moment of the act, because a hold placed on Tuesday has to cover Wednesday's mail and
a frozen set of ids stops covering things the day nobody maintains it. Placing is one administrator, alone,
immediate and audited — it only ever preserves, and ceremony in front of it is how evidence is lost in the hour
after somebody realises they need it. A refused deletion is audited too, as `hold.blocked`, because an attempt
to destroy held mail is evidence about the attempt. **The tripwire is worth more than the mechanism**: a test
derives every `DELETE FROM` and `EVIDENCE.delete` in `src/` and `migrations/` from the source, fails on one
nobody classified, and for the three that carry content **asserts the guard is called in the same function** as
the statement that destroys. Migrations are held to zero, because a migration is raw SQL inside `batch()` and
no code can stand between its statements and a hold. Its blind spots — dynamic SQL, `wrangler d1 execute`, the
dashboard — are declared in the test, since a tripwire that hides its boundary is the thing it replaces. Two
consequences stated rather than discovered: orphan collection stops for the **whole organization** while any
hold stands, because an orphan is unattributable *by definition* and nothing can prove one is not responsive;
and **there is no way to lift a hold**, because lifting takes two approvers and that machinery does not exist
yet — so `doctor` reports the missing path as a finding instead of leaving it silent, and a check fails on any
code that would quietly narrow a hold's window.

**It sends and receives.** Two Mailda mailboxes on the same domain exchanged mail through Cloudflare —
sealed into an immutable manifest, dispatched, received, parsed and threaded. Both send APIs and both
MIME forms were verified end to end.

**It does now receive mail.** One Worker, deployed to a real Cloudflare account, accepted a
genuine Gmail message through Cloudflare Email Routing, stored it encrypted and framed, and served
it back **byte-identical** to a signed-in human — verified by SHA-256 against the original, with the
sender's real `Received:` chain and DKIM signature intact. That is the whole of what works: one
message, one mailbox, one authorized reader.

Sign-in is real too — email and password, ES256 access tokens, rotating refresh tokens, key
rotation that does not sign anyone out. Everything else in the contract above is still unbuilt.

---

## What's distinctive about how it's built

**Every number has a receipt.** No limit, timeout, threshold or budget enters the codebase
without a measurement behind it. The constants are *generated from* the receipt files, so
you cannot write the number — only the measurement. See
[`docs/receipts/`](./docs/receipts/) and the rule in [`AGENTS.md`](./AGENTS.md).

That has already earned its place. Measuring the authorization path found a **full table
scan on every request** — 1,864 rows read where 7 were needed, growing linearly with
organisation size. It would have shipped invisibly.
([receipt](./docs/receipts/authz-check-rows-read.md))

**Structure beats discipline — including when the first attempt was a check.** An automated review
found header injection in the outbound path. The first fix was a validator called at each site, which
closed the hole in the shape this project had already rejected for `innerHTML`: correct only while every
future author remembers. It is now a builder where the unsafe state is unrepresentable — no array to
push a raw header line onto, so a field added next year is validated whether anyone thought about it or
not. A test asserts that property directly rather than asserting the current fields are safe.

**Structure beats discipline, again.** Approval binds a manifest *id*, and editing a sealed manifest
produces a new id — so "any material edit invalidates approval" stopped being a rule someone has to
remember and became a property of the identifiers. Same move as the partial unique index that makes
two current signing keys unrepresentable.

**Honest semantics are enforced, not aspired to.** The outbox will never say *Sent*, and there is a
measurement behind that rather than a principle: Cloudflare **accepted** a message addressed to
`nobody@example.invalid` — a TLD that provably cannot exist — and returned a message id for it. The most
optimistic thing a transport can tell a Node is compatible with the mail being undeliverable by
construction, so `handed_over` is the literal ceiling of what is knowable. So the strongest claim Mailda makes is `handed_over`, and there are seven outbound
states because collapsing any two of them would be the first lie a mail client tells. A forwarded copy
is called a copy, never a sync. A provider action Mailda observed after the fact is never described as approved.
When a send outcome is genuinely unknown, the product says `outcome unknown` rather than
guessing. Names must mean the same thing in the code, the CLI, the API and the UI.

**Structural over disciplined.** Where a rule could be a code-review convention, it's made
into something a build can check instead: no Cloudflare resource in two Worker configs, no
queue without a dead-letter queue, no retryable table without a unique constraint, no bare
`Date.now()` outside one module. "At most one current signing key" is a partial unique index, not a
guard clause — two current keys are unrepresentable rather than merely avoided.

**A receipt that outlives its schema is a number that still reads as verified.** Adding two threading
indexes tripped the guard on the message-size receipt, so it was re-measured against real remote D1
before the guard's constant was touched: **1,253 → 1,505 bytes per message**, and a 10 GB shard now
holds 7.1 million messages rather than 8.5. **Two indexes cost 1.4 million messages of headroom** — a
figure nobody would have noticed without the guard.
([receipt](./docs/receipts/message-metadata-bytes.md))

**Keys belong to the Node.** Both root keys are generated into a Durable Object on first use — no
binding to configure and no way to install a Node that is accidentally unprotected. Secrets Store lost
that argument on measurement: removing its config block doesn't relink the binding the way D1 does, it
**drops it silently**. Re-sealing then makes rotation real, verified against the plaintext hash each
receipt already stored for exactly this purpose.
([receipt](./docs/receipts/evidence-lifecycle.md))

**The audit trail can be checked, not just trusted.** Every entry carries the hash of the one before
it, so a deletion, a reordering or an edit breaks verification at a nameable entry — and an
administrator reads it in the product rather than in a cloud dashboard. Demonstrated on the deployed
Node: editing one row directly in the database produced *"entry was altered after it was written: its
contents do not produce its hash"*, naming the row. This cannot stop someone with database access from
rewriting the whole chain — you own the database, which is the point — but it turns a log you have to
trust into one you can check. ([receipt](./docs/receipts/audit-and-log-retention.md))

**An audit entry commits in the same transaction as the act it records.** Writing the change and then
appending the entry leaves a window where the change survives and nothing records it — and that hole is
invisible to verification, which proves only that what *was* written is unaltered. So the entry travels
inside the caller's batch: either both land or neither does. The corollary is deliberate — if this Node
cannot record an act, it does not perform the act.

**The accessibility check had to be built to catch what the standard tool cannot.** axe-core returns
zero contrast violations on this interface — and proves AA for exactly one of its fourteen text nodes.
The body's gradient means axe cannot resolve a background, so it files almost everything as *unproven*
rather than failing it, and a harness reading only violations reports green forever. Contrast is
therefore computed from the tokens against both ends of the gradient, which bounds every point between
them. That found a real failure: small dim text in light mode was at 4.15:1 against AA's 4.5. Fixed and
deployed, with the dark theme's 0.01 margin now visible rather than latent.
([receipt](./docs/receipts/contrast-tokens.md))

**A measured number was deleted rather than corrected.** A receipt recorded that the Deploy to
Cloudflare button does not provision the R2 bucket Mailda stores mail in — the last thing standing
between this and an installable product. Re-examined, that observation came from a probe whose deploy
died before reaching R2, so it never measured what it claimed to. Direct measurement shows `wrangler
deploy` creates the bucket in every shape tested, with an explicit name or without one, interactive or
not. The constant is gone rather than flipped, because a number that reads as a platform limit when it
was a broken probe is worse than no number. ([receipt](./docs/receipts/r2-auto-provisioning.md))

**What a customer's install can actually provision is checked too.** A real Deploy to Cloudflare
click was measured against a paid account: it provisions D1 but **not** R2, pins one Worker per build
project, and writes resource ids into the clone. Those findings constrained nothing for two days — so
the Worker's configuration is now held to them, and a binding the button cannot satisfy fails the suite
until somebody says how a customer gets it. `doctor` names a missing evidence bucket directly, instead
of the generic failure that used to send the reader to migrations.

**And CI is checked by CI.** A cancelled run reads as neither pass nor fail, so a commit whose run was
superseded looked verified when nothing had checked it — that happened here, to a commit on `main`. Two
guards now: a test asserts the workflow's own concurrency policy cannot cancel a push to `main`, and a
step fails the build when any earlier push lost its verdict to a manual cancel or an outage.

**The checks run without being remembered.** Every check in this repository worked from a terminal
long before anything invoked one — which reads exactly like a check that passed. CI now runs them on
every push and pull request: that the committed constants still match their receipts, that the ctx seam
holds, types, tests, and that the Worker still bundles against its binding configuration.

**Audit coverage is enforced by the schema, not by memory.** The trail shipped with eight call sites
placed by hand, which is correct today and has nothing to notice when it stops being correct — an
action that records nothing looks exactly like a quiet week, and a hash chain cannot help, because it
proves what *was* written is unaltered and says nothing about what was never written. So every table
is classified: either changes to it are auditable and the actions are named, or it is exempt for a
stated reason. A migration that adds a table fails the suite until somebody decides which
(`test/audit-coverage.test.ts`), at the moment they still have the context to decide well.

**Nothing checks itself by default.** `mailda doctor` verifies the runtime claims every other
decision made, and on its first run against the deployed Node it found that the mail it holds is
encrypted under a key published in this repository. Two checks deliberately *use* a credential
rather than test for its presence — a Secrets Store secret is `pending` for a while after creation,
so the binding exists and reading it throws. Every failure carries a fix, and there is a test per
failure mode, because a check that cannot be shown to fail reads as verified.
([receipt](./docs/receipts/doctor-check-cost.md))

**A green test suite is not evidence about the platform.** Building sign-in, PBKDF2 was set to
OWASP's recommended 600,000 iterations. Every test passed. The deployed Worker returned HTTP 500 on
every sign-in, because **Cloudflare rejects any single PBKDF2 call above 100,000 iterations and
local `workerd` does not enforce that limit**. The work is now chained across six rounds, and the
receipt says in as many words: measure this against a deployed Node, never against the local
runtime. ([receipt](./docs/receipts/password-hash-cost.md))

---

## What it will need from you

| | |
|---|---|
| A Cloudflare account | Free to create |
| A domain you control | Or a delegated subdomain — `mail.example.com` is the default. **Pointing MX at Cloudflare is required**; nothing avoids it |
| **Workers Paid — mandatory** | **$5/month minimum**, 3,000 emails included, then $0.35/1,000 |
| Inbound mail | Unlimited, included |

A 20-person organisation sending 10,000 emails a month costs roughly **$7.45/month**, plus
storage. ([receipt](./docs/receipts/cloudflare-plan-costs.md))

**There is no free tier.** Not a pricing choice — Cloudflare's free plan forces 24-hour,
non-configurable queue retention, so a message stuck in a queue for a day is silently
deleted. A mail system cannot run there. `mailda deploy` detects the plan and refuses,
saying why, rather than failing later. ([ADR 25](./Mailda-Full-Engineering-Blueprint.md))

### Deliberate limitations

- **No Gmail or Microsoft 365 connector.** Adopting Mailda means moving mail to it. There's
  no import path for existing history. ([why](./Mailda-Full-Engineering-Blueprint.md))
- **No IMAP, JMAP or SMTP mailbox service.** The web app is the only way to read mail — no
  Outlook, Apple Mail or Thunderbird.
- **5 MiB outbound** to arbitrary recipients, and 50 recipients per message. A Node can
  receive a 25 MiB attachment and be unable to reply with it.
- **Cloudflare is a hard dependency.** You own your data and your bill; the Node is not
  portable to another platform.
- **Not for bulk or marketing mail.** Transactional and operational only.
- **Remote images are blocked until you ask for them.** A tracking pixel tells a third party when
  your colleague opened a message. Mailda will not proxy them either — that would make your Node
  fetch URLs a stranger chose, from inside your own Cloudflare account.
- **Your daily sending limit is invisible, so Mailda measures it.** Cloudflare starts new accounts on
  a conservative daily quota that scales with reputation and publishes no number for it. Mailda counts
  sends per rolling day and records the count at which you were first throttled — a limit you can hit
  is a limit you must see. ([receipt](./docs/receipts/cloudflare-email-sending.md))
- **Delivery outcomes take one command after the install, and are blind until it runs.** The queue that
  carries `accepted` and `bounced` is provisioned per Node with a name Cloudflare derives — documented by
  Cloudflare and unmeasured by us, so nothing here writes that name down — because a queue name is
  account-scoped and a committed one made two Nodes in one account share a queue. A consumer cannot
  name a derived queue, so `pnpm run queue:attach-consumer` attaches it out of band — and a button-only
  install that never runs it observes nothing, honestly and permanently, until somebody does.
  ([receipt](./docs/receipts/queue-provisioning.md))
- **Paying for Workers is not enough to send.** Arbitrary recipients require a *sending domain
  onboarded* with SPF and DKIM. Until then a Node can only send to addresses already verified in your
  own account — so it can receive a customer's message and be unable to answer it. `mailda deploy`
  checks both and says which one is missing.
- **Passwords are the weakest part of the design, deliberately.** Workers has no native Argon2id,
  so verifiers are PBKDF2 at 600,000 effective iterations — an accepted baseline, not a strong one.
  Passkeys are specified and not yet built. The reasoning, including what this does and does not
  protect against, is written down rather than implied.
  ([receipt](./docs/receipts/password-hash-cost.md))
- **A signed token cannot be recalled.** Removing someone's access takes effect on the next request
  for everything authorization-related, because authority is never carried in the token — but a
  revoked account keeps a working *session* for up to ten minutes. That window is the access
  token's lifetime, and it is a measured number rather than a comfortable one.

---

## Layout

```
Mailda-Full-Engineering-Blueprint.md   the product contract
AGENTS.md                              how we work; read before contributing
docs/receipts/                         every number, with its measurement
docs/onboarding-journey.md             where the first-run experience breaks
docs/authentication.md                 sign-in, tokens, key rotation, client lifecycle
docs/evidence-lifecycle.md             keys, re-sealing, reconciliation, the pipeline
docs/agents/                           issue tracker and domain-doc conventions
packages/receipts                      generates constants from receipts
packages/budgets                       GENERATED — do not edit
packages/runtime                       the clock, id and randomness seam
packages/contract                      command schemas
packages/evidence                      framed encryption for stored mail
apps/node/worker                       the single Worker (ADR 18): inbound mail, evidence store,
                                       authorization, auth, outbox sweeper, interface
apps/node/worker/src/auth              passwords, ES256 tokens, key rotation, sessions
apps/node/worker/src/client            browser scripts, served as real .js files
apps/node/worker/scripts               operator tools: password reset, queue consumer attach, axe
apps/node/worker/src/doctor.ts         checks the runtime claims every decision made
probes/                                throwaway platform experiments
```

## Contributing

Read [`AGENTS.md`](./AGENTS.md) first — it's short, and it's binding on humans and agents
equally. Work is tracked as a [wayfinder map](https://github.com/Straits-AI/mailda/issues/1):
one issue holds the route, each child issue holds one decision and the argument for it.

Open questions live there. Closed ones record what was rejected and why, which is usually
the more useful half.

## Licence

Not yet chosen. Blueprint §30 covers the intent; the decision is open.
