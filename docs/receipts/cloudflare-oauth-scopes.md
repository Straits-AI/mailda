---
id: cloudflare-oauth-scopes
kind: platform-limit
measured_on: 2026-09-09
stale_when: >
  Cloudflare's OAuth scope vocabulary stops being <group>.<verb> for API scopes or bare for protocol
  scopes; offline_access stops being added automatically from grant_types; an id below is renamed or withdrawn;
  Email Routing stops being four separate permissions; the read-only scopes for D1, Queues, Email Routing or Email Sending stop being offered;
  Email Routing stops being four separate permissions; wrangler stops being
  an OAuth client, since its bundle is where these strings were read; GET /client/v4/oauth/scopes becomes
  reachable without a token, which would make it the source instead; or a scope this Node requests is
  refused, since Cloudflare names any it will not grant
values:
  oauth.token_response_names_account: 0
  oauth.grant_type_alone_yields_refresh_token: 0
  oauth.offline_access_yields_refresh_token: 1
  oauth.access_token_lifetime_seconds: 3600
  oauth.refresh_token_obtainable_by_self_managed_client: 1
  oauth.scope_shape_is_group_colon_verb: 0
  oauth.scope_shape_is_group_dot_verb: 1
  oauth.read_only_scope_exists_for_d1: 1
  oauth.read_only_scope_exists_for_queues: 1
  oauth.read_only_scope_exists_for_email: 1
---

## Confirmed, 10 September 2026: a second consent returned a refresh token

After `PATCH grant_types: ["authorization_code","refresh_token"]` added `offline_access` to the client's
scopes automatically, a fresh consent requesting all fifteen:

```text
scopesGranted: [ …the fourteen…, "offline_access" ]   scopesDeclined: []
refresh_token: present        access_expires_at: one hour
```

`oauth.offline_access_yields_refresh_token: 1`. **ADR 42's one dashboard ceremony holds**, and the amendment
calling it a blocker is retracted below.

The access token is still an hour. That is what a refresh token is for, and the durable half is the one this
Node stores wrapped and a revocation kills — which is what makes `grant_refused` an observable state rather
than a guess.

## Retraction, 10 September 2026: a refreshable grant **is** obtainable, and the reference said so

`oauth.refresh_token_obtainable_by_self_managed_client` goes 0 → 1. This file asserted 0, and ADR 42 was
amended to call it a blocker on that basis. Both were wrong.

The evidence for 0 was real and the inference from it was not: `offline_access` is in no category of the
dashboard's scope picker, and `GET /client/v4/oauth/scopes` matches nothing for `offline`, `openid` or
`refresh`. From which this file concluded there is no such scope to have.

Cloudflare's **API reference** for `oauth_clients`, one sentence:

> Protocol scopes `offline_access` and `openid` are **added or removed automatically** based on `grant_types`
> and `response_types`.

So it is not in the picker or the scope list because it is not something you pick — it is derived from the
client's grant types. `GET` on the client showed the cause:

```text
grant_types: ['authorization_code']        <- no refresh_token
scopes:      14, no offline_access
```

One `PATCH` adding `refresh_token` to `grant_types`:

```text
grant_types: ['authorization_code', 'refresh_token']
offline_access auto-added: True
scopes: 15
```

### The same sentence settled the format question this file spent a day on

> **Colon-delimited scopes are not accepted. Dot-delimited scopes are validated** against available OAuth API
> scopes; simple identity scopes are allowed.

Colons ruled out, dots confirmed, and protocol scopes admitted as *simple identity scopes* — which is why
`offline_access` carries no dot and needed the schema's pattern widened. Three of this file's findings are in
that one paragraph, and it was established instead by probing a live client one scope at a time.

### Sixth time, and the last four were avoidable by reading one page

