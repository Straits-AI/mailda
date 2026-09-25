# Mailda

Shared inboxes that know who replied.

Two people answer the same customer. Nobody can say whether `invoices@` got a reply. The shared inbox is a
Gmail account four people know the password to. Mailda turns an email address into governed work:
assignment, collision detection, cases, approvals, an audit trail, and deterministic automation. AI is
available only where you put it.

It runs in **your own Cloudflare account**. You own the domain, the messages, the encryption keys, the
model keys and the bill. There is no Mailda service, no licence server and no telemetry. Disconnect us and
nothing stops working.

[mailda.site](https://mailda.site) is this README, `AGENTS.md`, `docs/` and the receipts, rendered. Its
landing page is the status table below in the shape of a `mailda doctor` report. Nothing on the site is
written anywhere but here.

---

## Installing it

One command, on macOS, Linux, WSL or Git Bash:

```sh
curl -fsSL https://mailda.site/install.sh | bash
```

It checks for git and Node 22, clones this repository, installs, signs you in to Cloudflare, asks which
account if you have several and what to call the Node (`mailda` by default), deploys the Worker with its
D1, R2 and queue, and applies the schema. Then it claims the Node from the same terminal: you choose the
first administrator's email and password, and the ten recovery codes are printed once. Then it asks one more
question, which domain this Node should receive mail at, and with the same Cloudflare sign-in you already
gave it enables routing on that subdomain, writes the rule to the Node, onboards the domain for sending,
subscribes delivery events to the Node's queue, and reads each back. The Node receives when the install
ends. No dashboard, no API token, no OAuth client ([receipt](./docs/receipts/wrangler-login-reach.md)).
Decline a question and the Node's own screens do the same thing later. Nothing in your account changes
before it asks. Connecting the Node with a grant of its own, for changing that setup from the browser
later, is optional and lives on *Setup*. From a clone, the same is `pnpm install && pnpm mailda install`; on Windows
without a bash, run that in PowerShell.

**After the install.** Open the Node. Until it has an address and mail routed to it, it shows the next
setup step and nothing else, with the command that does it; once it has both, the inbox. A Node claimed
before the install could set it up finishes with `pnpm mailda setup` from the clone, which does the same
receiving, sending and delivery-outcomes setup without deploying. Then send a message to the address you
chose: it appears in the inbox, and that is the proof.

The same command adds a second Node, and it can redeploy an existing one; updating is its own command,
below, because an update also has to pull the release and back the Node up first. It lists the Nodes the account already has (every
Node registers a `ButlerRun` Workflow under its own name), and the name you give decides: an existing name
is upgraded through the canary, which needs the Node's URL once and remembers it in a git-ignored
`.mailda/nodes.json`; a new name deploys another Node beside the first, with every resource named from it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Straits-AI/mailda)

The button does the deploy half without a terminal: it provisions D1 and R2, builds the Worker, and writes
no ids into your clone; the Node applies its own schema when it is claimed. You then need the claim secret,
which `pnpm mailda claim-secret` prints from a clone. The first click produced a dead Node, and what that
found and fixed is in the [receipt](./docs/receipts/deploy-button-install.md).

**One step neither path can do for you.** Delivery outcomes (`accepted`, `bounced`, per recipient) arrive
on a queue, and observing them needs two things in your account: a consumer on that queue, and an
`email.sending` event subscription publishing to it. The installer attaches the consumer. The
subscription is created from the Node's own Setup screen once the Node holds a grant on your account
([`docs/cloudflare-settings.md`](./docs/cloudflare-settings.md)). Until both exist every recipient stays
`unobserved`, and `mailda doctor` names whichever half is missing rather than letting silence read as
"nothing bounced" ([receipt](./docs/receipts/queue-provisioning.md)).

**A domain that already routes mail.** Setup lists the Email Routing rules on your zone and lets you
point one at the Node. That replaces where the address goes (Cloudflare allows one action per rule), the
previous destination is kept on the audit trail, and *put back* restores it. Existing rules for other
addresses are left alone. On a zone's own name the receiving step offers the **catch-all** instead: one
rule pointing the whole domain here, its previous target kept for a put-back, and every address from then
on managed on People inside the Node; on a subdomain Cloudflare allows literal rules only, so adding an
address on People writes its rule in the same act. `mailda provider --routing-rules <domain>` is the same
from the CLI.

**A second Node in the same account.** Give the installer a new name; `mailda deploy --name <worker>` is
the same from a script. Either derives the Worker, the Workflow and every other resource from that name
into a git-ignored config; first install measured at 108 s.

**Updating an installed Node** is one command, run where the install left the clone:

