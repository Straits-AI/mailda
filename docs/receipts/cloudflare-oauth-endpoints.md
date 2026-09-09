---
id: cloudflare-oauth-endpoints
kind: platform-limit
measured_on: 2026-09-09
stale_when: >
  the discovery document at https://dash.cloudflare.com/.well-known/openid-configuration stops answering, or
  any of the three endpoints this Node uses moves — authorization, token or revocation; the issuer stops being
  https://dash.cloudflare.com; client_secret_basic leaves token_endpoint_auth_methods_supported; S256 leaves
  code_challenge_methods_supported, which would make PKCE unavailable as defence in depth; or
  grant_types_supported stops advertising client_credentials, which would resolve the contradiction recorded
  below in the documentation's favour and close the probe named here
values:
  oauth.endpoints_from_discovery: 1
  oauth.token_auth_is_client_secret_basic: 1
  oauth.pkce_s256_available: 1
  oauth.client_may_request_offline_access: 0
  oauth.omitted_scope_defaults_to_client_scopes: 0
---

## Correction, 9 September 2026 (amended the same day): the encoding was **not** the cause

The section below diagnosed `invalid_client` as a missing form-url-encoding of the Basic credential and
called it *"a spec conformance bug in Mailda"*. The encoding fix is correct and stays — RFC 6749 §2.3.1 does
require it — but **it was not what failed.**

Established without spending a consent, by sending a deliberately invalid code to the token endpoint: an
invalid code with working client authentication answers `invalid_grant`, and a broken credential answers
`invalid_client`. So one request per candidate settles which, and the code is never a real one.

```text
client_secret_basic, percent-encoded   -> invalid_grant   (authentication WORKED)
client_secret_basic, raw               -> invalid_grant   (authentication WORKED)
client_secret_post                     -> invalid_client  "The OAuth 2.0 Client supports client
                                                            authentication method 'client_secret_basic',
                                                            but method 'client_secret_post' was requested"
```

Three things at once:

- **The client is registered `client_secret_basic`**, which Cloudflare names outright when the wrong method is
  used. This flow's earlier guessing had no need to guess at that either.
- **Both encodings authenticate** for a secret with no reserved characters, so the fix below was neither the
  cause nor a regression. It matters only for a secret containing `+`, `/` or `=`, and this one does not.
- **The stored secret was stale** — rotated in the dashboard after registration. That is the actual cause, and
  the migration for `provider_binding` had already recorded the shape of it: Cloudflare permits two secrets
  per client so one may be rotated before the old is deleted, and *"this Node holds one at a time and
  re-registration replaces it."*

**The diagnosis below was a guess that happened to touch real code.** It shipped a fix, a test and a receipt
section for a bug that was not the failure, and the failure was one `curl` away from being named — which is
the same mistake as the five readings in `cloudflare-oauth-scopes.md`, made with a debugging tool instead of a
document.

## Superseded: the Basic credential must be form-url-encoded, and Hydra enforces it

The consent completed. The **token exchange** then failed:

```text
error             invalid_client
error_description Client authentication failed (e.g., unknown client, no client authentication
                  included, or unsupported authentication method).
```

`cloudflare-grant.ts` built its header as `btoa(clientId + ":" + secret)`. RFC 6749 §2.3.1 requires both
values to be encoded with the `application/x-www-form-urlencoded` algorithm **before** they are joined and
base64'd, and this authorization server is Ory Hydra — `credentials_endpoint_draft_00` in its own discovery
document — which enforces that rather than decoding leniently.

It matters because a Cloudflare client secret is base64-ish and routinely contains `+`, `/` and `=`. Raw,
those change what the server decodes the password as.

**This is the worst place in the flow to fail, which is why it is worth its own section.** The authorization
code is single-use: by the time the exchange is attempted the operator has already signed in, reviewed
fourteen permissions and clicked Authorize, and there is no retry. Every attempt costs a fresh consent.

**Which is exactly why guessing here was the wrong move**, and why the amendment above exists: the token
endpoint answers questions about client authentication for free, using a code that was never valid. Two
consents were spent learning what one unauthenticated request would have said.

Fixed with `encodeURIComponent` on both halves, and the test uses a secret containing exactly those three
characters — verified by putting the bug back and watching it fail.

### What this says about the flow's shape

Four failures now have landed *after* the point of no return — `invalid_state`, `invalid_scope` twice, and
this one — and every one was a property of the request that could have been checked before a person was
asked for anything. The `state` minimum and the scope vocabulary are both recorded here and in
`cloudflare-oauth-scopes.md`; this one is a spec conformance bug in Mailda rather than a platform fact, and
it is recorded beside them because the cost is the same: an operator's consent, spent.

## Correction, 8 September 2026 (second of two): an omitted `scope` grants nothing, so the Node must name them

The correction below removed `offline_access` from every authorization request and made an empty scope list
**omit the `scope` parameter entirely**, on RFC 6749's rule that a request naming no scope leaves the scope to
the authorization server — so Cloudflare would apply the client's own registered scopes, the ones the operator
chose in the dashboard's picker.