| inferred from | what was actually true |
|:--|:--|
| `grant_types_supported` in discovery | describes the server, not a client |
| `scopes_supported` in discovery | describes the server, not a client |
| a client's registered scopes | a ceiling, not a default |
| wrangler's scope strings | what wrangler asks for |
| the guide's dotted example being unused | the documented format |
| `offline_access` absent from the picker | derived from `grant_types`, not picked |

Every one is a list read as a menu. The **guide** — `create-an-oauth-client` — is silent on scope format, on
refresh tokens and on rotation state; the **API reference** states all three. Probing is for when the
documentation does not answer, and here it did.

### And the `invalid_client` failures were a live secret rotation

`has_rotated_secret: true` on the same `GET`. Cloudflare permits two secrets per client, and the guide says
*"if the value is true, delete the old secret before you create another."* Two were live while the Node held
one. That is what the exchange failures were, and this repository diagnosed a missing form-url-encoding
instead, shipped a fix for it, and wrote it up as a spec bug — `cloudflare-oauth-endpoints.md` carries that
retraction.

## The consent completed, 9 September 2026, and two of ADR 42's premises did not survive it

A real grant, all fourteen scopes granted and none declined:

```json
{"ok":true,"scopesGranted":["account-settings.read", … 14 in total],"scopesDeclined":[]}
```

The row it produced:

| column | value |
|:--|:--|
| `account_id` | **null** |
| `access_token` | present |
| `refresh_token` | **absent** |
| `access_expires_at` | **one hour** after the grant |

### The token response does not name the account

`oauth.token_response_names_account: 0`. `cloudflare-grant.ts` handled this as unmeasured and left the column
null rather than inventing a field — which was right, and is now a fact rather than a hedge. Resolving which
account a grant covers costs a separate `GET /client/v4/accounts`, and belongs to the layer that already talks
to the API.

### There is no refresh token, and that breaks *"one ceremony"*

`oauth.grant_type_alone_yields_refresh_token: 0`. The client is registered with **Refresh Token** as a grant
type, and no refresh token came back. `oauth.access_token_lifetime_seconds: 3600`.

So the claim this repository substituted for the `offline_access` scope — *"the refresh token comes from the
client's grant type, not from a scope"* — is **also wrong**. That was the third guess in a row about this one
mechanism:

1. `offline_access` is required and discovery lists it → refused, a client may not request it.
2. So the refresh token must come from the grant type → it does not.
3. So it must be requestable another way → `offline_access`, `offline`, `offline-access.read` and `openid`
   were all refused against a client with fourteen scopes configured.

**ADR 42 accepts exactly one dashboard ceremony.** A grant that expires in an hour with nothing to refresh it
makes that ceremony hourly, which is not a cost the ADR priced and not one an operator would accept. The
decision's own words: *"without it the grant expires with its access token and this ceremony recurs."*

### It cannot be registered either, so a self-managed client cannot hold a refreshable grant

`oauth.refresh_token_obtainable_by_self_managed_client: 0`. Established two ways, 9 September 2026:

- The dashboard's scope picker has **no `offline_access`** in any category. `Other` — the last one, opened
  specifically to check — is Artifacts, Resource Library and Resource Sharing.
- `GET /client/v4/oauth/scopes`, the authoritative list, matches nothing for `offline`, `openid` or
  `refresh`.

So there is no scope to register and no scope to request. A self-managed OAuth client gets a **one-hour
access token and nothing to renew it with.**

This is a **blocker on ADR 42, not a defect in this Node**, and it is recorded rather than worked around
because every workaround contradicts something the decision relies on. See the ADR's own amendment; the short
version is that ADR 42 rejected a pasted API token partly as *"worse hygiene besides — a permanent secret
where a refreshable grant with visible scopes and one revocation list is available"*, and the availability
that comparison rested on is now measured as absent.

## Resolved, 9 September 2026: it is `<group>.<verb>`, which the documentation said and this file denied

`GET /client/v4/oauth/scopes`, with a token:

