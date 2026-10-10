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
account if you have several, what to call the Node (`mailda` by default) and, if you want one, a hostname of
your own for it (a zone from the list, then the label; Enter keeps `<worker>.<account>.workers.dev`), deploys
the Worker with its D1, R2 and queue, attaches the hostname, and applies the schema. Then it claims the Node from the same terminal: you choose the
first administrator's email and password, and the ten recovery codes are printed once. Then it asks one more
question, which domain this Node should receive mail at, and with the same Cloudflare sign-in you already
gave it enables routing on that subdomain, writes the rule to the Node, onboards the domain for sending,
subscribes delivery events to the Node's queue, and reads each back. The mailbox's first address is asked as the
part before `@domain`, and defaults to the local part of the email you signed in with when that email is on the
domain and no Email Routing rule of its own sends it elsewhere; the install's last line says which address you
sign in as and which one mail goes out as. The Node receives when the install ends. No dashboard, no API token, no OAuth client ([receipt](./docs/receipts/wrangler-login-reach.md)).
Decline a question and the Node's own screens do the same thing later. Nothing in your account changes
before it asks. Giving the Node a Cloudflare credential of its own, an API token pasted once on *Setup*, is
optional and only for changing that setup from the browser later; the OAuth client it replaced is gone
([ADR 42](./Mailda-Full-Engineering-Blueprint.md), amended 26 September 2026). From a clone, the same is `pnpm install && pnpm mailda install`; on Windows
without a bash, run that in PowerShell.

**What the CLI asks wrangler, and how.** It reuses wrangler's login through `wrangler auth token --json`, so a
login kept in the OS keychain or under a wrangler profile works, and the token never reaches the terminal or
wrangler's own debug log. A Global API Key (`CLOUDFLARE_API_KEY` with `CLOUDFLARE_EMAIL`) is refused, since
wrangler would deploy with it and the Node takes a Bearer token; set `CLOUDFLARE_API_TOKEN` instead. Every
wrangler it starts runs with `WRANGLER_SEND_METRICS=false` unless you set that variable yourself, because
wrangler sends usage metrics by default; wrangler's own npm update check is not turned off. The answers it reads
are asked for as JSON at wrangler's default log level and without colour, whatever `WRANGLER_LOG` or
`FORCE_COLOR` your shell sets. It needs wrangler 4.97 or later
([receipt](./docs/receipts/workflow-provisioning.md)); the JSON answers alone arrived in 4.65
([receipt](./docs/receipts/wrangler-json-output.md)).

**After the install.** Open the Node. Until it has an address and mail routed to it, it shows the next
setup step and nothing else, with the command that does it; once it has both, the inbox. A Node claimed
before the install could set it up finishes with `pnpm mailda setup` from the clone, which does the same
receiving, sending and delivery-outcomes setup without deploying. Then send a message to the address you
chose: it appears in the inbox, and that is the proof.

**Adding people.** On *People*, mint an invitation for the person's sign-in address: the link is shown to
you once and not mailed, you hand it over however you already trust, and the person opens it and chooses
a password. They hold nothing until you grant them a relation on a mailbox, on the same screen: each mailbox is a
card with a grid of people and permissions, one box each, and *What each permission means* under it. Tick *Also give them a mailbox at* to make a mailbox for them at
an address on your domain as you invite them; it is granted to nobody but you, as the creator of any mailbox
is, and they hold nothing on it. Once they have an account with that address and hold nothing on it directly,
*People* asks whether to give it to them, naming the two relations it grants, and never asks again about a
mailbox from which you withdrew a relation of theirs. Address fields there
take the part before the `@`, with your domain beside it. To receive at an address of their own, say
`user1@example.com`, add that address to a mailbox they hold (*People* → *Add an address*); on a domain
whose catch-all points at the Node nothing else is needed, unless the address has an Email Routing rule of
its own sending it elsewhere or disabled, which the screen names; on a subdomain the Node writes the routing
rule in the same act, or says exactly what to run if it could not. The composer shows the address a message
goes out from, the mailbox's and never the email you sign in with, and says so when it cannot read it. Each
mailbox lists its addresses there as a table, with where each forwards, *Change forwards* and *Remove*: the rule goes with it when this Node wrote it
(one it took over is left, and the screen names the put-back), and an address that has received mail stays,
by name, because every message under it is filed through that address. Mailboxes and teams are renamed on
the same screen.

