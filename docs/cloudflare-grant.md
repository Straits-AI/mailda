# The Node's own Cloudflare grant

How a Node comes to hold authority in its operator's Cloudflare account, what states that connection can be
in, and which of those states the Node **cannot observe**.

Implemented by `apps/node/worker/src/provider/cloudflare-grant.ts` with `migrations/0053_provider_binding.sql`,
surfaced by five routes in `src/routes/provider.ts` and two `doctor` findings. Decision record: **ADR 42**, with
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

The full list of what a Node needs from the account — what this grant can do, what a person still must, and
how `doctor` checks each — is [`cloudflare-settings.md`](./cloudflare-settings.md).

The cost ADR 42 accepts, stated plainly: the operator creates an OAuth client in the Cloudflare dashboard and
gives the Node two values. It is reduced by being *guided* — the Node prints the steps with its own redirect
URI filled in and verifies the result, which is the difference between learning the dashboard and following
five printed steps.

`GET /api/provider` returns those steps beside the state, so an operator with no client sees what to do and an
operator already connected can check that the redirect URI Cloudflare holds is still the hostname this Node is
reachable on.

### The scope list is printed now, and for four months it was not

This section used to say the scope list *"is not printed, and that is deliberate"*, arguing that Cloudflare's
scope names are enumerated from an endpoint needing a token and that printing plausible ones would be a
fabrication. That argument was sound and it has been settled: fourteen scopes were probed individually and
all fourteen granted, recorded in [`cloudflare-oauth-scopes.md`][r-scopes]. `ceremony.scopes` carries the
strings, and two real consents proved it had to — **a request naming no scope is granted none.**

`readOnlyExists` rides beside each one because four have no `:read` form in Cloudflare's vocabulary. Without
it an operator reading `zone-settings.write` on the list concludes this Node asked for more than it needed,
when write was the only shape the permission comes in.

`unmeasured` remains a **required** field: an operator following printed steps is entitled to know which
parts of them this Node has verified, and a required field is how that survives a surface being rewritten.
The `/setup` screen renders it under the scope table rather than in a document nobody opened.

Read capabilities belong to this layer. Write authority belongs to the layer that provisions — an operator
asked for write access to their whole Workers platform in order to display a read-only inventory would be
right to refuse.

[r-scopes]: receipts/cloudflare-oauth-scopes.md

### The screen, and the nineteen routes that did not have one

Every route in this document was, until #210, reachable only through `mailda provider …`. The person these
routes exist for is whoever owns the Cloudflare account, and requiring them to install a CLI and hold an API
token is requiring them to be somebody else — so the honest answer to *"can a non-technical operator run
this?"* was no, regardless of how carefully each refusal was worded.

`/setup` is the screen. It adds no endpoint: it sends what the CLI sends and renders the same refusals in the
same words. Two steps stay in the dashboard because they cannot leave it — an OAuth client this Node is not
allowed to create for itself, and a consent only a human may give.

`GET /oauth/cloudflare/callback` negotiates on `Accept`: a page for a browser, JSON for everything else. That
route is *always* reached by a browser — it is the redirect URI — and it answered with
`{"consent":{"ok":true,…}}`, ending a flow written in English at a parse error a person has no way to read.
Content negotiation rather than a second path, because Cloudflare holds exactly one redirect URI and a second
would be one more thing to register wrongly. `error_description` is a query parameter reflected onto that
page, on the one route here with no session check, so it is escaped — that is this route's one untrusted
input, not a hygiene measure.

The page wears the theme (16 September 2026). Its first version stacked every sentence inside the wordmark's
header band with an empty page beneath, which is what an operator described as *"does not match our
theme"*. It is the pre-authentication skeleton now — wordmark rack, lede with the state as the heading,
a panel with Cloudflare's own words as a refusal or the account as a fact, and a primary control to
continue. The same audit found two tone classes the screens used and the sheet never defined (`.dim`,
`.bad`) and a duplicate `.ledger-head` rule that rendered every ledger heading at weight 400; all three are
fixed in the sheet. The logo is absent by decision, not omission: `MARK_IS_AUTHORED` is false until the
traced mark reads as an M at 26px (`docs/history.md`, *the mark is not shipped, because it does not work*).

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