```json
{"name":"AI Audit Read","id":"aiaudit.read","category":"ai_and_machine_learning"}
{"name":"Access: Apps Read","id":"access-app.read","category":"cloudflare_one_and_zero_trust"}
{"name":"AI Gateway Metadata Read","id":"aig.metadata_read","category":"ai_and_machine_learning"}
```

**A dot.** Which is exactly the form Cloudflare's own documentation example uses — `workers-platform.read` —
and which this repository's test asserted **must not appear**, on the grounds that it was *"not the
vocabulary in use"*. It was the vocabulary. `wrangler`'s colons are a first-party shorthand.

### The fifth misreading, and the pattern all five share

| read as | actually |
|:--|:--|
| `grant_types_supported` = what a third-party client may use | what the server implements |
| `scopes_supported` = what a client may request | what the server implements |
| a client's registered scopes = a default for a request naming none | a **ceiling**; name none, get none |
| wrangler's scope list = the provider's vocabulary | what *wrangler* asks for |
| the docs' dotted example = not the real format | the real format |

**A list of what something supports or uses is not a list of what you may have.** Four of the five cost a
live consent; the fifth cost a day of asserting the opposite of the documentation. Every one was answerable
from this single call.

### The fourteen ids, each verified accepted

Probed one at a time against the real client — a scope it may request redirects to Cloudflare's login, one it
may not comes back `invalid_scope` naming it. An invented `definitely-not-a-scope.read` was refused, which is
what makes the accepted ones evidence rather than an absence of error.

| id | picker's name |
|:--|:--|
| `account-settings.read` | Account Settings Read |
| `account-dns-settings.read` | Account DNS Settings Read |
| `account-api-gateway.read` | Account API Gateway Read |
| `user-details.read` | User Details Read |
| `zone.read` | Zone Read |
| `zone-settings.read` | Zone Settings Read |
| `workers-scripts.read` | Workers Read |
| `d1.write` | D1 Edit |
| `queues.write` | Queues Edit |
| `email-routing-account-rule.read` | Email Routing Account Rules Read |
| `email-routing-address.write` | Email Routing Addresses Edit |
| `email-routing-rule.write` | Email Routing Rules Edit |
| `email-routing-suppression.write` | Email Routing Suppressions Edit |
| `email-sending.write` | Email Sending Edit |

Two things the mapping shows that no amount of reasoning would have: the ids are **singular**
(`email-routing-address.write`, not `-addresses`), and *Workers Read* is `workers-scripts.read` rather than
`workers.read` — which was probed and refused.

All fourteen together were accepted in one request.

### This list is an operator's selection, not a minimum

`d1.write` and `queues.write` are here because the picker had them on Edit. `d1.read` and `queues.read` both
exist and are what L1 would ask for, since it provisions nothing. Recorded so the next reader does not take
the shipped list for a requirement — `/api/provider/authorize` accepts an override for exactly that reason.

## Correction, 9 September 2026: the read-only scopes **do** exist, and this file said they did not

The section below claimed, from wrangler's vocabulary, that there is no `d1:read`, `queues:read`,
`email_routing:read` or `email_sending:read` — and built a design note on it about a read-only layer being
forced to ask for write.

**Wrong.** The dashboard's own scope picker, screenshotted while editing a real client:

| group | options offered |
|:--|:--|
| D1 | Edit, **Read** |
| Queues | Edit, **Read** |
| Workers | Edit, Bind, **Read**, edit |
| Email Sending | Edit, **Read** |
| Zone | Edit, **Read** |
| Account Settings | Edit, **Read** |

Every one of them has a read. What wrangler's bundle contains is **what wrangler asks for**, and wrangler
deploys Workers — so it requests write. Reading a client's own request list as the provider's vocabulary is
the same error this file was written about, made one layer further in: *a list of what something uses is not
a list of what exists.* Fourth time in this flow.

So L1 **can** be read-only for D1 and Queues, and the design note that accepted write authority for a
read-only layer accepted a cost that was not there.