```sh
curl -fsSL https://mailda.site/update.sh | bash
```

It hands over to `pnpm mailda upgrade`, which is the same thing from a clone. It fetches the release remote,
fast-forwards when the clone is behind and says so, reinstalls, asks which Node
if the account has several, and then, before the schema is touched, takes a `mailda backup` into a
git-ignored `.mailda/backups/<node>/<time>` directory, refusing to go on without one. It lists every
pending migration by phase, *expand* (adds, safe for the running version) or *contract* (drops or narrows,
refused unless `--contract`), asks once, and runs the same expand, canary, gate, promote sequence as
`mailda deploy`. A Node that was never set up to receive is offered the install's setup step afterwards,
with the same sign-in. It never creates a Node; `mailda install` with an existing name still upgrades too, but
with whatever code the clone has, which is why the verb exists.

The button clones without history and without a remote. The upgrade handles that on its first run: it adds
the release remote, merges once with unrelated histories allowed, and resolves the one conflict the update
path allows, `package.json`, by keeping your Worker's `name` and taking upstream's everything else. If
anything else conflicts it aborts the merge and names the files, because that is a clone somebody edited.
`test/node/update-path.test.ts` is what holds `package.json` to being the only file, and the same steps by
hand are:

```sh
git remote add upstream https://github.com/Straits-AI/mailda.git
git fetch upstream main
git merge upstream/main --allow-unrelated-histories
# One conflict, in package.json. Keep your own `name`, take upstream's everything else.
```

**Resetting a password.** There is no password-change flow in the product yet. `pnpm run set-password
<email>` reads the new password at a prompt with echo off, derives the verifier with the same PBKDF2 the
Worker uses, and revokes every session. It runs outside the Worker, so it does not appear in the audit
trail.

---

## Status: functional alpha, not production-ready

**Do not make this the only copy of mail you care about.** It receives, stores, reads, replies, governs and
automates, and the release gates it sets for itself are not all closed.