## Nothing about mail depends on this grant — drilled, 10 September 2026

Against the live Node: its grant was put into `grant_refused` and the same four things were asked before and
after.

| | before | with the grant refused |
|:--|:--|:--|
| `/health` | claimed, 0 pending | unchanged |
| sign-in (CLI session) | works | works |
| search | answers | answers |
| `doctor` | exit 0 | **exit 0**, the grant reported as a note |

Then restored, and the state read back `consent_granted`.

**A drill is a fact about one afternoon.** What keeps the claim true is that nothing outside two files can
reach the grant at all, and `test/node/provider-blast-radius.test.ts` holds that as a closed world over the
whole source tree — by import *and* by raw reference to `provider_binding`, since SQL would reach the same row
without naming the module. Permitted: `routes/provider.ts`, which manages it, and `doctor/node.ts`, which reports it. An
import added to `dispatch.ts` fails the test; so does raising the finding's severity to `degraded`, which
would make `mailda deploy` fail on a revocation an operator performed deliberately.

Both were mutated and both fail.

**What the drill does not cover:** revoking at Cloudflare's end — *My Profile → Manage OAuth authorizations →
Revoke* — which is one click and would make the stored refresh token stop working for real. This drilled the
Node's behaviour in that state, which is the half #162 asks about; whether Cloudflare's revocation produces
exactly this state is inferred from the error it returns, not observed.

## Superseded: nothing about mail depends on this grant

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

## The grant needs `refresh_token` in the client's grant types, or it dies in an hour

Measured 9 September 2026: fourteen scopes granted, and an access token valid for **one hour with no refresh
token**. The cause was the client, not the platform.

Cloudflare's API reference for `oauth_clients`:

> Protocol scopes `offline_access` and `openid` are **added or removed automatically** based on `grant_types`
> and `response_types`.

So `offline_access` is absent from the dashboard's scope picker and from `GET /oauth/scopes` because it is
**derived, not chosen**. A client registered `grant_types: ['authorization_code']` can never request it; one
with `refresh_token` alongside gets it added automatically:

```text
PATCH /accounts/{acc}/oauth_clients/{id}  {"grant_types":["authorization_code","refresh_token"]}
  -> grant_types: ['authorization_code', 'refresh_token']
  -> offline_access auto-added: True   (scopes 14 -> 15)
```

**This is why the ceremony's second step names both grant types.** An operator who sets only Authorization
Code gets a Node that reconnects every hour, and the failure appears an hour after everything looked fine.
The Node requests `offline_access`, so a client missing it is refused with `invalid_scope` **naming that
scope** — which points at the grant type instead of at a mystery.

### A word on secret rotation, since it cost several consents

Cloudflare allows **two** secrets per client so one can be rotated before the old is deleted, and
`GET` on the client reports `has_rotated_secret`. This Node holds one at a time, so while two are live an
exchange fails `invalid_client` if the Node holds the older. The guide is explicit: *"if the value is true,
delete the old secret before you create another."*

`DELETE /accounts/{acc}/oauth_clients/{id}/rotate_secret` clears it.

## Spending the grant

L1 obtained a grant and deliberately spent none of it — `doctor` said *"nothing has been read with it yet"*,
which was honest and not a place to stay. `cloudflareGet` is the one door.

**Renewing is not an optimisation.** The access token lives an hour, measured, so a caller using the stored
token without checking would work for an hour after each consent and fail silently after — which would make
ADR 42's *one ceremony* hourly in practice while claiming otherwise. Renewal happens **a minute before**
expiry: a token that expires between the check and the request it was fetched for produces a failure the
caller cannot tell from a revocation.

