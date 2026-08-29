# Authentication

How a human gets into a Mailda Node, and how they stay in without ever seeing a 401.

Specification: §8 of the blueprint. Decisions: ADR 27 (why two tokens), ADR 28 (where the KEKs live),
ADR 29 (passkeys and the per-user password setting).
Numbers: [`receipts/password-hash-cost.md`](./receipts/password-hash-cost.md).

**Built today: email/password.** ADR 29 makes passkeys the factor Mailda builds and demotes passwords
to a per-user setting an administrator switches on. This document describes what runs now; the
"Decided, not built" section at the end describes what supersedes it.

## Passkeys (#84, ADR 29)

ADR 29 locks *"passkeys are the authentication Mailda builds; password authentication survives as a per-user
fallback."* It shipped **inverted** — passwords were the only authentication, and every reference to passkeys
in the tree was prose. `src/claim.ts` said so outright, which is the honest treatment of a deferral and also
the evidence that the contract's primary mechanism was never started.

It mattered more than when it was written. #83 made a Node able to add people, so a password stopped being
one operator's own credential on their own Node and became **every colleague's**.

### The relying party is derived, never configured

WebAuthn binds a credential to an origin, and the relying-party id is that origin's domain — a
customer-specific value ADR 24 forbids the repository from holding. It comes from `request.url`, and that is
**better** than a stored value rather than a concession to one: a stored RP id can disagree with the origin
the browser is actually on, and when it does every ceremony fails with a mismatch nobody can act on.
Deriving it makes the disagreement unrepresentable.

Consequence, stated: a Node reachable at two origins holds separate credentials per origin. That is WebAuthn
working as specified.

### The five checks, and why a library

| check | what it stops |
|:--|:--|
| challenge server-issued, single-use | replay of an intercepted assertion |
| origin matches | a lookalike site relaying a ceremony |
| RP id hash matches | the same, one layer down |
| user presence | an assertion nobody touched |
| counter never decreases | a cloned authenticator |

`@simplewebauthn/server`, at +128.9 KiB gzip — 2.5× the YAML parser, and roughly two thirds of it X.509
machinery for attestation formats this Node does not use. Adopted anyway by the test
`mime-header-parse.md` set when it *deferred* a parser: attacker-chosen structure feeding an
**authentication decision** is where a mature implementation earns its bytes.

The tempting counter — *"the cryptography is Web Crypto either way"* — is true and beside the point. Those
five checks are where WebAuthn implementations go wrong, and **omitting one is an auth bypass rather than a
bug**. See `docs/receipts/passkey-verification.md`.

### Attestation is `none`, and `userVerification` is `preferred`

Attestation proves *what kind of authenticator* this is. Mailda has no policy that depends on the answer, so
requesting it would collect a device fingerprint the product cannot use. Requesting none is the
privacy-preserving default.

`preferred` rather than `required` is the trade this Node takes: `required` demands the authenticator verify
the *person*, which locks out every security key without a PIN. A primary mechanism some hardware cannot
satisfy is one people route around by using the password fallback for ever.

### Tested against a real authenticator, because the negatives are the point

`test/authenticator.ts` holds a P-256 key and signs real assertions. A recorded browser fixture would prove
one response verifies and could never answer *"does a replay fail"*. Mutation-proven four ways: not deleting
the challenge, not checking its purpose, accepting a second origin, and dropping the owner binding from
revocation each fail their own assertion.

That last one **caught a vacuous test**: the first version asked to revoke an id that did not exist, so
removing `user_id` from the delete's predicate changed nothing. The credential is now real and somebody
else's, which is the only shape that distinguishes the two.

### What does not change

**Dual control.** §18 and #61 count distinct **people**. A passkey does not make one person two. The session
a passkey issues carries the same fields a password's does, so no counting rule can branch on the mechanism
even if somebody wanted it to.