### Email Routing is four permissions, not one

The picker splits it, and one of the four is read-only with no Edit at all:

| permission | options |
|:--|:--|
| Email Routing Account Rules | **Read only** |
| Email Routing Addresses | Edit, Read |
| Email Routing Rules | Edit, Read |
| Email Routing Suppressions | Edit, Read |
| Email Sending | Edit, Read |

`email_routing:write` in wrangler's vocabulary is therefore an aggregate or a different granularity from what
a third-party client selects. L2's MX and routing work will need to name which of the four it wants, and
"read the current routing state" is a narrower ask than this file assumed.

### `<group>:<verb>` is not the format for a third-party client

`oauth.scope_shape_is_group_colon_verb: 0`, and this file asserted `1` for a day.

Probed against the client **after** its fourteen scopes were saved: `d1:read`, `queues:read`,
`workers:read`, `zone:read`, `account:read`, `email_sending:read`, `email_routing:read` — every one refused
with *"the OAuth 2.0 Client is not allowed to request scope"*, identically to an invented
`definitely_not_a_scope:read`. wrangler's strings are a **first-party shorthand**, not the vocabulary a
self-managed client requests.

What remains is Cloudflare's own instruction, which this flow has now failed to take literally twice:

> Fetch the available scopes from the API. Use the **scope ID** when you create a client through the API.

The permission-groups endpoint returns ids like `19637fbb73d242c0a92845d8db0b95b1` beside display names. A
scope is plausibly one of those, and that cannot be probed without knowing an id the client actually holds —
so it is **not guessed**. `GET /client/v4/oauth/scopes` is the one call that ends this, and it needs a token.

### And the confounded measurement, retested

`oauth.omitted_scope_defaults_to_client_scopes: 0` was first taken against a client with **no scopes at
all** — so it could not have measured what it claimed. Retested with the fourteen saved: the consent screen
still reads *"0 total permissions"* with `Authorize` disabled.

The figure stands, and now for the right reason. A client's registered scopes are a ceiling on what it may
request, not a default for what it does — confirmed against a client that had something to default to.

**That the first reading happened to be right is not a defence of taking it.** It was a measurement of a
different thing that agreed by luck, and the only reason anybody knows the difference is that the client
changed underneath it and it was run again.

# The scope vocabulary, and where it was finally read from

## Why this file exists, which is a process failure rather than a discovery

`cloudflare-grant.ts` shipped a list of **capabilities in prose and no scope strings**, on this argument:

> Cloudflare's scope names correspond to API-token permission names and are enumerated from
> `GET /client/v4/oauth/scopes`, which needs a token — and the only scope strings this repository has *seen*
> are the two in Cloudflare's own documentation example. Writing a list of eight or ten plausible names
> beside those would be a fabrication.

The refusal to invent names was right. The conclusion drawn from it was not: the Node **must** enumerate
scopes, so "we do not know them" was not a position it could ship from. Two consents against a real client
proved it, one round trip each:

1. Appending `offline_access` → `invalid_scope`. A client may request only what it was registered with.
2. Omitting `scope` entirely → *"0 total permissions"*, `Authorize` disabled. A client's registered scopes
   are a **ceiling on what it may request, not a default for what it does**.

Both are recorded in `cloudflare-oauth-endpoints.md`. What is recorded *here* is that neither was necessary to
learn that way. The documentation index at `developers.cloudflare.com/fundamentals/llms.txt` lists four OAuth
pages; one guessed URL 404'd early on and the search was abandoned in favour of inference from the discovery
document. **Three wrong readings of that document followed, and every one cost a live consent.** The
vocabulary was on this machine the whole time.

## Where the strings come from

`wrangler` is itself a Cloudflare OAuth client, and its bundle carries the vocabulary:

```text
$ grep -oE '"[a-z0-9_]+:(read|write|admin|run)"' node_modules/.../wrangler-dist/cli.js | sort -u | wc -l
76
```

