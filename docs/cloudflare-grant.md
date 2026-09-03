# The Node's own Cloudflare grant

How a Node comes to hold authority in its operator's Cloudflare account, what states that connection can be
in, and which of those states the Node **cannot observe**.

Implemented by `apps/node/worker/src/provider/cloudflare-grant.ts` with `migrations/0053_provider_binding.sql`,
surfaced by five routes in `src/index.ts` and two `doctor` findings. Decision record: **ADR 42**, with
[#108][108] for the chart it belongs to and [#162][162] for this layer. Measured facts:
[`cloudflare-oauth-node-as-client.md`][r167] (#167) and [`cloudflare-oauth-endpoints.md`][r168].

## Why the Node is the OAuth client

ADR 42 struck `provision_and_claim` as unavailable to this product and dropped the bootstrap orchestrator with
it. What replaced both is the Node holding its own grant as a **private OAuth client its operator creates**.

The shape is forced by two platform facts rather than chosen:

- Cloudflare supports only the Authorization Code flow for third-party clients — no client credentials, no
  device flow — so a grant requires a browser redirect, and the Node has a browser interface.
- A shared Mailda-owned **public** client cannot serve it. `redirect_uris` are enumerated per client, every
  Node has its own hostname, there is no wildcard, and public visibility requires domain-ownership
  verification. A shared client would land the authorization code on a Mailda-operated redirect, making
  Mailda the custodian **by construction rather than by choice**.

A private client is authorizable only by members of the account that created it — which is the customer — so
**no Mailda-operated service holds a Cloudflare grant at any point.** That is the only shape in which §1's
promise that disconnecting Mailda stops nothing needs no argument, because there was never anything to
disconnect.

## The ceremony, reduced rather than eliminated

The cost ADR 42 accepts, stated plainly: the operator creates an OAuth client in the Cloudflare dashboard and
gives the Node two values. It is reduced by being *guided* — the Node prints the steps with its own redirect
URI filled in and verifies the result, which is the difference between learning the dashboard and following
five printed steps.

`GET /api/provider` returns those steps beside the state, so an operator with no client sees what to do and an
operator already connected can check that the redirect URI Cloudflare holds is still the hostname this Node is
reachable on.

### The scope list is not printed, and that is deliberate

#162 asks for the required scope list prefilled. The Node cannot do that honestly yet. Cloudflare's scope
names correspond to API-token permission names and are enumerated from `GET /client/v4/oauth/scopes`, which
needs a token — and the only scope strings this repository has *seen* are the two in Cloudflare's own
documentation example. Printing eight or ten plausible names beside those would be a fabrication an operator
would discover by pasting them into a picker that does not offer them.

So the ceremony names **capabilities**, each with its reason and the layer that needs it, and the operator
selects the matching scopes in the dashboard's own picker. `unmeasured` is a **required** field on the
response for that reason: an operator following printed steps is entitled to know which parts of them this
Node has verified, and a required field is how that survives a surface being rewritten.

Read capabilities belong to this layer. Write authority belongs to the layer that provisions — an operator
asked for write access to their whole Workers platform in order to display a read-only inventory would be
right to refuse.

## Five states, and one of them is not a measurement

| state | evidence | what it is |
|:--|:--|:--|
| `no_client` | observed | no row. This Node has never been given a client |
| `awaiting_consent` | observed | a client is registered and nobody has consented. A place, not a failure |
| `account_not_selectable` | **reported** | the operator says their account was not listed on the consent screen |
| `consent_granted` | observed | a grant is held. Nothing has been read with it |
| `grant_refused` | observed | Cloudflare rejected the grant this Node holds |

Not `connecting / success / failed`, which is a lie about a flow with this many outcomes.

**`account_not_selectable` is the one the Node cannot observe.** An account administrator can disable public
OAuth app access under **Manage Account → Members → Settings**, and the consequence is that the consent screen
simply does not list the account the operator means — no error, and no response the Node ever sees, because
the authorization request never comes back. Inferring it from a consent that did not return would mean telling
an operator who closed the tab that their administrator had disabled OAuth apps.

So it is reported, the columns are named `unselectable_reported_at` and `unselectable_reported_by`, the API
carries `evidence: "reported"` as a required field, the audit entry says in its own detail that it is somebody's
account rather than a measurement, and `doctor`'s finding says it again in prose. Four places, because a
reported fact read months later is exactly where it gets mistaken for a measured one.

**`grant_refused` is deliberately distinct from `awaiting_consent`**, and the tokens stay in the row. *Never
granted* and *granted and then refused* are different questions, and clearing the row on a refusal would erase
the second one.

### Four states this layer does not have

`inventory_read`, `plan_produced`, `partially_provisioned`, `provisioned_unverified` and `verified` are facts
about an inventory and a deployment plan that this layer does not build. They are **not** declared: a state
nothing can construct is a branch no test can reach, and declaring all nine would look like coverage of a flow
that does not exist. The union grows with the layer that reaches them, and
`test/provider-grant.test.ts` asserts their absence rather than trusting this paragraph.

## What is stored, and what never leaves

`provider_binding` holds one row — a Node is deployed *into* one Cloudflare account, and two rows would be two
answers to *whose account is this*. Three secrets live in it, every one wrapped under the ADR 28 credential
key: the client secret, the access token and the refresh token. A fourth, the PKCE verifier, is wrapped on the
`provider_authorizations` row while a consent is in flight.

`providerStatus` is what `doctor` and every surface read, and it **decrypts nothing** — its column list is
exported so a test can assert the absence of every token column rather than trust a comment. The response
schemas are `.strict()`, which is the third place in this product where that is a security property rather
than tidiness: a handler that grew an `accessToken` field fails the contract suite instead of leaking.

## The flow

1. `PUT /api/provider/client` — the operator pastes the client id and secret. The **redirect URI is derived
   from the request's origin and not taken from the body**: one the caller could choose is one an attacker
   could choose.
2. `POST /api/provider/authorize` — mints a 32-byte `state` and a PKCE verifier, stores both, and answers with
   the URL. PKCE is used although Cloudflare calls it optional for a confidential client: the code arrives
   through the operator's browser to a public hostname, so a code in a history, a proxy log or a referrer is a
   code somebody else holds, and with a verifier it is worth nothing to them. The cost is one SHA-256.
3. `GET /oauth/cloudflare/callback` — validates the nonce, consumes it, exchanges the code with
   `client_secret_basic`, and stores the grant.
4. `doctor` reports the state and compares the four endpoints against Cloudflare's discovery document.

Re-registering the client **discards any grant with it**. A grant belongs to the client that obtained it;
keeping the tokens would leave a row whose `client_id` did not issue its `refresh_token`, and the first
refresh would be refused with an error about the client that an operator would read as a revocation.

### The callback is the only route here with no authority, and that is a decision

It arrives from Cloudflare through the operator's browser. Requiring a Mailda session would fail whenever the
consent was completed in a different browser profile — common, because an operator may hold their Cloudflare
account somewhere other than where they administer their mail.

What protects it is the `state` nonce, three ways: a state this Node never issued is refused, a state already
spent is refused, and an expired one is refused. The second is enforced by the row — the claim is
`UPDATE … WHERE consumed_at IS NULL` and the handler checks `changes` — so two callbacks racing for one state
resolve to exactly one, rather than to whichever handler happened to run first. A session check would be a
second gate answering a different question.

The nonce is consumed **before** the exchange. If the exchange fails the code is already spent at Cloudflare's
end, so a state left open would only permit a retry that could not succeed, and it would leave a verifier alive
after its redirect.

## Four ways a callback does not become a connection

Each writes nothing to the binding, and conflating any of them with a grant is the failure the state list
exists to prevent.

| what happened | refusal | resulting state |
|:--|:--|:--|
| the operator declined | 200, `ok: false`, Cloudflare's own `error` | `awaiting_consent` |
| the token endpoint refused | 200, `ok: false`, e.g. `invalid_grant` | `awaiting_consent` |
| a 200 with no `access_token` | 200, `ok: false`, `http_200` | `awaiting_consent` |
| the token endpoint was unreachable | `E_PROVIDER_EXCHANGE_UNREACHABLE` | `awaiting_consent` |

The last is an **unknown** rather than a failure and is recorded as neither: the code is spent and the Node
cannot tell whether a grant was issued. ADR 40's distinction between a refusal and an unknown, reached in a
second place.

A token-endpoint refusal is not `grant_refused`. That state means Cloudflare rejected a grant this Node
*held*; a failed exchange means it never got one, and conflating them would tell an operator their connection
had been revoked when it had never been made.

## The endpoints are constants with a receipt, checked by `doctor`

| purpose | endpoint |
|:--|:--|
| issuer | `https://dash.cloudflare.com` |
| authorization | `https://dash.cloudflare.com/oauth2/auth` |
| token | `https://dash.cloudflare.com/oauth2/token` |
| revocation | `https://dash.cloudflare.com/oauth2/revoke` |

Read from Cloudflare's discovery document, recorded in [`cloudflare-oauth-endpoints.md`][r168], and **not
fetched at runtime**: `dash.cloudflare.com` answers the RFC 8414 path with a **200 carrying HTML**, the
dashboard's own shell. A Node discovering its endpoints by trusting that 200 would parse a web page and fail
on the authorization path, at the moment an operator was trying to connect. `doctor` compares them against
live discovery instead, which puts the drift check in the thing whose job is detecting drift — and reports a
network failure as `ok`, because a report that degrades when a third party is briefly unreachable is a report
an operator learns to ignore.

`state` must be at least **8 characters**, measured: a shorter one is answered by a redirect carrying
`error=invalid_state` and a message about entropy, which does not read like a configuration problem. The Node
uses 32 random bytes and asserts the minimum anyway.

## Nothing about mail depends on this grant

Revoking it in Cloudflare leaves mail, users, Butlers, schedules, the API and CLI, backup and recovery
working, because none of those paths touch it. `doctor` therefore reports `grant_refused` as **`report` with
`ok: false`** rather than `degraded` — the first finding in that file to use the pair. `degraded` escalates the
verdict, which `mailda deploy` reads as a failure, and a Node that failed a deploy because its operator
revoked a grant on purpose would be failing for a deliberate act.

That the finding is not `ok` says a person may want to act; that the verdict does not move says nothing is
broken. **Drilled rather than asserted is still owed** — see below.

## Withheld from machines, all five routes

Every route here is `operator` tier in `packages/contract/src/agent.ts`, and two of them are `GET`s that the
derivation rule would otherwise have offered.

Registering the client and beginning a consent are **unfinishable by a machine**: the id and secret exist only
after a person has created them in Cloudflare's dashboard, and the authorization URL has to be opened by
whoever holds the account, past Cloudflare's own sign-in challenge. An agent offered these would read a
printed ceremony and have nowhere to perform it.

Reporting an unselectable account is withheld for a sharper reason. It is the one fact in this product recorded
as *reported rather than observed*, and a machine permitted to assert it could write an unfalsifiable claim
about an administrator's account settings into the audit trail — whose whole value is that the two kinds of
fact stay distinguishable.

`GET /oauth/cloudflare/callback` is withheld because it is **not a read at all**: it consumes a single-use
nonce, so a machine that fetched it would spend an operator's consent in flight.

## Still owed by this layer

Stated here rather than left to be discovered:

- **The scope matrix**, measured against a real consent. The mechanism to produce it ships — after a grant
  exists the Node can enumerate scopes with it — but no figures exist and nothing here pretends they do.
- **Whether Cloudflare's token response names the account.** No Node has held a grant, so it is unmeasured.
  The code reads `account_id` if present and leaves it null otherwise, and every surface says *not yet
  determined* rather than showing an empty account.
- **The revocation drill.** The paragraph above is an argument from what the code touches, not a measurement.
- **Whether a private client can use `client_credentials`.** Cloudflare's discovery document advertises it and
  its documentation says third-party clients cannot use it. If the document is right, ADR 42's browser
  ceremony is unnecessary — [`cloudflare-oauth-endpoints.md`][r168] names the two-call probe that would settle
  it. Until then the Node does authorization-code, because trusting the document over the documentation would
  fail inside the token exchange with an error about the client rather than about the flow.
- **Inventory read through the grant.** `deploy --plan` below reads the account through the operator's own
  `wrangler` rather than through this grant, because a plan for a *first install* runs before there is a Node
  to hold one. Reading zones and Email Service state through the grant, for a Node that already exists, is
  what the ownership page needs and is not built.

[108]: https://github.com/Straits-AI/mailda/issues/108
[162]: https://github.com/Straits-AI/mailda/issues/162
[r167]: receipts/cloudflare-oauth-node-as-client.md
[r168]: receipts/cloudflare-oauth-endpoints.md

## `deploy --plan`: what a deploy would do, before it does any of it

`mailda deploy --plan` prints the plan and acts on nothing. It exits 0 for `install` and `redeploy`, and 1 for
`blocked` or `unknown` — so it is usable as a gate.

**It reads the account through the operator's own `wrangler`, not through the grant above.** A plan for a first
install runs before there is a Node to hold a grant, so the chicken-and-egg is resolved by using the
credentials the operator already has. The grant is for a Node that exists.

### Three verbs, because a create-only plan is wrong in the expensive direction

`packages/cli/src/deploy-plan.mjs` is pure — values in, values out — for `promotionVerdict`'s reason: the gate
that function replaced was an inline `if` asserted *lexically*, and the assertion survived the condition being
mutated to `if (false && …)`.

| disposition | the account | what a deploy actually does |
|:--|:--|:--|
| `create` | absent | provisions it. The only case a create-only plan gets right |
| `linked` | present, bound to this Worker | nothing. An ordinary redeploy |
| `cannot_adopt` | present, no Worker | **fails on it**, after creating whatever comes before it |
| `orphaned` | absent, Worker exists | **reports success and changes nothing** |
| `stolen` | present, another script owns it | **succeeds and takes it** — exit 0, no warning |
| `unknown` | list unreadable | anything. The plan names the gap instead of guessing |

Three of those six are a deploy doing something other than what it looks like it does, and every one is
measured — `deploy-drill-live-account.md` for the Workflow reassignment and the ordering, the runbook for the
linked-binding repair that isn't one.

`orphaned` is the worst, because the deploy **succeeds**: the binding is linked server-side, so the Worker
keeps reading a dead resource id while the CLI resolves the same name to a live one. It is also the one
blocking disposition that offers **no unwind** — a plan that printed a teardown there would be telling an
operator to destroy a live Node's evidence bucket to fix its database.

### The names are derived, because wrangler derives them

`d1_databases`, `r2_buckets` and `queues` declare a binding and **no name and no id** — ADR 24 requires the
repository byte-identical across installs. wrangler names them `<worker>-<binding>`, lowercased and
hyphenated, which the drill measured on two Nodes: `mailda` got `mailda-catalog`, `mailda-evidence`,
`mailda-sending-events`, and `mailda2` got the `mailda2-` set.

**The Workflow is the exception and it is the whole of #99.** Its name is written in the config, so it does
not follow the Worker's — and a Workflow is owned by exactly one script. `mailda deploy` already refuses a
deploy that would take somebody else's; the plan reports it before the refusal, which is the difference
between being stopped and knowing why.

### The unwind is an order, and every step was found by getting it wrong

1. `wrangler queues consumer worker remove <queue> <worker>` — a Worker cannot be deleted while it consumes a
   queue (`code: 10064`).
2. `wrangler delete --env "" --force`.
3. R2 objects per key, then the bucket — a non-empty bucket refuses.
4. `wrangler d1 delete <name> -y`.
5. `wrangler queues delete <name>`.
6. `wrangler workflows delete <name>` — a Workflow **survives its script's deletion**, and its name is the one
   that collides between Nodes.

The plan prints only the steps that apply. A leftover database on an account with no Worker needs step 4 and
nothing else, and telling an operator to delete a Worker that is not there is how a teardown loses the reader's
trust in the steps that *are* necessary.

This sequence is also in [`disaster-recovery.md`](./disaster-recovery.md), which is where it was first written
down. The two now say the same thing in two places, which is a correspondence worth naming: the runbook is
prose for a person at three in the morning, and `UNWIND_ORDER` is what the plan filters. If they ever disagree,
the code is the one that ran.

### What the plan cannot see

**Names, not ids.** It reports whether a name is taken, not whether a present resource is the one this
Worker's binding points at. For `orphaned` that distinction *is* the defect, which is why the plan reports it
as one — but a resource renamed out from under a live binding would read as `orphaned` plus `cannot_adopt`
rather than as the one thing it is.

**An unread list does not block.** `wrangler workflows list` needs a permission a deploy token may not carry,
and refusing a plan because a *diagnostic* was unavailable is the wrong direction — the same trade the deploy
path makes. The plan names it under `not checked` instead. The Worker's own existence is the exception and
**does** stop the plan: the two deploy paths differ, and being wrong there means skipping the canary on a live
Node.