**A rejected renewal is what makes `grant_refused` real.** L1 could describe that state and not reach it —
the revocation drill had to write the row by hand. Now Cloudflare answering `invalid_grant` to a refresh
records it, in Cloudflare's own words, with the tokens kept so *never granted* and *granted and then refused*
stay different questions.

A network failure is deliberately **not** a refusal. An unreachable token endpoint says nothing about the
grant, and recording one would tell an operator their authorization was revoked because a request timed out —
ADR 40's distinction, in a third place.

**A renewal that returns no refresh token keeps the old one.** Rotation is at the server's discretion, and
overwriting it with an absent field would discard the durable half of the authorization on a *successful*
renewal: the grant would work for one more hour and then be unrecoverable.

### `POST /api/provider/resolve-account`, and why it is its own route

The token response does not name the account (measured), so it costs a `GET /accounts`. That is a separate
route from `GET /api/provider` on purpose — a status read that renewed a token and called Cloudflare as a
side effect of being *displayed* would make every page showing the connection a consumer of the account's
authority. `doctor` names the command rather than running it, for the same reason.

**More than one account is a real answer, not an error.** A person may belong to several, and the grant is
scoped to what they chose on the consent screen. The id is recorded only when there is exactly one, because
the column a deployment plan reads names the account it would provision into — and a guess there is worse
than *not yet determined*.

Run against the live Node on 10 September 2026, it resolved `1e0170aa…` — the first act this Node has
performed with its own grant.

## Reading Email Routing through the grant (#163 L2)

`mailda provider --email-routing`, run against the live Node on 10 September 2026:

```text
   mailda-test.whymelabs.com
     zone      whymelabs.com
     receiving ready
     needs     MX  whymelabs.com -> route1.mx.cloudflare.net. (priority 25)
     needs     MX  whymelabs.com -> route2.mx.cloudflare.net. (priority 34)
     needs     MX  whymelabs.com -> route3.mx.cloudflare.net. (priority 12)
     needs     TXT cf2024-1._domainkey.whymelabs.com -> "v=DKIM1; …"
     needs     TXT whymelabs.com -> "v=spf1 include:_spf.mx.cloudflare.net ~all"
```

**The diff comes from Cloudflare, not from Mailda's idea of what Email Routing needs.** Two endpoints answer
it: `GET /zones/{id}/email/routing` gives the verdict (`enabled`, and a `status` of `ready` /
`unconfigured` / `misconfigured`), and `GET /zones/{id}/email/routing/dns` gives the records. A list Mailda
maintained would be a second copy of somebody else's requirements — right the day it was written.

Both need `Zone Settings Read`, which the grant already carries as `zone-settings.read`. Nothing here writes.

### The zone is not the domain

This Node routes `inbox@mailda-test.whymelabs.com`. There is no zone of that name — Email Routing is
configured on `whymelabs.com`, and the address lives on a subdomain of it. So the search walks up the labels
until a zone answers, longest first, so a subdomain that *is* its own zone is found as itself rather than as
its parent. It stops at two labels: a single label is a public suffix, and asking Cloudflare about `com` is a
request whose every answer is wrong.

`zone` and `domain` are separate fields in the contract for the same reason — a surface showing one as the
other sends somebody to the wrong place in the dashboard.

### An unreadable answer is not an empty one

A zone that needs no records and a record list nobody could read are both an empty array, so `error` is what
tells them apart. A proposal built from the second would tell an operator their DNS was complete because a
request failed.

A Node routing **no** domains answers with an empty list and never touches the grant — *no domains to report
on* rather than *no domains have a problem*, and a Node that has not connected still answers the route
instead of erroring.

### What the write side has to reckon with here

Cloudflare reports the records for **`whymelabs.com`**, the zone — which carries live mail. So on this
particular Node, applying a proposal would modify a production zone even though the mail being tested is on a
test subdomain. The read side is safe and the write side is not, on this account, and that is a property of
the setup rather than of the design.

