---
id: cloudflare-oauth-endpoints
kind: platform-limit
measured_on: 2026-09-03
stale_when: >
  the discovery document at https://dash.cloudflare.com/.well-known/openid-configuration stops answering, or
  any of the three endpoints this Node uses moves — authorization, token or revocation; the issuer stops being
  https://dash.cloudflare.com; client_secret_basic leaves token_endpoint_auth_methods_supported; S256 leaves
  code_challenge_methods_supported, which would make PKCE unavailable as defence in depth; or
  grant_types_supported stops advertising client_credentials, which would resolve the contradiction recorded
  below in the documentation's favour and close the probe named here
values:
  oauth.endpoints_from_discovery: 1
  oauth.pkce_s256_available: 1
---

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
