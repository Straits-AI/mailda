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

## Status: functional alpha, not production-ready

**Do not make this the only copy of mail you care about.** It receives, stores, reads, replies, governs and
automates — and the release gates it sets for *itself* are not all closed. That sentence used to read "this
is not deployable software yet", which by August 2026 had become the opposite overclaim: too pessimistic
about the code and still correct about the verdict.

What is honestly blocking, as of 27 August 2026, with everything else on the [issue
tracker](https://github.com/Straits-AI/mailda/issues):

| | |
|---|---|
| **A restore has worked once, on three objects, with no domain** | Measured end to end against two Cloudflare accounts (#92): backup, cross-account catalog restore, escrow redemption, sign-in as the source's administrator, and `verify-evidence` reporting **3 checked, 0 faults** — the same draft byte-identical on both Nodes. That is the step #92 calls the one that makes the rest true, and it has been run **once**, over three objects, on a Node with no domain. It exercises every step in the sequence and none of the limits: a mailbox-sized restore has a D1 import size to respect and a bucket copy that must not be one request per object. Restore-to-receiving needs DNS and is unmeasured. The [runbook](./docs/disaster-recovery.md) records what was measured and the five defects the drill found. |
| **Deployment promotes by hand on a Free account** | `mailda deploy` does expand/contract with a canary and refuses to promote a version whose `doctor` is not `ok` (#98). It has now been run against a live account ([receipt](./docs/receipts/deploy-drill-live-account.md)) — and `versions upload --preview-alias` returned **no reachable preview URL**, so the gate cannot probe the canary and degrades to a safe manual promotion. The cause is not established, which is why that receipt records it without a number. |
| **Two Nodes in one account collide on the Workflow, and the deploy refuses** | Measured rather than suspected ([receipt](./docs/receipts/deploy-drill-live-account.md)): every other resource derives its name from the Worker's, the Workflow does not, and deploying a second Node **succeeded with exit 0 and silently took ownership** — leaving the first Node's `BUTLER_RUNS` binding pointing at a Workflow now running the second Node's code against the second Node's bindings. `mailda deploy` now refuses when the Workflow belongs to another Worker and names the fix. The config still ships a fixed name, so the refusal is the guard rather than the naming. |
| **Mail security is absent** | No attachment scanning, no spam or phishing classification, no URL reputation, no suppression management. A public mailbox should not be accepting attachments. |
| **The mail client is thin** | No threads, no forwarding, no attachments in the composer, no folders. Pagination and per-mailbox filtering landed in #91; search over subjects, senders and message bodies in #107. The rest has not. |
| **AI is reserved, not built** | The Butler engine is deterministic and the `llm.*` node types are declared and **refused**. There is no provider configuration, prompt versioning, cost governance or evaluation. Calling this AI-native today would be a claim about intent. |

What it is genuinely good for now: a controlled design-partner alpha, a non-critical shared mailbox, and
exercising the governance and deterministic-automation model — which is the part that is further along than
anything else here.

What exists today:

| | |
|---|---|
| **Product contract** | [`Mailda-Full-Engineering-Blueprint.md`](./Mailda-Full-Engineering-Blueprint.md) — 2,967 lines specifying the target state, with 41 locked architectural decisions |
| **Working agreement** | [`AGENTS.md`](./AGENTS.md) — how decisions get made and what counts as done |
| **Decisions taken** | Recorded with full reasoning and rejected alternatives, on the [issue tracker](https://github.com/Straits-AI/mailda/issues?q=is%3Aissue) |
| **Measurements** | 43 receipts in [`docs/receipts/`](./docs/receipts/), generating every constant in `packages/budgets` — which is itself generated and never hand-edited |
| **Code** | One Worker. **1,509 tests across three runtimes** — workerd, node, and a DOM for the interface, which had none until #90. The accessibility audit is manual and last covered 30 views with 0 AA violations; the screens added since have not been through it. |
| **Licence** | [Apache-2.0](./LICENSE). Security reports go to [`SECURITY.md`](./SECURITY.md), privately. |

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

**One constraint was cut, with the reason recorded rather than a column added for it — and it has now been
built.** A stage was meant to be able to say "a member of team T". `team_members` turned out to be read-only in
the whole product — three SELECTs, nothing writing it — and there was no `teams` table at all, so a team had no
name and no existence of its own. A team-scoped stage would have been **expressible and unusable**: no team
could be created through any surface, and publication could not check that a named team exists, only that it
currently has members. That is the same failure as a condition backed by no data, and a nullable `team_id` that
is always NULL is that failure wearing a column. So the constraint was named absent and what would have to
exist first was filed as an issue — and the issue was then taken, which is the rest of this paragraph.

**A team is now a first-class object, and the substrate and its consumer shipped together on purpose.** A
subsystem with no consumer and a constraint with no subsystem are the two halves of one mistake, and shipping
either alone is how one of them rots. So the same change adds a `teams` table with a name that is unique in the
organization — because a team is granted to by id and *picked by a human reading a name*, and two teams called
Finance is exactly how `approval.decide` reaches the wrong one — a writer for `team_members`, which had never
had one, and the stage constraint that justified them. Membership needed nothing else in the schema, and that
was checked rather than assumed: the UNIQUE index that stops one person joining a team twice has been there
since the first migration, so an add is `INSERT OR IGNORE` behind an audit gate and a replay is a no-op that
records nothing rather than a second entry claiming a second act.

**Membership is authority, and that is what decided both the audit question and the Butler one.** A principal
authorizes as themselves *plus every team they belong to*, so a relation held by a team is held by every member
— which means adding somebody to a team can hand them a mailbox's contents and a vote on somebody else's send
with **no access-granted entry anywhere**. Un-audited, an administrator grants a team once, in the trail, and
then changes who that grant reaches for ever, in silence. So `team.member_added` and `team.member_removed` are
recorded, keyed on the *person* so "what authority did this person get, and when" stays one filter across both
doors into it; the removal carries how many members are left, because emptying a team is what makes a rule
unsatisfiable and that consequence is not otherwise attributable to an act. Creating and renaming are audited
too, on their own merits and not by association: a team row has no neighbouring entry to answer for it the way
a policy's shell has, and a rename changes what the next administrator believes they are granting to. And a
**Butler cannot be put in a team** — enforced by requiring the subject to be a row in `users`, which is a join
that has to succeed rather than a test on the shape of an id, because a capability ceiling intersected with a
set that moves whenever somebody edits a team is not a ceiling.

**The constraint narrows and cannot widen, which is the property that let it exist at all.** The eligible set
for a stage is the `approval.decide` holders on the mailbox *intersected with* the named team's members, minus
the actor, minus everybody who has already decided — an intersection only ever removes people, so naming a team
can never make somebody eligible who holds no relation. A team id naming nothing resolves to **nobody** rather
than to everybody, which is the restrictive answer for the unclassified input. Publication verifies the team
**exists**, which is the check that was impossible before there was a row to look for, and it is a different
refusal from "that team is empty" because a misspelling and a quiet week need opposite answers.

**A team that is emptied reaches the same answer as authority being revoked, because it is the same thing.**
Removing the last member of a team a live policy names is permitted — refusing it would put a policy in charge
of who may leave a team, and would fail in the direction that leaves somebody in a team they should not be in.
What happens instead is what already happens when the last `approval.decide` holder loses the relation: the
next send is `withheld` with `approval_unsatisfiable`, naming which stage, which team and how many short,
rather than parking in a state that reads as waiting for somebody. And it is re-checked a third time at the
decision itself: the request freezes the team's **id** and deliberately not its members, so somebody who leaves
a team stops being able to decide on their next request rather than on the next send.

**One thing about the fold needed deciding and is refused rather than guessed.** Two live rules that both gate
one send are folded by taking the greater count at each ordinal — which is the existing conflict resolution
reused. Teams have no greater-of: "a member of Finance and a member of Legal" at one ordinal is a conjunction
one stage cannot carry, and picking either would silently drop half of a rule somebody wrote. So publication
refuses that pair, and only when the two rules could **provably both match one send** — Finance approving one
mailbox and Legal approving another is untouched, because a tripwire a good policy trips is a wrong tripwire.
The fold raises if it ever meets the conflict anyway, so the rule is enforced at both ends instead of claimed
at one.

**What it cost, measured rather than counted.** The receipt for an approval decision had already named this
change in its own staleness clause and reserved the headroom for it: *"the eligible set gains a narrowing
constraint — a team-scoped stage is the one #61 named absent."* It fired, the headroom was spent as predicted,
and no number moved. One query, `teams LEFT JOIN team_members`, spent at the seal, at the decision, at the
withdrawal and at publication — and **only where a stage actually names a team**: a send gated by an ordinary
policy asks nothing, because the resolver short-circuits an empty request before it prepares a statement. A
team-scoped seal is exactly one operation more than a team-less one, measured as a difference in one run rather
than against a figure written down last week. On the **authorization** path it costs nothing at all, and that
was measured too rather than argued from the fact that nothing there reads the new table: the same three checks,
before and after every team in the benchmark corpus becomes a real object, read identical rows and identical
queries.

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

**And it can be written in YAML, which is the first format here that can hold the reason for a step.** The
old sentence — "§16's YAML arrives when a YAML parser arrives in the bundle" — named no cost and no decider,
so it survived three layers by being unfalsifiable. Priced instead: `yaml` 2.9 costs **+246.2 KiB raw,
+50.8 KiB gzip**, about 1% of the Paid script ceiling, and it was spent because JSON structurally cannot
carry a comment and a Butler is a program. Every other file in this repository puts the argument next to the
code; the one that could not was the automation.

It goes **one way only**. There is no AST-to-YAML renderer and there must not be one: comments, blank lines
and key order are not in the AST, so regenerating a document from one would delete every reason its author
wrote down on the most ordinary act there is — open, change a field, save. The consequence is stated rather
than left to be found: §16's *visual* builder cannot edit a YAML Butler, because a graph editor writes an AST
and writing one back out needs the renderer that does not exist.

The `source_format` column arrives in the same commit as the second value and not one earlier. The objection
to it was correct for as long as it held — a column whose only value is `'json'` is the placeholder shape
this schema already carries two of, and a tripwire exists to catch a third. It is frozen with the text, for
the reason migration 0031 was written: a published version whose format could be flipped is a frozen program
that its own recorded source no longer describes.

**And a Butler can be tried before it is trusted.** `POST /api/butlers/:id/simulate` walks the draft over
facts from a run this Node actually performed, causes nothing, and reports what a live run would have done —
including the answer an author actually wants, which is *who this reply would go to*, derived by the same code
the live path uses.

**What makes that safe is a type rather than a flag.** Every function in `src/butler/simulate.ts` takes a
read-only environment, which is not assignable to the writable one — so nothing reachable from a dry run can
seal a manifest or write a draft *because it does not compile*, for every write that exists and every write
anybody adds. A proxy that threw would have been the effect-suppressing flag the map rejected: it fails at
the write, in a branch a test has to reach.

This replaced the mechanism the map's fifth Layer 4 answer specified, and the substitution is recorded rather
than quiet. That answer withheld a **transport** capability. A Butler run has none to withhold — nothing
under `src/butler/` names the mail binding, and `mail.send.propose` writes a sealed manifest that a separate
later invocation dispatches — so the property it wanted was already true for a stronger reason, and the
capability that actually needed withholding was the database write. Ranked by danger the answer's own example
came last: a proposed send is parked behind an approval, while assigning a case is gated by nothing.

It is **one walk**, shared with the engine, because a simulation that diverges from the engine is worse than
no simulation: it is a tool that tells authors their Butler is fine. And what it cannot know it says out
loud — the send's policy decision, breakers and approval gate happen when the manifest is sealed, so a report
says a send *would be proposed*, never that it would be sent.

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

**A published Butler now says what it may ever do, and its authority is capped by the person who published
it.** Layer 4's shape says a step's effective authority is `pinned ceiling ∩ live tuples of the Butler ∩ live
tuples of the sponsor`, and until now only the middle term existed — so a Butler was exactly as powerful as
the list of tuples naming it, and an administrator granting one a mailbox next month silently widened a
program published in June. The ceiling is `capabilities:` **inside the AST**, which is where §16 always put
it and which is what makes "frozen with the version" cost nothing: the trigger that already refuses to move a
published program refuses to move its ceiling, and the digest that already fingerprints the program
fingerprints its authority bound. Publication proves the ceiling's **action set is exactly what the graph
needs** — an action a node needs and the ceiling omits is refused, and so is an action the ceiling declares
that no node needs, because a ceiling padded *just in case* is a ceiling that does not bind. What publication
cannot prove is *which mailbox*, because a node's mailbox is an expression and the AST package does not parse
expressions; that half is enforced per step, in the statement that was already asking about tuples.

**The sponsor is the publisher, and that is not the identity #50 rejected.** #50 refused the publisher as a
Butler's *principal* on four counts, and every one of them is about identity: whose name is on the mail, who
is excluded from approving it, what a policy can tell apart. An intersection can only ever **subtract**. So
capping a Butler against its publisher's live authority grants it nothing — it still needs its own tuple —
while making a mailbox the publisher cannot reach unreachable to the program they published, which is the
direction §7 asks for. Revoking the sponsor's relation stops the Butler on its next node, visibly: the effect
row says `sponsor_lacks_it` and names them, because a ceiling that quietly empties and a Butler that quietly
does nothing look identical from outside. Migration 0031 froze `published_by`, closing a one-statement hole
the freeze trigger did not know it had — a swappable sponsor is a ceiling that is not pinned, and swapping it
left the AST untouched and every digest matching.

**Three terms, two queries, and one line that must not be simplified.** The ceiling is free — it rides on the
version row the run already loaded — the sponsor's teams are one query, and both tuple terms come back from
one more. The trap is that `subject_id IN (butler, sponsor, …teams)` answers *"does any of these hold it"*,
which is an **OR**, while the intersection needs an **AND**: written that way, a Butler holds whatever its
sponsor holds and nothing notices. What converts one into the other is selecting `DISTINCT subject_id` rather
than `1`, so the query returns *which* subjects hold the relation and the conjunction is evaluated on the
result. Measured rather than inherited: every node grew by exactly the round trips that derivation predicts —
a send from 23 to 25, a lookup from 2 to 3 — and every bound already had the headroom, so no number moved.

**What is still not enforced is said rather than implied.** A loop whose body performs no I/O costs nothing,
so it is affordable at a billion — true in subrequests, the only currency with a measurement behind it — and
the engine does not refuse it either: it runs until the platform's CPU limit kills the step. And a workflow's
name is account-scoped and **cannot be omitted**, so #72's fix for the queue is unavailable here; what is
enforced instead is that the name derives from the Worker's own, which makes a rename one edit. The residual
is named: Workers Builds overrides the Worker's name, so a second install into one account gets a different
Worker and the same workflow name. **That has now been measured, and it is the worse of the two
possibilities** ([receipt](./docs/receipts/deploy-drill-live-account.md)): deploying the second Node exits 0
with no warning and the Workflow's ownership moves, so the first Node keeps a binding into code and bindings
that are no longer its own. The queue case collided silently; so does this one. `mailda deploy` refuses when
the Workflow already belongs to another Worker, which is a guard at the one moment the collision can be
created rather than a naming rule the config enforces.

**Mail older than the newest fifty could not be reached, and the fix is a cursor that carries no authority.**
`listMessages` ordered by arrival and took fifty, with no cursor, no offset and no mailbox filter — so the
fifty-first message was not slow to reach, there was no parameter a caller could pass and no control the
interface could render that would return it. On a mailbox taking twenty messages a day that is three days
before the product that is meant to be a system of record stops showing its own contents. The bytes were
never lost; the archive was present and unnavigable, which for mail is close enough to matter the same way.

**The part that needed care is that a page is a position inside an authorization scope, not just a
position.** The listing authorizes *in SQL* and §7 requires the live relationship on every operation, so a
reader's scope moves between page one and page two: a supervised grant expires, a team membership is revoked,
a mailbox relation is removed. A cursor that remembered the mailbox set page one resolved would be fast,
obvious, and would disclose rows the reader may no longer see. So the cursor is `(accepted_at, id)` and
nothing else, and **every page re-runs the whole authorization** — which is also why it needs no signature:
forging one moves your own position in an ordering you are re-authorized against. The test the design exists
for revokes access between the two pages and proves page two cannot return a row the revocation removed,
against both structures that answer *"who may read this mailbox"* — a standing relation somebody deletes and
a grant that runs out of time.

**Keyset, not `OFFSET`, and the reason is arrivals rather than taste.** Mail lands while somebody is reading,
so an offset counting rows from the top would skip one message and repeat another on every page turn. Two
things came out of measuring it. `ingress_receipts` **had no index on the column the listing has ordered by
since Layer 1** — so every inbox load already scanned the table and sorted it, 6,004 rows read on a
1,200-delivery corpus against a 1,000-row budget, invisible because the fixtures hold three messages. And the
obvious one-line cursor — comparing `accepted_at || ' ' || id` as the export path does — is correct and *not*
an index constraint, so it reproduced `OFFSET`'s cost curve inside the change made to avoid it: page twenty
read 1,176 rows. Two predicates and one migration later, page one reads 208 and page twenty reads 210. The
fifty is now `messages.page_size` with a measurement behind it, sized under the tighter of two ceilings —
what the list budget allows, and what fits one audit entry, because §7 records each page as an act and a page
that splits its record stops being one row per act. ([receipt](./docs/receipts/message-page-size.md))

**The page control is two buttons, and the parity work is the larger half.** *Older* is rendered exactly when
the Node says there is at least one more row this reader may see — an absent control rather than a disabled
one — and *newer* is a pop of cursors already used, so nothing asks for a backwards cursor that does not
exist. The heading says `50 shown` rather than `50 messages`, because nothing counted a total and printing the
page size as one was the old wording's quiet lie. What took longer: a fix that taught only the browser to page
would have left `getMessages()` on page one for ever in the SDK, the Skill and MCP, which is #91's own defect
rebuilt in three surfaces. Query parameters are now part of the route registry, so all four learn them at
once.

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

## A machine can act in its own right now, under a named person's authority

An agent holds its own credential: an opaque token, an action ceiling pinned when it is minted, a hard expiry
with no refresh, and revocation that takes effect on the next request. Its acts land in the audit trail under
the agent **and** under the human accountable for it.

Three things bound what one can reach, and two of them already existed:

    effective(agent) = pinned action ceiling ∩ live tuples of the agent ∩ live tuples of the sponsor

The middle term is ordinary relationship tuples, so an agent's resource ceiling *is* its tuples — conferred by
an administrator through the same door as every other relation. The action ceiling is pinned at mint, derived
from the route registry rather than restated, so a route reclassified as `governed` leaves every agent's
reachable set on the same commit. There is deliberately no route that widens one.

### What a route requires is declared beside the route

The tier answers *may a machine do this*. It does not answer *can a machine be given what this needs*, and
treating one question as both was worth 22 tools an agent token could never satisfy. So each route declares
its authority — `public`, `member`, `recovery`, `organization`, `mailbox` with the relations, `filtered` with
what narrows the result, `self-or-admin`, or `export` — and everything downstream is derived from that one
declaration: the capability vocabulary, what the mint refuses, the MCP catalogue, the Skill's withheld list.

`public` and `member` were one value called `none`, documented as "reaches nothing scoped" and applied both to
`GET /health`, which answers a stranger, and to `GET /api/me`, which answers `401` without a principal. Five
routes were declared that way while requiring a session. Nothing leaked — the handler stayed stricter than the
declaration — and it was still a registry saying something false, in the one scope the parity suite did not
drive. A scope with no driver is a claim nobody checks.

A declaration is hand-written, so it is checked against the handler rather than trusted.
`test/route-authority-parity.test.ts` drives every organization-declared route as an administrator and as an
ordinary member, and only `admin succeeds, member does not` confirms one. It found five routes claiming to
need `org.admin` whose handlers require nothing of the sort — `GET /api/teams` says so in its own comment —
and each was withholding machine authority the Node would actually have allowed.

The distinction that took a second function is **reachable** versus **useful**. `GET /api/approvals` admits
any authenticated caller and narrows its list to mailboxes where the caller holds `approval.decide`, which no
mint confers. An agent is let in and shown an empty queue, for ever — worse than a refusal, because nothing
says no and the operator sees an agent that looks broken rather than a catalogue that lied.

Minting checks the **intersection**, which nothing did: both halves of an agent's authority were validated and
their product was not, so `capabilities: ["mail.read"], grants: []` produced a credential that authenticates
and reaches nothing. A capability is satisfied when one mailbox carries *all* of its relations — summing them
across mailboxes satisfies neither — and the same predicate disables the button and refuses the route.

Minting is administrator-only and the sponsor is named rather than assumed, so the person who authorises a
machine identity need not be the person whose authority it borrows. All three agent routes are withheld from
machines: an agent that could mint agents escapes its own ceiling in a single call.

### The sponsor term was written down before it was enforced

The third term was the whole point and it constrained nothing. `principalFor` set the delegator, the trail
recorded it, and no authorization query read it — so an agent kept reading a mailbox after its sponsor's
relation was revoked, after the sponsor left the team that granted it, and where the sponsor had never held it
at all. The sentence *a human cannot delegate more authority than they continue to hold* was false in the
header of the file responsible for it.

It is now one clause in one module, and the two decisions worth knowing:

- **The sponsor is derived from the identifier, not passed along with the request.** A threaded field reaches
  as far as a `Principal` travels, and three of the places that needed it have no `Principal` to travel in —
  `isAdmin` takes a bare id that thirty callers feed, and the send path re-checks the author's authority at
  seal time from a database column. Deriving it from the typed-prefix ULID is the same move that made actor
  attribution structural instead of remembered.
- **Fixing the one check fixed one route.** Mailbox read, send and export all land in the same check, which
  made the fix look complete; the listing, both arms of search, the dispatch sweep, the case queues, the sends
  listing, the notifications feed and the admin check each had their own predicate, and every test passed. A
  tripwire now enumerates every predicate that reads the table and fails until each one is classified as
  intersected — with its source checked for the term, so registering a name is not enough — or exempt with a
  written reason. Three of the clause's own terms were found by deleting them and watching nothing fail.

### The delegator was recorded by four call sites and readable by none

The column shipped inside the hash chain and then sat almost unused: four audited acts in the whole product
populated it, and `GET /api/audit` never selected it. So an agent's act named the machine and not the person,
and the audit screen showed no actor at all — not the identifier, not the kind, not the delegator.

It is now **derived from the actor's typed prefix** at write time and stored, rather than threaded through
every audited operation as the review suggested. That argument was already in the file: deriving the actor's
*kind* from its prefix is what made attribution structural, because a design where each call site passes it
"would be correct on the day it was written and wrong the first time a new effect node called a fifth
function". A delegator is the same kind of fact. An explicitly passed value still wins, since a Butler's
sponsor comes from its pinned ceiling — better information than a lookup, and the answer that must not drift.
A person acting for themselves pays no query for any of it: the derivation returns on a prefix test.

### Choosing what a machine may do, in the product's words

The mint surface took route strings, so setting up an agent meant composing a routing table by hand — and a
hand-assembled ceiling has no completeness: reading mail takes four routes, and granting three produces an
agent that works until it needs the fourth. Named capabilities now cover **every** grantable route, each with a
sentence saying what granting it does and a flag for whether it reaches the **content** of mail rather than
only its metadata.

Capabilities are **expanded at mint and the routes are what get stored**. Storing the name and resolving it per
request would mean adding a route to a capability silently widened every agent already holding it — §16's rule
broken — so the expansion is pinned. The consequence is visible rather than hidden: an agent minted before a
capability grew shows `4 of 5` in the interface, because that is what it holds. A closed-world test requires
every grantable route to belong to exactly one capability, so a new route cannot quietly become
grantable-in-principle and unconferrable in practice.

There is a screen for it now — `/agents` — with no edit control, because there is no route behind one.
Re-minting is how a ceiling changes, and it issues a new token with a new expiry.

**This is not an AI capability.** Whether the thing holding the credential is a language model, a script or a
cron job is outside it. The `llm.*` nodes remain declared and refused, and calling Mailda AI-native today
would still be a claim about intent.

## An act a machine performed now names the human accountable for it

The audit trail had one actor field. A Butler's entry correctly said *"`btl_x` sealed this"* — the kind is
derived from the identifier's prefix, so that half has been structural since Layer 4 — and could not say who
sponsored it. The sponsor was recoverable only by reading the Butler's **current** `sponsor_user_id`, which
can be reassigned, so the trail's answer to *"who was accountable for this act"* changed months after the act,
outside the hash chain that exists to stop exactly that.

Entries now carry a delegator, and it is inside the hashed form — a field the chain did not cover would be one
an operator with database access could rewrite undetected, and "who was accountable" is precisely the answer
somebody would want to change. Adding it to a live chain works because the delegator is appended only when
present, so every hash written before the column existed still recomputes to itself.

This is the first layer of [#109](https://github.com/Straits-AI/mailda/issues/109), and it is worth having on
its own: it fixes a shipped gap for Butlers rather than preparing for something. It also removes the premise
of the decision that withheld an agent credential — `mcp.ts` argued a token would make "every act land in the
audit trail under a machine rather than under the person who set it going", which is correct while there is
one actor field and is not an argument once there are two.

## The interface wears the brand, and three of the brand's own numbers did not survive contact

The Mailda identity — Ink, Flow Blue, Sky, Mist, White; Satoshi and Inter; a continuous-line M with a blue
dot — is applied to the shell. Light is the default theme now, which is the brand's own ground, and dark
follows the system. What is worth knowing is where the brand sheet and an accessible, custody-respecting
product disagreed, because in each case the resolution is written down rather than fudged:

- **Flow Blue cannot carry body text on Mist or Sky.** Measured: 4.53:1 on white — AA by three
  hundredths — then 4.11 and 3.87, which fail. So the accent is two tokens split by use: the brand hex for
  fills, borders, focus rings and the mark's dot, and a five-percent-darker same-hue blue for anything a
  person reads. ([receipt](./docs/receipts/contrast-tokens.md))
- **Satoshi is named in the type stack and never shipped.** Its licence allows self-hosting and forbids
  modifying and redistributing — and this repository *is* how customers get updates, so committing it would
  redistribute it to every one of them from a public URL. A designer with it installed sees the brand
  exactly; everybody else gets Plus Jakarta Sans, served from this Node.
  ([provenance](./apps/node/worker/fonts/README.md))
- **The brand supplies no warning, error or healthy colour**, and a mail product needs all three. Those are
  kept from the previous palette, verified against the new grounds, and labelled as an extension of the brand
  rather than part of it.

The interface now loads four webfonts where it previously loaded none, and the rule that forbade them is
intact: it was never about webfonts, it was about third parties. All four are same-origin under a
`font-src 'self'` policy that a test asserts is exactly that — adding a CDN host fails it.

**The logo mark in this repository is a reconstruction traced from raster artwork**, and `src/brand.ts` says
so in its first paragraph. It is fine at interface sizes and should not be used for print or an app icon
until the real vector replaces it, which is a one-line change.

## What's distinctive about how it's built

**Every number has a receipt.** No limit, timeout, threshold or budget enters the codebase
without a measurement behind it. The constants are *generated from* the receipt files, so
you cannot write the number — only the measurement. See
[`docs/receipts/`](./docs/receipts/) and the rule in [`AGENTS.md`](./AGENTS.md).

That has already earned its place. Measuring the authorization path found a **full table
scan on every request** — 1,864 rows read where 7 were needed, growing linearly with
organisation size. It would have shipped invisibly.
([receipt](./docs/receipts/authz-check-rows-read.md))

**And a measurement in a test is not a measurement in production.** The Butler engine's fixed
cost had been measured at three subrequests under miniflare and asserted by two tests. The first
run executed against real Cloudflare Workflows confirmed the three — and showed that the run
record said **zero**. The statement that writes that column was batched with an effect and issued
nowhere else, so every effect-free run had been closing with its `INSERT` default in a column an
operator reads as a measurement. Deploying proves a binding provisions; only running proves a run.
([receipt](./docs/receipts/butler-run-cost.md))

**A shipped sentence saying a gap is covered is worse than the gap.** Ten documents and two
source files described `mailda deploy` and `mailda doctor` as the mechanism for install and
plan enforcement. There was no CLI — no `bin` entry anywhere. And `doctor` shipped a finding
reading `workers_paid_plan: ok` whose detail said *"`mailda deploy` verifies the plan at
install and refuses on Workers Free"*, so a Node on the plan the design forbids read *ok* and
was told the check had happened elsewhere. A test required those words to be in the detail,
so the suite held the claim in place. The CLI exists now; the plan still cannot be checked by
anything, and the finding says so.

**The deploy order was wrong, and the reason given for it was false.** `mailda deploy` deployed the
Worker and *then* applied migrations, so new code served requests against a schema that did not yet
have what it needed — and if the migration failed, the incompatible Worker stayed deployed while the
health check was optional. The stated reason was that *"the Worker bundles them"*. It does not:
`wrangler d1 migrations apply` reads the `.sql` files from `migrations/` and needs no deployed Worker
at all. But reversing the two is *also* unsafe, because a migration that drops, renames or narrows
breaks the code currently serving — no order makes both safe. What does is splitting migrations by
phase, and the convention for that existed as prose in **five of thirty-nine files** and was **wrong
on both of the five that contracted**: two migrations call themselves "Additive (#10 expand/contract)"
above a `RENAME COLUMN`, which breaks code reading the old name. The phase is derived from the
statements now, and `mailda deploy` uploads a canary, checks it, and only then moves traffic — so a
failed check needs no rollback, because traffic never moved.
([#98](https://github.com/Straits-AI/mailda/issues/98))

**Clearing a gate is not the same as sending.** An approved message still sat in the outbox.
The sweeper that dispatches mail is armed by *sealing*, and three separate acts move a message
from gated to sendable — an approval completing, a Butler's send being released, a retry — none of
which armed anything. Arming from those three would have been a list, and the fourth act to clear a
gate would not have been on it. The backstop is one sweep on the cron that already runs every
minute, which covers the acts that exist and the ones that do not yet.

**You could not reply twice to the same conversation.** Reply claims the case in the same act,
and the claim's compare-and-swap was `WHERE assignee IS NULL` — so re-claiming a case you already
held changed no rows, fell through to the lost-the-race branch, and answered *held by you*. The
button refused with "Held by you since …" and offered to take it and tell them: stealing your own
case, notifying yourself. Every test claimed a case nobody held, so none of them saw it. It was
found by an accessibility harness that could not get the composer open — and the same confusion
turned out to be sitting in a Butler test whose name said "refuses one somebody else holds" while
its fixture had the holder and the assignee be the same person.

**A layer can be complete and unreachable.** Trying to publish one Butler through the product
found there was no way to: the interpreter, the checker, the run ledger, the pause machinery and
replay were all built and tested, and `createButlerDraft`, `editButlerDraft` and `publishButler`
had no HTTP route at all. `grep -ric butler src/client/app/` returned **0** — the whole layer was
invisible in the interface, including an `inspectRun` that redacts run facts by content
classification for a screen that did not exist. The same shape in miniature: the composer had
rendered "New message" in two places since it was written and no caller ever omitted the
`inReplyToMessageId`, so every outbound path in a mail product ran through somebody else having
written first. Tests pass on unreachable code. Now tracked as #77, #78 and #79, and built.

**The second thing that test found was worse: the mail did not leave.** Driving one real message
from one mailbox to another — seal, hand over, receive, trigger a Butler — surfaced a sealed send
sitting `held` with `attempts = 0` long after its hold window closed. `OutboxSweeper`'s alarm
re-armed on the *inbound* outbox only, while its own comment claimed "a Node that was asleep when
it expired still sends". Nothing woke it. What actually moved the send was an unrelated poke: the
sweeper is armed when mail arrives and when a page is served, so on an idle Node your mail left
when somebody happened to open the app. The alarm now sleeps until the earliest `release_at` and
sealing arms it — and the predicate for "a send worth waking for" is the dispatcher's own, not a
second copy in the scheduler.

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

**Nothing checks itself by default.** `mailda doctor --url <origin>` verifies the runtime claims every other
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
deleted. A mail system cannot run there. **Nothing enforces this**: a Worker cannot read
its own account's plan and Cloudflare exposes no documented API for it, so `doctor` reports
the requirement as unverified and names where to look. This paragraph used to say
`mailda deploy` detected the plan and refused; there was no CLI at all, which is the whole
of #80. ([ADR 25](./Mailda-Full-Engineering-Blueprint.md))

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
  own account — so it can receive a customer's message and be unable to answer it. **Nothing checks
  this either.** Onboarding is a dashboard flow with no endpoint listing its result, and the only
  honest probe would be sending a real message to a stranger to see whether it was refused. The
  outbox says the capability was never verified, and `mailda`'s own help says the same.
- **Nobody is emailed an invitation.** An administrator mints a secret and hands it over however they
  already trust; the person redeems it and chooses their own password, which the administrator never
  sees. The Node can send, which is what makes emailing it tempting — and it would mean posting a
  credential to an address nobody has verified, from a mailbox whose sending capability is itself
  unverified.
- **Search covers subjects, senders and message bodies. Attachments are not indexed.** Body search requires
  `mailbox.content.read`; the weaker `mailbox.metadata.read` reaches subjects and senders only, because
  answering *"the word X occurs in message Y"* discloses the message itself one word at a time. That applies
  to **supervised grants too** — a grant of scope `metadata` reaches subjects and not text. It did not at
  first: one grant subquery authorized both index arms, and a metadata grant could ask whether any word
  occurred in any message. Found by an external audit, not by the suite, because every test used standing
  relations and nothing exercised the second authorization mechanism against the second index. Attachment
  contents are not indexed and are not planned to be — there is no document parser on the ingest path, and
  adding one would be a new attack surface for a search feature.
- **A search whose words are split between a subject and a body finds nothing.** Every word of a query has to
  appear in the same index, and the subject index and the body index are separate — which is what keeps the
  authorization boundary above enforceable. Searching `hapag cabotage` fails even when `hapag` is in a
  message's subject and `cabotage` is in its text; each word alone finds it. This is the price of the
  boundary, and it is stated rather than left to be discovered.
- **The body index makes a D1 dump slightly more revealing, and ADR 28 was amended to say so.** It is
  *contentless* — the inverted index without any copy of the documents — so a dump lets somebody confirm that
  a given word appears in a given message, and not read the message. Bodies stay in R2, encrypted. There are
  no body excerpts in search results for the same reason: showing the matching line means fetching and
  decrypting the message, which is an authorized read rather than a free one.
- **A search returns one page of the best matches, and there is no way to reach the fifty-first.** Narrowing
  the words is the only route. Relevance ordering is bm25, which depends on how often a term appears across
  the whole corpus — so it shifts every time mail arrives, and a cursor into a ranked list would skip and
  repeat rows without saying so. The cost measurement landed on the same answer independently: ordering by
  time while filtering by a term costs O(corpus) rather than O(matches), and a rare search read 3,640 rows
  against a 1,000-row budget before the plan was driven from the index instead.
  ([receipt](./docs/receipts/message-search-cost.md))
- **Mail that arrived before the indexes existed is searchable only once the backfill reaches it.** Two
  backfills with very different speeds: subjects and senders go 500 a minute because it is one statement
  inside D1, and bodies go **25** a minute because each one is an R2 read, a key unwrap, a decryption and a
  MIME parse. `doctor` reports `search_index_backlog` and `body_index_backlog` separately for that reason — a
  single figure would look alarming while nothing was wrong. Unindexed mail stays reachable by paging.
- **A message whose body cannot be *parsed* is never searchable by its contents; one whose evidence could not
  be *read* is retried.** Those were the same thing until the state machine landed, which meant a momentary
  R2 error made a message permanently unsearchable with no record of why. A read failure now backs off from
  one minute to sixteen, gives up after six attempts, and keeps the reason. `doctor`'s `body_index_failed`
  reports what it gave up on and `mailda search list` shows why each one failed; `mailda search repair` puts
  chosen messages back in the queue. Repair is per message rather than a sweep, because some failures are
  deterministic and retrying those spends the backfill's budget on work that cannot succeed.
- **The pass claims what it works on, and settles under compare-and-swap.** The pass runs every minute and
  costs an R2 read plus a decryption plus a MIME parse per message, so it can take longer than a minute — and
  the next tick used to select the same rows, because the state stayed `pending` until the first pass committed
  at the very end. The wasted work was not the defect: attempts were counted as `read value + 1`, so two
  overlapping passes both wrote `attempts = 1`, the counter stopped advancing, and the six-attempt bound that
  exists so a pass cannot spend its budget on one failure for ever never tripped. Selection is now one
  `UPDATE … RETURNING` that picks the batch and leases it in the same statement, and each settlement is
  conditional on the claim version it was given — so a slow pass whose lease lapsed cannot overwrite the newer
  answer with its stale one. The version parameter is *required* rather than optional, because making it
  optional left the one call site free to drop it and every test still passed.
- **Repairing a message takes it out of the index first.** Leaving the row was argued safe on the grounds that
  the next pass overwrites it — true only when that pass finds text. A re-parse settling `empty` writes nothing,
  so the old terms went on answering for a message whose state column said it had never been indexed. The
  index and the state column now agree, and repair clears any live claim so the message does not wait out the
  lease of the pass that failed it.
- **A page bounded to a quiet mailbox is bounded by the archive.** Filtering to one mailbox walks receipts in
  time order until it has found enough belonging to it — measured at 2,410 rows read to return 3 messages from
  a mailbox holding the oldest 3 of 1,200. This is not something the filter introduced: the authorization
  predicate has the same shape, so a reader who may see one mailbox in ten has always paid it. Fixing it means
  driving the listing from a per-mailbox ordering rather than from the evidence table, which is a change to
  what the inbox reads. ([receipt](./docs/receipts/message-page-size.md))
- **Recovery codes minted before 28 August 2026 carry 80 bits, not 128, and cannot be upgraded.** The
  encoder rendered one base32 character per random byte, so sixteen bytes became sixteen characters. New sets
  are 26 characters and correct; a hash is one-way, so existing sets can only be *replaced*. `doctor` reports
  them degraded and `mailda recovery-codes rotate` is the replacement path.
- **A recovery code set nobody has confirmed is reported degraded.** Minting returns the plaintext once, so a
  lost response leaves this Node looking exactly as it would if the codes had been written down — ten rows,
  good hashes, current escrow — and health over an organization that cannot recover is the failure the whole
  escrow exists to prevent. `mailda recovery-codes confirm` compares one code without spending it, and it is
  typed at a prompt rather than passed as a flag — a confirmation a script can make from a file proves nothing
  about a person holding the sheet, which is the only thing it asserts (#136). A freshly claimed Node is
  therefore degraded until an operator confirms, which is intended rather than noise.
- **A person cannot be removed.** Deleting an account with audit entries, cases and sealed manifests
  attributed to it is a different question with its own answer, and guessing it would be worse than
  leaving it. Revoking every relation is the available act, and it takes effect on the next request.
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
docs/teams.md                          the team as an object, membership as authority, what is audited,
                                       why there is no delete, and what a team-scoped stage costs
docs/supervised-access.md              matters, the time-boxed grant, per-act recording, the notice
docs/ediscovery-export.md              the two export permissions, the bound, the manifest, the boundary
docs/send-breakers.md                  the three windowed rates, the domain pause, sized versus measured
docs/butler-ast.md                     the node set, what the checker refuses, how a version freezes
docs/butler-capability-ceiling.md      the pinned ceiling, who the sponsor is, the three-term
                                       intersection in two queries, and what it does not reach
docs/butler-engine.md                  what runs a Butler: the principal, the release gate, the budget,
                                       the pause and the loop that places it, the run ledger and the
                                       four replay modes
docs/evidence-lifecycle.md             keys, re-sealing, reconciliation, the pipeline
docs/agents/                           issue tracker and domain-doc conventions
packages/receipts                      generates constants from receipts
packages/budgets                       GENERATED — do not edit
packages/runtime                       the clock, id and randomness seam
packages/contract                      the route registry, its schemas, and command schemas
packages/sdk                           GENERATED from the registry — one method per route
skills/mailda                          GENERATED — the Agent Skill, from the curated list
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

## Passkeys are the way in now, and passwords are the fallback they were meant to be (#84)

ADR 29 locks *"passkeys are the authentication Mailda builds; password authentication survives as a per-user
fallback"* and it shipped **inverted**: passwords were the only authentication, and every reference to
passkeys was prose. #83 made that worse rather than better — a Node that can add people turns one operator's
own password into every colleague's, on a system holding an organization's mail.

The sign-in screen now offers a passkey first and the password beneath it, because an interface that puts
the fallback at the top teaches the opposite of what the decision says.

**The relying-party id is derived from the request, never configured.** A stored one can disagree with the
origin the browser is actually on, and when it does every ceremony fails with a mismatch nobody can act on —
so deriving it makes the disagreement unrepresentable, and keeps the repository free of the customer-specific
value ADR 24 forbids.

**Verification is `@simplewebauthn/server` at +128.9 KiB gzip**, two thirds of which is X.509 machinery for
attestation this Node deliberately does not request. Adopted anyway, by the test this repository set when it
*deferred* a parser: attacker-chosen structure feeding an authentication decision is where a mature
implementation earns its bytes. The tempting counter — that the cryptography is Web Crypto either way — is
true and beside the point, because the five checks around it are where implementations go wrong and omitting
one is an auth bypass rather than a bug.

Tested against a **real software authenticator** rather than a recorded fixture, because the negatives are
the whole property: a fixture proves one response verifies and can never answer *does a replay fail*. That
choice paid immediately — a mutation caught one of these tests being vacuous, asking to revoke a credential
id that did not exist, so the line binding a passkey to its owner could be deleted with everything still
green.

It also put the **pre-authentication surface into the accessibility gate for the first time**, and found a
WCAG 2.2 AA failure that had been shipping since #83. That gap was the sharp one: the harness signs in
first, so the one page an operator meets when the Node is broken was the one page nothing checked.
See [`docs/authentication.md`](./docs/authentication.md).

## Both send APIs exist now, and they are not interchangeable (#86)

ADR 33 locks *"the transport offers **both** send APIs, and every send records which one carried it."* The
recording half was built and correct, with one possible value.

The second adapter goes over `POST /accounts/{id}/email/sending/send`, and checking Cloudflare's docs before
building it decided its shape: **that API takes structured JSON and no raw MIME**, so it cannot carry
`authored` fidelity and refuses it rather than rebuilding the message. The binding stays preferred wherever
it exists — it holds no credential to leak or rotate, and it is the only adapter that can submit the exact
recorded bytes. What the REST path is for is the Node that has **no** binding, where the previous answer was
"cannot send, permanently".

Two of the ticket's own arguments for it did not survive this tree: batching recipients would collapse
per-delivery outcomes that migration 0013 exists to keep, and a prior measurement had already found that
submitting N times costs nothing extra. So it does not batch, and the honest remainder is smaller and real —
a bindingless Node can speak, and a permanent bounce known at submission becomes `suppressed` rather than an
optimistic hand-over.

**It is also the first credential this Node has ever held**, and therefore the first real test of ADR 22's
"every credential is a Secrets Store binding" — which does not survive ADR 24, for the reason already
recorded in `wrangler.jsonc`: a `store_id` is account-specific and its removal drops the binding silently.
The token is wrapped under the credential KEK instead, whose own header already named *transport credentials*
as what it protects. No route returns it, and it is never a property of `env` — which is the property ADR 22
was actually buying. See [`docs/send-transport.md`](./docs/send-transport.md).

## The routes are described once, and the description is checked (#85)

ADR 12 locks *"UI, CLI, SDK, Skill and MCP parity is **generated from shared contracts**"*. Two of the five
surfaces existed, neither was generated from anything, and `packages/contract` held one command's schemas
against seventy-one served paths — through a `"main"` pointing at a file that did not exist, imported by
nothing. A package with no importers has no way to be wrong.

`packages/contract/src/routes.ts` now describes every route, and three checks hold the chain: the client's
template is typed per method, so naming a route this Node does not serve is a **compile error**; and a
tripwire compares the registry with the handler in both directions, on paths and on verbs.

**Writing it found a live defect.** The interface sent `PUT /api/policies/:id/draft` and the handler answered
only `POST`, so **editing a policy draft returned 404 `not_found`** — on a governance surface, since the route
shipped. Nothing caught it because the route tests built every request with a helper that hard-coded
`method: "POST"`: a helper that fixes the method cannot detect a method divergence, and fourteen green tests
sat over it. Confirmed against a running Node before and after, rather than inferred.

Step 2 adds the schemas: **every describable route is described, 90 of 90**, and the test asserts equality
rather than a floor — so a route added without a schema fails. Partial on purpose — ninety-four hand-written shapes that nothing checks against
a real response would be ninety-four guesses a generated client trusts, so each arrives with a test that
drives its route and parses the answer. Two of them do security work rather than tidiness: `.strict()` is
what makes a route that grew an `apiToken` or a `publicKey` field fail instead of leak.

It found that **`usr` was not in the id registry** — minted as a literal since the first layer, because
nothing had ever needed to validate a user id — and registering it made the id-prefix tripwire fire on both
mint sites, which now go through the registry.

Reaching all of them took fixtures the product's own rules dictated: a second and third administrator for
dual control, a lowercase address for the Butler ceiling, and a stub transport that **refuses** — because a
retry is offered only where non-acceptance is recorded.

**Step 3 ships the SDK, generated.** `packages/sdk` emits one method per route from the registry, `pnpm
sdk:check` fails on any diff, and responses are validated against the contract by default — so a Node that
has drifted is caught in the caller's process with the offending field named, as a `ContractViolation`
rather than a refusal. Building it found its own defect: a top-level `writeFileSync` in the generator made
the drift test vacuous, because importing the generator regenerated the file before the test could read a
hand edit.

**Step 2½ applies the request schemas instead of only publishing them (#93).** Through steps 2 and 3 nothing
on the Node ever checked a body against one — the only reader of `spec.request` was the MCP server, turning it
into a tool's input schema and forwarding the body unexamined. So a route with a schema read exactly like a
route that was validated, and one of them was publishing rules nobody had written: `POST /api/policies`
with `{"conditions":{"mailbox_id":…}}` dropped the misspelled key, stored five NULLs, and made a policy
version **matching every send in the organization** — reported to the caller as created, because it was. A
`deny` written that way stops all outbound mail.

The boundary is one function, applied centrally before the route and before authentication, and it refuses
**unknown fields only** — bad values still reach the handlers, whose refusals name the four outcomes or
explain why a volume floor of 0 is an unconditional rule in disguise. Strictness is a per-route decision with
the argument written beside the schema, not a global flag: two routes refuse an unrecognised field today, six
tolerate one, and a tripwire asserts both sets exactly. The refusal names the offending key, the fields that
do exist, and the near miss — `did you mean mailboxId?` — using normalised spelling rather than an edit
distance, because a distance cutoff is a number with no receipt.

See [`docs/api-contract.md`](./docs/api-contract.md).

## Two machine surfaces, over one curated list (#88, #89)

ADR 12's last two surfaces. Both needed the same answer to the same question — *what should a machine be able
to do here?* — so it is answered once in `packages/contract/src/agent.ts` and both read it.

**53 of 94 routes are offered.** Everything that answers a question, and everything a person can undo.
Withheld: 25 that need more than one person or cannot be undone, 17 that are acts of running the Node rather
than using it, and one that is the surface itself.

**`governed` is not about permission.** §18 counts distinct **people**, and an agent inside somebody's
session is that person — so the Node already refuses. What the tier prevents is *offering* the act. A Skill
listing "approve a send" teaches an agent to try, and it will keep trying: the refusal says *ask somebody who
holds approval.decide*, and it has no way to know it can never be that somebody. An offer a caller can never
complete is worse than no offer.

So the Skill **names what it withholds**, with reasons. An absence reads as a gap somebody forgot; a stated
exclusion reads as a decision.

The MCP server is `POST /mcp` **on this Worker**, which was #89's actual question. A second Worker breaks ADR
18; a separately-run bridge would be the first component holding credentials for a Node it is not part of,
which is the shape ADR 7's custody premise rules out. A tool call re-enters this Node's own router in
process — same guards, same audit entry, same refusals — authenticated by the caller's own session, so the
trail names the person who set it going rather than a machine.
See [`docs/machine-surfaces.md`](./docs/machine-surfaces.md).

## The document is defended now, and not only the message inside it (#97)

The Node sent **no security headers at all**: no CSP, no `frame-ancestors`, no `nosniff`, no HSTS, no
`Referrer-Policy`. The reason that went unnoticed is worth more than the fix. The message reader's sandboxed
iframe is a real, well-reasoned defence and is documented as one — so it read as *the* browser-security
story, when it only protects the document from the mail. Every governance control here is a button — approve,
release, lift, grant — and an application any origin may frame turns a button into a signature.

One policy, set in `withSecurityHeaders` and applied in `fetch`, which every response already passed
through: `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `frame-ancestors 'none'`,
`base-uri 'none'`, `nosniff`, `no-referrer` and HSTS. Two of those need saying out loud.

**`script-src 'self'` cost the shell its inline code, which is the whole point.** `MAILDA_CONFIG` shipped as
an inline `<script>` and the stylesheet as an inline `<style>`; keeping either needs `'unsafe-inline'`, which
permits exactly what the directive exists to stop, or a per-response nonce that the header and the document
must agree on forever. So the config is a same-origin ES module at `/app/config.js` — a module rather than
a JSON endpoint because `session.client.js` reads it at module evaluation, and an async bootstrap in the file
whose job is that nobody sees a 401 is a worse trade than an import. The stylesheet is `/app/app.css`.

That module is now the browser's **one** channel for a receipt-derived number, including the composer's hold
window, which also retired a `?? 15` fallback standing in for a receipt. The obvious alternative — the
composer is bundled here, so let it `import { BUDGETS }` — was built, measured and withdrawn: it put the
whole 218-entry table in the shell bundle for one integer (+7,960 bytes raw, +2,783 gzip) and gave the
interface a second source for figures that must agree with the Node.

It also broke #90's draft-flush test at the time, by slowing that screen's module graph enough to cross the
1,499 ms boundary the test sits on — and that half of the argument has since **expired**, which is worth
recording rather than deleting. The test was on `vi.useFakeTimers({ shouldAdvanceTime: true })`, where
wall-clock time advances the fake clock, so it really was sensitive to how long a module graph takes to
load. That was a flaky test rather than a cost of the import, and it is now fixed at the root: the clock
moves only when a test moves it. So the bundle size is the whole reason this alternative stays withdrawn.

**`frame-src 'self'`, not `'none'` — though not for the reason the ticket gave.** The reader renders sanitised
mail into a `sandbox=""` `srcdoc` frame, and the expectation was that `'none'` would break it. Driven through
a real Chromium, it does not: that frame renders under `'self'`, under `'none'`, and under no `frame-src` at
all, because a `srcdoc` navigation inherits its parent's policy instead of being matched against a source
list. `'self'` stays anyway, and the comment says why — only one engine was measured, and `'self'` is the true
description of what this application frames, where `'none'` would be a claim that it frames nothing. What
*does* matter is that the frame **inherits** this policy, which is safe rather than lucky: the sanitiser
already strips `<style>`, every `style` attribute and `src` on images, so the mail HTML asks for nothing
`default-src 'none'` refuses — asserted against the sanitiser's real output, not a fixture.

**HSTS is one year and says nothing about subdomains.** `docs/receipts/hsts-max-age.md` records why: the
preload list's minimum is the only externally stated figure in the mechanism, and `includeSubDomains` from a
Node at an apex domain would assert HTTPS for hosts Mailda never saw, for a year, on a customer's behalf.
A domain-wide claim belongs to the domain's owner, who has a zone setting for it.

The accessibility harness broke on the CSP, which was the useful signal: it injected axe-core as an inline
`<script>`. It now injects through the debugger instead — and deliberately not with `bypassCSP`, which would
have disabled enforcement for the application too and hidden the one regression the harness is now placed to
notice.

## A comment that cites a file which isn't there, and the three checks not worth building (#103)

Nine authorization gaps in one audit turned out to be one test-oracle defect. The follow-up question was
narrower and more uncomfortable: the *comments* were wrong too, repeatedly, including comments written while
fixing wrong comments. One cited a test file that has never existed:

```text
test/composer.test.ts   — the real file is test/drafts.test.ts
```

That reads exactly like a citation of a real file, and nothing in the toolchain resolves a path inside a
comment, so it is wrong at the moment it is written and stays wrong. #103 asked whether that has a mechanical
countermeasure and said the honest answer might be no, but that it should be **concluded, not assumed**.

One of four candidates paid, and it widens a check that was already here. `test/node/receipt-references.test.ts`
resolves citations shaped `docs/receipts/<id>.md` in the worker's `src`, `test` and `scripts`; the question was
whether the idea holds for *every* path in *every* prose region. It does.
`test/node/prose-references-world.test.ts` extracts all 2,931 of them and fails on any that does not resolve.
It found four stale references nobody had caught — all outside the older check's scope, three of them outside
the worker's source tree — including a receipt whose **Measured:** line named a path that its own line 140
contradicted, and two client type declarations pointing at an `externals-note` document that exists nowhere.

The scan deliberately stops where the toolchain starts. Sweeping code as well raised the candidate set to
3,851 and the unresolvable set from 33 to 86 — and all 53 extra were false: template holes, property reads,
package specifiers. A check whose new findings are all false is a check that gets muted.

Two holes turned up in the checker itself, both found by measuring rather than reasoning. The suffix match
was built as `"/" + path` without stripping a leading `./`, so it reported a live file as missing; and the
token pattern allowed only one leading `../`, which skipped every deep relative reference in the repository
without mis-resolving one — the scan simply reported clean. That is the defect the check exists to catch,
twice, inside the check.

**What it cannot catch is the sharper half.** A wrong claim *about a real file* resolves fine. While fixing
the two declarations above, the first attempt **deleted** a correct reference after an `ls` of the wrong
directory — a false claim introduced by the act of removing one, and structurally invisible here, because a
reference that is gone is never unresolvable. Existence mechanises. Accuracy does not.

So the rule the check depends on is now written down: an inline `` `path` `` is a citation and must resolve; a
fenced block holds a literal and is skipped. Without that line, every document explaining a broken reference
would need exempting from the rule it explains.

Three detectors were rejected, each with the measurement that rejected it, in
[`false-claim-detectability`](./docs/receipts/false-claim-detectability.md). Counts in prose — 261 of them,
and the class most of the session's own errors fell into — because verifying a count needs to know *which
set* it counts and the prose never says. Release gates in prose — 14 matches, zero genuine orphans, and
"ship" turns out to be polysemous. And prose citing a test by name, which is perfectly checkable and appears
**once**: a tripwire over a single instance cannot fail for the reason it was built, which §2b forbids. An
earlier, broader phrase list looked far more productive at 36 apparent orphans, until reading them showed it
was flagging `unmeasured` — which in this repository is overwhelmingly a deliberate honest-limit statement,
the receipt discipline working. It would have punished the practice it was meant to protect.

## The canary's 404 was never a setting, and the gate had to change shape (#98)

`mailda deploy` uploads a canary version and checks it before moving traffic. For three deploys the check
could not run — the canary's hostname 404'd — and two rounds of the live drill recorded the cause as *"not
established: could be an account-level preview setting, a per-Worker dashboard toggle, or something about a
Worker whose first version predates the alias"*, each time noting that settling it needed the dashboard.

It never needed the dashboard. One read of the account's API:

```text
GET /accounts/{account}/workers/scripts/mailda/subdomain
  → {"enabled": true, "previews_enabled": true}
```

Preview URLs were already on, the alias was recorded on every version, and no hostname routed. The cause is a
documented platform limitation: **Cloudflare does not generate preview URLs for Workers that implement a
Durable Object.** Mailda has two, and cannot drop them — ADR 28 moved both root keys into `KeyVault` precisely
so a managed secret store could not re-provision them. `preview_urls: true` was a declaration with no effect,
standing exactly where a reader would look for the reason.

The transferable part is not about preview URLs. **The suspected cause was checkable without the dashboard,
and two drills did not check it** — the ticket asked a person to go look at a toggle that a `GET` could have
read.

So the gate changed shape. The canary is now placed in the current deployment at **0%** and reached through
`Cloudflare-Workers-Version-Overrides` on the production hostname. That works with Durable Objects, and it
brings one trap with it, which is the interesting half: Cloudflare does not error when an override cannot be
applied — it routes by traffic percentage, to the version already serving. A gate asking *"is the Node
healthy?"* would get `ok` from the **incumbent** and promote a canary nothing had examined.

That is an assertion that cannot fail, so the gate is an *identity* check rather than a health check: the
Worker gained a `version_metadata` binding, `/api/doctor` reports which version answered, and the deploy
refuses unless that id is the one it uploaded. A report naming no version is a refusal too — a Node too old
to carry the field is one this gate cannot check, and "cannot check" is not "passed".

Building it turned up a fourth lexical assertion in this repository that proved nothing. The test requiring
identity to be settled before the verdict matched `shouldPromote(verdict)` exactly, so a mutation inserting
`shouldPromote(report.verdict ?? "refuse")` **above** the identity check passed — a different string, the
original still found later, green against a sequence that decides on the verdict first. It matches the call
now, not one of its call sites.

The hand-written `deploy-parse.d.mts` also drifted while this landed: it kept exporting the preview-URL
parser after the function was gone. Its own header had said the drift was *"bounded"* and that *"nothing
checks the pair"*. Something does now — a set comparison in both directions, which is what that admission was
always worth.

Still not verified end to end: the sequence needs a deploy against a live Node, and the two drills that
produced the measurement above are the reason it is written this way. Every refusal in it leaves the incumbent
serving 100%.

## A customer can now check what they merged, and cannot yet check who wrote it (#102)

#102's argument is that the update model — merge this repository into the software holding your organization's
mail — has to be verifiable. Three of its six parts were already done: the Apache-2.0 licence, `SECURITY.md`
with private disclosure, and a protected `main` with the CI verdict required and no bypass actors.

Two more are now done. Every push to `main` publishes a **CycloneDX SBOM** and a Sigstore-backed
**provenance attestation** over it, after the suite passes:

```sh
gh run download --repo Straits-AI/mailda --name mailda-sbom
gh attestation verify mailda-sbom.cdx.json --repo Straits-AI/mailda
```

It is keyless — GitHub's OIDC identity rather than a maintainer's key — which is why it could ship now while
commit signing cannot.

The generator reads `pnpm-lock.yaml`, not `node_modules`, and both reasons are the point. `pnpm list` needs a
completed install, so the inventory would describe the runner rather than the commit; and it reports resolved
URLs but **no integrity hashes**, which is the one field that makes an entry checkable rather than a name
somebody typed. 386 entries, every one carrying the hash the install would have verified.

It parses YAML with regular expressions, whose failure mode is silent under-reporting — and an SBOM missing a
dependency is worse than no SBOM, because it answers *"is this dependency here?"* with a confident no. So an
entry the parser cannot read **fails the build**, and the count is checked against a second, independent scan
of the same section rather than against the generator's own parser. The document is byte-identical across runs
of the same commit, because "reproducible" was the word #102 used.

**The sixth part was considered and rejected, which is the more useful half to record.** Maintainer commit
signing is not adopted. Merge commits into `main` are already signed by GitHub's web-flow key, so every change
that lands carries a signature over the merge that put it there; authored commits report `N`.

The argument against went: a signature is worth what its verification is worth, and **nothing in this
product's update path verifies one.** `git pull` does not check signatures unless an operator configures an
allowed-signers file and passes `--verify-signatures`, which nobody does. Requiring them would constrain every
commit in order to produce a property no consumer reads — a condition backed by nothing, which is the defect
this repository spends most of its effort removing.

What answers the question that matters — *did this come from there* — is the attestation above: one command,
tied to a workflow run over a commit that passed `check`. What it does not answer is *who wrote* that commit,
and the control there is repository access: protected `main`, no bypass actors, a required green check, a
reviewed pull request per change.

It changes if the update path ever verifies. Shipping `git pull --verify-signatures` into an update command,
or a preflight that checks the upstream commit against a known key, would make signing load-bearing — and
signing should follow that rather than precede it.

Two lexical assertions were caught proving nothing while this landed, both by mutation. The test requiring the
attestation to run only on a push searched backwards from the step for the nearest `if:` — with the job's own
condition deleted, it ran on into the **`check` job** and found `if: always() && github.event_name == 'push'`
there. Green, against a workflow that attests every pull request. It reads one job's block now. And
`deploy-parse.d.mts` — whose own header said the drift it allowed was *"bounded"* and that *"nothing checks the
pair"* — had kept exporting a function that no longer existed. Both hand-written declarations are now compared
against their modules as sets, in both directions, in `test/node/declaration-drift.test.ts`.

## Nothing checked that the evidence was still there (#92)

`doctor` sends one HEAD at the R2 bucket. That answers *is R2 reachable*, and nothing at all about whether
what is in it is what arrived. So the question a mail system exists to answer — *is the message still there,
and is it the one we received* — had no mechanism behind it, and the first person to find out otherwise would
have been somebody opening a message years later.

#92 asks for a restore into a clean Cloudflare account, and says of the step that proves sampled messages
decrypt and hash-verify: *"Step 5 is the one that makes the rest true. An export nobody has restored is a
claim, and this ticket exists because of a claim."* That step needs a verifier. There wasn't one — for a
backup **or** for the running Node.

`POST /api/evidence/verify` opens each object in a bounded batch and compares the plaintext hash against the
one recorded when it was sealed. `mailda verify-evidence --url <origin>` pages until the Node says there is no
more, and prints the total it actually covered — the route cannot sweep everything in one invocation, and a
single call that looked complete is the failure this feature exists to prevent.

**It swept inbound mail only, and said nothing was wrong (#131).** The inventory next door walked all four
prefixes the Worker writes; the verifier read `ingress_receipts`. So a Node whose evidence is drafts or staged
sends — every Node before its domain is bound, and any Node that composes more than it receives — verified
nothing and reported a clean sweep. Measured on the first real backup: three sealed drafts, `3 object(s)
listed`, `0 checked, 0 fault(s)`. Every number honest and the conclusion drawn from them false.

Neither list was wrong on its own. They had stopped agreeing, and nothing could tell — which is #67 and #74 a
third time, arriving as a difference in *coverage* rather than a gap in one list. So the verifier now groups
`INVENTORY_REFERENTS` by table instead of naming any, and a test asserts it names **no** evidence table in its
own code: a mutation swapping the derivation for a literal of the same four names passed a test that compared
values, because the literal is right today. The property is that a fifth prefix arrives without anybody
remembering.

Two consequences worth stating. The batch bound now counts **objects, not rows** — one `send_manifests` row
stages three, so a row bound meant three different per-invocation costs depending on which table was reached
([re-measured](./docs/receipts/evidence-integrity-cost.md), and the old receipt's `stale_when` named this
change as the thing that would invalidate it). And a fault reports its **table**: a bare id was unambiguous
when one table was swept, and sends somebody looking in the wrong place now.

**The recorded hash is of the plaintext, not the stored bytes**, and that decision — made at ingress, long
before this — is what makes the check survive ADR 28's key rotation. `reseal.ts` rewrites every object under a
new generation; a ciphertext hash would mark every message in the Node as altered after correct maintenance,
and a verifier that fails after correct maintenance is one that gets switched off.

Three faults, kept separate because an operator does something different with each: **missing** (the object is
gone, the row saying it existed is not), **unreadable** (it names a key generation this vault cannot produce —
the ADR 28 loss the recovery codes exist for), and **altered** (the bytes changed after ingress, which does not
happen by accident).

### Two of my own tests were theatre, and the mutations said so

Both are the oracle defect this repository keeps finding: an assertion a broken implementation also satisfies.

The missing-object test broke one object out of two and asserted one fault. A verifier that **stops at the
first fault** satisfies that too — and `checked` came from the page size rather than the loop, so the count
did not move either. Mutating the loop to `break` left it green. It takes two broken objects with an intact one
between them to tell "found a fault" from "kept looking", and the fault kinds take different paths through the
loop, so the altered test needed its own pair for the same reason — pairing only the missing one still left the
altered branch's `break` surviving.

Forcing `resumeAfter` to null also passed everything, because three seeded messages never fill a page of two
hundred and a short page correctly ends a sweep. The branch deciding whether a sweep **continues** was
untested. The batch bound is now a parameter defaulting to the receipt's value, so a test reaches that branch
in three messages instead of two hundred; the route does not read it from the query string, so an operator
cannot widen a batch past what was measured.

### A duplicate classification, found by having to add one

Adding the route meant classifying it in `packages/contract/src/agent.ts`, which is where
`POST /api/audit/verify` turned out to be declared **twice** — as `act`, with a written justification, and
again inside an `operator` block. Object spread means the later wins, so the `act` reasoning was dead code and
the route was withheld carrying a `why` inherited from a block about *"installation and the account
lifecycle"*. That string is what the Skill and the MCP server quote to explain the absence.

Nothing could have noticed: `DECLARED_ROUTES` collapses the duplicate before any test reads it, the counts
matched, and every withheld route had *a* reason. The oversized `operator` block is now split into five, each
carrying the reason its inline comment already stated — the comments were right, they just weren't the
operative value — and a test reads the source for a route declared more than once.

**What a clean sweep does not establish**, printed by the command rather than left implied: an R2 object no
receipt names, and anything that never reached ingress. And the clean-account restore drill is still ahead of
this — it needs a second Cloudflare account, and the export it verifies is the next layer.

## The deploy refused for the right reason and named the wrong one (#98)

Found while working out what a live deploy drill needed, on an ordinary machine, with nothing misconfigured
except one thing nobody had thought to ask about: the operator's wrangler token could see **four Cloudflare
accounts**. That makes every non-interactive wrangler call fail with a message about non-interactive mode. What
the operator was told, in order:

1. a **note** that the Workflow-theft guard had been skipped — so #99's protection against one Node stealing
   another's Butler engine silently did not run, in exactly the situation where nothing else worked either;
2. *"could not tell whether this account already has a Mailda Worker"*, with `CLOUDFLARE_ACCOUNT_ID` mentioned
   in passing at the end of a three-line advice block about something else.

It failed safe. It also diagnosed the wrong thing, and the guard that quietly stopped guarding is the more
serious half — a check that treats *"I could not look"* as *"nothing to check"* reads exactly like a pass.

`mailda preflight` now answers all of it in one `wrangler whoami`, before anything is touched, and `deploy`
runs it first — **before the Workflow guard**, because settling the account is what makes that guard's answer
mean anything:

```
== preflight
   wrangler        4.118.0 (floor 4.97)
   account         unresolved
   node            https://mailda.mystraits-ai.workers.dev

1 thing(s) must be settled before a deploy can run — nothing has been changed.

  1. the Cloudflare account is ambiguous
     why      this token can see 4 accounts and nothing says which one to deploy to, so every wrangler
              call fails with a message about non-interactive mode — and the Workflow-theft guard (#99)
              is skipped rather than enforced
     fix      export CLOUDFLARE_ACCOUNT_ID=<one of these>
             e842216b23604d45c318ae890bbd2999  Admin@arbuilder.app's Account
             ...
```

Every problem is reported together rather than one per round trip, because an operator standing a Node up has
several wrong at once and each round trip otherwise ends in a message about a different thing.

**Three account failures, three messages.** One account needs no environment variable — demanding one would be
ceremony. Several with no choice made is the defect above. And an id that is set but *not in the token's list*
gets its own wording, because wrangler answers that with a permissions error which reads like an expired login
and sends people to re-authenticate instead of to their typo.

**The version floor is compared numerically, and that is not pedantry.** As strings `"4.118.0" < "4.97.0"`,
because `1` sorts before `9` — so a floor checked the obvious way rejects every wrangler released after 4.99
and accepts the ones actually too old. The exact inversion, presenting as a broken toolchain on an up-to-date
machine. There is a test asserting the string comparison is wrong, so nobody simplifies it back.

It also warns, without refusing, when a Node cannot report which version answered — that Node predates the
`version_metadata` binding, so a version override that fails to apply is reported as *"the report named no
version"*, which is the canary gate refusing correctly rather than a fault. Better read in advance than
investigated mid-deploy.

Its parsers are tested against **real** `wrangler whoami` output, box-drawing and all, from the machine that
hit this. A parser tested against a fixture written from memory is a parser tested against its author's belief
about the format, and the format is the entire difficulty — wrangler offers no structured way to ask.

And the fifth lexical assertion in this repository was caught the same way as the four before it: the test
requiring preflight to precede the Workflow guard searched for `refuseIfWorkflowBelongsElsewhere()`, which
matched the function's **definition** two thousand characters earlier and failed against correct code. It
matches the call site now.

## The drill ran, the mechanism works, and the gate was wrong (#98)

The fourth live deploy drill, and the first since the preview-URL cause was established and the canary gate
rebuilt around a version override. Every step ran in order:

```text
preflight                    account resolved, wrangler 4.118.0 above the 4.97 floor
workflow guard               mailda-butler-runs owned by mailda — ran, rather than being skipped
migrations                   0045–0051 applied (all expansion)
reading the serving version  d27a228d
canary upload                c7e7b917
canary at 0%                 SUCCESS: c7e7b917 at 0% and d27a228d at 100%
override probe               answered version: c7e7b917  ← the identity gate passed
```

That last line is what three previous drills could not reach. The override **does** reach a 0% version on the
production hostname, and the canary named itself — so the identity check, the thing standing between this gate
and an assertion that cannot fail, works against a real account.

**Then the gate refused, and the refusal was the defect.** The canary reported `degraded` with one finding,
`signing_key` — *"generated on the next sign-in, so this self-heals"*. The incumbent reported `degraded` with
**the same one finding**. A version neither better nor worse than the one already taking every request was
withheld, and the operator was told to promote it by hand.

An unclaimed Node is in that state by construction until somebody signs in. So *every* deploy to one would
have gone that way — which is the weak "upload, check by hand, promote" path the earlier drills recorded,
reached from a completely different direction. A gate that always has to be overridden has stopped being a
gate.

The comparison is differential now. **A canary answers whether the new code is worse**, and a finding the
incumbent already has is information about the Node rather than about the new version — refusing on it
withholds the fix as readily as the regression. Shared findings are reported as *carried*, never silently
dropped. `refuse` still refuses whatever the incumbent says, because two broken versions is a reason to stop
rather than to proceed. And an *improvement* promotes, which is the direction nobody thinks to test: a canary
that fixes the incumbent's finding has fewer, and a comparison written backwards would block it.

The mutation worth naming survived everything else: fetch the incumbent's report **with** the override header
and both reports come from the canary, so nothing ever blocks — including a canary that broke the Node. The
pure function cannot see it; it is handed two reports and has no way to know they came from one version. The
property is countable instead: exactly one request in the CLI overrides a version, and it is the canary's.

`shouldPromote` is gone rather than left as an export nothing calls, with the expensive lesson from its
docstring folded into its replacement.

**Then it was promoted, and the drill measured what the gate can actually see.** `c7e7b917` at 100%; the Node
now reports its own version, so every future gate can run; `migrations_applied` reads *"All 52 expected tables
present"*; the events consumer was already attached, so the step the refusal interrupted had nothing left to do.

The canary check is unauthenticated, which costs something now measured: **9 findings of 21.** The other 12
describe the organization's mail and are withheld from an anonymous caller, so the differential comparison
covers 9 and a regression confined to a data-disclosing finding would not block a promotion. Fixable —
sessions are signed by the Node's key and that state is shared across versions, so signing in and sending the
cookie *with* the override header would reach the canary authenticated — and deliberately not fixed, because it
needs credentials in the deploy path, which is a decision about what `mailda deploy` may hold.

One number moved that looked alarming and was not: the report went from 20 findings to 9 across the promotion.
The old route reduced only `if (orgId !== null && !signedIn)`, so an **unclaimed** Node served its *full*
report to anonymous callers; the current one reduces that case too. Nothing was removed — four checks were
added since — and the tightening is an improvement. Recorded because the first reading of a shrinking number is
that coverage was lost.

## A successful deploy reported failure, and the gate saw less than it looked (#98)

Two findings the drill left, both now closed.

**`mailda deploy` inherited `doctor`'s exit code.** So a Node reporting `degraded` made a *successful* deploy
exit 1 — and on a fresh Node `degraded` means `signing_key`, which self-heals on the next sign-in. Every green
deploy to a new Node reported failure, indistinguishable in a pipeline from a deploy that never happened.

The two commands are asked different questions. `doctor` is asked *how is this Node*, so its verdict **is** its
answer and the mapping is a faithful translation. `deploy` is asked *did the deploy happen*, and a pre-existing
degradation is neither its doing nor its subject — the gate already refused anything the canary made worse.

`refuse` is the exception, and it earns an exit code for a specific reason: it is the one case the canary gate
provably cannot catch. A Durable Object runs the promoted version only **after** traffic moves, so a fault
inside `KeyVault` or `OutboxSweeper` appears exactly there and could not have appeared earlier. So a deploy
ending in `refuse` exits 2 and prints the rollback with the version that was serving before it ran — the one
value nobody can look up mid-incident.

**The gate compared 9 findings of 21.** The canary check was anonymous, and `withoutDataFindings` withholds
everything describing the organization's mail from a caller who is not an administrator. A regression confined
to the withheld 12 would not have blocked a promotion.

It can sign in now, and the reason it works is worth stating: a session is signed by the Node's own key, and
that key lives in D1 and the vault — **state, not code** — so two versions share it. A cookie obtained from the
incumbent is honoured by the canary, and sending it *with* the override header reaches the new version
authenticated.

The trap that shapes the implementation is not the signing in; it is the asymmetry. **Asking the canary
authenticated and the incumbent anonymously compares 21 findings against 9**, twelve read as new, and every
deploy is blocked by a difference in who was asking rather than in what the code does. One headers object is
built once and used for both; the override is the only thing added on top.

Credentials stay optional — a Node that cannot be deployed to because its credentials are wrong is a worse
failure than a narrower gate — and the downgrade announces itself. The deploy now prints how many findings it
compared and how many were withheld, because *"the gate passed"* is worth less without how much the gate could
see. An ordinary member's credentials buy nothing here and it says so: the full report needs `org.admin`, and
anything less is reduced to the same 9.

## An inventory, so a restored bucket can be checked object by object (#92)

The verifier from #117 proves an object is what was recorded. It cannot say **what should be there at all** —
and a copy of a bucket into a fresh Cloudflare account is a copy nobody has checked without that. #92's step 1
asks for D1, the R2 object inventory, and the manifests; `wrangler d1 export` covers the first, the manifests
live in D1, and this is the missing middle.

`GET /api/evidence/inventory` walks every prefix the Worker writes and returns each object's key, size,
timestamp, key generation, and **the hash its plaintext should have**. The prefixes come from
`scannedPrefixes` — the function #67 and #74 both exist because of, each a prefix the Worker wrote and no
listing covered — whose completeness is enforced by a test that derives the written set from `src/`. Building
a *backup* on a second, copied list would be that defect in the place it costs most.

All four prefixes turn out to have a referent row carrying their objects' SHA-256, which is better than a
listing of sizes: `raw/` from `ingress_receipts`, `drafts/` from `drafts`, `exports/` from `exports`, and
`sent/` from three columns on `send_manifests`. So a restored copy is checkable object by object rather than in
aggregate, and the existing verifier is the thing that would run over it in the new account.

**An object no row names is reported, not omitted.** `recordedSha256: null` is `reconcile.ts`'s "object, no
referent" — safe to delete after a grace period, and never safe to leave out of an inventory: a backup that
silently drops what it cannot explain restores less than the operator thinks, and the gap is invisible
precisely because nothing references it.

Three things the build was taught rather than reasoned into:

**D1 refused a six-arm `UNION ALL`** — *"too many terms in compound SELECT"* — which turned out to be the right
design pressure. A page is always from one prefix, so only that prefix's referents can name its keys; joining
a page of raw mail against the drafts table was pointless work as well as one arm too many. Worst case is now
three arms, for `sent/`.

**The closed world caught my own route contradicting itself.** The route's documentation said it was withheld
from machines, and nothing classified it — so the GET-derivation rule offered it. An inventory is the widest
description of an organization's mail that contains no mail: every object with its size and timestamp, which
is who was busy, when, and how much. It is also a backup's index, which is a list of what to ask for next.
*The declaration is what withholds; prose is not.*

**One filter was decorative until a test made it load-bearing.** Removing `org_id` from the hash join passed
every test, because keys are org-scoped by the R2 prefix they were listed under. What it defends is narrower
and real: another organization's row naming an object under *our* prefix would otherwise supply *their*
recorded hash for *our* object, and a restored copy would be verified against another tenant's number. That
case is now a test, so the line can fail.

## A backup an operator holds, and a check that runs without the Node (#92)

Cloudflare's own recovery — D1 Time Travel, Durable Object point-in-time — covers thirty days and restores
**into the account that failed**. #92 puts it plainly: *"A backup that only restores into the account that
failed is not a backup for a product whose selling point is that you own the account."*

`mailda backup --url <origin> --out <dir>` writes three files:

```text
catalog.sql       wrangler d1 export. The thing you restore — and it carries the manifests, the
                  audit chain and the wrapped vault escrow, because all three are rows.
inventory.jsonl   every R2 object with the hash its plaintext should have.
index.json        what the other two should contain, with a SHA-256 of each.
```

That the escrow is a row is why #92's layers had to come in the order they did: exporting evidence nobody can
decrypt is a backup that proves nothing, so the keys had to exist first.

**It deliberately does not copy the evidence bytes.** Streaming a mailbox's worth of R2 through a laptop is not
a backup strategy, and a command that pretends otherwise works on a demo Node and fails on a real one. The
inventory is what turns somebody else's copy — `rclone`, an R2 bucket-to-bucket job — into a copy that can be
**verified object by object** afterwards. The command says so last, where it is read, because that is the half
an operator will assume it did.

`mailda verify-backup --in <dir>` reads the artifact and nothing else — no Node, no network — so it runs on the
copy you keep rather than the machine that took it. It answers exactly one question: *is this backup the one
that was taken?* Every file present, every hash matching, the line count agreeing with the index. That catches
a truncated copy, a partial download, a corrupted transfer and a directory somebody edited, which is most of how
a backup is discovered to be useless — and all of it discoverable **before** the day it is needed.

What it cannot establish is printed in its own output rather than left to a reader, because *"the backup
verified"* is the sentence somebody will remember on the day it matters: not that the evidence decrypts (the
objects are not in the backup), and not that the catalog restores. Both are properties of a restore.

Three judgements worth naming:

**`verified: null` is "not asked", never "clean".** `--verify` runs the evidence sweep first and records what
it found; without it the field is empty, and the checker reports the absence rather than letting a reader infer
a clean bill of health from a quiet field. Faults found *at backup time* are a failure, not a note — a backup
of a known-broken state discovered on restore day is the whole thing this ticket is about.

**Every problem at once.** A backup is checked rarely and in a hurry; being told about a missing file, then a
bad hash, then a short inventory across three runs is how a restore becomes an evening.

**An unknown format declines rather than guessing.** A future backup read by an older CLI would otherwise be
checked against today's rules and produce confident nonsense. Declining leaves the operator their files.

**Both administrator-only commands now refuse an unclaimed Node with the accurate reason.** They used to ask
for `MAILDA_EMAIL` and `MAILDA_PASSWORD` and then fail at sign-in — which on an unclaimed Node is a request for
something that *cannot exist*, since claiming is the step that creates the first organization, its first user,
and that user's password. There is also nothing to back up on such a Node. The old message sent an operator
after the one thing that cannot work; the check reads `claimed` rather than probing the login route, because a
failed sign-in is recorded and counts toward lockout.

The prose-reference tripwire from #103 caught this change **three times**, which is the return on having built
it: the docstrings naming files the command *writes* — the same class as an export archive's entries, so the
exemption cap moved from 26 to 30 with the reason recorded — then the sentence in the receipt explaining that
exemption, which cited one of those names inline, and then this very section.

The third catch came from CI rather than locally, and the reason is worth knowing: **this test reads the whole
repository, and turbo caches on the package's own inputs.** A change to the root README alone leaves the
cached result in place, so `pnpm test` reports green without re-running it. Recorded in the test itself, since
anyone editing prose will meet it.

## A runbook written before the drill, and a check that its commands exist (#92)

Three deploy drills each spent their time rediscovering a precondition — an ambiguous account, a preview URL
that cannot exist, a gate comparing against the wrong thing. [`docs/disaster-recovery.md`](./docs/disaster-recovery.md)
is the restore drill's sequence written down **first**, so the fourth one can be followed rather than improvised.

It names its preconditions because each has already cost something: the source Node must be claimed (an
unclaimed one has no administrator, so the commands that need one refuse by name); the destination account must
have **R2 enabled**, which is a dashboard-and-billing action a deploy cannot do for you; `CLOUDFLARE_ACCOUNT_ID`
must be set when the token sees several accounts. Two facts found while writing it: there is no
`wrangler d1 import` — `execute --file` is the restore path — and **the destination needs no claim**, because
the catalog carries the organization and its users, so a restored Node arrives already claimed.

What it will not do is pretend. It says it has not been run end to end, and it splits RTO rather than offering
one number: **restore-to-readable** is measurable, and **restore-to-receiving** needs DNS propagation, which is
not the product's to control. A receipt recording the first and stating the second is unmeasured is worth more
than one figure covering both.

`test/node/runbook.test.ts` is the #103 defect in a new place: the path tripwire catches a comment citing a
file that is not there, and nothing caught a **document citing a command** that is not there. Both are claims a
reader follows and nothing resolves — and a runbook is read once, under pressure, by somebody who cannot tell a
stale document from a broken Node.

Mutation testing found the first version checking the wrong half of its own document. The pattern was
`\bmailda\s+`, and an actual invocation reads `node packages/cli/src/mailda.mjs backup` — after "mailda" comes
`.mjs`, not a space. So it was matching the **prose** mentions and none of the commands an operator copies,
which are the only ones that fail at three in the morning. Renaming a command inside the runbook's own code
block passed. It matches both spellings now.

The second gap was subtler: the blueprint and `AGENTS.md` are exempt, because one sketches thirty-three verbs
by design and the other names two as illustrations of an error message's shape. A mutation adding the *runbook*
to that exemption list also passed — the general non-vacuity check was satisfied by the README while the one
document the test exists for went unchecked. It is now pinned in scope by name. And writing this turned up one
real instance: `SECURITY.md` named a CLI command that does not exist, in my own sentence about signing.
Rephrased rather than exempted.

That is the third time in this session a checker for wrong claims has made it awkward to *write about* wrong
claims — the path tripwire caught its own receipt, then a README section explaining an exemption, and now this
sentence, which named the very command it was reporting as absent. The pattern is worth knowing rather than
fixing: each time the cheapest correct move was to describe the defect instead of quoting it, and each time
that left the prose better. A checker that objects to its own documentation is usually objecting to a quote
that did not need to be there.

## The claim page was a blank page without JavaScript, and a comment said otherwise (#92)

Found by driving a browser at the claim screen — the point of doing it that way rather than reading.

`main.tsx` stated that three screens *"stay **server-rendered** with no framework, because they are the
screens an operator sees when the Node is broken and they must **work before any bundle loads**"*. The
reasoning is right. The mechanism was not there. `ui.ts` exports `page()`, which ships
`<main id="app"></main>` and a script tag; nothing in `src/*.ts` renders a claim form, and the only place the
form's text exists is the framework-free client script.

Measured by fetching it: **2.4 KB, and the only visible text was the wordmark.** No form, no error, no hint —
on the first screen a Node ever shows. That is the worst available diagnostic, because a blank page reads as a
network problem rather than as a requirement, and an operator claiming a Node has no reason yet to suspect
their own browser.

Half the comment was true and worth keeping: those screens use **no framework**, and React is imported
dynamically only after sign-in, so somebody staring at a 500 does not download a hundred kilobytes to find out
why. What was false was *server-rendered*, and it was false on the one screen where the stated reason matters
most.

There is a `<noscript>` in the shell now — it says the page needs scripting, says plainly that nothing here is
rendered on the server so a reader stops looking for a path that does not exist, and points at
`/api/doctor?format=text`, which genuinely needs no scripting because the server renders it. The comment says
what ships. **Actually server-rendering those three screens is a larger change and a decision**, not an
omission to fix quietly, so it is stated rather than done.

One assertion in the new test is the measurement itself: strip the scripts, the SVG and the tags, and what a
browser without JavaScript can show is the wordmark plus the notice. If server-rendering ever arrives, that
test fails and should be rewritten rather than deleted.

## The ten recovery codes were minted, hashed, escrowed, and thrown away by the interface (#134)

The operator who claimed a Node was never shown them. They asked whether they had missed a screen; they had
not, because there was no screen.

`claimNode` returns them — `claim.ts:186`, `recoveryCodes: escrow.codes` — and the contract is explicit that
this is the only place they ever appear, *"the Node keeps a hash to recognise one and an escrow only the code
itself opens, so nothing can produce them again."* The claim handler did:

```js
if (response.ok) { adopt(); startSessionTicker(); return route(); }
```

The body was never read. `src/client/` contained **zero** references to `recoveryCodes`. So the one artifact
that decrypts an organization's mail was returned once and dropped on the floor, and `doctor` correctly
reported *"10 recovery codes exist and nobody has confirmed holding one"* about codes nobody could ever have
held.

**And there was no way to spend one either.** `POST /api/recovery/redeem` exists and is deliberately
unauthenticated — the state it exists for is one where the signing key cannot be unwrapped, so no session can
be issued. But no screen referenced it and the CLI had no verb: the only way to redeem was a hand-written
`curl`, for the operation whose entire purpose is to be performed during a disaster by somebody who has lost
everything else.

Measured, in #92's restore drill: a full catalog and every object restored into a different Cloudflare
account, the destination holding all ten hashes and escrow blobs, and it refuses —
`signing_key: E_EVIDENCE_AUTH_FAILED`. The escrow ADR 28 says it does not ship without was present, correct,
and unusable.

Now the claim shows them on a screen of their own with one way forward, and the button says what it asserts —
*"I have saved these ten codes"* — rather than "OK", because a person clicking it should know what they are
claiming. And `mailda recovery-codes redeem` reads the code from a terminal, never an argument, for the reason
`set-password` already gives: a secret on a command line ends up in shell history.

### The command with the gentler verb was leaking the worse secret (#136)

Walking the drill with that fix in place found the rule broken forty lines from where it is written. `redeem`
refuses a code as an argument; `confirm` **required** one. And confirming is the more dangerous place to leak,
because confirming deliberately does not spend the code: a redeemed code in a shell history is spent, while a
confirmed one still opens the escrow holding the organization's content and credential keys.

The second reason is the one that decided it. Confirmation asserts exactly one thing — that a **person** holds
the sheet — and `doctor` words its warning as that: *"nobody has confirmed holding one"*. A code a script reads
from a file clears the warning without the fact becoming true, which is 2b: an assertion that cannot fail. The
agent that found this had just rotated a Node's codes and could have cleared its warning from the file it had
written, making the Node report that a human held codes no human had read.

So `confirm` prompts, and refuses `--code` **by name** with the reason rather than ignoring it. The test is
written over the whole function rather than over the one command, because the rule had been living in a comment
next to a single caller — `test/node/recovery-code-entry.test.ts` requires that *every* code the CLI sends is
one somebody typed, which is a rule the next recovery verb has to meet.

### Why nothing caught it, and what that cost

`src/client/app.client.js` renders the claim, the sign-in and a locked-out doctor — and **no test had ever
loaded it.** Its imports name the session and config modules the way the Worker serves them, not as files on
disk, so it could not be resolved under vitest. The React suite drives the screens *after* sign-in. This file
was outside both, and the claim screen is the first thing a Node ever shows.

Three aliases and a stub make it importable, so the pre-authentication surface is now testable at all. That is
the more valuable half of this change: the fix is four lines, and the reason it was possible to ship is that
nothing could see the file.

Two mutations survived the first version of the tests, and both are worth naming. Adding an unconditional
`route()` to the new screen — rendering ten codes and navigating past them, the original defect wearing the
fix's clothes — **passed**, because `route()` is async and the assertions read the DOM in the same tick. And
softening the heading from *"Write these down now."* to *"Recovery codes"* passed, because the substantive
warnings live in the paragraphs. The tests yield before asserting now, and the heading is pinned.

### Eight, and a helper

The claim-path assertion searched for `return route()` and found it inside a comment saying *"this used to be
`return route()`"*. That is the **eighth** time in this repository a lexical assertion has matched its own
documentation, three of them caught only by mutation testing — which means the others were luck.
`test/without-comments.ts` now exists, lists all eight, and strips comments by default rather than by each
test remembering. It does not fix the class: a lexical test can still match the wrong call site, and scoping to
a function's body is the other half.

The **ninth** arrived while fixing #138, and it is that other half rather than a comment. A test asserting the
collision branch exits non-zero took nine hundred characters from the branch's start, ran past it into the guard
below, and found *that* `fail(`. Swapping the branch's own `fail(` for a `process.stdout.write(` passed.
Delimiting the slice at both ends killed it.

### An empty box is not an empty draft (#143)

The drill's last finding, and the one with a person on the other end of it. `GET /api/drafts/:id` on a Node
whose vault was incomplete answered `200` with `body: ""` and **`bodyBytes: 180` beside it** — the row
contradicting the answer, and nothing saying which of two very different states it was.

`.catch(() => "")` swallowed both alike. The reasoning behind it was sound and is still in place: a draft
whose body is gone should not fail to open, because that loses the recipients and the subject as well as the
writing. What was missing is that the two cases need different words. **missing** is ADR 32's
reportable-only side and nothing recovers it. **unreadable** means the object is *there*, sealed under a key
generation the vault does not hold — the ADR 28 loss the recovery codes exist for, and it clears when one is
redeemed.

**And an empty box invites typing.** Two losses were reachable from there, and the second is the one
reasoning alone would have missed:

- a non-empty save re-seals to `bodyKeyFor(orgId, id)`, which is deterministic, so it **overwrites the object
  it could not open** — recoverable evidence becomes gone evidence;
- an empty save skips that branch entirely and leaves `body_key` pointing at the old object while writing
  `body_sha256 = NULL` and `body_bytes = 0`. The bytes survive and stop being **verifiable**, because the
  verifier skips a row carrying no recorded hash.

So the read says which state it is, the composer says it where the empty box is, and the write refuses while
the body is unreadable — naming the recovery code as the way out. Only `unreadable` is refused: blocking a
write over a body that is genuinely gone would strand the recipients and subject too, punishing somebody for
a loss they cannot undo. A mutation over-blocking that case **passed** until a test was written for it.

The refusal is gated on the body actually changing, which costs nothing on autosave — and the gate turned out
to be better than its own justification. A caller can only produce a matching digest by already holding the
text, so writing it back is proof the writing was never lost, and it **repairs** the object. The test that
went looking for persistence found that instead.

## The restore drill: what running it found that reading could not (#92, #138)

Two full runs against two real Cloudflare accounts. The backup half works. The half it exists for does not, and
that is now measured rather than assumed.

**The redemption installs nothing.** On a clean destination — Worker, D1, R2 and queue all provisioned from
scratch, catalog restored, evidence copied and byte-checked — spending a recovery code answered:

```text
HTTP 200
{"restored":{"content":[],"credential":[]},"conflicted":{"content":[1],"credential":[1]}}
```

A fresh Node mints its own content and credential generation 1 **before it can be claimed** — `mailda deploy`'s
closing `doctor` says so on a brand-new unclaimed install — and the escrow carries generation 1 too. One number
cannot hold both, and the Node keeps its live key, which is the right trade in the scenario the code was written
for and the wrong one here: the destination's generation 1 has sealed nothing, so keeping it costs the whole
organization's mail to protect an empty key. The runbook's own order forces the collision, because the redeem
route needs a claimed Node and the claim arrives with the catalog.

**And every layer read it as a success.** The route returned two arrays and a 200; the CLI printed *"the vault
is restored"* — a false success message I had shipped less than an hour earlier in the #134 fix, over the exact
case where an operator most needs the truth. The Node already knew better: `vault.restore` answers
`restored | conflict | identical`, so it can tell a harmless re-run from a real collision, and only the API
threw the distinction away. The answer now carries what happened, including the sentence worth the most —
**another code will not help, because all ten carry the same generations.** Without it an operator spends the
sheet.

**The escrow installs now, and the trade that blocked it was real.** `restore` never overwrote a generation
already present, and the argument is good: a code redeemed against a healthy vault by somebody uncertain what
state it is in would otherwise replace live keys with older copies and make everything sealed since the escrow
unreadable. That trade only exists when there **is** newer mail. A generation nothing has ever sealed under is
a reserved number, not a protected key — so an escrowed key may now take it, and a generation that has sealed
is still refused. The vault records the difference at the first seal rather than at the mint, which is why
`doctor` moved from `sealingKey` to a new `ensureKey`: a diagnostic that wraps a constant and throws it away
was marking the generation load-bearing, and that alone made the escrow uninstallable on every fresh Node.

Measured on the drill's destination: both generations installed, `adopted` naming what they displaced, and
**sign-in returned `200` for the first time** — the restored Node authenticating the source's administrator,
with the source's user id.

**Then the evidence failed, and it was my own copy that did it.** `verify-evidence` opened all three objects
and reported all three unreadable. `wrangler r2 object get | put` carries the bytes and drops the custom
metadata naming the key that sealed them; there is no flag for it. The destination fell back to generation 0,
the published constant, and authentication failed on every frame.

The first answer was a runbook warning and a list of approved copy tools. That is the wrong shape: **a Node's
ability to read its own mail should not depend on an annotation any S3 client may normalise away**, and an
operator recovering from a disaster is the least likely person to have used the blessed tool. So the
generation went back to being a hint (#142). When an object carries no label, the read tries the generations
the vault holds — sound rather than a guess, because AES-GCM authenticates: a wrong key fails rather than
producing wrong plaintext, so the sweep either finds the key that works or proves none does.

Bounded, and off the ordinary path entirely: an object with its label takes the route it always did. And the
frame header has three unused bytes already covered by the authentication tag, so a later change can put the
generation in the object's own bytes, where no copy can lose it.

**With that, the drill completed**: `3 checked, 0 fault(s)`, and the same draft byte-identical on both Nodes.

The check designed to catch exactly this was already built and already silent: the inventory reported
`keyGeneration` per object as `0` for **everything**, because `list()` was never passed
`include: ["customMetadata"]` and R2 returns none without it — honoured since compatibility date 2022-08-04
(#141, fixed). A wrong number in a backup artifact, in the one field saying which key opens each object, and
the eight tests over that inventory passed throughout because not one of them asserted it.

**And a draft whose body cannot be decrypted reads as an empty body** (#143), with `bodyBytes: 180` returned
beside it. The existing reasoning is sound for a *missing* object — losing the recipients and subject as well
would be worse — but it swallows a decrypt failure too, and an empty body in a composer is an invitation to
type over evidence that was only unreadable, not lost.

**Three of the side-findings were ours, and are fixed** (#148, #149, #150). A **backup aborted on one
transient sign-in `500`** with nothing retried — and a backup that fails on a blip is a backup that does not
happen, since it runs unattended and the next thing anybody learns is that the newest artifact is a week old.
It retries now, three times with a short backoff, and never retries a `401`, because wrong credentials will be
wrong again and a scheduled job hammering a login is a different problem. **`/health` called a missing
database "no schema"** and named `migrations apply` — which resolves the binding *by name*, applies every
migration to a live database the Worker does not read, and reports success; the two states are now told apart
and the second says plainly not to run it. And **`mailda deploy` stopped on a raw wrangler error** when a
Node's script existed but its bindings did not, a state that is routine because every failed provisioning
retry produces it; it is now named, with the path that works.

**Seven more findings between "the destination exists" and "the destination is clean"**, each in the runbook
now: a second restore onto a restored Node fails with the opaque `{"D1_RESET_DO":true}`; a deleted D1 is never
re-provisioned by `wrangler deploy`, because the binding is linked server-side, so the Worker kept reading a
dead database id while the CLI resolved the name to a live one; **the fix the Node printed therefore ran
successfully and changed nothing**, applying 51 migrations to a database the Worker does not read; `/health`
calls a missing database "no schema"; `mailda deploy` lists migrations before the deploy that provisions them;
auto-provisioning never adopts an existing resource, and fails *after* creating the earlier ones, so each retry
needs a manual unwind; and a Worker cannot be deleted while it consumes a queue.

The pattern across all of them is one thing: **a layer's honest output read as the layer above's good news.**
`backup --verify` reported `0 checked, 0 fault(s)` over three objects — true, and worthless, because the sweep
reads `ingress_receipts` and this Node's evidence is drafts (#131). `verify-backup` was the only thing in the
chain that said it: *"the sweep that ran when this backup was taken checked **nothing** … That is not a clean
bill of health."*

## Contributing

Read [`AGENTS.md`](./AGENTS.md) first — it's short, and it's binding on humans and agents
equally. Work is tracked as a [wayfinder map](https://github.com/Straits-AI/mailda/issues/1):
one issue holds the route, each child issue holds one decision and the argument for it.

Open questions live there. Closed ones record what was rejected and why, which is usually
the more useful half.

## Licence

**[Apache-2.0](./LICENSE).** Chosen 27 August 2026 (#102), and it was not merely unchosen before — it was a
gap with legal effect. Without a licence file, default copyright applies: nobody had permission to reproduce,
modify or deploy this source, which is the entire distribution model. The product described itself as
customer-owned software you run yourself, and that was not something anybody was licensed to do.

Apache-2.0 rather than MIT for the **patent grant**, which matters for a project already taking outside
contributions and for the enterprise buyers the paid offerings are aimed at. Rather than AGPL, because
customers self-host by design — the network clause would bind resellers rather than users, and it would cost
adoption at firms that forbid AGPL outright, for protection this deployment model largely already has.

The paid offerings are unaffected. What is licensed here is the software; what is sold is deployment,
updates, deliverability, assurance and managed responsibility, which is Blueprint §30's open-core position
and needed no change.

Security problems go to [`SECURITY.md`](./SECURITY.md) — privately, and **not** to the issue tracker. It also
lists what is already known, so nobody spends time reporting a documented limitation.