**Cloudflare's default is nothing.** The consent screen for a request with no `scope` reads:

```text
This will allow test to        0 total permissions
                              (empty list)

Only authorize access if you trust this application.
Select at least one permission to authorize, or cancel.
```

`Authorize` is **disabled**. Measured against the same private client, 8 September 2026.

So the premise `REQUIRED_CAPABILITIES` was written on — *the operator selects the scopes in the dashboard's
own picker, and this Node never needs to know their names* — **is false**. A client's registered scopes are a
ceiling on what it may request, not a default for what it does request. The Node has to enumerate them, and
therefore has to know them.

`oauth.omitted_scope_defaults_to_client_scopes: 0`.

### Three readings of one document, three wrong

This is the third time a capability list in the discovery document or the client registration has been read as
something it is not:

| read as | actually |
|:--|:--|
| `grant_types_supported` = what a third-party client may use | what the server implements |
| `scopes_supported` = what a client may request | what the server implements; a client may request only what it was registered with |
| a client's registered scopes = the default for a request that names none | a **ceiling**, not a default. No scope named, nothing granted |

The pattern is the same each time and worth naming: **a list of what something supports is not a list of what
you may have.** Every one of the three cost a round trip with a real consent to find out.

### What the screen did answer

#162 requires that the consent screen *"selects the intended account and exposes the exact requested
scopes"*. Both hold: it named `swmengappdev@gmail.com` and `Swmengappdev@gmail.com's Account` with an **Edit**
control to change the account, and it listed the requested scopes exactly — which in this case was none, and
it said so rather than substituting any.

It also carries `This application has not verified ownership of any domain`, which is the expected badge for a
private client on a `workers.dev` host: #167 measured that a private client needs no domain verification, and
this is what the absence of one looks like to the person consenting.

## Correction, 8 September 2026: `scopes_supported` describes the server, and a client cannot request from it

The table below records `scopes_supported` as `["offline_access", "offline", "openid"]` and notes that these
are OIDC scopes rather than Cloudflare permission names. What it did **not** say, and what mattered, is that
a client cannot request them at all.

`cloudflare-grant.ts` appended `offline_access` to every authorization request, on the argument that discovery
lists it and that without it there is no refresh token. The first real consent refused the whole
authorization:

```text
error             invalid_scope
error_description The requested scope is invalid, unknown, or malformed.
                  The OAuth 2.0 Client is not allowed to request scope 'offline_access'.
```

Measured against a private client created in the dashboard on 7 September 2026, with grant types
**Authorization Code and Refresh Token**, response type `code`, and scopes chosen from the dashboard's own
picker.

**So `scopes_supported` is a statement about the authorization server, not about what any client may ask
for.** A client may request only what it was registered with, and the dashboard registers Cloudflare
permission names — the OIDC scopes are not on offer there. Reading a discovery document's capability list as a
client's menu is the same mistake as reading `grant_types_supported` as a third-party client's options, which
this file already records one section down. Twice now, from the same document.

**The refresh token comes from the grant type.** A client registered with `refresh_token` beside
`authorization_code` receives one; Cloudflare's own documented example lists no `offline_access` in `scopes`
either, which is the reading this measurement confirms. `oauth.client_may_request_offline_access: 0`.

### What the Node does instead

Requests **no scope of its own**, and omits the `scope` parameter entirely when the caller names none — which
is not the same as sending an empty one. RFC 6749 leaves the scope of a request that names none to the
authorization server, so Cloudflare applies the client's own registered scopes: the ones the operator chose in
the picker. For a Node that deliberately does not know their names
(`REQUIRED_CAPABILITIES` says why), that is a better answer than any guess it could print.

The guided ceremony changed with it. It used to tell the operator to *include* `offline_access` — an
instruction that would have made the authorization refusable for everybody who followed it. It now says to
select **Refresh Token as a grant type** and not to add that scope.

### The cost of getting this wrong, since it is the argument for measuring before shipping

Nothing was lost: the callback validated its nonce, consumed it once, exchanged the code, and reported
`ok: false` carrying Cloudflare's own words rather than a paraphrase — the refusal path working exactly as
built. But every operator following the printed steps would have hit it, and the Node would have blamed a
scope it added itself.

# Where Cloudflare's OAuth endpoints are, read from the server rather than from prose

ADR 42 makes the Node an OAuth client. A client needs three URLs — authorize, token, revoke — and #167's
probe established the authorization path (`/oauth2/auth`) without recording the **host**, because the question
it was answering was whether a `workers.dev` redirect would be accepted. So the endpoints a Node would
actually call were, until this receipt, partly inferred.

They do not need to be inferred. Cloudflare publishes an RFC 8414 / OpenID Connect discovery document, and it
is the authority on its own endpoints.

## Measured