## Whether a send's outcome would be seen (#163 L2)

`mailda provider --delivery-events`, run against the live Node on 10 September 2026:

```text
   mailda-test.whymelabs.com
     zone      whymelabs.com
     sending   mailda-test.whymelabs.com — dkim cf-bounce
     needs     MX  cf-bounce.mailda-test.whymelabs.com -> route1.mx.cloudflare.net. (priority 25)
     needs     TXT _dmarc.mailda-test.whymelabs.com -> "v=DMARC1; p=reject;"
     …
     events    mailda-sending-events — message.delivered, message.deferred, message.bounced, …
     queue     mailda-sending-events
     consumer  mailda
```

Four objects have to line up. The domain has to be **onboarded for sending** on its zone; an account-level
`email.sending` **event subscription** has to publish its lifecycle events to a queue; and a Worker has to
**consume** that queue. Any one missing produces the same symptom: silence. So each is named separately — a
single verdict over them would be one nobody could act on. `sending` comes first because it decides whether
the rest could matter: a domain that may not send produces no events, and reporting *no subscription* about
it would point one step past the fault.

### Where L2 may write, which is not where it was thought to be

Email **Routing**'s required records land on the zone **apex**. Email **Sending**'s land inside the sending
domain itself — every record above is at or under `mailda-test.whymelabs.com`. And
`/zones/{zone_id}/email/sending/subdomains` has all five methods, `POST` included, which
`docs/receipts/email-routing-subdomain-onboarding.md` recorded as absent in August. So the write side is
exercisable against a test subdomain without proposing a change to a zone carrying live mail.

### Longest match wins, and a live run is what said so

`whymelabs.com` and `mailda-test.whymelabs.com` are both onboarded for sending, so *"which sending domain
covers this one"* has two true answers and one right one. Taking the first match returned the apex, and the
six records it printed were all correct — about the wrong domain. A proposal built from them would have
written into the production zone with the test subdomain's name at the top of the output.

A fixture could not have caught it: one entry has no ambiguity to resolve. The same rule now decides the
subscription match, where the same two-entry case is equally possible.

**`doctor` used to say this was unanswerable.** `sending_events_consumer` read *"not checkable from inside a
Worker — no account API access"*, which was true when it was written and which ADR 42 made false. The grant
carries `queues.write`, and two reads settle all three. The finding now points at this route instead, and
`test/node/delivery-events-world.test.ts` is what makes that pointer refer to something — the old sentence
was `report`, `ok: true`, for ever, so nothing could have failed when it stopped being true.

The answer is deliberately **not** folded into `doctor`: it costs live Cloudflare calls and may renew a
token, and a health report that reached the network would spend the account's authority every time anything
asked how the Node was.

### The subscription is in no menu, and exists — and the API creates it

`wrangler queues subscription create --source` does not offer `email.sending` (re-measured 10 September
2026, wrangler 4.118.0), and neither does the API reference's create-subscription schema. Both enumerations
are incomplete: the account holds one, created 7 August 2026, whose `source` carries `type: "email.sending"`
with `zone_id` and `domain` — fields that same schema does not document either.