The shape is **`<group>:<verb>`** — not the dotted `workers-platform.read` of Cloudflare's documentation
example, which appears nowhere in the vocabulary actually in use. `wrangler whoami` prints the same set as
`group (verb)`, which is how the format was first noticed.

What this Node asks for, and why each:

| scope | for | read-only form? |
|:--|:--|:--|
| `account:read` | the plan (ADR 25 needs Paid) and membership | yes |
| `zone:read` | which zone carries mail; name collisions | yes |
| `workers:read` | the inventory a deployment plan is diffed against | yes |
| `d1:write` | the catalog | **no** |
| `queues:write` | the delivery-events queue and its consumer | **no** |
| `email_routing:write` | receiving; L2's MX and routing diffs | **no** |
| `email_sending:write` | sending | **no** |

## Four of them have no read-only form, and that costs this design something

L1's whole point was that it **reads**. The capability list it replaced said so:

> `layer` is not decoration. L1 needs to *read*; provisioning authority belongs to the layer that provisions,
> and an operator asked for write access to their whole Workers platform in order to display an inventory
> would be right to refuse.

That argument stands, and Cloudflare does not permit it. There is no `d1:read`, `queues:read`,
`email_routing:read` or `email_sending:read` in the vocabulary — only `:write`. So an inventory of the
catalog, the queue or the mail routing costs write authority over them, at L1, for a layer that provisions
nothing.

Recorded as the provider's shape rather than smoothed over, because the consent screen shows an operator four
write permissions and the honest answer to *"why does a read-only layer need these"* is that there was no
narrower choice. `REQUIRED_SCOPES` carries `readOnlyExists` per entry so that stays legible, and a test
asserts every `:write` entry says which read scope does not exist.

## A scope can be checked against a client without anybody consenting

Found while looking for the authoritative set, and it is the cheapest diagnostic in this whole flow: the
authorization endpoint validates `scope` **before** it shows a consent screen, and refuses by redirecting to
the registered URI. So one unauthenticated request per candidate answers *may this client request this
scope*:

```text
GET /oauth2/auth?…&scope=account%3Aread
302 Location: <redirect_uri>?error=invalid_scope
    &error_description=… The OAuth 2.0 Client is not allowed to request scope 'account:read'.
```

No sign-in, no consent screen, no grant. The refusal **names the scope**, so a caller learns which one is not
permitted rather than that something was wrong.

Run against the client created on 7 September 2026, every one of the seven scopes above was refused — and so
were `offline_access` and a deliberately invented `definitely_not_a_scope:read`. All nine refused identically
means the client had **no scopes registered**, which is also why its consent screen read *"0 total
permissions"*. The dashboard's creation form documents that at least one scope is required; this client has
none, so either the form permitted it or they were not saved.

That is worth knowing as a shape rather than an incident: **a client with no scopes is indistinguishable from
a client refusing a particular scope**, from the outside, unless you probe a scope you know to be invalid as a
control. The invented one is what made the difference legible.

## What is not established

**That these are the exact scopes a third-party client may request.** They are what a **first-party** client
(wrangler) requests. `GET /client/v4/oauth/scopes` is the authority and needs a token this Node does not have
— so the shape is measured and the *set* is inferred. Cloudflare names any scope it refuses, which makes the
failure loud and cheap: `/api/provider/authorize` accepts an override so an operator whose account offers a
different set can proceed without waiting for a release.

**Whether `workers:read` covers D1, R2, Queues and Workflows provisioning.** Auto-provisioning happens
through the deploy, and which scope authorises it is untested. There is no `r2:*` in the vocabulary at all —
only `r2_catalog:write` — which suggests buckets are reached through `workers:write`, unverified.

**Whether `offline_access` is reachable any other way.** A client cannot request it; the refresh token is
expected from the `refresh_token` grant type instead. That expectation is untested until a consent completes.