The same command adds a second Node, and it can redeploy an existing one; updating is its own command,
below, because an update also has to pull the release and, when a migration is pending, back the Node up first. It lists the Nodes the account already has (every
Node registers a `ButlerRun` Workflow under its own name), and the name you give decides: an existing name
is upgraded through the canary, which needs the Node's URL once and remembers it in a git-ignored
`.mailda/nodes.json`; a new name deploys another Node beside the first, with every resource named from it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Straits-AI/mailda)

The button does the deploy half without a terminal: it provisions D1 and R2, builds the Worker, and writes
no ids into your clone; the Node applies its own schema when it is claimed. You then need the claim secret,
which `pnpm mailda claim-secret` prints from a clone. The first click produced a dead Node, and what that
found and fixed is in the [receipt](./docs/receipts/deploy-button-install.md).

**Delivery outcomes need two things in your account.** Delivery outcomes (`accepted`, `bounced`, per
recipient) arrive on a queue, and observing them needs a consumer on that queue and an `email.sending` event
subscription publishing to it. The installer's deploy attaches the consumer, and its setup step creates the
subscription with the same wrangler login, attaching the consumer too if nothing consumes the queue yet. The button
does neither: on a button-deployed Node, or one whose setup step was declined, `pnpm mailda setup` from a clone does
both, and so does the Node's own Setup screen once the Node holds an API token for your account
([`docs/cloudflare-settings.md`](./docs/cloudflare-settings.md)). Until both exist every recipient stays
`unobserved`, and `mailda doctor` names whichever half is missing rather than letting silence read as
"nothing bounced" ([receipt](./docs/receipts/queue-provisioning.md)).

One case no subscription fixes: in the one case measured, mail to a verified destination address of your own
account (one verified for Email Routing forwarding) produced no delivery event at all
([receipt](./docs/receipts/email-sending-events.md), which also records the send that told it apart from
delivery outside Cloudflare, and that it rests on one verified address). The Node reads which of its recipients those are (`mailda setup` and `mailda upgrade` with wrangler's
login, or the Setup screen with a token carrying the optional Email Routing Addresses: Edit), the Outbox marks them `verified destination`, and
`mailda doctor` does not call that silence blind.

**A domain that already routes mail.** Setup lists the Email Routing rules on your zone and lets you
point one at the Node. That replaces where the address goes (Cloudflare allows one action per rule), the
previous destination is kept on the audit trail and written into the rule's own name, and *put back* restores
it. Every rule can be pointed back; mail that arrived here meanwhile stays here. Existing rules for other
addresses are left alone.

`mailda install`, `mailda setup` and every `mailda upgrade` end with the same list for the name the Node
receives at: each address with a rule of its own, where it goes, and the one change the Node offers for it.
These are the defaults, and how to change each:

- **One y/N, only when a rule can be offered.** On a zone whose rules you keep on purpose, it asks on every
  upgrade; nothing remembers a "no". Answer N, or run with `--yes`.
- **Every answer can be taken back before anything changes.** Each address's choice ends with *← back to the
  previous address*, each mailbox choice with *← back to the choices for* that address, and the plan numbers every
  address: answer a number at *Apply?* to ask that one again.