**Recovery.** Passwords stay, as ADR 29 says. `mailda set-password` remains the hatch for an account that has
lost both — not the ordinary path, which is what #84 worried about and what keeping the fallback prevents.


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
| `__Host-mailda_at` | ES256 JWT. HttpOnly, `Path=/`, 10 minutes. |
| `mailda_rt` | Opaque, 32 random bytes. HttpOnly, `Path=/api/auth`, 30 days. Stored SHA-256-hashed. |
| `__Host-mailda_at_exp` | One integer: when the access token expires. **Not** HttpOnly, on purpose. |

All three are `SameSite=Strict`. **This paragraph used to say they were `Lax`, and that Lax "is what makes
the state-changing endpoints CSRF-safe without a separate token" — which was false** (#96). Lax does
withhold cookies from cross-site POST, but same-site is computed on scheme plus registrable domain, so every
sibling subdomain of the customer's own domain sat inside its protection. On a Node deployed into the
customer's own account that is the normal configuration: a marketing site, a Pages preview, a forgotten
CNAME. The real defence is `src/csrf.ts` — exact `Origin`, and `Sec-Fetch-Site` refusing `same-site` as well
as `cross-site`. Strict is one more layer, not the argument.

**`__Host-` on two of the three, and the exception is deliberate.** The prefix is a browser-enforced promise
that a cookie was set by this exact host over HTTPS with `Path=/`, so a sibling subdomain cannot set one
this Node would read — the same threat as above, arriving as fixation rather than forgery. The refresh cookie
cannot have it, because the prefix *requires* `Path=/` and that cookie is scoped to `/api/auth` so the
refresh token is not attached to every request. A token that is not sent cannot leak from a log or a
mis-proxied request, and for the one credential that mints sessions that is the stronger property. What is
given up is bounded: a sibling could set a `mailda_rt` this Node reads, and it would be a refresh token they
already know, refused by the D1-backed family it is validated against.

