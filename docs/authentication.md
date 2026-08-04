# Authentication

How a human gets into a Mailda Node, and how they stay in without ever seeing a 401.

Specification: §8 of the blueprint. Decisions: ADR 27 (why two tokens), ADR 28 (where the KEKs live),
ADR 29 (passkeys and the per-user password setting).
Numbers: [`receipts/password-hash-cost.md`](./receipts/password-hash-cost.md).

**Built today: email/password.** ADR 29 makes passkeys the factor Mailda builds and demotes passwords
to a per-user setting an administrator switches on. This document describes what runs now; the
"Decided, not built" section at the end describes what supersedes it.

## The shape

```
POST /api/auth/login          email + password  ->  access + refresh + expiry cookies
POST /api/auth/refresh        refresh cookie    ->  rotated pair
POST /api/auth/logout                           ->  this device's family revoked
POST /api/auth/logout-everywhere                ->  every family for this user
POST /api/auth/rotate-signing-key               ->  new current key, old one still verifying
GET  /.well-known/jwks.json                     ->  public verification keys
```

| | |
|---|---|
| `mailda_at` | ES256 JWT. HttpOnly, `Path=/`, 10 minutes. |
| `mailda_rt` | Opaque, 32 random bytes. HttpOnly, `Path=/api/auth`, 30 days. Stored SHA-256-hashed. |
| `mailda_at_exp` | One integer: when `mailda_at` expires. **Not** HttpOnly, on purpose. |

All three are `SameSite=Lax`, which withholds them from cross-site POST — that is what makes the
state-changing endpoints CSRF-safe without a separate token. `mailda_rt` is path-scoped so it rides
along only with refresh requests; a token that is not sent cannot leak from a log.

`mailda_at_exp` is readable by the page because the page has to see expiry *coming*. It carries no
authority whatsoever. Without it, a client cannot know when its own HttpOnly token dies, and the only
remaining strategy is to wait for a 401 — the exact behaviour this design exists to avoid.

## Why two tokens (ADR 27)

A signed token cannot be recalled. §7 and §28 require withdrawn authority to stop working
immediately. Rather than compromise one for the other, the two properties live in two objects:

- **Access token** — verifies with no database read. Its lifetime *is* the revocation hole, which is
  why it is ten minutes and why the number has a receipt.
- **Refresh token** — a row in D1. This is what revocation acts on. Killing it caps a revoked user's
  remaining access at the access token's residual life.

**The access token carries no authority.** Organization and user id, nothing else. Every
authorization decision is re-read from `relationship_tuples` per request, so removing a grant takes
effect on the next call regardless of any outstanding token. A token can only ever be wrong about
whether the account still exists.

ES256 rather than HS256 because verification then needs only the public key. Verification can move
out of this Worker later — to §25's client, to an auditor checking a token was genuinely issued —
without handing out the ability to mint one. HS256 would require shipping the signing secret to
every verifier.

## Rotation, and the two things that were nearly shipped wrong

Every refresh mints a new refresh token and marks the old one used, so a stolen token is useful once
at most. A used token reappearing normally means capture, and the response is to revoke the whole
**family**.

### 1. A lost response is not a theft

Two browser tabs, or one dropped connection, present the same token twice through no fault of the
client. Bare reuse detection reads that as theft and signs the user out for having flaky wifi.

So for 30 seconds the parent row keeps its successor — wrapped under the credential KEK, so the
window costs a database dump nothing — and hands it back verbatim to a second presentation. Same
token, no new rotation, no revocation. After the window it is cleared and reuse means theft again.

The client also single-flights across tabs via a Web Lock. The replay window is what makes
correctness not *depend* on the client having got that right.

### 2. A rejected token is not always an expired one

The client refreshes proactively, 120 seconds ahead of expiry. The first version refreshed *only*
when the clock said the token was stale — which made every non-expiry 401 unrecoverable: a withdrawn
signing key, a key aged past its verification window, a restored backup. The client short-circuited
its own refresh, retried with the dead token, got 401 again, and told nobody. The page rendered
"you are not signed in" above a session countdown that was still ticking.

Found by deleting the signing keys from the live deployment's D1 and reloading. The fix: a rejected
token forces a refresh, and the only safe reason to skip a forced refresh is evidence that another
tab already replaced the token — detected by comparing the published expiry across the lock.

Every 401 from a Node now carries `refreshable: true | false` (and the same as
`x-mailda-refreshable`). `true` means try refreshing. `false` means the session is over and the
cookies have already been cleared, so a client cannot loop on a dead token.

## Signing keys

Three states, and the middle one is the point:

| | |
|---|---|
| `current` | Signs. **At most one**, enforced by a partial unique index — two current keys are unrepresentable, not merely avoided. |
| `retiring` | Does not sign, still verifies, until `retires_at` (2x the access-token TTL). |
| `retired` | Verifies nothing. Kept, not deleted — which key signed a token is what an incident wants to ask about. |

Without `retiring`, rotating a key throws out every signed-in user at the moment of rotation.
Rotation is therefore invisible, which is the only kind of rotation anyone actually performs. A key
is generated on first use, so a fresh install needs no key ceremony.

Private keys are wrapped by the **credential** KEK, never the content KEK. A signing key mints
authority; message content does not. One KEK for both would mean a single leaked secret that reads
every message *and* forges a session for any user.

The KEK is a Secrets Store binding today and **ADR 28 moves it into Durable Object storage**,
generated per Node — Secrets Store bindings are not account-portable, and #7 had already established
they never protected against the platform anyway.

Verification keys are cached per isolate for 60 seconds. That is a staleness bound on *withdrawing*
a key, deliberately an order of magnitude below the access-token TTL so this cache is never what
makes revocation slow.

## Passwords