- **Each rule defaults to "leave it".** A forward (often someone's personal mail) offers *receive here only*:
  the destination gets nothing more, and replies sent from there are not seen here. A rule to another Worker
  offers *receive here*: that Worker stops receiving the address, and this Node cannot see what it did. A drop
  offers *receive here*: mail Cloudflare was discarding is kept from now on. A forward also offers *receive
  here and keep forwarding to X* (ADR 47): the Node stores each message, then forwards it to X, the rule's own
  verified destination. The copy leaves before the Node scans it, a failed forward is shown on People and not
  told to the sender, and Cloudflare reports no delivery for X. A rule to another Worker also offers *receive here and
  forward to addresses you choose*, filled in from the verified destinations that Worker's code names (read with
  wrangler's login; you confirm or change them), up to `forward.max_destinations`. Any address can forward to several
  verified destinations later: People's *Change forwards*, or `mailda provider --set-forwards <address> --to a,b`
  (no `--to` stops it). `mailda provider --forwards` lists every destination with its latest attempt;
  `mailda provider --destinations [--addresses]` and `--add-destination <email>` list and register the account's
  destination addresses (a new one waits for verification until someone there clicks Cloudflare's link).
- **Copies are off.** An address that forwards may opt in to a copy (`mailda provider --copy <address> on`,
  People, or `--copy` with `--forward keep` or `--forward-to`): when Cloudflare refuses a forward as not verified, the
  message is sent on from the address itself through Email Sending, one copy to every destination refused that way. The recipient sees it from "Alice via \<mailbox>", replies go
  to Alice, the body is hers as written; up to 5 MiB (`email.outbound.max_bytes`); a message with a dangerous
  attachment, a quarantined one or one that failed DMARC is not copied; each copy counts towards today's sending and
  is in the Outbox like any send, sealed under the administrator who turned copies on.
- **A forward goes only into a mailbox you choose**, a new one named after the address offered first (or the
  mailbox already named after it, never a second), never into the only mailbox by default (the API refuses it,
  `E_ROUTING_FORWARD_NEEDS_MAILBOX`).
- **Rules on names the Node does not receive for** (another subdomain) are a count line with
  `mailda provider --routing-rules <name>` to list them.
- **`--yes`, or no terminal, changes no rule**: it prints the list and the exact `mailda provider --take-over`
  command for each, with `--mailbox <mailbox id>` and the mailboxes listed wherever one must be chosen, and
  `--forward stop`, `--forward keep` and `--forward keep --copy` for a forward; the interactive step offers the same
  three, keep-with-copies in the Node's own sentence about what a copy is.
- Disabled rules, rules with several destinations, duplicate rules and zones with subaddressing on are listed
  with the reason and never offered.

**Before deleting a Node, put back every rule it took over**
(`mailda provider --routing-rules <domain>` shows each with its put-back). If it is already gone, a rule taken
over from 1 October 2026 records in its name where it went, and `mailda provider --put-back <rule id> --domain
<domain> --without-node` restores it with your own wrangler login, without the Node and without an audit entry.
Two kinds record nothing in their name and can only be put back through the Node, so do it before deleting it:
the **catch-all** (the receiving step's take-over), and any rule taken over before 1 October 2026. The step
also says so for any rule whose name did not read back as written. On a zone's own name the receiving step offers the **catch-all** instead: one
rule pointing the domain's unmatched mail here, its previous target kept for a put-back, and every address
without a rule of its own from then on managed on People inside the Node. An enabled rule of an address's own
outranks the catch-all (of a disabled one Cloudflare does not say), so `mailda install`, `mailda setup`, `mailda provider --onboard-receiving` and the Setup screen
list each such address and where it goes before the choice, and never change those rules; on a subdomain Cloudflare allows literal rules only, so adding an
address on People writes its rule in the same act. `mailda provider --routing-rules <domain>` is the same
from the CLI. Setup and the CLI offer a take-over or a put-back only where the Node would do it: a disabled
rule, a rule with more than one destination, an address with more than one rule, and a rule this Node never
took over are listed with the refusal instead, by name, and a zone with subaddressing on is refused when you
act. An address already on People keeps its mailbox, and the take-over names it. Each take-over and put-back
reads the rule back and says so when Cloudflare holds something other than what was sent, including when a
lost answer means the change may have been applied.

**A second Node in the same account.** Give the installer a new name; `mailda deploy --name <worker>` is
the same from a script. Either derives the Worker, the Workflow and every other resource from that name
into a git-ignored config; first install measured at 108 s.

**Updating an installed Node** is one command, run where the install left the clone:

```sh
curl -fsSL https://mailda.site/update.sh | bash
```

It hands over to `pnpm mailda upgrade`, which is the same thing from a clone. It fetches the release remote,
fast-forwards when the clone is behind and says so, reinstalls, asks which Node
if the account has several and, when Cloudflare lists no custom domain on the Node, whether to give it a hostname of
your own (the install's question: a zone, then a label such as `mail`, so `mail.example.com`; Enter keeps workers.dev,
and `--hostname` answers it ahead). A Node that has one is checked at it, and keeps its workers.dev address too. Each
command prints its steps first, numbered, then `Step 3 of 7 · …` as each begins. It lists every
pending migration by phase, *expand* (adds, safe for the running version) or *contract* (drops or narrows,
refused unless `--contract`), and asks once. When a migration is pending it then takes a `mailda backup` into a
git-ignored `.mailda/backups/<node>/<time>` directory before the schema is touched, refusing to go on without one;
a code-only release takes none, and says so (`--backup` takes one anyway). Then it runs the same expand, canary, gate, promote sequence as
`mailda deploy`. A Node that was never set up to receive is offered the install's setup step afterwards,
with the same sign-in. Whenever it can sign in to the Node, it then reads, with the same login, which of the
Node's recipients are verified destinations of the account, and prints how many; when wrangler gives it no token
it prints why, in wrangler's words, and goes on. It never creates a Node; `mailda install` with an existing name still upgrades too, but
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
| **Mail security is thin** | The receiving server's SPF, DKIM and DMARC verdict is stored; a DMARC failure is shown on the message and its row in the list, and the full verdict is one click away in the message's details. Attachments are judged by name and magic bytes, links by where they really go, and a mailbox can hold back mail its sender's domain disowns or that carries a dangerous attachment. A hard-bounced recipient is refused at the seal until an administrator vouches for it. A send policy can hold, gate or refuse a reply to a message whose DMARC failed, which is where a forged invoice does its damage. A classifier you run in your own account can hold a delivery through the API with its reason and score; the Node ships none ([example](./examples/hold-agent/)). A ZIP is listed without being opened, and one naming a program is held. Leaving, a program, a script, a program under a document's name, or a ZIP naming one is refused unless its author sends it anyway (a zip of source code is the usual case), with a warning in the composer, and the seal's audit entry records which attached files it let through, by position. A mailbox can bound attachment size and type, in and out. Absent: inbound acts beyond the quarantine switch, RAR and 7z listings, and any classifier, because Workers AI has none for mail ([receipt](./docs/receipts/workers-ai-classifier.md)). [`docs/mail-security.md`](./docs/mail-security.md). |
| **English and Simplified Chinese** | The interface's words are a typed catalog per locale (ADR 46): a missing translation does not compile, and a check with the TypeScript checker counts every string not yet in the catalog, file by file, down to zero, which it is. Simplified Chinese (简体中文, the mark 淼达) is offered beside English since 2 October 2026: a browser asking for `zh`, `zh-CN`, `zh-SG` or `zh-MY` gets it (Traditional `zh-TW`, `zh-HK` and `zh-MO` do not), Settings > Language and a switch before sign-in choose either, and `?locale=` picks one for a page load. Every screen is migrated, those before sign-in included, a pseudo-locale render of every route and its error states finds no English left bare, and every glossary word is confirmed by the owner, the last layer's 25 accepted as proposed in the working session on 2 October 2026 without a review page. A message is drawn in its own script's forms whatever the interface's language, from its charset, then its `Content-Language`. The API, the CLI's machine-read output, doctor's text, MCP and the SDK stay English permanently, for the programs that parse them. [`docs/i18n.md`](./docs/i18n.md). |

What it is good for now: a design-partner alpha, a non-critical shared mailbox, and exercising the
governance and deterministic-automation model, which is further along than anything else here.

What exists today:

| | |
|---|---|
| **Product contract** | [`Mailda-Full-Engineering-Blueprint.md`](./Mailda-Full-Engineering-Blueprint.md): the target state, and §29's locked architectural decisions |
| **Working agreement** | [`AGENTS.md`](./AGENTS.md): how decisions get made and what counts as done |
| **Decisions taken** | Recorded with full reasoning and rejected alternatives, on the [issue tracker](https://github.com/Straits-AI/mailda/issues?q=is%3Aissue) |
| **Measurements** | The receipts in [`docs/receipts/`](./docs/receipts/), generating every constant in `packages/budgets`, which is itself generated and never hand-edited |
| **Code** | One Worker. Tests across three runtimes: workerd, node, and a DOM for the interface. The accessibility audit is manual. Its last run, on 27 September 2026 after the fourth round of the redesign's review, covered 146 views (per theme, the sign-in page, the invitation form, a refused sign-in, the eighteen routes at 1280, 1024 and 390 px wide, each grown until nothing on it scrolls vertically, fifteen opened states and the first-run gate, each audited only once it had loaded; the Butler resume form had no paused Butler to open) with 0 AA violations. The opened states are audited at one size and not grown, the pages before sign-in at 1280 px wide only; the contrast it could not decide under an overlay is computed from the tokens instead ([`docs/application-shell.md`](./docs/application-shell.md), *Accessibility*). The spacing check is manual too: every route and opened state at 1440 and 390 px, both themes, every pair of controls under 8px apart; its last run, on 29 September 2026, measured 132 views with none (*Spacing*, same document). |
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
[`docs/cloudflare-settings.md`](./docs/cloudflare-settings.md). The Node does the account work with
wrangler's login at install and, later, with its own API token from `/setup`. The dashboard path is kept
for builders who would rather do it by hand, and `doctor` verifies either the same way.

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
- **A session that ends by itself loses what was typed in the last second and a half.** A draft saves 1.5 s
  after the last keystroke. *Sign out* and *Sign out everywhere* save the open draft first, and keep you signed
  in with the Node's reason when it will not take it. A session the Node ends (a failed renewal, a revocation
  from another device) is already gone when the page hears of it, so words typed in that pause are lost with
  nothing to say so ([`docs/application-shell.md`](./docs/application-shell.md), *Drafts*).
- **Archive and Trash are yours alone and always restorable.** Nothing you place is deleted and there is no
  purge (ADR 45). No spam folder; Quarantine is an administrator's.
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
- **Until a deploy is promoted, an outbox row can show a reason its state no longer has.** Versions before 1
  October 2026 kept a gate's reason, such as *too much, too fast*, and its sentence after the send moved on or was
  cancelled. Such a version keeps serving until the new one is promoted, indefinitely if its canary check fails.
  Once a fixed version is promoted, the scheduled handler clears them within a minute, or a few for more than 500.
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
  retried with backoff, and `mailda search repair` or the `body_index_failed` finding on the Doctor screen lists
  them with the reason each failed and requeues chosen messages.
- **Chinese, Japanese and Korean are found by any part of a sentence.** `发票` finds `关于发票的问题`, `123` finds
  `订单123`, and `abc` finds full-width `ＡＢＣ`. Runs are indexed as overlapping character pairs, which costs about
  3.8 times the index storage for Chinese text and nothing for English
  ([receipt](./docs/receipts/cjk-search-bigrams.md)). Thai, Lao, Khmer and Myanmar are not yet covered.
- **A search may carry at most 12 words, and at most 128 index terms; more is refused, not cut.** A run of
  Chinese, Japanese or Korean without spaces counts as one word and about one term a character, so a pasted
  paragraph is refused with `E_SEARCH_TOO_LONG` rather than searched slowly.
- **Mail indexed before this release is re-indexed on its own, including mail the previous version indexes
  during a deploy or after a rollback.** Each message records the form its search rows were written in, and the
  backfills rewrite whatever is older, subjects 500 a minute and bodies 25. Meanwhile such mail is found by its
  words in Latin and other spaced scripts, but by Chinese, Japanese or Korean only when the search is the first
  one or two characters of a run, and `doctor`'s `search_index_backlog` and `body_index_backlog` count it. After a
  rollback the previous version finds the re-indexed mail the same limited way until the code rolls forward.
- **A restored Node rebuilds both search indexes.** `mailda backup` leaves the indexes out (they are derived) and
  ends its dump by marking every message not yet indexed, so the backfills rebuild them from the evidence.
- **A very long body is searchable only in its first 2,000,000 bytes of indexed text** (D1's limit on one
  string; a Chinese body passes it at about 300,000 characters). Words after that point are not found, and
  `doctor`'s `body_index_partial` counts such messages and names the limit and the largest size.
- **A row's preview and sender name appear on older mail once a backfill reaches it**, up to
  `PREVIEW_BACKFILL_LIMIT` (`src/preview.ts`) on each scheduled pass that finds the body and authentication
  backfills idle; `doctor` reports the backlog (`preview_backlog`). A row the
  backfill gave up on (its evidence missing, or three reads failing) waits for an administrator's
  `POST /api/maintenance/requeue-previews`, the *Requeue failed previews* button under that finding on the Doctor
  screen. A preview reads only
  the first 16,384 characters of a body, so a reply under a longer quote has none. A supervised reader sees no
  preview: opening the message is the recorded act.
- **A page bounded to a quiet mailbox is bounded by the archive.** Filtering to one mailbox walks receipts
  in time order until it finds enough: 2,410 rows read to return 3 messages from a mailbox holding the
  oldest 3 of 1,200. Fixing it means driving the listing from a per-mailbox ordering
  ([receipt](./docs/receipts/message-page-size.md)).
- **The Inbox, Unread and Mine look back through at most `messages.max_lookback` of the messages you can see
  per request** and offer *Look further back* rather than walking the whole archive
  ([receipt](./docs/receipts/message-page-size.md)); Archive and Trash cost a page.
- **Recovery codes minted before 28 August 2026 carry 80 bits, not 128.** A hash is one-way, so they can
  only be replaced. `doctor` reports them degraded and `mailda recovery-codes rotate`, or the same act on the
  Doctor screen's `recovery_escrow` finding, replaces them. A set nobody has confirmed is also reported
  degraded, and `mailda recovery-codes confirm` is typed at a prompt, never passed as a flag, because a
  confirmation a script can make from a file proves nothing about a person holding the sheet. The screen
  holds to the same rule: it shows the ten once and never fills the confirm field in for you.
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
docs/cloudflare-grant.md               the two credentials a Node acts with: wrangler's login carried on
                                       one request at install, and the optional stored API token for the
                                       browser; what is stored, and what is still owed
docs/agents/                           issue tracker and domain-doc conventions
packages/receipts                      generates constants from receipts
packages/budgets                       GENERATED, do not edit
packages/runtime                       the clock, id and randomness seam
packages/contract                      the route registry, its schemas, and command schemas
packages/sdk                           GENERATED from the registry, one method per route; publishable to npm as
                                       `@mailda/sdk`, built from source on pack (CONTRIBUTING.md)
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
apps/node/worker/src/i18n              the interface's words: a typed catalog per locale and area, the runtime
                                       over Intl, the glossary (ADR 46)
apps/node/worker/scripts               operator tools: password reset, queue consumer attach, axe, spacing
apps/node/worker/src/doctor.ts         checks the runtime claims every decision made: the report, the
                                       meter and the verdict; the checks themselves are in src/doctor/
apps/site                              mailda.site: Astro + Starlight, static; the docs are rendered from this
                                       repository's Markdown at build time (apps/site/scripts/generate-docs.mjs)
docs/history.md                        what each change found, in the order it was found
docs/i18n.md                           the interface's languages: the catalog, the preview flag, the glossary
                                       and its confirmation, the register rules, and the checks
docs/zh-cn/                            Simplified Chinese translations of the docs an operator needs first,
                                       each held to its English by a recorded hash (docs/i18n.md)
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