What is blocking, as of 19 September 2026, with everything else on the
[issue tracker](https://github.com/Straits-AI/mailda/issues):

| | |
|---|---|
| **A restore has worked three times, and once through to receiving mail** | Three drills (#92): cross-account, then a real backup, then a same-account restore that took a domain, wrote its own routing, and accepted a message from outside. The catalog imports at about a thousand rows a second. The evidence copy works with any tool that moves the bytes, including one that drops the key label, and has only been timed with wrangler (5.4 s per object); a bucket-to-bucket copy is the tool for a real mailbox and is deliberately not timed here. [Runbook](./docs/disaster-recovery.md). |
| **Deployment promotes on its own, measured twice** | `mailda deploy` does expand/contract with a canary and refuses to promote a version whose `doctor` is worse than the incumbent's (#98). The canary is reached by a version override on the production hostname, because preview URLs do not exist for a Worker with Durable Objects. Unmeasured on a Free account, where ADR 25 says not to run anyway. [Receipt](./docs/receipts/deploy-drill-live-account.md). |
| **Mail security is thin** | The receiving server's SPF, DKIM and DMARC verdict is stored and shown on every message. Attachments are judged by name and magic bytes, links by where they really go, and a mailbox can hold back mail its sender's domain disowns or that carries a dangerous attachment. A hard-bounced recipient is refused at the seal until an administrator vouches for it. A send policy can hold, gate or refuse a reply to a message whose DMARC failed, which is where a forged invoice does its damage. A classifier you run in your own account can hold a delivery through the API with its reason and score; the Node ships none ([example](./examples/hold-agent/)). A classifier you run in your own account can hold a delivery through the API with its reason and score; the Node ships none ([example](./examples/hold-agent/)). A ZIP is listed without being opened, and one naming a program is held. A mailbox can bound attachment size and type, in and out. Absent: inbound acts beyond the quarantine switch, RAR and 7z listings, and any classifier, because Workers AI has none for mail ([receipt](./docs/receipts/workers-ai-classifier.md)). [`docs/mail-security.md`](./docs/mail-security.md). |

What it is good for now: a design-partner alpha, a non-critical shared mailbox, and exercising the
governance and deterministic-automation model, which is further along than anything else here.

What exists today:

| | |
|---|---|
| **Product contract** | [`Mailda-Full-Engineering-Blueprint.md`](./Mailda-Full-Engineering-Blueprint.md): the target state, and §29's locked architectural decisions |
| **Working agreement** | [`AGENTS.md`](./AGENTS.md): how decisions get made and what counts as done |
| **Decisions taken** | Recorded with full reasoning and rejected alternatives, on the [issue tracker](https://github.com/Straits-AI/mailda/issues?q=is%3Aissue) |
| **Measurements** | The receipts in [`docs/receipts/`](./docs/receipts/), generating every constant in `packages/budgets`, which is itself generated and never hand-edited |
| **Code** | One Worker. Tests across three runtimes: workerd, node, and a DOM for the interface. The accessibility audit is manual and last covered 30 views with 0 AA violations; screens added since have not been through it. |
| **Licence** | [Apache-2.0](./LICENSE). Security reports go to [`SECURITY.md`](./SECURITY.md), privately. |

## What's distinctive about how it's built

- **Every number has a receipt.** No limit, timeout or budget enters the code without a measurement behind
  it. The constants in `packages/budgets` are generated from [`docs/receipts/`](./docs/receipts/), so you
  cannot write the number, only the measurement.
- **Every assertion has been seen to fail.** A test is mutated against the line it covers before it counts.
- **Names do not overclaim.** A forwarded copy is a `copy`. A provider action is `observed`. A send is
  `handed_over`, never `sent`, until a delivery event says otherwise.
- **Contracts before channels.** Routes are declared once in `packages/contract`. The SDK, the Agent Skill
  and the MCP surface are generated from it, the CLI resolves every path through it, and a route that
  exists in one channel and not another fails a test.
- **A list that stops says so.** Every capped listing (quarantine, suppressions, the outbox, drafts,
  notifications, audit, log) reads one row past its cap and returns `truncated`, and the screen that shows
  the list says so in a sentence, so nobody mistakes the newest N for all of them.
- **The screens you need when it is broken carry no framework.** Sign-in, first-run claim and a locked-out
  `doctor` are server-rendered and load zero bytes of the React bundle (ADR 30).

What each change found on the way (the defects, the measurements that reversed a plan, the tests that
turned out to be theatre) is in [`docs/history.md`](./docs/history.md), in the order it happened.

## What it will need from you

Every Cloudflare setting a Node depends on is listed once, with both ways to put it there, in
[`docs/cloudflare-settings.md`](./docs/cloudflare-settings.md). The Node does the account work through its
own grant, from `/setup`. The dashboard path is kept for builders who would rather do it by hand, and
`doctor` verifies either the same way.

| | |
|---|---|
| A Cloudflare account | Free to create |
| A domain you control | Or a delegated subdomain; `mail.example.com` is the default. **Pointing MX at Cloudflare is required.** |
| **Workers Paid, mandatory** | **$5/month minimum**, 3,000 emails included, then $0.35/1,000 |
| Inbound mail | Unlimited, included |

A 20-person organisation sending 10,000 emails a month costs roughly **$7.45/month**, plus
storage ([receipt](./docs/receipts/cloudflare-plan-costs.md)).

**There is no free tier.** Cloudflare's free plan forces 24-hour queue retention, so a message stuck in a
queue for a day is deleted. A mail system cannot run there. Nothing enforces this: a Worker cannot read its
own account's plan, so `doctor` reports the requirement as unverified and says where to look
([ADR 25](./Mailda-Full-Engineering-Blueprint.md)).

### Deliberate limitations

- **No Gmail or Microsoft 365 connector.** Adopting Mailda means moving mail to it. There is no import
  path for existing history ([why](./Mailda-Full-Engineering-Blueprint.md)).
- **No IMAP, JMAP or SMTP mailbox service.** The web app is the only way to read mail.
- **5 MiB outbound** to arbitrary recipients, and 50 recipients per message. A Node can receive a 25 MiB
  attachment and be unable to reply with it.
- **Cloudflare is a hard dependency.** The Node is not portable to another platform.
- **Not for bulk or marketing mail.** Transactional and operational only.
- **No AI inside the app.** The Butler engine is deterministic and the `llm.*` node types are declared and
  refused. The app goes in your AI instead: the MCP server, the Agent Skill and the SDK are generated from
  the same route contract, and a model you run scores what a policy reads, never decides.
- **The composer is plain text.** To, Cc, Bcc, files and a quoted reply. No HTML, signatures or templates.
  No archive, trash or spam folder; labels are the one way to sort mail (ADR 13).
- **Remote images are blocked until you ask for them.** A tracking pixel tells a third party when your
  colleague opened a message. Mailda will not proxy them either, because that would make your Node fetch
  URLs a stranger chose from inside your own account.
- **Your daily sending limit is invisible, so Mailda measures it.** Cloudflare starts new accounts on a
  quota it does not publish. Mailda counts sends per rolling day and records the count at which you were
  first throttled ([receipt](./docs/receipts/cloudflare-email-sending.md)).
- **Delivery outcomes take two out-of-band steps.** The consumer and the event subscription, above. A
  button-only install that never does them observes nothing, and says so.
- **Paying for Workers is not enough to send.** Arbitrary recipients need a sending domain onboarded with
  SPF and DKIM. Until then a Node can only send to addresses already verified in your account, so it can
  receive a customer's message and be unable to answer it. The outbox says when the capability was never
  verified.
- **Nobody is emailed an invitation.** An administrator mints a secret and hands it over however they
  already trust; the person redeems it and chooses their own password. Emailing it would post a credential
  to an address nobody has verified.
- **Search covers subjects, senders and bodies. Attachments are not indexed.** Body search needs
  `mailbox.content.read`; the weaker `mailbox.metadata.read` reaches subjects and senders only, and so does
  a supervised grant of scope `metadata`. A query whose words are split between a subject and a body finds
  nothing, because the two indexes are separate and that separation is what keeps the authorization
  boundary enforceable.
- **A search returns one page of the best matches, and there is no way to reach the fifty-first.** Narrow
  the words. Relevance is bm25, which shifts as mail arrives, so a cursor into a ranked list would skip and
  repeat rows silently ([receipt](./docs/receipts/message-search-cost.md)).
- **Mail that arrived before the indexes existed is searchable once the backfill reaches it.** Subjects go
  500 a minute, bodies 25, because each body is an R2 read, a decryption and a parse. `doctor` reports the
  two backlogs separately. A body that cannot be parsed is never body-searchable; one whose read failed is
  retried with backoff, and `mailda search repair` requeues chosen messages.
- **A page bounded to a quiet mailbox is bounded by the archive.** Filtering to one mailbox walks receipts
  in time order until it finds enough: 2,410 rows read to return 3 messages from a mailbox holding the
  oldest 3 of 1,200. Fixing it means driving the listing from a per-mailbox ordering
  ([receipt](./docs/receipts/message-page-size.md)).
- **Recovery codes minted before 28 August 2026 carry 80 bits, not 128.** A hash is one-way, so they can
  only be replaced. `doctor` reports them degraded and `mailda recovery-codes rotate` replaces them. A set
  nobody has confirmed is also reported degraded, and `mailda recovery-codes confirm` is typed at a prompt,
  never passed as a flag, because a confirmation a script can make from a file proves nothing about a person
  holding the sheet.
- **A person cannot be removed.** Revoking every relation is the available act, and it takes effect on the
  next request.
- **Passwords are the weakest part of the design, deliberately.** Workers has no native Argon2id, so
  verifiers are PBKDF2 at 600,000 effective iterations. Passkeys are built and are the stronger factor; the
  per-user switch that would turn passwords off (ADR 29) is not
  ([receipt](./docs/receipts/password-hash-cost.md)).
- **Every download is recorded.** The `.eml` button needs `message.export`, which every existing reader was
  granted, and each download is in the trail. The bulk export for a matter needs two approvers, who agree
  to a hash of the query and a hard message count; an export that would exceed the count stops and asks
  again ([the design](./docs/ediscovery-export.md)).
- **A signed token cannot be recalled.** Removing someone's access takes effect on the next request for
  everything authorization-related, but a revoked account keeps a working session for up to ten minutes,
  the access token's lifetime.

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
packages/budgets                       GENERATED, do not edit
packages/runtime                       the clock, id and randomness seam
packages/contract                      the route registry, its schemas, and command schemas
packages/sdk                           GENERATED from the registry, one method per route
packages/cli                           `mailda`: the dispatcher, `support.mjs`, one module per verb under
                                       `verbs/`, and the pure parsers beside them (deploy-plan, preflight, backup)
skills/mailda                          GENERATED, the Agent Skill, from the curated list
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
apps/site                              mailda.site: Astro + Starlight, static; the docs are rendered from this
                                       repository's Markdown at build time (apps/site/scripts/generate-docs.mjs)
docs/history.md                        what each change found, in the order it was found
```

## Contributing

Read [`AGENTS.md`](./AGENTS.md) first. It's short, and it's binding on humans and agents
equally. Work is tracked as a [wayfinder map](https://github.com/Straits-AI/mailda/issues/1):
one issue holds the route, each child issue holds one decision and the argument for it.

Open questions live there. Closed ones record what was rejected and why, which is usually
the more useful half.

## Licence

**[Apache-2.0](./LICENSE).** Chosen 27 August 2026 (#102), and it was not merely unchosen before. It was a
gap with legal effect. Without a licence file, default copyright applies: nobody had permission to reproduce,
modify or deploy this source, which is the entire distribution model. The product described itself as
customer-owned software you run yourself, and that was not something anybody was licensed to do.