Renaming those two **signs everybody out once, on upgrade.** Accepted rather than smoothed over: carrying
both names for a grace period means two cookies either of which authenticates, and "two live paths, one of
them the older weaker one" is the shape ADR 29 warns about for authentication generally.

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
  surface to price. The same codes carry the key escrow below. **The escrow half is built** (#92); signing in
  with a code is not — see below.
- **Both KEKs move into Durable Object storage, generated per Node.** Secrets Store bindings are not
  account-portable (measured: removing the config block drops the binding silently rather than
  relinking as D1 does), and #7 had already established that Secrets Store never protected against
  the platform. The dev-KEK fallback is deleted rather than refused, so "wrapped under a published
  constant" stops being representable. The DO's storage then becomes the crown jewels, which is why
  escrow and recovery are one artifact.

Still additive and not blocked: OIDC/SAML federation and SCIM, DPoP/mTLS sender constraints, the CLI
device grant.

## The key escrow, which ADR 28 refused to ship without (#92)

`keyvault.ts` said it plainly and for a while nothing satisfied it: *"ADR 28 therefore does not ship without
the key escrow in ADR 29."* Worse than a gap — three refusals told an operator to *"restore the vault from
the ADR 29 recovery codes"* when none existed, so the remedy named was impossible and somebody would go
looking for it.

Ten codes are minted at claim and returned **once**, in the claim response and nowhere else. Each carries its
own copy of the vault's secrets, so any one of them restores it and losing nine is survivable — which is what
"ten single-use codes" has to mean.

**Two uses of one secret, kept apart, and this is the whole design:**

| | derived from | stored on the Node | answers |
|:--|:--|:--|:--|
| authentication | `sha256(code)` | **yes** | is this one of the ten? |
| encryption | the code's plaintext, domain-separated | **no** | may this open the vault? |

Sealing the escrow under the stored hash would put the ciphertext and its key in one row, and a D1 dump — the
exact threat ADR 28 says Durable Object storage defends against — would carry both. So this Node can *verify*
a code it cannot *use*. `test/recovery-escrow.test.ts` asserts it by attempting the attack: every value the
table contains, used as a key against the blob, must fail, and the code itself must succeed.

Three things the mechanism reports rather than hides:

- **A stale escrow.** Rotation makes new objects openable only by the new key, so an escrow taken before it
  restores a vault that reads old mail and not new. `doctor`'s `recovery_escrow` compares the escrow's
  generations against the vault's inventory and goes `degraded` — the only honesty check in `doctor.ts`
  allowed to be, because a Node holding unrecoverable mail is not healthy.
- **A generation it could not install.** Reachable, and found by mutation testing rather than by reasoning:
  lose the storage, let the Node keep working, and `sealingKey` mints a *fresh* generation 1 with a different
  secret. The escrow's generation 1 and the live one are both real and both needed. The live key is kept, so
  newer mail survives, and the collision is reported — the first version silently skipped it and reported the
  generation as restored.
- **Nothing in the audit trail that could open the escrow.** Both acts are audited, because
  `POST /api/recovery/redeem` takes **no session** — it must, since the state it exists for has no verifiable
  session keys — and an unauthenticated route that installs keys without a trace is what §7 forbids. The
  subject is the code's row id, never the code and never its hash.

### A sheet is a set, and a rotation no longer destroys the one somebody holds

`recovery_codes` held rows for an organization and nothing more, so *"the current set"* meant *"every row"*.
Two defects came out of that single absence, and neither was fixable without a set identity (migration 0047,
prefix `pad_`):

- **Rotation deleted the working set to insert its replacement.** One batch made that atomic, so a partial
  write was impossible — but a *lost response* is not, and it is the ordinary failure. The operator who never
  sees the new sheet holds an old one that no longer works and a new one they have never read; the escrow stays
  perfectly intact and becomes unreachable by anybody. A confirmed sheet now survives a rotation and is retired
  only when its replacement is **confirmed**. What a rotation still replaces is an *unconfirmed* sheet, which
  nobody proved they hold — that bounds the table at one pending sheet plus one active one instead of leaving
  another sealed copy of the vault behind on every press of the button.
- **Confirmation was org-wide.** It verified a code against the current rows and then marked every unconfirmed
  row in the organization. A rotation landing between the two statements marked the *new* sheet as held on the
  strength of a code from the old one. It is now conditional on the set the code belongs to, so a set that has
  since been replaced marks nothing and the count says so.

Three details that are load-bearing rather than incidental:

- **Retirement is a deletion, not a state.** Each row carries the vault *sealed under its own code*, so a
  retired row left in the table is the vault still openable by the old sheet — the exact thing somebody
  rotating their codes is trying to stop being true. A `retired_at` column would have recorded the intent and
  kept the capability.
- **`set_id IS ?` and `IS NOT ?`, never `=` and `<>`.** Migration 0047 leaves pre-existing rows with a NULL
  `set_id` — one legacy set per organization, nothing to classify and no identifier to invent. `<>` against
  NULL is NULL, so the `=` forms would retire nothing on the first rotation after an upgrade: two live sheets,
  and the vault still open to codes the operator was just told were retired. That is the most likely path
  through the predicate, not an edge.
- **`doctor` asks whether a sheet is *held*, not whether any row is unconfirmed.** With two sets able to
  coexist, an operator holding the active sheet while a fresh one waits is recoverable — and the older
  condition went `degraded` on precisely that state. Staleness is judged on the confirmed sheet's generations
  too, since a pending sheet carrying the current generation says nothing about whether anybody can use it.

Minting is also **attributed** now. It recorded `actorKind: "node"` on the reasoning that the claim path has
no session — which had stopped being true, since `claim.ts` issues one on the line above, and never applied to
`POST /api/recovery-codes/rotate` at all. Rotating the one artifact that can decrypt an organization's mail was
the least attributable act in the product and the least attributed.

### Restoring the vault is a saga, because it cannot be a transaction

`redeemForVault` wrote `recovery.vault_restored / ok`, marked the code spent, and **then** made the Durable
Object calls that put the keys back. D1 and Durable Object storage share no transaction, so a Worker dying in
between left three things true at once: the code gone, the trail claiming success, and the keys still absent.
Ten codes bound the damage and do not make the record honest — and this is the disaster-recovery path, whose
record is read during the incident it exists for.

The attempt is now recorded before the vault calls and settled after:

- `recovery.restore_started` claims only that an attempt began, with which code, and what the escrow carried.
  It cannot say what was installed, because nothing has been yet.
- `recovery.vault_restored` is written **knowing** — `ok` when it ran to the end, `failed` when the vault
  refused part way — and names the generations put back and the ones that collided with a live key.

A `started` with no settling entry beside it is an interrupted restore. That state existed before and was
indistinguishable from a completed one.

Three details:

- **The row is the reservation.** A code with a live `started` row is in flight, which stops two concurrent
  redemptions doing the work twice; `started_at` is the lease, so a dead attempt frees the code after five
  minutes rather than parking it for ever. A reservation nothing can release is a deadlock wearing a safety
  argument, which is the same reasoning the body-index lease carries.
- **A failed attempt does not spend the code.** The operator has few and needs them under exactly the
  conditions that cause failures. Resuming is safe rather than merely allowed, because every step is
  idempotent: `vault.restore` reports `identical` for a generation already present and `conflict` for one that
  disagrees.
- **A corrupt escrow is refused with a reason.** One that decrypts and no longer describes a vault used to
  throw a bare `TypeError` out of the audit detail's `.map` — a 500 with no what, why or fix, on the path
  where an operator is deciding whether to spend one of nine remaining codes.

### Doctor answers less, to fewer people, after less work

Two things were true of `/api/doctor` and neither was intended. It ran the **entire diagnostic** to decide
whether an anonymous caller got a 401 — an organization-wide sweep of D1, R2 and the vault, performed for a
request that received nothing. And any signed-in colleague got the full report, which names holds, matters,
mailboxes, send manifests, agent names, Butler triggers and domain pauses. The `discloses: "data"`
classification that marks those findings existed already and decided only what a *locked-out* operator saw.

Now: a two-check probe answers the 401 question, and the reduced report is the default with the full one
reserved for `org.admin`. That also makes the locked-out case coherent rather than an exception — the
anonymous reduced report and an ordinary member's are the same report, for the same reason.

Two more findings joined it, both about what the latest row cannot say:

- **`recovery_key_conflicts`** scans every completed restore, not the newest. A collision is permanent — two
  secrets cannot share one generation number — so mail sealed under the escrowed key of that generation stays
  unreadable, and a later clean restore was becoming the newest row and taking the conflict out of the verdict
  without anything having repaired it. It stays degraded; there is no acknowledgement record yet, which is
  stated rather than implied.
- The restore detail is **parsed through a schema**. Catching invalid JSON and then trusting the shape meant a
  row carrying `"conflicted": 7` reached `.map()` and took the diagnostic down — a disaster report that fails
  on a malformed historical record fails at the one moment it is needed.

**Signing in with a recovery code is deliberately not built.** ADR 29 gives the codes two jobs and this is
the second. The first needs step-up, rate limiting and an audited session-issuance path, and shipping the
vault half first closes ADR 28's gate without waiting on any of it. Redemption issues no session and grants
nothing.

**What #92 still asks for and this does not do:** exporting D1, the R2 object inventory and the cryptographic
manifests, restoring all of it into a clean Cloudflare account, and measuring RPO and RTO from a real drill.
That is a later layer rather than a deferral — the keys had to come first, because exporting evidence nobody
can decrypt is a backup that proves nothing.

## Not built

The `sessions` table is **dead**. It was replaced rather than supplemented — two live authentication
mechanisms is the shape where one gets hardened and the other quietly becomes the way in. Dropping
it is a separate contract step (§10 expand/contract). `users.password_salt` is likewise dead now
that the salt travels inside the verifier.
