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
| **A restore has worked three times, and once through to receiving mail** | Three drills (#92): cross-account on 2 September; a real backup on 15 September; and on 16 September a same-account restore that took a domain, wrote its own routing through the restored grant, and accepted a message from outside — with four defects found in the receiving step and fixed. What is still unmeasured is scale: the evidence copy was one request per object at 5.4 s each, and a mailbox-sized restore needs a copy tool this repository has not timed. The [runbook](./docs/disaster-recovery.md) has the figures and what they are worth. |
| **Deployment promotes by hand on a Free account** | `mailda deploy` does expand/contract with a canary and refuses to promote a version whose `doctor` is not `ok` (#98). It has now been run against a live account ([receipt](./docs/receipts/deploy-drill-live-account.md)) — and `versions upload --preview-alias` returned **no reachable preview URL**, so the gate cannot probe the canary and degrades to a safe manual promotion. The cause is not established, which is why that receipt records it without a number. |
| **Two Nodes in one account collide on the Workflow, and the deploy refuses** | Measured rather than suspected ([receipt](./docs/receipts/deploy-drill-live-account.md)): every other resource derives its name from the Worker's, the Workflow does not, and deploying a second Node **succeeded with exit 0 and silently took ownership** — leaving the first Node's `BUTLER_RUNS` binding pointing at a Workflow now running the second Node's code against the second Node's bindings. `mailda deploy` now refuses when the Workflow belongs to another Worker and names the fix. The config still ships a fixed name, so the refusal is the guard rather than the naming. |
| **Mail security is thin** | The receiving server's SPF/DKIM/DMARC verdict is read, stored and shown on every message since 17 September ([`docs/mail-security.md`](./docs/mail-security.md)) — deterministic, no model. Attachments are judged by name and by magic bytes — executable, script, disguised, archive, plain — listed on every message and read by Butler guards. A mailbox can hold back a delivery its sender's domain disowns (DMARC fail against `p=reject`/`p=quarantine`) or one carrying a dangerous attachment, for an administrator to release. Every link is judged at render — text naming one host and going to another, lookalikes of your own domains, `user@host` tricks, bare addresses — and the flagged ones are listed with their real destination. A recipient the provider hard-bounced or that complained is refused at the seal, by name, until an administrator vouches for it with a reason. Still absent: a general policy on the verdict, an attachment size bound and allowed-type list, archives opened, a stored link verdict a guard can act on, and any classifier. A public mailbox should not be accepting attachments. |
| **The mail client is thin** | No threads, no forwarding, no attachments in the composer, no folders. Pagination and per-mailbox filtering landed in #91; search over subjects, senders and message bodies in #107, and `since`/`until` date bounds on the listing. Filtering by **sender** is not built (#152) and a date window cannot be combined with a search term (#153) — both because the plan reads more than the budget allows, measured rather than assumed. The rest has not. |
| **AI is reserved, not built** | The Butler engine is deterministic and the `llm.*` node types are declared and **refused**. There is no provider configuration, prompt versioning, cost governance or evaluation. Calling this AI-native today would be a claim about intent. |

What it is genuinely good for now: a controlled design-partner alpha, a non-critical shared mailbox, and
exercising the governance and deterministic-automation model — which is the part that is further along than
anything else here.

What exists today:

| | |
|---|---|
| **Product contract** | [`Mailda-Full-Engineering-Blueprint.md`](./Mailda-Full-Engineering-Blueprint.md) — the target state, and §29's locked architectural decisions |
| **Working agreement** | [`AGENTS.md`](./AGENTS.md) — how decisions get made and what counts as done |
| **Decisions taken** | Recorded with full reasoning and rejected alternatives, on the [issue tracker](https://github.com/Straits-AI/mailda/issues?q=is%3Aissue) |
| **Measurements** | The receipts in [`docs/receipts/`](./docs/receipts/), generating every constant in `packages/budgets` — which is itself generated and never hand-edited |
| **Code** | One Worker. Tests across three runtimes — workerd, node, and a DOM for the interface. The accessibility audit is manual and last covered 30 views with 0 AA violations; the screens added since have not been through it. |
| **Licence** | [Apache-2.0](./LICENSE). Security reports go to [`SECURITY.md`](./SECURITY.md), privately. |
## What's distinctive about how it's built

- **Every number has a receipt.** No limit, timeout or budget enters the code without a measurement behind
  it; the constants in `packages/budgets` are *generated from* [`docs/receipts/`](./docs/receipts/), so you
  cannot write the number, only the measurement. The rule and the vocabulary are in [`AGENTS.md`](./AGENTS.md).
- **Every assertion has been seen to fail.** A test is mutated against the line it covers before it counts.
- **Names do not overclaim.** A forwarded copy is a `copy`; a provider action is `observed`; a send is
  `handed_over`, never `sent`, until a delivery event says otherwise.
- **Contracts before channels.** Routes are declared once in `packages/contract`; the SDK, the Agent Skill
  and the MCP surface are generated from it, and a route that exists in one channel and not another fails
  a test.
- **The screens you need when it is broken carry no framework.** Sign-in, first-run claim and a locked-out
  `doctor` are server-rendered and load zero bytes of the React bundle (ADR 30).

What each change found on the way — the defects, the measurements that reversed a plan, the tests that
turned out to be theatre — is kept in [`docs/history.md`](./docs/history.md), in the order it happened.

## What it will need from you

Every Cloudflare setting a Node depends on is listed once, with both ways to put it there, in
[`docs/cloudflare-settings.md`](./docs/cloudflare-settings.md). The intended experience is that an operator
never opens the Cloudflare dashboard — the Node does the account work through its own grant, from `/setup`
— and the dashboard path is kept for builders who would rather arrange the account by hand, with `doctor`
verifying either the same way.

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
docs/message-search.md                 the two indexes and their authorization, why a searched page has no
                                       cursor, the date window and its four refusals, and the release step
docs/mail-security.md                  what the Node establishes about a message: the receiving server's
                                       verdict, stored and shown; and what is not built, in order
docs/cloudflare-settings.md            every Cloudflare setting a Node needs, from Mailda or by hand, and
                                       the doctor check that verifies each
docs/cloudflare-grant.md               why the Node is its own OAuth client, the guided ceremony, the five
                                       connection states and which one it cannot observe, and what is
                                       still owed
docs/agents/                           issue tracker and domain-doc conventions
packages/receipts                      generates constants from receipts
packages/budgets                       GENERATED — do not edit
packages/runtime                       the clock, id and randomness seam
packages/contract                      the route registry, its schemas, and command schemas
packages/sdk                           GENERATED from the registry — one method per route
packages/cli                           `mailda`: the dispatcher, `support.mjs`, one module per verb under
                                       `verbs/`, and the pure parsers beside them (deploy-plan, preflight, backup)
skills/mailda                          GENERATED — the Agent Skill, from the curated list
packages/butler-ast                    the Butler AST: node set, checker, canonical serialization
packages/evidence                      framed encryption for stored mail
apps/node/worker                       the single Worker (ADR 18): inbound mail, evidence store,
                                       authorization, auth, outbox sweeper, interface
apps/node/worker/src/router.ts         the registry as router: one typed handler per registered route
apps/node/worker/src/routes            the handlers, by part of the product: mail, sending, access,
                                       governance, butlers, session, machine, provider, node
apps/node/worker/src/auth              passwords, ES256 tokens, key rotation, sessions
apps/node/worker/src/butler            the run engine: interpreter, effects, principal, release gate,
                                       recipient derivation, the latched pause and its two write acts
apps/node/worker/src/client            browser scripts, served as real .js files
apps/node/worker/scripts               operator tools: password reset, queue consumer attach, axe
apps/node/worker/src/doctor.ts         checks the runtime claims every decision made: the report, the
                                       meter and the verdict; the checks themselves are in src/doctor/
docs/history.md                        what each change found, in the order it was found
```

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
