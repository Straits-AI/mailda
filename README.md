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
| **Product contract** | [`Mailda-Full-Engineering-Blueprint.md`](./Mailda-Full-Engineering-Blueprint.md) — 2,967 lines specifying the target state, with 41 locked architectural decisions |
| **Working agreement** | [`AGENTS.md`](./AGENTS.md) — how decisions get made and what counts as done |
| **Decisions taken** | 31 recorded with full reasoning and rejected alternatives, on the [issue tracker](https://github.com/Straits-AI/mailda/issues/1) |
| **Measurements** | 38 receipts in [`docs/receipts/`](./docs/receipts/) generating 206 verified constants |
| **Code** | A measurement harness and one Worker. 1,132 tests across two runtimes, checked on every push. Not a product. |

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

**The same defect was sitting in a second place, and the class is now closed rather than the instance.** The
reconciler listed three R2 prefixes and this Worker wrote four: `${orgId}/sent/` holds the typed body, the
normalized body and the exact bytes handed to the transport, and nothing listed it. Identical to the draft-body
finding above and invisible for the identical reason — the cost of an unlisted prefix is invisible precisely
because nothing reports it — and it had been in that state since before that finding landed. It is scanned now,
under its **own** referent rule rather than a copied one: a `send_manifests` row keyed by the id in the key's
second segment, so three objects resolve to one row. Nothing deletes a manifest row, so an object with no row
is only reachable through a lost transaction, which makes this the orphan rule (grace window, org-wide hold
suppression) rather than the residue rule; and a **cancelled** send keeps its row, so its staged objects are
referenced and are not residue at all — verified, because that assumption failing would destroy the
composition evidence §12 calls immutable. The hold decision was re-argued rather than inherited, because a
`sent/` key *looks* more attributable than a raw orphan: it is not, since the mailbox lives in the row whose
absence defines the state, so the org-wide rule stands unwidened. The report's sentence changed with it — it
used to hedge about objects under prefixes it had not listed, and a sentence describing a state the code has
left is the defect this whole thread is about. **What closes the class is a test, not the repair**: a closed
world derives every `${orgId}/<segment>/` any writing file in `src/` spells and fails if the reconciler's
scanned set does not cover it, in both directions, so a fifth prefix cannot arrive unlisted and a listed prefix
nothing writes cannot report itself clean for ever. The arithmetic needed no re-derivation, which was the
point of the previous round pricing `reconcile.list_limit` at 150 for a fourth prefix rather than the 198 the
inequality allowed: the worst case moved 758 → **910** against the Free ceiling of 1,000. The assertion that
used to claim the *next* prefix would also fit was true at three prefixes and false at four, so it now asserts
the opposite — a fifth costs 1,062 and has to re-derive the limit deliberately.

**And the growth nobody had measured is a finding of its own.** Three objects per handed-over send, two per
send that never hands over, linear in sends rather than deliveries, with the body carried three times — so
`sent/` grows at roughly three copies of every message plus headers plus 144 bytes of framing, measured under
miniflare rather than read off the source. Every one of those objects is **referenced** for the life of the
Node, because nothing deletes a manifest row, so the reconciler will never collect them and is not supposed
to: two of the three are immutable composition evidence. A Node that composes heavily and sends rarely
accumulates for ever, `doctor` has no figure that names it, and the cost meter prices operations rather than
stored bytes. Filed as **#76** rather than recorded as an aside, because a growth term with no observable is
the same shape of defect as a prefix with no listing.

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
dashboard — are declared in the test, since a tripwire that hides its boundary is the thing it replaces. One
consequence stated rather than discovered: orphan collection stops for the **whole organization** while any
hold stands, because an orphan is unattributable *by definition* and nothing can prove one is not responsive.

**A hold nobody can lift is an operational trap; a hold one person can lift quietly is not a hold.** So the
lift is the exact mirror of placing: an administrator asks, with a **mandatory reason**, and two *other* people
holding `approval.decide` on the held mailbox have to agree. The requester is excluded from deciding by the same
separation-of-duty rule that stops an author approving their own send — reused, not rewritten, because all three
defects the approval machinery shipped with were in that race logic and a second copy is a second place for
them. Reusing it cost one schema decision, taken on the day the second caller appeared rather than the day it
hurt: `approvals` pointed at a manifest and nothing else, so it now points at a **subject** — a kind and an id,
with a unique index over the pair — and a lift's subject is the request itself. That is why a denied lift does
not make a hold permanent: asking again mints a new request, exactly as re-sealing mints a new manifest. The
tripwire that guarded the absent lift was **inverted rather than deleted**, which is the part worth copying:
there is now exactly *one* `UPDATE holds` allowed in the product, a test proves it is the one that sets
`lifted_at` and that **that statement's own SQL** carries both halves of the gate — read from its string
literal with its `${}` holes resolved, because the first version of this check read a window of the enclosing
function *including its comments* and passed with either half deleted — and narrowing a hold's window
still fails — because that was always the silent lift, and building the loud one does not make it safe.
`doctor` dropped the finding that said lifting was impossible, since that sentence became false, and gained the
one that matters instead: a hold over a mailbox where fewer than two people hold `approval.decide` **cannot be
lifted by anybody**, and it says so before an administrator finds out by being refused.

**"Mailbox administration alone does not imply content access" was true about the relation and false about
the administrator.** `org.admin` can grant any grantable relation to any subject, and nothing excluded itself
as a subject — so an administrator could give themselves `mailbox.content.read` and read anybody's mail in one
audited call. Refusing that was the tempting fix and it sets a trap: in a two-person organization the only
other approver is the person being examined, so the ceremony is either theatre or the read is impossible, and
"impossible" for an administrator genuinely responsible for a mailbox is the wall that gets solved by editing
the database directly — which leaves no record at all. So the door stays open and is made **loud**: an
`access.granted` entry whose actor and subject are the same principal is now a `doctor` finding, costing one
seek into the entries of the one action it is about — which is what it costs *because* the purpose-built index
written for it was deleted: SQLite never chose it, and forced with `INDEXED BY` it was strictly worse, because
its test for whether a query implies a partial index's predicate does not credit a column-to-column comparison.
An index nothing chooses, under a comment saying it is load-bearing, is the defect this repository keeps paying
for, and the only reason it was caught is that the plan was printed rather than reasoned about. The same print
caught the *other* new index having its range column ahead of an equality column, truncating its usable prefix
at four of five — #11's lesson arriving one table over. It is
a `report` and not a `degraded`, because in that two-person organization the self-grant is the *correct* act and
a permanent WARN on a legitimate act is how a check gets muted. Its own text says the thing that had to be said
plainly: **this does not prevent an administrator reading mail. It makes the front door and the back door
distinguishable in the record.**

**The front door is `supervised.read`, and it is a relation no tuple carries.** A time-boxed grant over one
mailbox, at one of two scopes, citing a matter or nothing, live only once **two people who are not the reader**
have approved it — and the reader *is* the requester, structurally, because a request on somebody else's behalf
would leave the reader outside the separation-of-duty exclusion and free to approve their own access. It is not
a tuple because `relationship_tuples` has no expiry column and giving it one would put a time comparison into
every authorization check in the product for the benefit of one relation. That is also the more honest shape:
*"who can read this mailbox"* now has two answers with different structures, and collapsing them would make the
answer uniform and wrong. The relation is nonetheless declared beside the others, with **how it is conferred**
as a field — so `Grantable` is derived from the registry rather than listed twice, the ordinary grant route
refuses it at compile time as well as at runtime, and the refusal a person reads **names the door that works**.
An administrator told only "not grantable" is the person who grants themselves `content.read` instead.

**Purpose had to become an object, and the notification requirement is what decided it.** §7 requires telling
the employee after the matter **closes**, and free text cannot close — one shape simply cannot satisfy the
contract, so `matters` carries a type, a description, who opened it and `closed_at`. It pays for itself twice
more: several grants belong to one investigation, and *"widening scope requires a new approval"* becomes a
second grant citing the same matter rather than an edit to a live one, because an editable grant is an audit
trail that can be rewritten in place. There is no `UPDATE` of a grant's scope or deadline anywhere, and a test
reads the one `UPDATE supervised_grants` that exists — from its string literal, with comments stripped, because
this repository has already shipped a source scan that its own prose satisfied — to prove it sets `granted_at`,
requires the approval to have become approved, refuses a grant already live, and **does not touch
`expires_at`**. Recomputing the deadline at decision time would silently extend every grant by however long
the decision took, which is the widening that is supposed to need its own approval.

**A matter's description is not org-wide reading, and that boundary is what §7's deferred notice rests on.**
The listing was open to every member at first, justified by the fact that the two approvers read the text
before deciding — an argument about approvers, implemented as an argument about everybody. A description says
*"suspected exfiltration by Dana"*, and §7 makes the notice to Dana due **after the matter closes**; an
org-wide listing delivers it on the day the matter opens, to the one person it must not reach first. So
`GET /api/matters` shows an `org.admin` everything and anybody else the matters they opened, and the
approvers' real need is served where it belongs: the pending-approval row carries the cited matter's type and
description to the two people being asked, on the join that was already fetching the grant. An approver reads
the matter they are deciding on, not every matter in the building.

**Expiry needed no mechanism, and the enumeration that proves it came back empty.** Nothing caches
authorization, so the request after the deadline checks and finds the grant over; §7's list of things an expiry
must terminate — cursors, event streams, presigned attachment URLs, cached previews — has no members on this
Node, because nothing presigns, nothing streams and the raw-evidence read is authorized per request. So the
test proves the **stop** through the real `.eml` read rather than asserting the absence of a cache: sixty
seconds authorizes at +30 s and is refused at +60.001 s with nothing having run in between. What was measured
instead of assumed is the cost, because the authorization receipt's `stale_when` names exactly this — a
condition beginning to read additional rows on the request path. The grant lookup is a `UNION ALL` arm of the
statement the check was already issuing, so it is **two queries either way**, priced through `mayRead` itself
rather than through a copy of its query; and the index is partial on `granted_at IS NOT NULL`, so the arm costs
**one row** on a check that misses the tuple arm and **nothing** on one that hits. The receipt's values did not
move; the dated correction says so, which is the point of having the clause.

**A supervised read is the third approval subject, not a second approval mechanism.** Adding it was a compile
error in three places until handled, which is the design working: the per-kind wording, the per-kind deadline
and the per-kind completion effect are all records keyed on the union. The hold lift had proved the
generalisation; this ticket spent it, and the one refactor it cost is the shape worth knowing — the lift's
hand-written "strong predicate" branch, where a completing decision also requires that the effect has not
already happened and a lost race records **nothing** rather than an entry claiming an act that did not occur,
became per-kind *data* while the race logic stayed written once. All three defects the approval machinery
shipped with were in that logic.

**A supervised read that is not recorded is now unrepresentable, and the way that is done is a parameter.**
§7 wants every query, result opened and attachment read in the trail, and the tempting shape — an `audit`
call beside each read — is correct on the day it is written and silent the day somebody adds a fourth read
path. So the record lives **where the authorization decision is made**: `mayRead` takes the act it is about
to authorize, cannot be called without one, and appends the entry inside itself before it returns `true`.
The check returns *which* authority answered rather than a boolean, because an ordinary relation owes
nothing and a grant owes an entry, and the guess that hides is the one that decides an unrecorded supervised
read was ordinary. A listing cannot use that shape — its rows do not exist at the moment of the check, so an
entry written there could not name the ids — so it records afterwards, and what keeps *that* structural is
that a grant id reaches a listing from exactly one builder, whose callers a world test requires to emit the
entry before they return. All of it fails **closed**: the append throws where `audit` swallows, because a
record of something that already happened must not fail its request and a disclosure that has not happened
yet must not proceed without one.

**A query entry names the ids it returned, and the interesting decision was refusing to pick a page size.**
"A query matched forty things" understates what a person saw by forty subject lines, so the ids go in — and
the cap that bounds them is about 57 of them, close enough to a real page to matter. Truncating would have
been the silent version of the same understatement: the detail cap replaces an over-long value with a
*prefix*, so an oversized list would have recorded the first fifty-seven ids and looked complete. The list
is **split** across continuation entries instead, sized by asking the cap's own measurement rather than by
restating its arithmetic — so a sibling field added tomorrow lowers the fill and breaks nothing, and the
number is printed rather than asserted because the design deliberately does not rest on it.

**The employee's notice is a row, and `doctor` counting rows is the whole reason.** §7 wants a durable job
the investigator cannot disable. A Workflow instance is not a durable record — retention is 30 days and a
matter can stay open for months — and a sleeping instance and a culled one look identical from outside,
which is exactly the question a report has to answer. So the obligation is a row written in the **same
transaction** as the grant taking effect, delivered by the one-minute cron that already runs, and counted
when overdue. Suppressing one therefore means deleting an audited row: the count of grants in the
hash-linked trail is compared against the rows in the table, so removing the row shows up in `doctor` and
removing the entry instead breaks verification at a nameable point. The product has no delete, no dismiss
and no mark-read, and a world test forbids `DELETE FROM notifications` anywhere in the source — because a
product that can clear a notice makes a missing one ordinary and the finding meaningless.

**Closing a matter could tell somebody their mail was read while it still was, and the fix was to hold the
notice rather than to block the close.** §7 hangs the notice on the close; a closed matter deliberately does
**not** revoke a live grant. Refusing the close while a grant is live was the other available shape and it
inverts a control this design already made: closing is open to any administrator *because the investigator
is the one party with a reason to delay it*, and a block any live grant could hold open hands that delay
back to the person who asked for the grant and chose its duration. With no revocation path, the block could
not even be cleared. So the notice waits instead — due at `max(close, the grant's own expiry)` — and "after
the matter closes" comes to mean after the reading actually stopped. The residual is stated rather than
hidden: a matter nobody ever closes defers its notices for ever, which is §7's own shape, and the control
is that closing is not the investigator's to withhold.

**Holding a notice means something has to un-hold it, and the first version of that had a hole the
investigator could walk through.** The date was written by the close, in the close's own transaction — which
can only reach notices that already exist, and a grant is asked for at one instant and takes effect two
approvals later. Close the matter in between and the notice was left undated with nothing that would ever
date it: no second close is permitted, the cron delivers only what is due, and the overdue count is
*has a due date* by construction, so the row sat there for ever looking present and correct. The reader
read, every act was recorded, and nobody was ever told — **without deleting an audited row**, arranged by
whoever opened the matter, which is usually the investigator. Both orderings now write the same instant
from the same expression, and `doctor` grew a third finding that counts notices which can never fall due —
because the two checks it already had are both about a row being *removed*, and neither can see one that is
present and inert.

**What the notice says is a decision, and "your mailbox was accessed" is not it.** It names the reader, the
scope, the window, the matter's type — and **what was actually done**: queries run, messages those queries
listed, contents opened, raw messages read, counted off the trail so they cannot drift from the entries they
describe. That is the difference between a grant nobody used and one under which four hundred messages were
opened, and without it the notice is the compliance theatre §7 would otherwise be satisfied by. What it
withholds is the matter's **description** — free text naming an investigation and often a third party, which
this Node cannot vouch for and must not publish as a system statement — and the ids themselves, which live
in the trail where a record of what was read belongs. Delivery is in-product because outbound mail is not a
dependable carrier for a legal obligation on a platform whose transport refuses unverified destinations, and
the notice is addressed to the **mailbox**: its audience resolves from standing relations, and a supervised
grant is never one, so the person who read the mail structurally cannot see the notice about having read
it.

**A cron expression in a doc comment cost a build, so the comment-hazard tripwire grew a third language.** The
guard has now been narrower than the hazard twice: it started as backticks in CSS, learned about SQL comments
after three repeats, and did not know that a `*` and a `/` in prose end a **TypeScript** block comment — which
is what a one-minute cron expression is made of. The prose after it parsed as code. The new check is the exact
invariant the CSS one enforces, one language up: scanning left to right, every comment terminator must close a
comment an opener opened, so a doc block that ends early leaves the terminator the author *meant* standing in
code. It walks strings, template literals, line comments and regular expressions to get there, declares the
regex heuristic as the one place it can produce a false positive, and is proved by putting the cron expression
back and watching it name the line.

**A policy that cannot be expressed is a policy that never fires, and so is one that can.** The blueprint
lists thirteen policy dimensions and six outcomes. This Node ships **five conditions and four outcomes**, and
the arithmetic in that sentence is the whole of the decision: the five — mailbox, actor, external recipient,
reply, org daily volume — are the ones answerable from a column that exists or one derivation over storage that
exists, and every other dimension is **named absent with its reason** rather than given a column nothing fills.
A condition backed by no data is worse than a missing feature, because it reads as governance. The conditions
are five typed columns rather than a JSON bag for the same reason pointed the other way: a bag would have
accepted `dataClass`, stored it, published it, and fired never. External recipients are exact rather than
heuristic, and exact for a **platform** reason rather than a schema one — Email Routing only accepts addresses
on domains in the customer's own Cloudflare account, so every domain this Node has an address on is one the
customer controls, and the internal set derives from those with no domains table and no cache. Which is a
correctness argument resting on somebody else's product, so it is the first clause of a receipt's `stale_when`
rather than a comment.

**Four outcomes, totally ordered, so conflict resolution is one comparison and sixteen tests.**
`allow < hold < require_approval < deny`, and a send's outcome is `max` over every rule that matched. There is
no priority field, deliberately: a priority lets a narrow `allow` beat a broad `deny`, which is exactly how a
policy system fails open, and it makes *"why was this allowed"* unanswerable from one row. The order between
the two gates is the part that is not intuitive and is settled by **who may clear them** — anybody who may send
as the mailbox releases a hold, only an approver approves — so a hold is the *less* restrictive gate. All
sixteen ordered pairs are tested, three ways each: against the declared order, symmetrically, and through the
real evaluator with two rules actually published, because a total order being right where it is defined proves
nothing about the code that uses it. A precedence table would have been sixteen cells with a wrong one nobody
notices; this is four numbers.

**A denial goes to `withheld`, not to `awaiting`, and that overrules the ticket that specified it.** The
resolution said "held if `allow`, `awaiting` otherwise" in one sentence and named only the two gates as
`awaiting` in another. The loose sentence is the one to distrust: a denied send parked in `awaiting` is a send
**nobody can ever clear** — a hold gets released, an approval gets decided, a denial has no counterpart — so it
would accumulate forever in a state that renders as pending. `withheld` already means precisely the right
thing. The state machine now has two halves that are symmetric rather than accidental: gates are `awaiting`
plus a reason, refusals are `withheld` plus a reason, and the reason is a machine token whose words live in the
one client module a test can evaluate as the exact bytes a browser is served. `awaiting` was also given a
drain, because the argument above applies to gates too until the approval act exists: an author can stop their
own gated send, and until they can, "waiting for somebody to clear this" and "unstoppable" would have rendered
identically.

**Approvals are ordered stages with a count, which is one mechanism where the contract asked for three.** The
blueprint wants sequential, parallel and dual review. They are not three features: parallel is one stage of
count 2, sequential is two stages of count 1, and dual control is whichever of those an organization means. The
order is on the **stages**, not on the people — which is what makes an order expressible at all, because a set
defined by a relation has no natural sequence and naming people in a policy would widen authority. Each stage's
membership stays derived from the `approval.decide` relation on the mailbox, minus the author, minus everybody
who has already decided.

**Distinctness is measured on the person, and that is the subtle one.** A principal authorizes as themselves
*plus every team they belong to*, so a relation can be held through a team — which means the holder set is a set
of tuples while a decider is a human being. One person in two teams that both hold `approval.decide` would
satisfy a count of 2 if the count were taken at the tuple layer: dual control defeated by something that looks
exactly like working code. It is measured on `user_id`, and twice — the eligible-set query resolves teams to
people and de-duplicates, and a UNIQUE index on `(approval, decider)` is what holds when two decisions race. The
test for it constructs that person on purpose. Break the resolution and the suite reports
`expected [ 'tm_appr_a', 'tm_appr_b', …(1) ] to deeply equal [ 'usr_appr_dual' ]` — team ids where people
should be, which is the bug in one line.

**Refused at publication, and re-checked at evaluation, because one check would have been silent.** A policy
requiring two approvers on a mailbox where one person holds the relation is refused when somebody tries to
publish it, naming the mailbox, the stage and how many short. It is then checked *again* at the seal — and that
second check is the point rather than belt-and-braces: publication cannot know who will write the message, and
an author is never eligible to approve their own send, so a policy that passes publication can still be
unsatisfiable for one particular person. More importantly, revoking `approval.decide` afterwards would otherwise
make a live policy unsatisfiable in **silence**, with gated sends collecting in a state that reads as waiting for
somebody. Unsatisfiable now means `withheld` with a reason naming the shortfall, which is a refusal a person can
act on. What is *not* covered is named in `docs/approvals.md` rather than implied: a send already waiting when
the last approver loses the relation is not re-checked, because nothing sweeps that state yet.

**Withdrawing is allowed and denying is final, and the asymmetry is the design.** An approver who learns
something after approving can take their approval back while the request is incomplete. Without that, their only
remedy is persuading a colleague to deny — which records *somebody else's judgement* as the reason a message was
stopped, in a trail whose entire value is that it does not do that. A denial needs no counterpart, because
composing again mints a new manifest and a fresh approval. Withdrawal is terminal for the withdrawer, so the
eligible set only ever shrinks and no amount of withdraw-then-approve lets one person fill two slots.

**Cancelling the send settles the request it was waiting on, in the same transaction.** Cancelling is the drain
a waiting send has, and the author may use it while other people are being asked — so the request has to go with
it. Not for tidiness: the queue an approver reads is built from open requests, and one whose send no longer
exists is work nobody can clear; and every refusal on the decision path keys on the request's state, so leaving
it open let an approval of a cancelled send close the request, move nothing, and still report the send as
released. A request already answered is left alone.

**The withdraw-versus-final-approval race is a conditional UPDATE, and its zero is read carefully.** Completion
is *"every stage satisfied and nothing withdrawn"*, evaluated inside the database at the instant of the write.
`changes = 0` there does **not** mean somebody withdrew — every non-final approval leaves it zero, legitimately,
which is why writing that down would have been a claim the code contradicts on its most ordinary path. The signal
is "this decision should have closed the last stage and did not", and *that* means a withdrawal, because a
competing finalisation is refused by the predicate every statement in a decision shares rather than recorded.

**One constraint was cut, with the reason recorded rather than a column added for it.** A stage was meant to be
able to say "a member of team T". `team_members` turns out to be read-only in the whole product — three SELECTs,
nothing writes it — and there is no `teams` table at all, so a team has no name and no existence of its own. A
team-scoped stage would be **expressible and unusable**: no team can be created through any surface, and
publication could not check that a named team exists, only that it currently has members. That is the same
failure as a condition backed by no data, and a nullable `team_id` that is always NULL is that failure wearing a
column. So the constraint is named absent, what would have to exist first is filed as an issue, and what it
actually costs is said plainly: the team *labels* on a chain, not the chain — ordered stages of count 1 still
give sequential review by two distinct people in a fixed order.

**The cost was owed as a receipt and came back one third of the estimate.** The resolution counted "at most
three queries" by reading the source, and said so in as many words — *"counted by reading, not measured, and
that is a hypothesis."* Measured with `src/cost-meter.ts` against real D1 in `workerd`: three is the ceiling
and **one** is the ordinary cost, because the two conditions that need a derived input — the domain set, the
daily counter — are fetched only when some published rule actually asks for them, and reading the rules first
is what makes that possible. Which is also why the five conditions are columns and the matching is not pushed
into SQL: a SQL predicate would have to bind both inputs before it could run, spending both on every send from
every Node whether or not any rule mentions them. Thirty published policies cost the same as three. The seal
that carries the decision went from 10 subrequests to 11, and to 17 at the worst realistic case against a
published bound of 20 — so the receipt that divides that bound got a dated correction saying the headroom
narrowed from 6 to 3 rather than a quietly raised number.

**An approval now buys verification, and the assurance is what pays for it.** The contract says a Node rechecks
approval validity, authority, approver eligibility, policy and every bound hash *immediately before* the effect
runs. An approved send gets all of it, one instruction before the transport is asked. An unapproved send gets the
authority re-read it always got and nothing else — and that asymmetry is the design, not an optimisation
somebody may tidy up later. Measured: the recheck is **8 subrequests** against a 16-subrequest dispatch, so
making it universal would add half again to every message this Node sends to buy a guarantee nobody requested.
The tripwire is deliberately on the *cheap* path: a bound of 20 against a measured 16, which a unified path
blows through immediately. Six ways it can fail closed, all of them `withheld` with a machine reason — because
this state machine already had one convention for that and a second would read as an accident — and every one of
the six is produced through the real dispatcher in the tests, not by calling a predicate. Changed evidence is
produced by writing **different bytes**, because editing the recorded hash would have tested the comparison and
left nobody able to tell the difference afterwards.

**One of the six is not the system working, and it is the only one that raises.** Authority withdrawn, policy
tightened, a deadline passed, an approver who lost the relation — those are decisions and deadlines, and the
person who needs to know is the one reading their own outbox. A body that no longer hashes to what its manifest
recorded is different in kind: the archive disagrees with its own record, which is corruption or tampering. So it
writes an operational log line and `mailda doctor` grew a finding for it, reading a partial index that is
**empty on a healthy Node** — the query plan is asserted, not assumed, because this repository has already
shipped one index that was written on reasoning and earned nothing when the plan was finally read.

**The prediction the whole design rested on was wrong in both directions, and it is written down.** The ticket
estimated the recheck at "~6 extra subrequests" and that making it universal would take a Butler's send step
"from 10 to about 16". The magnitude is 8, and 9 on a Node that can actually send: the estimate priced two body
hashes at six operations when they are four, and its own cost table disagreed with its own prose by roughly a
factor of two. The *location* was wrong too — the recheck runs at dispatch, which is a separate invocation with
its own budget, so it never touches a Butler step's pot at all and the receipt that owns that arithmetic now says
so. The decision the estimate was drawn for survives on the measurement instead, which is the only reason to
have measured it. Four times this month a number counted by reading has been wrong; this is the fourth.

**An approval expires, and the deadline is a constant rather than a policy field.** Four days: long enough that
an approver working across a weekend and a public holiday is not defeated, short enough that an approval is not a
standing permission. That is sized, not measured, and the receipt says so in those words rather than dressing a
preference as a measurement. A per-policy deadline was refused for now with the reason recorded — the policy
object has no expiry condition, and inventing one here would be a governance dimension backed by no interface,
which is the exact failure that list of five conditions exists to avoid — and the refinement is named for
whoever asks, including which way the fold has to run. Expiry is terminal: re-sealing is the invalidation
mechanism, so the author composes again. Returning a lapsed send to "waiting" would make the deadline mean
nothing and build a queue that never drains.

That is not the same call as the one above about case claims, where an expiry was refused outright as "a policy
guess". A claim's age is a fact anybody can read and act on, and nothing downstream depends on the claim still
being true. An approval is a *statement about exact bytes* that a later act relies on, and the contract binds an
expiry into the envelope precisely so that reliance has an edge. Nothing sweeps it either way: a lapsed request
still shows in an approver's queue with its deadline beside it, and deciding it is honest work whose send is then
withheld — one enforcement point rather than two, and the deadline visible before somebody answers rather than
after.

**Two kinds of circuit breaker, and the split decides every other question about them.** A **rate** breaker
is not a latch, it is a question re-asked on every send — *too much, too fast, and the mail is still wanted* —
so volume, bounce rate and complaint rate gate a send to *waiting* with a reason and it goes when the window
clears. An **abuse** breaker means *this must not be sent at all*, so a domain pause refuses outright and
stays until a person removes it. Collapsing them fails in a specific way in each direction: all-hold lets a
runaway build a backlog somebody eventually releases in bulk, which is how a loop finally sends its thousands;
all-refuse throws away perfectly good invoices on a busy afternoon, and the sender's only remedy is composing
them again into the same breaker. The classification is written out per breaker rather than inferred from a
threshold, because that is the one place this design could rot into whatever the last person assumed.

**There is no counter, and that is the strongest property available: nothing is armed, so nothing can fail to
re-arm.** Each rate is a windowed `COUNT(*)` over rows that already exist — the shape this repository's only
working rate limiter already had, counting sign-in attempts. Nothing to increment means nothing to contend on,
no compare-and-swap, and no cell that can drift from the events it claims to summarise: the number is derived,
not maintained. Recovery happens because failures **age out**, so there is no timer, no cron dependency and no
open/half-open state machine anybody must keep advancing. A Durable Object was permitted by the contract for
exactly this and refused anyway: it adds a subrequest to every send, it is opaque to `mailda doctor` in a way
a table is not, and a timer-based reset would inherit the alarm's documented absorbing failure state — *stop
re-arming and nothing external notices, ever* — inside the one component whose job is to notice things.

**The trap was in the substrate, and it was found by reading rather than assumed.** The event table a bounce
rate would naturally count has a **second writer**: an inbound delivery report about *somebody else's* mail
lands in it with `terminal = 1`, which is indistinguishable from a real failure on any query that does not
discriminate. A naive count trips this Node's breaker on another system's bounces — the read-a-wrong-number
inversion a breaker exists to prevent, sitting in the one table a breaker would reach for. It turned out there
are **two** kinds of foreign row, not one, and each is excluded by a different predicate: forwarded reports by
the event-type filter, and Cloudflare's own bounce events that this Node could not attribute by
`manifest_id IS NOT NULL`. That second kind was found by deleting the attribution clause and watching which
tests still passed — the first version of the test built only the corpus the ticket named, and it passed
against a breaker with no attribution clause at all.

**A gate that promises to clear itself needs a drain, and `awaiting` did not have one.** Before this, a send
in that state was unreachable by the dispatcher *by omission* — the predicate that lets a send move simply
never admitted it, which is what made a policy gate a real gate. A rate gate parks a send there and promises
it goes when the window clears, so the predicate gained one arm and now lives in one function with three call
sites rather than three hand-written copies. The policy gates stay closed twice over: the admitted reasons are
derived from the breaker list, and the seal will not write a breaker reason over a policy gate in the first
place. Both halves are asserted, because a rate limiter that could release policy-gated mail is a governance
bypass with a benign-looking name.

**Pausing a domain inverts the legal hold's asymmetry, for the same reason it held there.** Placing a hold is
one administrator and no justification, because placing only preserves and ceremony in front of it is how
evidence is lost. Placing a domain pause **stops a customer's mail**, so the safe direction reverses: two
administrators and a mandatory reason to place, and **one** administrator alone to lift — because the harm of
a wrongly-paused domain grows every minute it stands, and a lift waiting for a second person to wake up is an
outage with a governance story attached. Same principle, opposite conclusion, which is what a principle looks
like when it is real. What was removed from the lift is the ceremony, not the record.

**It is the fifth approval subject, and the first one that is not about a mailbox — which made a column stop
lying.** Every other subject's approvers are the `approval.decide` holders on some mailbox. A domain pause
stops every mailbox sending from that domain, so no single mailbox's holders have authority over it. The
migration that generalised approvals to a subject named this exact case a year of tickets ago and deferred it
in one sentence: *that kind either names a mailbox or brings a second source for its eligible set*. It brought
one — the organization's administrators — and `mailbox_id` became `scope_id`, because a column named for a
mailbox holding an organization id produces a join that returns nothing, and a join that returns nothing is
the one nobody notices.

**A breaker nobody can see is the failure this repository keeps finding, so the reading is printed whether or
not anything is wrong — and it is never a reassuring 0%.** A bounce rate over too few observations reports
`armed: false, reason: no_observations` **and no percentage at all** — the field is blank rather than `0`,
in the API as well as in the report — because 0% on a Node whose delivery channel is dead looks exactly
like 0% on a Node whose mail all arrives, and an unverified number is worse than a blank: a blank prompts a
question and a wrong number ends one. Whether that is a *fault* reads the existing blindness check rather
than recomputing it: a Node sending and hearing nothing has breakers that cannot fire and gets a warning; a
Node that simply has not sent much has nothing wrong and gets a figure. Failing closed on no observations was
refused in one line — a Node that has never sent would refuse to send.

**The thresholds are sized, not measured, and the receipt opens by saying which of its numbers are which.**
There is no corpus: this Node has never observed a real organization's bounce rate, and `doctor` reports the
reason it might never have. So eight of the nine figures are tripwires placed by arithmetic, each with what it
trades off written out, and the first real corpus is the receipt's first staleness clause. The ninth — what
asking every breaker costs — **is** measured, at one subrequest, because all seven questions are scalar
sub-selects in a single statement. Four statements would have consumed the entire headroom of the bound that
exists to stop the cheap dispatch path becoming expensive. The seal went from 11 to 12 and the two dispatch
paths from 16 and 24 to 17 and 25, all inside their published bounds.

**What is not built is named with the evidence rather than stubbed.** The resolution also specified a pause
keyed on a Butler id, so that republishing a fixed Butler cannot silently clear a pause the machine placed —
a good decision about an object that does not exist *as a runtime thing*. There are `butlers` and
`butler_versions` tables now, so a Butler id can be validated — but nothing **runs** one, so no run can be
recorded and a loop-detecting pause would have no denominator. That is the same failure eight policy dimensions
and one team-scoped approval stage were already named absent for — a condition backed by no data is a policy
that silently never fires, which reads as governance and is not. Filed as an issue with the evidence. Loop
detection is excluded one layer down for the same reason: a breaker needs a denominator, and nothing records
per-run outcomes at all. What shipped is not diminished by it — the three rates are the ones that stop a
runaway *sending*, and a domain pause is a human act that needs no Butler.

**A Butler can now be written down, checked and frozen.** The node set is closed over storage that exists today, drawn by looking rather than by taste:
fourteen nodes ship, and fifteen more are *representable in the AST and refused at publication with a reason
naming what is missing*. That distinction is the point. `llm.classify` parses and is refused with "there is
no LLM control plane"; an author who writes tomorrow's node gets an answer rather than a parse error.
`template.render` is on the refused side because the groundwork for the cost ticket went looking for the
template subsystem and found there is none — no table, and every occurrence of the word in the Worker's
source incidental — which means the ticket caught itself putting a node on the shipping side of its own
dividing line while drawing that line. What that costs is stated rather than glossed: the automation this
layer ships is "assign it and draft a reply", not "assign it and send the standard acknowledgement".

**Publishing is the versioning event, and it dissolves a question rather than answering it.** A published
version cannot be edited at all — the edit goes to a draft, and publishing is a deliberate second act — so
there is no dilemma about what a comment-only change does. Resubmitting the same bytes is **refused**: a
version representing no decision is one a run would bind and a reader would be asked about for nothing.
Reformatting the text *does* mint a version — the source text is half of what a version freezes — and the
version says plainly that the program did not move, because the AST is stored canonically: sorted keys, no
whitespace, null and absent identical, integers only. That canonical form is not what makes the refusal
work, and the tempting sentence claiming it is has been struck: an AST is derived from its source, so
identical bytes already give an identical AST. What it makes true is that `ast_sha256` fingerprints the
*program* rather than its formatting. And "frozen" is enforced by the **database**, not by
the write path: a trigger aborts any update that touches a published version's AST, its source text, either
digest or its version number — or that tries to walk it back to a draft, which was the two-statement way
round the first four. The test asserts it by *trying* rather than by reading the code. Deletion
is deliberately **not** blocked, and the reason is written down — immutability and indestructibility are
different properties, and an organization-deletion path is a good widget that a trigger would have trapped
forever.

**Every loop declares its own bound, and a bound that is exceeded fails.** It never truncates: *"replied to
100 of 340 customers and reported success"* is not lost work, it is a system reporting something untrue
about work owed to customers.

**And a Butler that cannot afford to run is now refused before it can try.** The checker used to verify a
bound was present and well-formed and say nothing about whether it was affordable, because that arithmetic
had moved twice in one week and the pot it divides is plan-scoped while nothing inside a Worker can detect
the plan. The seam was named and left empty rather than filled with the wrong number. It is filled now, and
four things about the filling are worth more than the feature.

**A loop cannot be priced in isolation, which is why the answer is 498 and not 500.** The receipt's headline
is `10,000 / 20 = 500` sending items per run. No loop is alone: in the worked example the guard, the assign,
the draft and the propose around it have already spent 38, so the pot has room for 498 and the 499th is over
by eighteen. The rule is therefore *sum the graph* — every non-loop node's fixed cost, plus `maxItems ×
per-item cost` for each loop, with nested loops multiplying. That also catches the shape a per-node check
would wave through: 3,334 `case.close` nodes, the cheapest effect in the set, no single one of them large,
and together two subrequests over the pot.

**The figures were re-measured before anything divided them, and one of them has run out of headroom.** All
four per-node costs were measured on 14 August and three Layer 5 changes had since added I/O to the send
path, which is the receipt's own first staleness clause. Re-run: `case.assign` 5, `case.close` 1 and `draft`
5 are unchanged, and `mail.send.propose` went from 10 to **12** on a bare new thread and from 14 to **16** on
a reply. The **worst realistic seal** — a reply, both derived policy conditions, an approval gate and the
breaker query — now measures **20** against a bound of **20**. The bound holds and it is left alone; what is
said plainly instead is that its headroom is zero, so it has stopped being a tripwire past where any good
widget goes and the next operation added to a send breaks the measurement rather than sneaking past it. That
is the intended behaviour of a receipt, not a nuisance. A fifth node was measured for the first time:
`lookup` shipped with *"its cost is unmeasured"* written into its own declaration, at 1 subrequest for all
five entities, and the price list is now exhaustive over the shipped set **by construction** — the next node
that ships without a measurement does not compile.

**Which plan's pot to divide was a real choice and it is argued in the code.** The pot is 10,000 subrequests
per Workflow instance on Workers Paid and 1,000 on Workers Free, and a Node cannot ask which it is on —
`doctor` reports that gap rather than guessing. Dividing the Free figure would refuse a `foreach` of 200
sending items, which is the fan-out this repository reaches for elsewhere, so the tripwire would sit *before*
where a good Butler goes; and the permissive direction lands only on a plan ADR 25 already refuses at
install. So it divides Paid — and every refusal prints **both** rows and the affordable `maxItems` under
each, because the one-click install verifies no plan at all and an operator on Free should meet that
arithmetic in a refusal rather than in a dead run.

**The refusal names the arithmetic, and the boundary of what it can claim is asserted rather than assumed.**
An author reads which nodes outside a loop, which loop, its bound, its per-item cost, their product, and the
bound that would have fitted. It also distinguishes the two failures it sits between: an exceeded `maxItems`
fails the step and processes nothing, while an overspent pot is the platform killing the invocation wherever
it had got to, after the effects it already performed. And a loop whose body performs no I/O is affordable at
any bound, including a million — true in subrequests, the only currency with a measurement behind it, since
CPU cannot be metered from inside a Worker at all. That case is a passing test rather than a footnote, so the
limit of the claim is pinned in the same place as the claim. Writing an invented per-iteration cost to make
the million look handled would have been the one thing this whole mechanism exists to prevent.

**One defect fell out of needing a fixture.** Pricing a `lookup` meant writing one, and a `lookup` could not
be written: its schema declared a field called `id` for the row to read, which the spread quietly put *over*
the node's own identifier, so the node had four fields where it should have five and one `id` was doing both
jobs. Its identifier had also escaped the node-id pattern entirely, making `id: "${event.case_id}"` a legal
node name. The field is `entityId` now, and the collision is a **compile** error rather than a convention —
no future node's shape can declare `id` or `type` at all.

**One divergence stopped being latent.** The contract required a case id spelled `case_`; the Node minted
`cas_`. A case id this Node produces could not pass its own contract's validation, and it was invisible only
because the field was optional and nothing populated it. Butler nodes name case ids, so it had to be settled:
the runtime won, because its spelling is on every row of every installed Node while the contract's had never
matched anything — no data moved. The prefix now lives in one registry both sides read, with the pattern
built *from* the ULID alphabet rather than beside it, and a closed-world test that refuses any hand-written
identifier pattern anywhere in the repository. That test found a second divergence the day it was written: a
field validating a sender identity against the **send manifest's** prefix, for an object that has no table
at all.

**And a Butler now runs.** Mail arrives, and every published Butler whose trigger names that mailbox starts —
one generic Workflow class interpreting whatever `ast_json` it reads, so publishing one still needs no deploy.
That genericity is not tidiness: a workflow **outlives the Worker that declared it** (measured — deleting the
script left it behind, and it took `wrangler workflows delete` to remove), so a class per Butler would have
left one orphaned account-level resource per published Butler, for ever, invisible to the Worker. There is
exactly one, whatever comes and goes. Full account in [`docs/butler-engine.md`](./docs/butler-engine.md).

**The instance id is the Butler version plus the delivery, and that makes §16's `forbid` free.** `create({ id })`
throws on a duplicate, so the same message cannot start two runs and the refusal comes from the platform
rather than from a check we wrote — the same conflict-is-the-signal shape already carrying the audit sequence
and the claim CAS. It matters because the trigger hangs off an at-least-once pipeline that will see the same
delivery twice. Three things kept separate because each is easy to conflate: the run id is **not** an ADR 9
effect key (it dedups the *trigger*; every send still mints its own), the dedup window is **30 days** because
that is the instance retention rather than our design, and `createBatch` is refused outright — it silently
skips a duplicate id and drops it from the returned array, measured at 4 requested and 1 returned with no
error.

**A Butler's principal is the Butler, and this is the decision with the most reach in the layer.** Not the
administrator who published it. Four reasons, and the fourth is the one that turns a constraint into a
feature: borrowing the publisher's identity would grant the program everything that person can ever do,
put their name on mail they never saw, silently remove them from the approver pool for every send it
proposes — and make it **impossible to write a policy about a Butler at all**, because the `actor` condition
compares an id. As itself, a Butler holds only the tuples an administrator granted to its `btl_` id, which
means a freshly published one can do *nothing* until somebody says otherwise and revoking stops it on the
next node. It cost the schema nothing: identifiers are typed-prefix ULIDs, so `actor_kind = butler` is
**derived from the id** rather than passed by each call site — which is what stops attribution being a thing
every future effect node has to remember.

**A Butler cannot put mail on the wire.** Every send it proposes is sealed `awaiting` a human release, and
both halves of that are necessary: without the D1 state the outbox sweeper hands the bytes over the moment
the hold window elapses, and without the parked `waitForEvent` a release cannot resume the program. So the
gate is in the database and the waiting is in the Workflow — which costs no concurrency, so ten thousand
proposed sends are ten thousand sleeping instances and no capacity. A send therefore stays releasable after
its *run* has expired, because instance state lasts 30 days and a manifest lasts for ever. A timeout ends the
run and never the send. The release takes `send.propose` — the authority composing it would have needed — and
the trail names the **person**, while the seal names the Butler.

**Being refused is the system working, so it is an outcome rather than an error.** A policy denial, a paused
domain, an approval nobody can give, a case somebody else is holding, a relation that was never granted: each
is recorded against the node that met it and the run carries on. Three of those are tested against the real
machinery rather than a stub — a real published `deny` policy, a real two-administrator domain pause, a real
stage set whose approvers were revoked. What that costs is stated rather than glossed: the shipped AST has no
failure edge, so a Butler cannot say *"if the send was denied, assign it to a human instead"*. It can only be
read afterwards.

**The one thing a Butler must not have is a path a person does not have.** So `case.assign` is `claim`,
`case.close` is `close`, `draft` is `saveDraft` and `mail.send.propose` is `sealManifest` — not copies. Which
means `case.close` closes only a case the Butler is *holding*, exactly as it does for a human, and the shipped
way to reach that is to assign it to `${butler.id}` first. Widening `close` for the program's convenience
would have changed what closing means for everybody. The engine's own additions are three: resolve the
expressions, record what happened, and check **the Butler's** authority where the function checks somebody
else's — which is the gap that mattered, because `claim` verifies the *assignee* and a Butler holding nothing
anywhere could otherwise have assigned any case in the organization to anybody who may work it.

**A stored AST is data, and data can be edited by whoever holds the database.** So the checker runs **again**
at run start, for free, and a reserved node written straight into the row makes the run refuse itself before
any effect — with the checker's own sentence, *"there is no LLM control plane"*, in the reason and the log.
Not a crash and not silently skipped. The same pass catches the other three things a hand edit could
introduce: a cycle, a dangling edge, and a graph that cannot afford itself.

**Measuring a run against the checker's prediction for the same AST found them disagreeing, and that is worth
more than either number.** #54 prices the *functions* a node calls; a run costs the *nodes*, and a node is the
function plus the Butler's own authority check plus its record row. Four of the five fit inside the headroom
those bounds already carry. The fifth does not: `mail.send.propose` measures **23** against a bound of **20**,
because the node reads the draft back before sealing it. At two nodes that is a rounding error — 32 against a
predicted 30. At loop scale it is not: a `foreach` of 500 sends prices at exactly the Paid pot and really
costs 11,503, so the instance dies at about item 434 **having already sealed 434 manifests**, which is
precisely the failure the publication-time refusal exists to prevent.

**So #54's arithmetic was left alone and the engine was given a live meter instead.** Editing a closed
ticket's figures from inside another ticket's work is how a receipt stops describing what it says it measured
— its numbers are correct measurements of the functions they name. What changed is that the run now **counts
its own spend**, carries the total across invocations on its record, and refuses an effect it cannot afford
*before* performing it, with the budget, the limit, the ask and the receipt in the operational log. The
500-send loop stops at item 357 with something a person can read. Three numbers, and the distance between the
first and the last is the whole finding: **500** admitted at publication, **434** actually affordable, **357**
permitted by the guard. The guard being strictest is the right direction — refusing one send too early costs a
run that could have finished, and refusing one too late means it has already gone.

**A Butler that talks to itself gets stopped, and the thing that made that possible was already in the
schema.** #66 designed a Butler pause — a latched row, keyed on the *Butler* rather than on a version, so
republishing a fixed one cannot silently clear a pause the machine placed — and then named it absent, because
there was no `butlers` table to key one on and no run record to place one from. Both exist now, so the decision
was implemented as written rather than re-argued. What did get re-argued was the loop, because #66 had said
detecting one needed a causal record that did not exist. **It did exist**: a manifest carries the `Message-ID`
this Node emits, an inbound reply stores what it quoted with the brackets already stripped, and a run's effect
row names the manifest it sealed — so *"this delivery is a reply to a send this Butler made"* is a join across
three tables that have been there since Layer 2. Checked rather than inherited, which is the only reason this
ticket built the loop that matters instead of the one that was easy.

**So the loop that ships is causal, and the easy one is what is now named absent.** A windowed count of *runs*
would have been trivial — `butler_runs` supports it in one `COUNT(*)` — and it has no threshold anybody can
defend, because a Butler's legitimate run rate **is** its mailbox's inbound mail rate and nothing here has
measured that for even one organization. What is counted instead is **self-provoked runs**: links of a chain
this Butler made itself, inside an hour, and over three of them it is paused before the next run starts. Three
absences go with it and each has a reason rather than a shrug: an unthreaded reply has no link back and is
invisible, a loop through two Butlers counts for neither, and — the one that bounds the whole feature today —
**a Butler's send cannot leave this Node without a person releasing it**, so a real chain needs an
administrator clicking release at every hop. What this catches now is a human-assisted loop; what it exists for
is the day that gate moves, because at that moment a chain with nothing counting it is a sending loop with no
bound at all. Saying which of those two it is was the whole point.

**Asking costs nothing, which is a design property rather than a small number.** Both evaluation points ride on
statements that were already being issued: the pause and both loop counts are sub-selects on the read of
published versions the trigger already makes, and the run-side question is a sub-select on the read of
accumulated spend the interpreter already makes once per invocation and already must not cache. That second one
is not symmetry — a workflow outlives the Worker that declared it and a `wait` node reaches 365 days, so a
pause that stopped new triggers and let ten thousand parked instances wake up and act would be a pause in name
only. Measured: the trigger costs **3** subrequests with a live Butler and **2** with a paused one, because a
paused Butler starts no run at all. A control that exists to stop a runaway makes the runaway's own path
cheaper.

**The machine places it and one administrator resumes it, which inverts the domain pause's ceremony and for the
same reason it had ceremony.** Stopping a customer's *mail* takes two administrators and a written reason,
because somebody should have decided it. Stopping a customer's *automation* takes nobody, because a breaker
that waits for a person is not a breaker — the mail still arrives, is still filed, and is still answerable by
hand. The resume is one administrator alone, because an automatic pause nobody can resume is an outage and
placement needed no administrators at all; it is `org.admin` and not anybody, because one anybody can resume is
not a pause. And the reason is **mandatory** here where a domain lift's is optional: a domain pause already had
two people's judgement in it, and this one has none anywhere except at the resume. **Republishing does not
resume**, deliberately, and that is this feature's loudest test — a fix needs an explicit decision that it is
safe to run again, which is the act somebody should have to perform.

**A paused Butler produces silence, and silence is what `doctor` exists to distinguish from health.** So the
harder finding is not *"which Butlers are stopped"* — it is *"has one stopped producing runs"*, which from the
run record alone is indistinguishable from a Butler nothing has triggered. The discriminator is whether mail
actually arrived at the address the trigger names: the address parsed out of the frozen AST, the arrivals from
one grouped read. Mail arrived and no run started is a fault; no mail arrived is not; a stored AST that will
not parse is a fault of its own. Anchored on the publication instant rather than on a window, because a window
would have needed a figure for *how long may a Butler legitimately go without running* and a Butler on a quiet
mailbox may honestly go a month. A third finding refuses to call the loop detector armed on a Node whose
inbound mail carries no threading at all, rather than reporting a reassuring zero — which is the same refusal
the bounce-rate breaker already makes about a dead delivery channel.

**And an index for something else nearly turned a diagnostic into a table scan.** The causal join needs
`send_manifests` reachable by the Message-ID a reply quotes, and written the way every other index in this
schema is written — leading on `org_id` — it displaced the partial index `doctor`'s evidence-mismatch check
depends on, turning a seek into an empty B-tree into a scan of every manifest ever sealed. Found by a test that
reads the query plan from the planner rather than trusting a comment, in the same change rather than six months
later. It leads on the Message-ID instead, and is UNIQUE, so two manifests cannot claim one — which would have
let a single reply attribute to two sends and counted a chain that never happened.

**A Butler can no longer choose who mail goes to, and the reason that had to change is worth reading twice.**
§16 has always said untrusted content must not select or construct To/CC/BCC. The node set charted before that
was settled gave `draft` a `to` list of *expressions*, an expression may read `event.*`, and `event.*` is the
inbound message — so a published Butler could send to an address chosen by the mail it was answering. Nothing
objected, because the thing that would have objected was the tripwire the same ticket asked for and had not
built. **The absent guard and the open sink were one omission**, which is the shape this repository has now
paid for four times.

**So the parameter is gone rather than guarded.** A guard has to stay right for ever; an absent parameter has
nowhere for a value to arrive. The Node addresses a Butler's reply itself, from the **parent delivery** — the
envelope sender of the message that triggered the run, which is RFC 5321's return path and what RFC 3834
requires an automatic responder to answer. Not the `From:` header and not `Reply-To:`, and that is the whole
point rather than a detail: a header is content, so honouring one would be the same sink wearing a different
name. A message forged to say `From: finance@victim.example` gets its reply at the address that actually sent
it, and there is a test that sends exactly that message. A bounce — `MAIL FROM:<>`, no return path at all — is
**refused**, because every available default is worse: the header reopens the sink, the mailbox is a loop, and
a manifest with no recipients is not a send.

**And the loop in that sentence turned out to be reachable, which is why driving a thing beats reading it.**
Nothing stopped the derived recipient from being the address the delivery arrived at — a message whose reverse
path is `support@acme.example`, delivered to `support@acme.example`, sealed a reply from that address to that
address, which comes back in and does it again, and forging `MAIL FROM` is all it takes to start one. The
sentence had been a reason not to default to the mailbox; it was not a rule anything enforced. It is one now,
and the honest limit is stated with it: the check compares one address against one address, so a loop that runs
through a second mailbox or between two Nodes still passes. Breaking those needs `Auto-Submitted`, which
nothing in this repository emits or reads.

**What it costs is real and is written where authors meet it: a Butler cannot CC a colleague, add a supervisor,
or forward anything.** All three mean naming somebody who is not the correspondent, which needs a *trusted*
recipient, and there is no contacts table, allowlist or suppression list anywhere in the schema. They arrive
with that store rather than with a parameter that would accept whatever an expression produced. **A person is
not constrained by any of it** — the draft store takes the recipients the request gives it and derives nothing,
which was verified rather than assumed and is now pinned by a test, because a change that made the store clever
would hand every Butler a recipient back through the same function.

**And the checker that was planned for this became a tripwire instead, which is a reversal recorded rather than
made quietly.** A dataflow checker at this layer would have had nothing to refuse — the sink is closed by
construction — so no test could prove it refuses, and a green suite would have established only that the
analysis never fired. That is the exact shape of three defects found here in one day. What is built instead is
structural and fails today if broken: a shipped node's parameters are **closed and strict**, so `to`, `cc`,
`recipients`, `escalateTo` and `forwardTo` are all refused at publication by one rule that knows none of their
names — and a test pins the entire parameter surface of the node set, so a recipient cannot come back without
something failing and naming §16. Both halves were proved by putting `to` back and watching them fail. The
dataflow checker lands with `connector.*` and `llm.*`, at Layer 6, where there will be something to refuse.

**Re-verifying the other ten sinks corrected two entries, and one of the corrections matters.** *"Sender
identity is closed structurally"* was half true: `From` is the mailbox's address, and the mailbox is chosen by
an **expression**, so untrusted content can reach it. It is closed by *validation against trusted organization
state* — §16's own escape clause — rather than by construction, and the asymmetry with the recipient is exactly
why the two are handled differently: a recipient had nothing to be validated against, while a mailbox has the
tuple table, which only an administrator writes. Both arms are now asserted: content naming a mailbox the
Butler was not granted is refused, and content naming one it *was* granted works, which is the residual stated
rather than implied by silence. The other correction is smaller and was simply stale — policy *does* have a
table now, and recipient externality is one of its conditions, so policy selection had been riding on the
recipient parameter all along and closing that closed this too. A third thing fell out of the same pass:
a Butler on a **multi-address mailbox cannot send at all**, because it has no way to name which address it
sends as and nothing will let a `created_at` decide what every recipient sees.

**One thing is stated and not fixed.** Deriving the recipient closes the *selection* — nothing an author wrote
and nothing in the message decides who receives it — and it does not make the envelope sender trustworthy. A
spoofed reverse path aims a reply at whoever it names. What stands between that and an unattended exfiltration
path today is the human release gate on every Butler send, which is the gate the pause work already flagged as
one that may later be outranked. The proper answer is the same missing trusted-recipient store, and saying so
is better than a paragraph implying the problem is closed.

**A run can now be replayed, and the rule that makes that safe is the one this ticket's own body got
backwards.** §16 says a replay never reuses an old idempotency key for a *materially new* effect, and the
tempting reading — *materially new means a different manifest id* — is exactly wrong. ADR 35's property is
**directional**: a manifest id is a time-and-random ULID with no content constraint behind it, so the same id
implies the same content and a different id implies nothing at all. A replay that reproduces a message byte for
byte always gets a new id, so an id-based rule would call it new, mint a fresh key and **hand the same message
over twice** — the precise thing that sentence exists to prevent. So it is decided by content: the envelope
plus the normalized body's SHA-256, hashed by one function using hashes the seal already computes, derived
rather than stored so it works on every manifest this Node has ever sealed. Same content means the old key is
reused and nothing is sealed, written or sent; different content means a new key, and any approval bound to the
old bytes is moot because approval binds an id. The headline test is a replay of an unchanged run producing
**one** manifest where the rejected rule would have produced two.

**`retry-effect` is offered only where non-acceptance is proven, and the unprovable case got its own name
rather than a flag.** §16's precondition named a reconciler that does not exist — the only one here reconciles
R2 evidence against ingress receipts — so the four things that can actually be proven are recorded outcomes:
`refused`, `throttled`, `suppressed`, and an authored send whose submitted bytes were never written, because
that column is set *before* the first submit. A recipient's attempt count is not a proof and is not consulted:
it is updated after the call resolves, so a dead isolate leaves it at zero with the bytes already gone. Where
the proof is missing the mode is **absent, not failing**, and `resend-may-duplicate` is what exists instead:
human-only, refusing without an explicit acceptance of the risk and without a reason, minting a **new** key
deliberately because the old one may already have been handed over, and audited under an action naming the
person rather than the author. Two names because two epistemic states; one button for both would have put the
safe act and the duplicate-risking one behind the same click. The rule is a total map over the send states
rather than a list of ones to exclude — `outcome_unknown` is the *default* for anything unrecognised, so the
unprovable population is the one that grows and a denylist guards only the spellings its author thought of.

**A replay inherits its input and re-asks its judgement, and every one of those was decided rather than
inherited by default.** The trigger facts are frozen on the run record and replayed unchanged, because
re-deriving them describes *now* — a case created since, a conversation merged since — and a run over different
input is not a replay of anything. Policy, authority, approvals, the rate breakers, the domain pause, the
Butler pause and the version's publication state are all re-asked, so a replay cannot do what the live path
would now refuse; a policy published after the original ran refuses the replay, and that is a test rather than a
claim. A legal hold is in neither list on purpose: it governs destruction, not sending, and inventing a coupling
would be a control nobody asked for. The ledger itself is four columns on the two tables the engine already had
rather than tables of its own, because a second account of one run is two truths that can disagree — and the
replay's cost counter starts at zero, since the pot is per instance, which is what makes a run killed for
budget replayable at all.

**Reading what a Butler did is not free of the mail it read, and `inspect` had to be gated for it.** A run's
recorded input is the `event.*` root, and that carries the triggering message's subject line and sender — mail
content, which the fact set's own declaration says of the `From:` header in as many words. The route is
`org.admin`, which is a relation on the *organization* and appears nowhere in this Node's table of who may read
a mailbox, so the mode shipped as a way for an administrator holding nothing anywhere to read the subject and
sender of every message any Butler ever processed, with nothing recorded. The fix classifies every fact once, as
a total map beside the fact set so a tenth one cannot arrive unclassified and an unknown key in a stored blob is
treated as content, and withholds the content half unless the reader holds the mailbox's metadata or content
relation — or a live supervised grant, which #63 built for exactly this investigation and which records itself
before answering. Ids, states and tokens stay, so an auditor with no mailbox authority can still see which
program ran over which delivery and what it did; what they get instead of a subject line is a named list of what
was withheld and the authority that would open it, because a redaction a reader cannot see is a hole they read
past. And the raw column is no longer on the run row at all: it had one careful gate and three responses
serializing the row beside it, so it now has exactly one reader named for what it returns.

**A replay of a send that was decided against says so, rather than reporting success.** Reusing the original's
key is right whatever state it is in — that is what stops a duplicate — but *"this message is on its way"* is
false of a send a policy withheld or a person cancelled. "A policy wrongly denied a Butler's send; fix the
policy and re-run" is the most obvious use of the mode there is, and it was a no-op answering `ok`. It now
records a refusal naming the decision, still against the original key, because re-composing there would open a
real duplicate path rather than close anything.

**And one Layer 2 invariant turned out to assume a first attempt.** `drafts_one_per_reply` says replying twice
to the same message resumes the draft that exists — written about a person, and it binds a program too. A
replay drafting the same reply died on the constraint before its first effect row, recording `engine_fault` and
nothing else. The fix is the index's own sentence: on a replay the draft is resumed rather than re-created, and
the argument against upserting on the ordinary path survives untouched because the lookup is bound to the
Butler's own author id, so the widest thing it can find is a draft the same program wrote.

**What is still not enforced is said rather than implied.** A loop whose body performs no I/O costs nothing,
so it is affordable at a billion — true in subrequests, the only currency with a measurement behind it — and
the engine does not refuse it either: it runs until the platform's CPU limit kills the step. And a workflow's
name is account-scoped and **cannot be omitted**, so #72's fix for the queue is unavailable here; what is
enforced instead is that the name derives from the Worker's own, which makes a rename one edit. The residual
is named: Workers Builds overrides the Worker's name, so a second install into one account gets a different
Worker and the same workflow name, and what happens then is unmeasured. The queue case collided silently;
this one is not known to.

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
- **Downloading a message used to leave no trace. It does now.** The `.eml` button produces a complete
  copy of somebody's mail, off the Node, and until now it did that on the strength of "you can read this
  mailbox" and recorded nothing — so *has anyone taken a copy of this message* had no answer. It is a
  permission of its own, `message.export`, which every existing reader was granted so nothing broke, and
  every download is now in the trail. What that buys is that exporting can be taken away without taking
  away reading. The bulk version — a whole mailbox, for a matter — is a different permission with a
  different price: two approvers, and they agree to a **hash of the query and a hard message count**,
  because a query that matches forty things today matches four hundred next month. An export that would
  exceed the count stops and asks again rather than quietly copying more, and one too large for a manifest
  to name is refused with the number rather than truncated. Revoking the permission stops a running export
  at its next page and a download at its next file. ([the design](./docs/ediscovery-export.md))
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
docs/approvals.md                      stages, eligibility, the races, the dispatch recheck, what is absent
docs/supervised-access.md              matters, the time-boxed grant, per-act recording, the notice
docs/ediscovery-export.md              the two export permissions, the bound, the manifest, the boundary
docs/send-breakers.md                  the three windowed rates, the domain pause, sized versus measured
docs/butler-ast.md                     the node set, what the checker refuses, how a version freezes
docs/butler-engine.md                  what runs a Butler: the principal, the release gate, the budget,
                                       the pause and the loop that places it, the run ledger and the
                                       four replay modes
docs/evidence-lifecycle.md             keys, re-sealing, reconciliation, the pipeline
docs/agents/                           issue tracker and domain-doc conventions
packages/receipts                      generates constants from receipts
packages/budgets                       GENERATED — do not edit
packages/runtime                       the clock, id and randomness seam
packages/contract                      command schemas
packages/butler-ast                    the Butler AST: node set, checker, canonical serialization
packages/evidence                      framed encryption for stored mail
apps/node/worker                       the single Worker (ADR 18): inbound mail, evidence store,
                                       authorization, auth, outbox sweeper, interface
apps/node/worker/src/auth              passwords, ES256 tokens, key rotation, sessions
apps/node/worker/src/butler            the run engine: interpreter, effects, principal, release gate,
                                       recipient derivation, the latched pause and its two write acts
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
