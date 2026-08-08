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

The CLI path has no such caveat: clone, `pnpm install`, `pnpm run deploy`. It provisions D1 and R2 on
first deploy ([receipt](./docs/receipts/r2-auto-provisioning.md)) and applies the schema.

---

## Status: designed, not built

**This is not deployable software yet.** Saying otherwise would be the kind of overclaim
the project's own working agreement forbids.

What exists today:

| | |
|---|---|
| **Product contract** | [`Mailda-Full-Engineering-Blueprint.md`](./Mailda-Full-Engineering-Blueprint.md) — 2,549 lines specifying the target state, with 41 locked architectural decisions |
| **Working agreement** | [`AGENTS.md`](./AGENTS.md) — how decisions get made and what counts as done |
| **Decisions taken** | 30 recorded with full reasoning and rejected alternatives, on the [issue tracker](https://github.com/Straits-AI/mailda/issues/1) |
| **Measurements** | 25 receipts in [`docs/receipts/`](./docs/receipts/) generating 151 verified constants |
| **Code** | A measurement harness and one Worker. 364 tests, checked on every push. Not a product. |

**It can send to more than one person, which it never could before.** `EmailMessage` takes one address, so
the old code joined recipients with commas into a single malformed one — a `Cc` refused the whole send.
Mailda now submits the same stored bytes once per recipient, which costs nothing extra (measured: Cloudflare
already counts one three-recipient send as three) and makes `Bcc` correct rather than merely possible, since
a real Bcc needs its own envelope. Proven live: one send, three recipients, three submissions, three
outcomes — **accepted, bounced, bounced** — each with its own message id.

**A Node that cannot see delivery outcomes says so.** The event subscription that carries them is an
account-level object outside the Worker's config, so it can be absent, deleted, or pointed at the wrong
domain — and nothing about a Node in that state looks wrong: sends hand over, the outbox fills, and every
recipient sits unobserved forever. `doctor` compares what was handed over against what came back and names
the silence, because "no bounces" must not be able to mean "nothing heard".

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
