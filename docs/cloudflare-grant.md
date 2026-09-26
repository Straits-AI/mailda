# The Node's Cloudflare credential

How a Node comes to act in its operator's Cloudflare account, which credential it uses when, and what it
stores. Decision record: **ADR 42**, amended 25 and 26 September 2026; [#108][108] for the chart it belongs
to and [#162][162] for this layer.

## Two credentials, both the operator's, and only one is ever stored

**At install and upgrade: wrangler's login, carried on one request.** Every provisioning route
(`GET`/`POST /api/provider/receiving`, `/sending`, `/subscription`, the email-routing and delivery-events
reads, the routing-rule routes) accepts two request headers, `x-cloudflare-token` and
`x-cloudflare-account`. When they are present the Node reads and writes the account with that token,
inside that account, for that request, and never stores either. `mailda install` and `mailda upgrade` send
wrangler's login token this way, which the operator consented to before anything was deployed and which
reaches every endpoint the Node needs but the registrar ([`wrangler-login-reach.md`](./receipts/wrangler-login-reach.md)).
After the claim the install asks which domain the Node receives at and sets up receiving, sending and the
delivery-events subscription; a Node is receiving when the install ends, with no dashboard visit. This is
the ordinary path.

**Later, from the browser: a stored API token, optional.** The Setup screen and `mailda provider --token`
take an API token the operator made in the dashboard (`PUT /api/provider/token`). The Node verifies it
against `GET /user/tokens/verify`, binds itself to the one account the token can see (`GET /accounts`;
several is refused, naming them, unless `accountId` says which), and stores it wrapped under the ADR 28
credential key, exactly as the Email Sending token of `PUT /api/transport` is stored. `DELETE
/api/provider/token` forgets it. It exists for what a browser needs later and a terminal does not have:
another receiving domain, a sending domain, taking over a routing rule, buying a domain.

The seam is the two functions that turn a request context into a credential, `accessTokenFor` and
`boundAccount`: the operator's headers first, else the stored token, else a refusal
(`E_PROVIDER_NO_TOKEN`) that names both ways to give one. The provisioning code above them does not know
which it was given; the audit entry does, in its detail (`authority: "operator"` or `"token"`).

### The permissions the token carries

Cloudflare's token form names them; the Setup screen prints the same list with why each is asked for:

| permission | why this Node needs it |
|:--|:--|
| Account Settings Read | which account this is, so a plan names where it would provision |
| Zone Read | which zone carries a domain, before anything is created |
| Zone Settings Edit | turning Email Routing on for a zone, and reading its own records |
| Email Routing Rules Edit | the rule that sends an address, or a zone's catch-all, to this Worker |
| Queues Edit | the `email.sending` subscription that makes a send's outcome reach this Node |
| the Email Sending group | onboarding a domain for sending; the form's exact name is not published |
| Registrar Domains Read | only for buying a domain from the Node; leave it off otherwise |

Restrict the token to the account the Node runs in, and give it a TTL if one is wanted; a token Cloudflare
no longer accepts is reported at the act that tried it, in Cloudflare's own words (`10000 Authentication
error`), with the fix naming this section, and the Node keeps running,
because nothing about mail depends on it (drilled 10 September 2026 against the grant this replaced, and
the argument is unchanged: no mail, sign-in, Butler, backup or recovery path touches it).

### Why a token, and not the OAuth client this replaced

From 3 to 26 September 2026 the Node was its own private OAuth client: a client the operator created in the
dashboard, a consent, an access token renewed hourly against a refresh token, five connection states, a
scope ceremony, a redirect URI tied to the Node's hostname. The measurements that built it are kept as
receipts, marked superseded: [`cloudflare-oauth-node-as-client.md`][r167],
[`cloudflare-oauth-endpoints.md`][r168], [`cloudflare-oauth-scopes.md`](./receipts/cloudflare-oauth-scopes.md).

It was replaced because both mechanisms cost the operator the same thing, one dashboard form, and two
ways to make one browser-side credential was one too many; the founder's rule was keep the simpler. The
argument ADR 42 had made against a pasted token, that a refreshable grant with visible scopes and one
revocation list is better hygiene, is answered by what an API token is: account-restricted, its
permissions visible on the dashboard's token page, an optional expiry, one revocation list, and no state
machine or hourly renewal to keep it alive. What is lost is nothing a Node ever used: the consent screen's
account picker, and a grant that dies on its own.

## What is stored, and what never leaves

`provider_token` holds one row. A Node is deployed *into* one Cloudflare account, and two rows would be
two answers to *whose account is this*. The token is wrapped under the ADR 28 credential key; the row
carries the account it was bound to, when it was verified, and who registered it. The status read
decrypts nothing, and the response schema is `.strict()`, which is a security property here rather than
tidiness: a handler that grew a `token` field fails the contract suite instead of leaking.

`GET /api/provider` reports `no_token` or `token_held` (with the account and the verification date),
beside `provisioned`, the latest receiving, sending and
subscription act from the audit trail with its date and which credential did it. A sighting counts as
the latest act and is marked `observed: true` (a domain Cloudflare already had onboarded when this Node
asked). The progress list reads those as a record of an act, not a live read, and says so, and says
"in place on Cloudflare before this Node, observed" for a sighting rather than claiming the Node did it.

## Withheld from machines

`PUT` and `DELETE /api/provider/token` are `operator` in the agent registry: a token is a person's, made in
the dashboard, and handing one to a machine to spend is what the install's own credential makes
unnecessary. `GET /api/provider` is withheld too, for the reason it always was: it is the map of the
infrastructure the mail sits on.

## Reading Email Routing through the credential (#163 L2)

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
maintained would be a second copy of somebody else's requirements, right the day it was written.

Both need `Zone Settings Read`, which the grant already carries as `zone-settings.read`. Nothing here writes.

### The zone is not the domain

This Node routes `inbox@mailda-test.whymelabs.com`. There is no zone of that name. Email Routing is
configured on `whymelabs.com`, and the address lives on a subdomain of it. So the search walks up the labels
until a zone answers, longest first, so a subdomain that *is* its own zone is found as itself rather than as
its parent. It stops at two labels: a single label is a public suffix, and asking Cloudflare about `com` is a
request whose every answer is wrong.

`zone` and `domain` are separate fields in the contract for the same reason. A surface showing one as the
other sends somebody to the wrong place in the dashboard.

### An unreadable answer is not an empty one

A zone that needs no records and a record list nobody could read are both an empty array, so `error` is what
tells them apart. A proposal built from the second would tell an operator their DNS was complete because a
request failed.

A Node routing **no** domains answers with an empty list and never touches the grant: *no domains to report
on* rather than *no domains have a problem*, and a Node that has not connected still answers the route
instead of erroring.

### What the write side has to reckon with here

Cloudflare reports the records for **`whymelabs.com`**, the zone, which carries live mail. So on this
particular Node, applying a proposal would modify a production zone even though the mail being tested is on a
test subdomain. The read side is safe and the write side is not, on this account, and that is a property of
the setup rather than of the design.

## Whether a send's outcome would be seen (#163 L2)

`mailda provider --delivery-events`, run against the live Node on 10 September 2026:

```text
   mailda-test.whymelabs.com
     zone      whymelabs.com
     sending   mailda-test.whymelabs.com   dkim cf-bounce
     needs     MX  cf-bounce.mailda-test.whymelabs.com -> route1.mx.cloudflare.net. (priority 25)
     needs     TXT _dmarc.mailda-test.whymelabs.com -> "v=DMARC1; p=reject;"
     …
     events    mailda-sending-events   message.delivered, message.deferred, message.bounced, …
     queue     mailda-sending-events
     consumer  mailda
```

Four objects have to line up. The domain has to be **onboarded for sending** on its zone; an account-level
`email.sending` **event subscription** has to publish its lifecycle events to a queue; and a Worker has to
**consume** that queue. Any one missing produces the same symptom: silence. So each is named separately. A
single verdict over them would be one nobody could act on. `sending` comes first because it decides whether
the rest could matter: a domain that may not send produces no events, and reporting *no subscription* about
it would point one step past the fault.

### Where L2 may write, which is not where it was thought to be

Email **Routing**'s required records land on the zone **apex**. Email **Sending**'s land inside the sending
domain itself. Every record above is at or under `mailda-test.whymelabs.com`. And
`/zones/{zone_id}/email/sending/subdomains` has all five methods, `POST` included, which
`docs/receipts/email-routing-subdomain-onboarding.md` recorded as absent in August. So the write side is
exercisable against a test subdomain without proposing a change to a zone carrying live mail.

### Longest match wins, and a live run is what said so

`whymelabs.com` and `mailda-test.whymelabs.com` are both onboarded for sending, so *"which sending domain
covers this one"* has two true answers and one right one. Taking the first match returned the apex, and the
six records it printed were all correct, about the wrong domain. A proposal built from them would have
written into the production zone with the test subdomain's name at the top of the output.

A fixture could not have caught it: one entry has no ambiguity to resolve. The same rule now decides the
subscription match, where the same two-entry case is equally possible.

**`doctor` used to say this was unanswerable.** `sending_events_consumer` read *"not checkable from inside a
Worker; no account API access"*, which was true when it was written and which ADR 42 made false. The grant
carries `queues.write`, and two reads settle all three. The finding now points at this route instead, and
`test/node/delivery-events-world.test.ts` is what makes that pointer refer to something. The old sentence
was `report`, `ok: true`, for ever, so nothing could have failed when it stopped being true.

The answer is deliberately **not** folded into `doctor`: it costs live Cloudflare calls and may renew a
token, and a health report that reached the network would spend the account's authority every time anything
asked how the Node was.

### The subscription is in no menu, and exists, and the API creates it

`wrangler queues subscription create --source` does not offer `email.sending` (re-measured 10 September
2026, wrangler 4.118.0), and neither does the API reference's create-subscription schema. Both enumerations
are incomplete: the account holds one, created 7 August 2026, whose `source` carries `type: "email.sending"`
with `zone_id` and `domain`, fields that same schema does not document either.

**And the endpoint accepts that shape** (measured 16 September 2026, `email-sending-events.md`): a `POST`
with it refuses a domain not onboarded for sending with *"domain is not an enabled sending subdomain"*, and
creates the subscription for one that is. The refusal orders the ceremony (onboard, then subscribe) and
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
on)`. The dot is a label boundary, without which `notexample.test` would count as covered by
`example.test`.

### The queue is read by id

`GET /accounts/{id}/queues` pages at 100 and this account holds 66. Matching against page one would be right
until the hundred-and-first queue. A subscription names its `queue_id`, so there is a targeted read and no
list to be wrong about, the mistake `deploy --plan` already made once, on R2's page of twenty.

## Onboarding a subdomain for receiving (#209, #210), and what the restore drill found in it

`POST /api/provider/receiving` enables Email Routing on the zone if it is off, has Email Routing create the
subdomain's records, reads them back, and only then writes the routing rule that sends one address's mail to
this Worker. A rule with no records is accepted and never matches.

**The records are Email Routing's, not raw DNS** (since 26 September 2026). The first real run with
wrangler's login refused at the proposal, because it read `GET /zones/{zone}/dns_records` to see the MX
already on the apex and that token cannot read raw DNS. Email Routing's own endpoint answers the same
question without it: `GET /zones/{zone}/email/routing/dns?subdomain=…` lists what is `missing` for a
subdomain never enabled and `records` once it is, and an apex's records come with enabling routing on the
zone. That endpoint is the plan and the read-back now, and `POST` on it creates the records
([`wrangler-login-reach.md`](./receipts/wrangler-login-reach.md)). Two things the #92 restore drill on 16
September 2026 found by running it against a restored Node's grant:

- **The rule needs `email-routing-rule.write`.** The reach table had carried the rules endpoint as covered
  by `zone-settings.write`, by inference. A grant holding that and `dns.write` wrote the records and was
  refused the rule with `10000 Authentication error`. The ceremony asks for the rule scope now.
- **The enable did nothing.** `PATCH /email/routing { enabled: true }`, chosen because Cloudflare marks
  `POST /email/routing/enable` deprecated, answers `success: true` and leaves the zone
  `enabled: false, status: unconfigured`. The `POST` enables it. The Node sends the `POST` now and reads
  the zone back, refusing with `E_RECEIVING_ZONE_STILL_OFF` if it is still off, rather than writing
  records and a rule onto a zone that will not route.
- **Nothing registered the address on the Node.** The rule named `inbox@mailda.site`; ingress resolves a
  recipient against the `addresses` table before reading a byte, and no product path had ever inserted a
  row there. The live Node's two were put in by hand. The onboarding now writes the row, in the same
  batch as its audit entry and before Cloudflare is asked, so a refusal from Cloudflare leaves an address
  that files and no rule (harmless) rather than a rule and no address (mail rejected). The mailbox is the
  organization's only one, or the `mailboxId` the request names; several and none named is refused.

## A zone that already routes (#258)

`onboardReceiving` keeps a rule that already routes the address it is asked for, so on a zone that received
mail before this Node existed, onboarding `hello@` leaves `hello@` forwarding to wherever it went and
reports success. Three routes cover that case, all administrator-only and withheld from machines:

- `GET /api/provider/routing-rules?domain=` lists the zone's rules: the address, the action and its
  destinations, whether it is the catch-all, whether it already names this Worker, and a digest over the
  rule as listed. `/setup` → receiving shows the table; `mailda provider --routing-rules <domain>` prints it.
- `POST /api/provider/routing-rules/take-over {domain, ruleId, digest, mailboxId?}` registers the rule's
  address on this Node (the #92 lesson, in the same batch as the audit entry), records the action the rule
  had on that entry, then `PUT`s the rule with `worker → this Node`. A rule holds exactly one action
  (measured, `email-routing-rule-takeover.md`), so this replaces; there is no forward-and-also-here. A
  stale digest, the catch-all, and a rule already pointing here are refused.
- `POST /api/provider/routing-rules/put-back {domain, ruleId}` reads the latest take-over entry for that
  rule and `PUT`s its previous action back. A rule this Node never took, or one somebody changed since the
  take-over, is refused rather than overwritten. The address row stays; an address that files and nothing
  routes is harmless.

Not built, on purpose: editing forward destinations or deleting rules. Either would make this Node a
routing-rule editor.

**The catch-all, built 25 September 2026, through the receiving step only.** This paragraph used to refuse
it on the ground that every address without its own rule would be rejected here as an unknown recipient.
That is true, and it is what a mail server does: known addresses file, unknown ones bounce with *No such
recipient at this Mailda Node*, which the `email()` handler has always answered. Literal rules keep their
priority over the catch-all, so a zone's existing forwards keep working. What made the refusal right was
the *route* it was on: the take-over of one rule is a decision about one address, and the catch-all is a
decision about a whole domain. So `POST /api/provider/routing-rules/take-over` still refuses the catch-all,
and the receiving step takes it instead, where the proposal shows the whole domain. When the domain asked
for is a zone's own name, `GET /api/provider/receiving` reports `apex: true` and the zone's current
catch-all (its action, destinations and whether it is on); confirming with `catchAll: true` points it at
this Worker and writes `provider.catch_all_taken_over` to the audit trail with `before` and `after`.
`POST /api/provider/routing-rules/put-back` restores it from that entry (`provider.catch_all_put_back`).
Measured: `PUT /zones/{zone_id}/email/routing/rules/catch_all` is permitted to wrangler's login and to the
grant's `email-routing-rule.write` ([`wrangler-login-reach.md`](./receipts/wrangler-login-reach.md)).

### Apex or subdomain

Cloudflare decides what "route this domain here" can mean, by the domain's shape: *"Catch-all entries
support apex domains only. To route mail sent to an Email Routing subdomain, list each literal recipient
address."* So a Node receiving at a zone's own name can take the catch-all and manage every address inside
the Node, on the People screen, with no further act in Cloudflare. A Node receiving at a subdomain needs one
literal rule per address, and adding an address on People writes that rule in the same act when the Node
holds a credential (the grant, or the operator's token on a CLI request); when it holds none the response
says `routing: not_written` and names the command that writes it, rather than an address that files and
nothing routes. On either shape the operator's act is the same, add an address, and the difference is what
the Node does behind it and says about it.

And the half-done case is resumable at every step: MX already on the name that is entirely Cloudflare's
own routing hosts reads as this Node's earlier attempt, kept and not rewritten, rather than as somebody
else's mail host to refuse, which is what the proposal said about its own records after the scope refusal
above; the address row is `INSERT OR IGNORE`; and a rule already routing the exact address is kept rather
than asked for again, which Cloudflare refuses as `2014 Duplicated Zone rule`. Each of the three was met on
the drill, one run apart.

## Onboarding a domain for sending (#163 L2, write side)

The first act this Node performs that **changes the Cloudflare account it is installed in**. Two steps:

```text
$ mailda provider --onboard-sending drill.mailda-test.whymelabs.com

   drill.mailda-test.whymelabs.com
     zone      whymelabs.com
     covered   mailda-test.whymelabs.com already sends for this domain; onboarding it as itself
               gives it its own DKIM key and bounce domain, and is a separate thing
     creates   cf-bounce.drill.mailda-test.whymelabs.com
     creates   cf-bounce._domainkey.drill.mailda-test.whymelabs.com
     creates   _dmarc.drill.mailda-test.whymelabs.com
     keeps     _dmarc.drill.mailda-test.whymelabs.com   un-onboarding removes the rest and leaves this one,
               on a name Cloudflare stops managing. Measured, not documented

   confirm: mailda provider --onboard-sending drill.mailda-test.whymelabs.com --confirm 04c5bcf2…
```

One `POST` applies it, and **Cloudflare places the records itself**. This Node writes no DNS record. All six
were live in public DNS within thirty seconds, checked with `dig` against the authoritative nameserver.

### A binding, not a second signature

The confirmation is a digest over the proposal. That is a deliberate choice against dual control, and the
argument is what already went wrong: the read side matched an apex and printed six records that were each
perfectly correct, about a domain nobody had asked about. **Two administrators would have approved that.**
Dual control defends against one person acting alone; the failure available here is a plausible proposal
aimed at the wrong name, and what defends against that is binding the apply to what was displayed.

Run live, offering one domain's digest for another:

```text
E_PROVIDER_SENDING_STALE  the proposal confirmed is not the proposal this Node would now apply
```

Nothing reached Cloudflare. `domain_pause` is the precedent for an organization-scoped approval and its
reason does not transfer. `approvals.ts` says it exists to stop *a single administrator stopping a
customer's mail*. This stops nothing and is scoped to one name the operator typed.

### Two refusals, two codes, and a sighting

`E_PROVIDER_SENDING_STALE` and `E_PROVIDER_SENDING_UNREADABLE` are separate because *you are holding an old
proposal* and *this Node could not find out* are different things to be told. *Somebody already did this*
used to be a third, `E_PROVIDER_SENDING_ALREADY`, and the live Node showed its cost on 26 September 2026:
whymelabs.com had been onboarded before the install, so the install never posted, and the Node's own record
of its setup (`provisioned` on `GET /api/provider`, read by the first-run progress list and by `mailda
upgrade`'s summary) said sending was never set up. So a confirmed proposal for a domain already onboarded
now records `provider.sending_observed` and answers 200 with the proposal; Cloudflare is still never asked
to onboard twice, and its `2040 Subdomain already exists` is still never reached. *Observed* is the word
because this Node did not do it, it saw that it was done, and `provisioned.sending.observed` carries that
distinction to every surface that shows the record. `POST /api/provider/subscription` does the same for a
subscription already publishing into a queue this Worker consumes (`provider.delivery_events_observed`, in
place of the former `E_PROVIDER_SUBSCRIPTION_ALREADY`). Receiving never had the gap: `onboardReceiving`
records its act on a zone that already routed here too.

### Covered is not onboarded

`mailda-test.whymelabs.com` already sends for everything beneath it, and `drill.` under it was still
un-onboarded *as itself*. Onboarding it is a real act that gives it its own DKIM key and bounce domain. The
read side matches an apex as covering a subdomain, because for sending it does; the proposal asks about the
exact name, because onboarding does. Reusing either match for the other would be wrong in a different
direction each way.

## Still owed by this layer

Stated here rather than left to be discovered:

- **A live token refused.** There is no stored "refused" state: a token revoked in the dashboard is found
  out at the next act, which Cloudflare refuses with `10000` and the Node reports whole with the fix naming
  this section. The drill that revokes a token and reads the refusal back is not yet run.
- **The Email Sending permission's form name.** Cloudflare's permissions reference does not list it; the
  Setup screen says "the Email Sending group" and the first token that carries it is the measurement.
- **Inventory read through the stored token.** `deploy --plan` below reads the account through the
  operator's own `wrangler`, because a plan for a *first install* runs before there is a Node to hold
  anything. Reading zones and Email Service state through the stored token, for a Node that already
  exists, is what the ownership page needs and is not built.

[108]: https://github.com/Straits-AI/mailda/issues/108
[162]: https://github.com/Straits-AI/mailda/issues/162
[r167]: receipts/cloudflare-oauth-node-as-client.md
[r168]: receipts/cloudflare-oauth-endpoints.md

## `deploy --plan`: what a deploy would do, before it does any of it

`mailda deploy --plan` prints the plan and acts on nothing. It exits 0 for `install` and `redeploy`, and 1 for
`blocked` or `unknown`, so it is usable as a gate.

**It reads the account through the operator's own `wrangler`, not through the credential above.** A plan for a first
install runs before there is a Node to hold a grant, so the chicken-and-egg is resolved by using the
credentials the operator already has. The grant is for a Node that exists.

### The plan names the account, because for a while it did not

The header said *"plan for the Worker `mailda`"* and stopped. A token that can see four accounts produces
four plans whose text is **identical**, and the one fact distinguishing them was the one fact missing.

Measured on 16 September 2026, by doing it: `wrangler deploy` was run directly rather than `mailda deploy`,
refused non-interactively with *"More than one account available"*, listed four, and the wrong id was given
back to it. A complete Node was provisioned into an account that had never held one: Worker, D1, R2, queue,
Workflow, and a cron firing every minute. Nothing was lost, because nothing was there to lose, and that is
precisely why nothing objected: every resource was absent, so every disposition was
`create` and the verdict was `install`. The plan would have been correct and useless.

So the header carries the account **id and name** (an operator cannot tell `dc8d1b7d…` from `1e0170aa…` by
eye, and telling them apart is the whole job at that moment), and `install` carries a second sentence saying
that nothing of this name exists here.

**That sentence accused, in its first version**, and was wrong for a day: it said *"you are pointed at the
wrong account"*. One account holds more than one Node, which [#207][207] measured on purpose (`env.test`
deploys as `mailda-test` with its own `mailda-test-*` resources beside `mailda`), so an absent Worker name
means a first install, and a first install reads two ways no plan can separate: a new Node where it belongs,
whether or not others are already here, or a deploy into an account nobody meant. Naming one of them is a
guess dressed as a finding, and it lands on the operator doing the ordinary thing.

The verdict is not changed to a refusal either. A plan that cannot resolve an ambiguity hands it to the
reader; it does not settle it in the reassuring direction, and it does not settle it in the alarming one.

[207]: https://github.com/Straits-AI/mailda/issues/207

`null` prints nothing, which is the single-account case where wrangler picks and there is nothing to confuse.
An "account: unknown" line there would manufacture a doubt the situation does not contain.

**`mailda deploy --plan` already refused an ambiguous account** and names the four ids to choose from
(`preflight.mjs`). It was not what failed here. It was not run. That is worth stating rather than
implying the guard was missing: the gap was that the correct command's output could not be checked afterwards.

### Three verbs, because a create-only plan is wrong in the expensive direction

`packages/cli/src/deploy-plan.mjs` is pure, values in and values out, for `promotionVerdict`'s reason: the gate
that function replaced was an inline `if` asserted *lexically*, and the assertion survived the condition being
mutated to `if (false && …)`.

| disposition | the account | what a deploy actually does |
|:--|:--|:--|
| `create` | absent | provisions it. The only case a create-only plan gets right |
| `linked` | present, bound to this Worker | nothing. An ordinary redeploy |
| `cannot_adopt` | present, no Worker | **fails on it**, after creating whatever comes before it |
| `orphaned` | absent, Worker exists | **reports success and changes nothing** |
| `stolen` | present, another script owns it | **succeeds and takes it**; exit 0, no warning |
| `unknown` | list unreadable | anything. The plan names the gap instead of guessing |

Three of those six are a deploy doing something other than what it looks like it does, and every one is
measured: `deploy-drill-live-account.md` for the Workflow reassignment and the ordering, the runbook for the
linked-binding repair that isn't one.

`orphaned` is the worst, because the deploy **succeeds**: the binding is linked server-side, so the Worker
keeps reading a dead resource id while the CLI resolves the same name to a live one. It is also the one
blocking disposition that offers **no unwind**. A plan that printed a teardown there would be telling an
operator to destroy a live Node's evidence bucket to fix its database.

### The names are derived, because wrangler derives them

`d1_databases`, `r2_buckets` and `queues` declare a binding and **no name and no id**. ADR 24 requires the
repository byte-identical across installs. wrangler names them `<worker>-<binding>`, lowercased and
hyphenated, which the drill measured on two Nodes: `mailda` got `mailda-catalog`, `mailda-evidence`,
`mailda-sending-events`, and `mailda2` got the `mailda2-` set.

**The Workflow is the exception and it is the whole of #99.** Its name is written in the config, so it does
not follow the Worker's, and a Workflow is owned by exactly one script. `mailda deploy` already refuses a
deploy that would take somebody else's; the plan reports it before the refusal, which is the difference
between being stopped and knowing why.

### The unwind is an order, and every step was found by getting it wrong

1. `wrangler queues consumer worker remove <queue> <worker>`. A Worker cannot be deleted while it consumes a
   queue (`code: 10064`).
2. `wrangler delete --env "" --force`.
3. R2 objects per key, then the bucket. A non-empty bucket refuses.
4. `wrangler d1 delete <name> -y`.
5. `wrangler queues delete <name>`.
6. `wrangler workflows delete <name>`. A Workflow **survives its script's deletion**, and its name is the one
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
as one. But a resource renamed out from under a live binding would read as `orphaned` plus `cannot_adopt`
rather than as the one thing it is.

**An unread list does not block.** `wrangler workflows list` needs a permission a deploy token may not carry,
and refusing a plan because a *diagnostic* was unavailable is the wrong direction, the same trade the deploy
path makes. The plan names it under `not checked` instead. The Worker's own existence is the exception and
**does** stop the plan: the two deploy paths differ, and being wrong there means skipping the canary on a live
Node.