**And the endpoint accepts that shape** (measured 16 September 2026, `email-sending-events.md`): a `POST`
with it refuses a domain not onboarded for sending with *"domain is not an enabled sending subdomain"*, and
creates the subscription for one that is. The refusal orders the ceremony — onboard, then subscribe — and
`POST /api/provider/subscription` (#222) makes the call the way `POST /api/provider/sending` does: a
proposal that names the sending domain, this Node's own queue (found by the name wrangler derived from
`WORKER_NAME`, paging the account's queues) and the six event types; a digest over it; a write that
recomputes the proposal and refuses unless the digest still matches. The proposal says *onboard first*
before a write is attempted, so the API's refusal is never the first an operator hears of the order.

Five times in #162 a *list of what something supports* was read as a list of what may be had. This is the
same mistake from the other side, and the rule that survives both is **ask the account, not the menu**.

### Apex or subdomain, and the dot that decides

A subscription is scoped to one sending domain: the zone apex or a verified sending subdomain. So an apex
subscription covers a subdomain sending under it, and matching on equality would tell an operator to create a
second subscription for a domain that already has one. The match is `on === domain || domain.endsWith("." +
on)` — the dot is a label boundary, without which `notexample.test` would count as covered by
`example.test`.

### The queue is read by id

`GET /accounts/{id}/queues` pages at 100 and this account holds 66. Matching against page one would be right
until the hundred-and-first queue. A subscription names its `queue_id`, so there is a targeted read and no
list to be wrong about — the mistake `deploy --plan` already made once, on R2's page of twenty.

## Onboarding a subdomain for receiving (#209, #210), and what the restore drill found in it

`POST /api/provider/receiving` enables Email Routing on the zone if it is off, writes the MX records
Cloudflare lists for the subdomain, reads them back, and only then writes the routing rule that sends one
address's mail to this Worker — a rule with no records is accepted and never matches. Two things the #92
restore drill on 16 September 2026 found by running it against a restored Node's grant:

- **The rule needs `email-routing-rule.write`.** The reach table had carried the rules endpoint as covered
  by `zone-settings.write`, by inference. A grant holding that and `dns.write` wrote the records and was
  refused the rule with `10000 Authentication error`. The ceremony asks for the rule scope now.
- **Nothing registered the address on the Node.** The rule named `inbox@mailda.site`; ingress resolves a
  recipient against the `addresses` table before reading a byte, and no product path had ever inserted a
  row there — the live Node's two were put in by hand. The onboarding now writes the row, in the same
  batch as its audit entry and before Cloudflare is asked, so a refusal from Cloudflare leaves an address
  that files and no rule (harmless) rather than a rule and no address (mail rejected). The mailbox is the
  organization's only one, or the `mailboxId` the request names; several and none named is refused.

And the half-done case is resumable at every step: MX already on the name that is entirely Cloudflare's
own routing hosts reads as this Node's earlier attempt, kept and not rewritten, rather than as somebody
else's mail host to refuse — which is what the proposal said about its own records after the scope refusal
above; the address row is `INSERT OR IGNORE`; and a rule already routing the exact address is kept rather
than asked for again, which Cloudflare refuses as `2014 Duplicated Zone rule`. Each of the three was met on
the drill, one run apart.

## Onboarding a domain for sending (#163 L2, write side)

The first act this Node performs that **changes the Cloudflare account it is installed in**. Two steps:

```text
$ mailda provider --onboard-sending drill.mailda-test.whymelabs.com

   drill.mailda-test.whymelabs.com
     zone      whymelabs.com
     covered   mailda-test.whymelabs.com already sends for this domain — onboarding it as itself
               gives it its own DKIM key and bounce domain, and is a separate thing
     creates   cf-bounce.drill.mailda-test.whymelabs.com
     creates   cf-bounce._domainkey.drill.mailda-test.whymelabs.com
     creates   _dmarc.drill.mailda-test.whymelabs.com
     keeps     _dmarc.drill.mailda-test.whymelabs.com — un-onboarding removes the rest and leaves this one,
               on a name Cloudflare stops managing. Measured, not documented

   confirm: mailda provider --onboard-sending drill.mailda-test.whymelabs.com --confirm 04c5bcf2…
```

One `POST` applies it, and **Cloudflare places the records itself** — this Node writes no DNS record. All six
were live in public DNS within thirty seconds, checked with `dig` against the authoritative nameserver.

### A binding, not a second signature

The confirmation is a digest over the proposal. That is a deliberate choice against dual control, and the
argument is what already went wrong: the read side matched an apex and printed six records that were each
perfectly correct — about a domain nobody had asked about. **Two administrators would have approved that.**
Dual control defends against one person acting alone; the failure available here is a plausible proposal
aimed at the wrong name, and what defends against that is binding the apply to what was displayed.

Run live, offering one domain's digest for another:

```text
E_PROVIDER_SENDING_STALE  the proposal confirmed is not the proposal this Node would now apply
```

Nothing reached Cloudflare. `domain_pause` is the precedent for an organization-scoped approval and its
reason does not transfer — `approvals.ts` says it exists to stop *a single administrator stopping a
customer's mail*. This stops nothing and is scoped to one name the operator typed.

### Three refusals, three codes

`E_PROVIDER_SENDING_ALREADY`, `E_PROVIDER_SENDING_STALE` and `E_PROVIDER_SENDING_UNREADABLE` are separate
because *somebody already did this*, *you are holding an old proposal* and *this Node could not find out* are
different things to be told. Cloudflare's own `2040 Subdomain already exists` would say the first — after a
write had been attempted.

### Covered is not onboarded

`mailda-test.whymelabs.com` already sends for everything beneath it, and `drill.` under it was still
un-onboarded *as itself*. Onboarding it is a real act that gives it its own DKIM key and bounce domain. The
read side matches an apex as covering a subdomain, because for sending it does; the proposal asks about the
exact name, because onboarding does. Reusing either match for the other would be wrong in a different
direction each way.

## Still owed by this layer

Stated here rather than left to be discovered:

- ~~**The scope matrix**~~ — measured. Fourteen scopes, listed in `cloudflare-oauth-scopes.md` with each
  id's picker name, every one probed individually and all fourteen granted.
- ~~**Whether the token response names the account**~~ — measured: it does not
  (`oauth.token_response_names_account: 0`). The code left the column null rather than inventing a field,
  which was the right call and is now a fact. Resolving it costs one `GET /client/v4/accounts`.
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

### The plan names the account, because for a while it did not

The header said *"plan for the Worker `mailda`"* and stopped. A token that can see four accounts produces
four plans whose text is **identical**, and the one fact distinguishing them was the one fact missing.

Measured on 16 September 2026, by doing it: `wrangler deploy` was run directly rather than `mailda deploy`,
refused non-interactively with *"More than one account available"*, listed four, and the wrong id was given
back to it. A complete Node was provisioned into an account that had never held one — Worker, D1, R2, queue,
Workflow, and a cron firing every minute. Nothing was lost, because nothing was there to lose, and that is
precisely why nothing objected: every resource was genuinely absent, so every disposition was genuinely
`create` and the verdict was genuinely `install`. The plan would have been correct and useless.

So the header carries the account **id and name** — an operator cannot tell `dc8d1b7d…` from `1e0170aa…` by
eye, and telling them apart is the whole job at that moment — and `install` carries a second sentence saying
that nothing of this name exists here.

**That sentence accused, in its first version**, and was wrong for a day: it said *"you are pointed at the
wrong account"*. One account holds more than one Node, which [#207][207] measured on purpose — `env.test`
deploys as `mailda-test` with its own `mailda-test-*` resources beside `mailda` — so an absent Worker name
means a first install, and a first install reads two ways no plan can separate: a new Node where it belongs,
whether or not others are already here, or a deploy into an account nobody meant. Naming one of them is a
guess dressed as a finding, and it lands on the operator doing the ordinary thing.

The verdict is not changed to a refusal either. A plan that cannot resolve an ambiguity hands it to the
reader; it does not settle it in the reassuring direction, and it does not settle it in the alarming one.

[207]: https://github.com/Straits-AI/mailda/issues/207

`null` prints nothing, which is the single-account case where wrangler picks and there is nothing to confuse.
An "account: unknown" line there would manufacture a doubt the situation does not contain.

**`mailda deploy --plan` already refused an ambiguous account** and names the four ids to choose from
(`preflight.mjs`). It was not what failed here — it was not run. That is worth stating rather than
implying the guard was missing: the gap was that the correct command's output could not be checked afterwards.

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
