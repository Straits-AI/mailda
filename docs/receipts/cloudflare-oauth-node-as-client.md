---
id: cloudflare-oauth-node-as-client
kind: platform-limit
measured_on: 2026-09-03
stale_when: >
  Cloudflare stops accepting a `workers.dev` hostname as an OAuth redirect target, or begins requiring
  domain-ownership verification for private clients; the minimum `state` length changes from 8; the
  authorization endpoint moves from /oauth2/auth; Cloudflare adds a grant type usable without a browser
  redirect, which would remove the reason the Node has to be the client at all; or ADR 42 is superseded
values:
  oauth.workers_dev_redirect_accepted: 1
  oauth.private_client_needs_domain_verification: 0
  oauth.min_state_length: 8
---

# A Node's own hostname is an acceptable OAuth redirect target

**ADR 42** rests on one platform fact it could not assume: that Cloudflare will send an authorization
response to a `workers.dev` hostname. If it would not, a Node could not be its own OAuth client without a
custom domain, and the ADR's cost argument — *one dashboard ceremony* — would have to be reopened.

This is that verification. A private OAuth client was created in a real account with a single redirect URI on
a `workers.dev` host, and the authorization endpoint was then exercised against it.

## The proof is the error response, not the success

The first attempt passed `state=probe`. Cloudflare answered by **redirecting to the registered URI** with the
error in the query string:

```text
https://mailda.<subdomain>.workers.dev/oauth/cloudflare/callback
  ?error=invalid_state
  &error_description=The state is missing or does not have enough characters and is therefore
                     considered too weak. Request parameter 'state' must be at least be 8
                     characters long to ensure sufficient entropy.
  &state=probe
```

That redirect **is** the measurement, and it is stronger evidence than a consent screen would have been. RFC
6749 requires an authorization server **not** to redirect when `redirect_uri` is missing or unregistered — it
must report the error to the user agent directly instead. So a provider that redirects an error *to* a URI has
already decided the URI is registered and usable. Cloudflare did.

The second attempt, with a `state` of sufficient length, advanced into Cloudflare's own sign-in challenge
rather than refusing — the flow proceeding normally. It was not completed: a probe does not need a granted
authorization, and signing in was neither necessary nor this process's to do.

## Three facts recorded

**A `workers.dev` host is accepted.** A shared suffix is exactly the kind of redirect target a provider may
refuse on principle, which is why this was named as unverified rather than assumed.

**A private client needs no domain verification.** The documentation says verification applies to the
`client_uri` and only before a client can be made **public** — *"If your client is only for private use by
members of the account, domain ownership verification is not required."* Creating and exercising this one
without any verification step confirms it, which matters because `workers.dev` is not a domain a customer
could verify.

**`state` must be at least 8 characters, and the server enforces it.** A CSRF nonce should be long and random
regardless, so this changes no design — but it is an enforced minimum with a specific error, and a Node
generating a short state would fail at the redirect with a message about entropy rather than anything that
reads like a configuration problem.

## What this does not establish

**The consent screen's contents.** #108 requires that it *"selects the intended account and exposes the exact
requested scopes"*, and that is an assertion about a page reached after sign-in. It belongs to the layer that
builds the flow rather than to this probe.

**The scope matrix.** This client was created with an arbitrary scope, because the question was the redirect
and not the permissions. What a Node actually needs must be measured against a real consent, and that is
#162's.

**Anything about a custom domain**, which remains the fallback if this fact ever changes — hence the
`stale_when`.

The probe client was created in an account belonging to this repository's operator and deleted afterwards. A
client id is not a secret — it appears in every authorization URL by construction, including the ones above —
but a probe artifact should not outlive its probe.