**Workers rejects any single PBKDF2 call above 100,000 iterations, and local `workerd` does not
enforce it.** This shipped as a green test suite and an HTTP 500 on every deployed sign-in. The work
is chained across six rounds of 100,000, each round consuming the previous round's output, so an
attacker still performs all 600,000 HMAC evaluations per guess.

Verifiers describe themselves:

```
pbkdf2-sha256$r=6$i=100000$<salt-b64>$<hash-b64>
```

The parameters travel with the hash. If the ceiling rises and this code moves to a single round, a
row recording only "600000 iterations" would be re-derived as one call, produce a different key, and
lock out every user. Self-description makes that unrepresentable — and it is how Argon2id arrives
later without a migration: a new prefix, old rows still verifying.

Other properties, each easy to lose and hard to notice losing:

- **No user enumeration.** Unknown address, address without a password, and wrong password are
  indistinguishable *and* take comparable time — the unknown-address path spends a real derivation
  against a dummy verifier rather than returning early. An early return leaks the user list to a
  stopwatch.
- **Constant-time comparison**, so timing cannot reveal how many leading bytes of a guess were right.
- **Lockout lives in D1.** Ten failures in fifteen minutes. An in-memory counter resets whenever a
  new isolate starts, which an attacker can cause at will. A successful sign-in clears the count.
- **Transparent cost upgrade.** The only moment the plaintext exists is at sign-in, so that is when a
  verifier made under less work is re-derived at the current cost.
- **Length only, no character classes.** Minimum 12. Composition rules produce `Password1!`;
  NIST 800-63B agrees. A breached-password check would help and needs a corpus a Node does not ship —
  recorded as absent rather than pretended at.

**This is the weakest part of the design and it is a deliberate interim.** Argon2id is the better
primitive and Workers has no native implementation. §8 specifies passkeys, which remove offline
attack rather than repricing it.

## Client lifecycle

`src/client/session.client.js`. Five things have to hold, and each is its own failure mode:

1. **Refresh ahead of expiry.** Waiting for a 401 means one request fails every ten minutes.
2. **One refresh at a time, across tabs.** Rotating tokens plus concurrent refreshes means presenting
   the same token twice. A Web Lock serialises across tabs; a promise serialises within one.
3. **Recheck inside the lock.** The tab that waited usually finds the token already renewed and must
   then do nothing at all.
4. **Wake-ups, because timers stop.** Background tabs are throttled and sleeping laptops do not fire
   timers. `visibilitychange`, `focus`, `online` and `pageshow` all recheck. Deliberately *not*
   gated on `visibilityState` — an earlier version was, which discarded the reschedule too and left
   tabs on stale timers.
5. **Distinguish "retry" from "over."** See `refreshable` above.

Not handled, and recorded rather than discovered later: retrying a request whose body is a stream.
Exactly one retry happens after a refresh, and a consumed stream cannot be replayed.

`window.mailda` exposes `refresh`, `ensureFresh`, `apiFetch`, `accessExpiresAt`, `isSignedIn` and
`route`. This grants a hostile script nothing new — cookies are HttpOnly, so an injected script could
already issue the same same-origin requests with `fetch`. What it buys is a lifecycle an operator can
watch from a console instead of infer. The status strip shows the countdown for the same reason.

## Verified against a deployed Node

On `mailda.swmengappdev.workers.dev`, 4 August 2026:

- Sign-in, wrong password (401, `refreshable: false`), and lockout counting.
- Refresh rotation; the presented token stops working and its successor works.
- **Replay window:** presenting a used token inside 30 seconds returned the *same* successor and left
  the family alive.
- **Two tabs refreshing simultaneously:** both stayed signed in, both got 200, zero families revoked.
- **Proactive refresh:** expiry forced to +60s, a wake event fired, token replaced with a full
  600-second lifetime — no 401 reached the page.
- **Reactive refresh:** signing keys deleted from D1; the page recovered by itself, minting a new key
  and rendering the ledger.
- **Rotation is invisible:** a token minted before rotation still verified, with two keys published.
- Sign-out cleared all three cookies.

## Decided, not built (ADR 28, 29 — 4 August 2026)

- **Passkeys replace passwords as the factor Mailda builds**, with no dependency: verification is an
  ES256/RS256 signature over `authenticatorData ‖ sha256(clientDataJSON)`, and ES256 already exists
  above. Attestation `none`.
- **Password authentication becomes a per-user setting, default off, enabled by an administrator**
  under step-up authentication and audited. Not removed, because a shared workstation with no
  enrollable device is a real case. **This adds a third sign-in outcome that must collapse to
  `invalid_credentials` with matching timing** — "not enabled for this account" would otherwise name
  exactly the accounts worth attacking.
- **Ten single-use 128-bit recovery codes, plain SHA-256.** Not human-chosen, so no offline-guessing
  surface to price. The same codes carry the key escrow below.
- **Both KEKs move into Durable Object storage, generated per Node.** Secrets Store bindings are not
  account-portable (measured: removing the config block drops the binding silently rather than
  relinking as D1 does), and #7 had already established that Secrets Store never protected against
  the platform. The dev-KEK fallback is deleted rather than refused, so "wrapped under a published
  constant" stops being representable. The DO's storage then becomes the crown jewels, which is why
  escrow and recovery are one artifact.

Still additive and not blocked: OIDC/SAML federation and SCIM, DPoP/mTLS sender constraints, the CLI
device grant.

## Not built

The `sessions` table is **dead**. It was replaced rather than supplemented — two live authentication
mechanisms is the shape where one gets hardened and the other quietly becomes the way in. Dropping
it is a separate contract step (§10 expand/contract). `users.password_salt` is likewise dead now
that the salt travels inside the verifier.
