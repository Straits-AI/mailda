# The Node's Cloudflare credential

How a Node comes to act in its operator's Cloudflare account, which credential it uses when, and what it
stores. Decision record: **ADR 42**, amended 25 and 26 September 2026; [#108][108] for the chart it belongs
to and [#162][162] for this layer.

## Two credentials, both the operator's, and only one is ever stored

**At install and upgrade: wrangler's login, carried on one request.** Every provisioning route
(`GET`/`POST /api/provider/receiving`, `/sending`, `/subscription`, the email-routing and delivery-events
reads, the routing-rule routes, `POST /api/provider/verified-destinations`) accepts two request headers, `x-cloudflare-token` and
`x-cloudflare-account`. When they are present the Node reads and writes the account with that token,
inside that account, for that request. It never stores the token. It does not store the account id either,
except that `POST /api/provider/verified-destinations` records the account it read in `verified_destination_read`
and in its `provider.verified_destinations_read` audit entry. `mailda install`, `mailda setup` and `mailda
upgrade` send wrangler's login token this way, which the operator consented to before anything was deployed and which
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
| Email Routing Addresses Edit (optional) | which of the addresses this Node has sent to are verified destinations (no delivery outcome was reported for one in the case measured); whether a kept forward's destination is verified; and registering a destination (ADR 47). Edit because registering is a write; it includes the read |

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

The routing **rules** follow the same rule (28 September 2026). Adding or removing an address reads the zone's
rules first, and a listing that could not be read writes and deletes nothing: an unread list is not a list
without a rule for the address, and a rule written over one that exists is Cloudflare's `2014 Duplicated
Zone rule`, or a second rule. On a domain whose catch-all this Node took over, the answer is then
`unconfirmed`, naming what could not be checked, rather than the `catch_all` its own history would suggest.

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

## Recipients for which no outcome is reported (28 September 2026)

In the one case measured, Cloudflare published no `email.sending` event for mail to a **verified
destination** of the account, an address verified for Email Routing forwarding: three sends to one such
address stayed silent, while on the same subscription a send to an ordinary address on the same Node got
`message.delivered` (`accepted`) in 18 seconds, and a send to a second `gmail.com` address that is not a
verified destination, with the same receiving provider and MX as the silent three, got `message.delivered` in
27 seconds ([`email-sending-events.md`](./receipts/email-sending-events.md), 28 September 2026 addition, the
discriminating send). So the silence follows verified status, not delivery outside Cloudflare. The sample is
still one verified address and only the `send_email` binding (the REST adapter was not sampled), and
Cloudflare does not document the behaviour, so the product treats it as an observation: doctor stops calling
the silence expected as soon as any event contradicts it.

Such a recipient stays `unobserved`, which reads like an answer still coming or a subscription that is
missing. So the Node records which of its recipients are verified destinations:

- **The read.** `POST /api/provider/verified-destinations` lists the account's destination addresses
  (`GET /accounts/{account_id}/email/routing/addresses`, every page) with the operator headers or the
  stored token. `mailda setup` calls it after provisioning with the token it already fetched from
  wrangler's login; `mailda upgrade` calls it when a login is found; the Setup screen's *Delivery outcomes*
  section calls it with the stored token. Nothing else does: not install (no recipients yet), not doctor
  (no live call), not a cron, not dispatch.
- **What is stored.** Only the intersection: a row in `verified_destination_recipients` exists only for an
  address `send_recipients` already holds as handed over, so the account's list, which can hold anybody's
  address, enters SQL only as a filter. Each row keeps the interval a read proved, Cloudflare's own
  `verified` timestamp to the latest read that listed it, and is never removed; a hand-over inside an
  interval, or after the latest read for an address that read still listed, is explained. The read itself
  is one row in `verified_destination_read`: the account, which credential, when it last succeeded, when it
  was last attempted, and the failure as reported (Cloudflare's words when it gave any).
- **The account check.** A Node lives in one account, and the rows a read writes are never removed. An
  operator credential naming a different account is refused before anything is asked
  (`E_PROVIDER_ACCOUNT_MISMATCH`, 409, naming both): different from the stored token's when one is held, else
  from the account the last successful read named, which is the ordinary path's case. A Node that really moved
  says so by registering a token for the new account (`mailda provider --token`), which is then what is
  compared; rows an earlier account's read proved stay true for the hand-overs made while it lived there. A
  failed read of the stored token is a 500, never "no token held", since that would skip the comparison. With
  no credential at all it is `E_PROVIDER_NO_TOKEN`, naming `mailda setup` first.
- **The audit entry.** Every read that reaches Cloudflare writes `provider.verified_destinations_read`, `ok`
  with the actor, the account, the credential (`token` or `operator`) and two counts, or `failed` with the
  same names and the failure as reported in place of the counts. The two
  refusals before that (`E_PROVIDER_NO_TOKEN`, `E_PROVIDER_ACCOUNT_MISMATCH`) ask Cloudflare nothing and write
  no entry. Never an address: the trail is permanent and widely read, and which recipients were verified
  destinations is content.
- **Counts, not addresses.** The route, the Setup screen and the CLI say how many. Which recipients they
  are is shown only by the Outbox, as the reason `verified destination` beside `unobserved`, on
  `GET /api/sends`, which is bounded by `mailbox.content.read`.
- **The non-success states.** A refused or unreachable read answers 200 with `error` set and changes no
  address row: that is could not read, never none verified, and an earlier read still stands. Never read
  and read-and-found-none are different answers because the read row exists.

Wrangler's login reaches the list: 200, measured on 28 September 2026 with the `email_routing:write`
scope ([`wrangler-login-reach.md`](./receipts/wrangler-login-reach.md)). What Cloudflare answers a stored
token that lacks Email Routing Addresses Read was **not measured**. A token made from the list before 28
September 2026 does not carry it; add it in the dashboard, or make a new token and register it (if the
dashboard shows a new value after the edit, register that).

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
  had on that entry, then `PUT`s the rule with `worker → this Node`, renamed
  `mailda <worker> (was <action>[ <destination>], repointed <YYYY-MM-DD>)` (1 October 2026, critic H1): the
  audit entry lives on the Node, and a deleted Node took the only record of where the address went with it.
  The name is Cloudflare's to keep; the entry records both names, and the answer's `nameRecorded` says whether
  the rule read back with the name as written (false: only this Node's put-back can restore it). A rule that
  already routes to the Worker its name records (another Node's take-over) keeps that record: the new name
  carries the earlier `was …` forward, and the offer says so, so the forward it replaced is never recorded only
  in the second Node's audit trail. The catch-all's take-over (the receiving step) writes no name. A forward rule whose address has no row here
  is refused without a `mailboxId` (`E_ROUTING_FORWARD_NEEDS_MAILBOX`, critic M4): a forwarded address is
  usually one person's mail, and the organization's only mailbox is not a default for it. A rule whose action
  is not forward, worker or drop is refused (`E_ROUTING_RULE_ACTION_UNKNOWN`). A rule holds exactly one action
  (measured, `email-routing-rule-takeover.md`), so this replaces. Since 3 October 2026 (ADR 47) a forward rule
  must also say `forward: "keep"` or `"stop"` (`E_ROUTING_FORWARD_NEEDS_CHOICE`; on any other rule
  `E_ROUTING_FORWARD_NOT_A_FORWARD`): keep records the rule's destination on the address, and this Worker stores
  each message, then forwards it there with `message.forward()` (see *Kept forwards and destination addresses*
  below). A
  stale digest, the catch-all, and a rule already pointing here are refused. So, since 30 September 2026,
  is every rule a take-over would point here and then receive nothing through, or lose a destination by:
  a disabled rule (`E_ROUTING_RULE_DISABLED`: Cloudflare applies none, and the take-over keeps `enabled`),
  a rule listing more than one destination
  (`E_ROUTING_RULE_MANY_DESTINATIONS`), an address with more than one rule (`E_ROUTING_RULE_DUPLICATE`:
  Cloudflare applies the one first in its dashboard, and the API does not say which), and a zone with
  subaddressing on (`E_ROUTING_SUBADDRESS_UNSERVED`: `user+tag@` would match the rule, reach this Node and
  bounce, because ingress files by the exact address; the zone's settings are read, and unreadable ones are
  refused too, `E_ROUTING_SETTINGS_UNREADABLE`). An address row already there, added on People or left by a put-back, keeps its mailbox: the
  take-over uses it and the answer's `mailbox` names it, and a different `mailboxId` is refused
  (`E_ROUTING_ADDRESS_FILES_ELSEWHERE`) rather than recorded while the row files elsewhere.
- Each listed rule carries `offer` (`take_over`, `put_back` or null) and, when null, the `refusal` the act would
  answer (30 September 2026). The listing and the act decide by the same function, so Setup and
  `mailda provider --routing-rules` never offer an act the Node must refuse: every refusal above, subaddressing
  included since 1 October 2026 (the listing reads the zone's settings once). An offered rule also carries
  `takeOver`: the one choice besides leaving it (`receive here only` for a forward, `receive here` for a Worker
  or a drop), what it changes in one sentence, the mailbox an existing address row files into, and whether a
  mailbox must be chosen. The setup step, the Setup screen and the CLI listing print those words rather than
  each keeping its own. A rule that names
  this Node offers a put-back only when a take-over of it is on the audit trail, or its name records one by this
  Worker (a reinstalled Node); one onboarding wrote, or the customer pointed here by hand, answers
  `E_ROUTING_RULE_NEVER_TAKEN`. The CLI's `--take-over` prints the
  mailbox the address now files into, as Setup does.
- `POST /api/provider/routing-rules/put-back {domain, ruleId}` reads the latest take-over entry for that
  rule and `PUT`s its previous action back, with the name it had while the take-over's name is still on it (a
  rule renamed since keeps its new name). With no entry, it restores from the name's record, clears the name,
  and says `restoredFrom: "name"` on its own entry. With no Node to ask, `mailda provider --put-back <rule id> --domain
  <domain> --without-node` reads the action from the rule's name with the operator's wrangler login, restores
  it, clears the name and reads it back; it writes no audit entry, and refuses a name with no record in it (the
  catch-all's, and any rule taken over before 1 October 2026) or a rule that no longer routes to the Worker the
  name says. A rule this Node never took, or one that no longer routes here
  (somebody changed it, or the take-over did not complete), is refused rather than overwritten. The address
  row stays; an address that files and nothing routes is harmless.
- Both write their entry as the intent, before the `PUT`, and then read the rule back and record
  `provider.routing_rule_read_back` (30 September 2026): `ok` only when it reads back with the action,
  destinations and enabled state sent, whatever the `PUT` answered; `refused` when the `PUT` threw and the rule
  reads back as something else; `failed` when the `PUT` answered and the rule reads back otherwise, or when it
  could not be read back at all, and then the act answers `E_ROUTING_RULE_NOT_CONFIRMED`. The rule is read back
  after a `PUT` that threw too, since a lost answer is reported as a refusal: one that reads back as sent is
  `ok`, and one whose read-back also fails is `failed`, with both errors on the entry and "may have applied" in
  the refusal, never `refused`. The answer's `after` is the read-back.
- Removing an address on People whose rule this Node ever took over deletes nothing (28 September 2026). The
  rule reads as this Node's, enabled with a Worker action naming it, but it is the customer's rule with its
  action replaced; deleting it would lose the action a put-back restores. So the answer is `not_removed`,
  naming `mailda provider --put-back <id> --domain <domain>`. Any take-over of the rule decides it, not the
  latest of take-over and put-back (30 September 2026): a put-back Cloudflare refused left the rule routing
  here with the put-back as the latest entry, and the rule was deleted.

**The setup step** (1 October 2026). `mailda install` (once the first address exists), `mailda setup` and every
`mailda upgrade` list the rules on the name the Node receives at, through the listing above
(`packages/cli/src/verbs/routing-step.mjs`). It asks one y/N only when a rule is offered, then "leave it" (the
default) or the rule's `takeOver.label` per rule, then a mailbox where the Node leaves it open (for a forward: a
new mailbox named after the address, first), then shows the plan and asks again before any take-over. A refusal
is printed under its row and the others go ahead; the step never ends the run. `--yes`, or no terminal, prints
the list and each `--take-over` command and changes nothing. Rules on other names are a count line. The Setup
screen offers the same choice with the same words.

Not built, on purpose: editing forward destinations or deleting rules. Either would make this Node a
routing-rule editor. Keeping a rule's forward while receiving here (`message.forward()`) is not built and not
decided; the step offers "receive here only" for a forward.

**The catch-all, built 25 September 2026, through the receiving step only.** This paragraph used to refuse
it on the ground that every address without its own rule would be rejected here as an unknown recipient.
That is true, and it is what a mail server does: known addresses file, unknown ones bounce with *No such
recipient at this Mailda Node*, which the `email()` handler has always answered. Literal rules keep their
priority over the catch-all, so a zone's existing forwards keep working. What made the refusal right was
the *route* it was on: the take-over of one rule is a decision about one address, and the catch-all is a
decision about a whole domain. So `POST /api/provider/routing-rules/take-over` still refuses the catch-all,
and the receiving step takes it instead, where the proposal shows the whole domain. When the domain asked
for is a zone's own name, `GET /api/provider/receiving` reports `apex: true` and the zone's current
catch-all (its action, destinations and whether it is on), and on any domain `ownRules`: every address on it
with a literal rule, classified by `classifyAddress` (`rule_written`, `routed_elsewhere`, `rule_disabled`) with
where the rule sends it, or the error that kept the rules from being read (28 September 2026). An enabled one
outranks the catch-all, so a take-over does not reach its address; for a disabled one Cloudflare does not say
whether the catch-all then applies, and neither channel claims it. So every prompt that offers it (`mailda install`, `mailda setup`,
`mailda provider --onboard-receiving`, the Setup screen) lists them first and says "every address without a rule
of its own"; the list is in the proposal's digest, so a rule added or changed before the confirmation makes it
stale. Confirming with `catchAll: true` points it at this Worker and writes `provider.catch_all_taken_over` to the audit trail with `before` and `after`.
`POST /api/provider/routing-rules/put-back` restores it from that entry (`provider.catch_all_put_back`).
Measured: `PUT /zones/{zone_id}/email/routing/rules/catch_all` is permitted to wrangler's login and to the
grant's `email-routing-rule.write` ([`wrangler-login-reach.md`](./receipts/wrangler-login-reach.md)).

### Apex or subdomain

Cloudflare decides what "route this domain here" can mean, by the domain's shape: *"Catch-all entries
support apex domains only. To route mail sent to an Email Routing subdomain, list each literal recipient
address."* So a Node receiving at a zone's own name can take the catch-all and manage every address inside
the Node, on the People screen, with no further act in Cloudflare for an address that has no rule of its
own. A literal rule outranks the catch-all, so an address that already has one keeps going where it sends
it: adding it reads the zone's rules live and answers `routing: routed_elsewhere`, naming the rule, rather
than claiming the catch-all routes it (found 28 September 2026 on a zone where `admin@` had a rule to
another Worker). A disabled rule of its own is `rule_disabled`, named and left: Cloudflare says a disabled
rule "will not forward emails to a destination address or Worker", and does not say whether the catch-all
then applies, so the Node claims neither. A Node receiving at a subdomain needs one
literal rule per address, and adding an address on People writes that rule in the same act when the Node
holds a credential (the grant, or the operator's token on a CLI request); when it holds none the response
says `routing: not_written` and names the command that writes it, rather than an address that files and
nothing routes. On either shape the operator's act is the same, add an address, and the difference is what
the Node does behind it and says about it.

And the half-done case is resumable at every step: MX already on the name that is entirely Cloudflare's
own routing hosts reads as this Node's earlier attempt, kept and not rewritten, rather than as somebody
else's mail host to refuse, which is what the proposal said about its own records after the scope refusal
above; the address row is `INSERT OR IGNORE`; and a rule already routing the exact address here is kept
rather than asked for again, which Cloudflare refuses as `2014 Duplicated Zone rule`. Each of the three was
met on the drill, one run apart. "Here" means enabled, with a Worker action naming this Worker: a rule on the
address that forwards, names another Worker, drops or is disabled is somebody's routing, named in the answer
and never rewritten, and when the rules cannot be read no rule is written, because a blind write is the
duplicate. The decision is one pure function, `classifyAddress` in `apps/node/worker/src/provider/routing-classify.ts`,
shared by adding, removing and the receiving onboard.

How the onboard's first address ended up routed is its own audit entry, `provider.receiving_routed`, written
after the act (28 September 2026); `provider.receiving_onboarded` is the intent and is written before
Cloudflare is asked anything, so on its own it read as set up for an address a rule of its own sent to
another Worker, on every re-run of `mailda setup` and `mailda upgrade` and in the Setup progress. `GET
/api/provider` carries the outcome as `provisioned.receiving.routing`, and receiving counts as set up only
when it is `catch_all` or `rule_written`. An onboard from before that date has no outcome and reads as the
record it was; one that promised an outcome and has none stopped part-way and reads as `unconfirmed`. Whether
this Node holds a domain's catch-all, which decides `unconfirmed` against `not_written` when the rules cannot be
read, comes from the latest `provider.catch_all_taken_over` or `provider.catch_all_put_back` for it.

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

**An unread probe does not block.** The plan asks `wrangler workflows describe <name>`, and refusing a plan
because a *diagnostic* was unavailable is the wrong direction, the same trade the deploy's #99 guard makes for a
failed `describe` (a Workflow rides the Workers Scripts permission a deploy already needs,
`workflow-provisioning.md`). The plan names it under
`not checked` instead. The deploy refuses one case the plan does not: a `describe` that succeeded and named no
owner, since that is wrangler's wording moving under the check, not a diagnostic being unavailable. The Worker's own existence is the exception and
**does** stop the plan: the two deploy paths differ, and being wrong there means skipping the canary on a live
Node.

## Kept forwards and destination addresses (ADR 47, 3 October 2026)

A forward rule taken over with `forward: "keep"` keeps its destination receiving: `email()` stores the message,
then calls `message.forward(destination, X-Mailda-Forwarded-By: <claim id>)`. What the platform does was measured
on mailda.site on 2 October 2026 (`docs/receipts/email-worker-forward.md`); the parts that shape this:

- **Only a verified destination.** `forward()` to any other throws "destination address not verified", and the
  rules API refuses to create a forward rule to one (2054). So keep reads the account's destination list first and
  refuses a destination listed unverified or not at all (`E_FORWARD_DESTINATION_NOT_VERIFIED`); an unreadable
  list keeps it as "not checked", and the first forward is then the check.
- **A failure reaches nobody.** A caught `forward()` failure answers the sender 250 and delivers nothing, so every
  call leaves a row in `kept_forward_attempts`: `handed_over`, `refused` with Cloudflare's words, `withheld` for a
  message carrying this Node's own marker (a loop), or `outcome_unknown` when the call never answered. People shows
  each address's latest ("forwards to X (verified) · last forwarded …"), `GET /api/forwards` and
  `mailda provider --forwards` print the same, and doctor's `kept_forwards` degrades for a refused latest attempt
  or one with no recorded answer. The handler never rejects or throws after accepting.
- **Once per receipt.** A redelivery of a stored message forwards nothing; the attempt row is written in the
  receipt's own batch.
- **Put back, then remove.** A put-back clears the forward once the rule reads back; removing an address that keeps
  one is refused (`E_ADDRESS_KEEPS_A_FORWARD`). A put-back that finds the rule re-pointed by hand
  (`E_ROUTING_RULE_NOT_OURS_NOW`) stops keeping the forward too, since that mail no longer reaches the Node, so the
  address is never left both forwarding and unremovable. The rule's name already records `was forward <destination>`.

**Destination addresses.** `POST /api/provider/verified-destinations` (`mailda provider --destinations`, the Setup
screen's Verified destinations) now also counts the account's whole list (verified, waiting for verification),
re-checks each kept forward's destination, and returns the addresses only when asked (`{ addresses: true }`,
`--addresses`, the "Show the addresses" box). `POST /api/provider/destination-addresses {email}`
(`mailda provider --add-destination <email>`, the Setup screen) registers one: Cloudflare mails it a link, and it
is *waiting for verification* until someone at that address clicks it. An address already listed is answered as
listed and nothing is sent. A refusal names the permission (`E_DESTINATION_NOT_ADDED`, Email Routing Addresses:
Edit). The audit entry `provider.destination_added` names Cloudflare's id for the destination and never the address,
and no log does. This Node deletes no destination: it cannot tell what else relies on one. All three routes are
withheld from machines.


**Copies, when a forward cannot be used** (ADR 47, amended 3 October 2026). An address that keeps a forward may opt
in to a copy, off by default: `POST /api/forwards/copy {address, copy}` (`mailda provider --copy <address> on|off`,
People), or `copy: true` beside `forward: "keep"` on the take-over (`--copy`, the Setup screen's box under keep), which
then also keeps a destination listed unverified or not at all. When `forward()` throws "destination address not
verified", the one refusal measured to deliver nothing, the stored message is filed, judged, and sealed as an ordinary
send through Email Sending, not through Email Routing: From is the address itself with "<sender> via <mailbox>" as its
display name (DMARC aligns on the customer's domain, so the address's domain must be onboarded for sending like any
send from it), Reply-To and `X-Original-From` are the sender, `X-Mailda-Copy-Of` is this Node's claim id, and the body
is the original's, byte for byte. So a copy needs no Email Routing permission at all, and the destination need not be
verified; it does need the `send_email` binding (`E_COPY_NEEDS_SENDING` without one) and counts against the account's
daily sending like any send. The opt-in's administrator must hold `send.propose` on the mailbox
(`E_COPY_NEEDS_SEND_PROPOSE`) and is read again at every copy and at dispatch. A copy is refused, and the reason left
on the attempt (`copy_state`), for a message over `email.outbound.max_bytes`, one quarantined, one failing DMARC, one
with an attachment this Node judges dangerous or could not read, one whose body is 8-bit and not UTF-8, and a
destination on any domain this organisation receives at (`E_COPY_WOULD_LOOP` at the opt-in). People shows the copy's
send and its state; doctor's `kept_forwards` counts the refused. The opt-in route is withheld from machines.