```text
GET https://dash.cloudflare.com/.well-known/openid-configuration   → 200
GET https://api.cloudflare.com/.well-known/openid-configuration    → 200 (byte-identical body)
GET https://api.cloudflare.com/.well-known/oauth-authorization-server → 404
GET https://dash.cloudflare.com/.well-known/oauth-authorization-server → 200, but HTML — the dashboard's
    single-page shell, not a discovery document. A client that parsed it would get a page.
```

Read on 3 September 2026. What the Node uses:

| Purpose | Endpoint |
|:--|:--|
| issuer | `https://dash.cloudflare.com` |
| authorization | `https://dash.cloudflare.com/oauth2/auth` |
| token | `https://dash.cloudflare.com/oauth2/token` |
| revocation | `https://dash.cloudflare.com/oauth2/revoke` |

And three properties that decide how the flow is built:

- **`token_endpoint_auth_methods_supported`** includes `client_secret_basic` and `client_secret_post`. ADR 42's
  Node is a server-side confidential client, so it authenticates the token exchange with its secret.
- **`code_challenge_methods_supported`** includes `S256`. PKCE is documented as optional for a confidential
  client; it is available, so the Node uses it anyway — a code intercepted between Cloudflare's redirect and
  the Node is useless without the verifier, and the cost is one hash.
- **`scopes_supported`** lists only `offline_access`, `offline` and `openid`. These are the OIDC scopes and
  **not** the Cloudflare permission scopes — those correspond to API-token permission names and are enumerated
  from `GET /client/v4/oauth/scopes`, which needs a token. So this document does not answer #162's scope
  matrix, and nothing here should be read as if it did.

## The 404 is the reason a Node reads neither at runtime

`api.cloudflare.com` has no `oauth-authorization-server` document and `dash.cloudflare.com` answers that path
with **HTML** — a 200 carrying the dashboard's shell. A client that discovered its endpoints by fetching the
RFC 8414 path and trusting a 200 would parse a web page and fail with a JSON error, on the authorization path,
at the moment an operator was trying to connect their account.

So the Node holds these four URLs as constants, measured here, and `doctor` compares them against live
discovery. That puts the drift check in the thing whose job is detecting drift rather than a subrequest on the
path an operator is waiting on, and it means a moved endpoint is reported as a finding rather than met as a
failure.

## The contradiction, recorded because it bears on ADR 42's cost and is not resolved

`grant_types_supported` advertises **five** grant types:

```json
["authorization_code", "implicit", "client_credentials", "refresh_token",
 "urn:ietf:params:oauth:grant-type:device_code"]
```

and there is a `device_authorization_endpoint`. Cloudflare's own documentation says the opposite, in as many
words: *"Cloudflare does not support Client Credentials, Implicit, Resource Owner Password Credentials, Device
Authorization, or other OAuth grant types for third-party clients."*

**Both can be true.** A discovery document describes what the authorization server implements; the per-client
`grant_types` field on client creation decides what a given client may use. The server here fingerprints as
Ory Hydra — `credentials_endpoint_draft_00` and that exact `response_types_supported` list — and Hydra
publishes its own capabilities rather than a tenant's policy. The likely reading is that the server can do
all five and Cloudflare's client-registration API permits one.

**Recorded rather than resolved, because it is the difference between ADR 42's ceremony and no ceremony at
all.** ADR 42 accepts one dashboard ceremony, and the entire reason is *"Cloudflare supports only the
Authorization Code flow for third-party clients — no client credentials, no device flow — so a grant requires
a browser redirect."* If a private client can be registered with `client_credentials`, that premise is false
and the browser ceremony is unnecessary. If it can be registered with the device code grant, the operator
authorizes on their own device with no redirect URI at all, which would also remove the `workers.dev`
dependency #167 measured.

The immediate consequence is a warning and not an opportunity: **a Node must not trust this document over the
documentation**, because attempting `client_credentials` would fail somewhere in the token exchange with an
error about the client rather than about the flow. That is why the Node's flow is authorization-code and why
this file is a `platform-limit` rather than a plan.

### The probe that would settle it

Two API calls, in an account whose OAuth clients are expendable:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/oauth_clients" \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"client_name":"grant-type probe","grant_types":["client_credentials"],
       "scopes":["<one scope>"],"response_types":["code"],
       "token_endpoint_auth_method":"client_secret_basic"}'
```

A refusal at **creation** confirms the documentation and closes this section. A client that is created is then
exercised against the token endpoint — creation succeeding is not the same as the grant working, and only the
token response settles it.

Not run here. It creates a real client in a real account, which is the operator's to authorize, and #167's
probe artifact was deliberately deleted after use for the same reason.

## What this does not establish

**The scope matrix** — see above; it needs a token and a real consent, and it is #162's.

**That a consent completes.** Every URL here was read from a document, and the authorization endpoint was
exercised by #167 only far enough to prove the redirect was registered. No grant has been issued to any Node.

**Anything about `api.cloudflare.com`'s resource endpoints**, which are a separate surface with separate
versioning; this is only the authorization server.
