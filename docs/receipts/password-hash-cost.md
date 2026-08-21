---
id: password-hash-cost
kind: measured-tripwire
measured_on: 2026-08-04
stale_when: >
  Cloudflare raises or removes the 100,000-iteration PBKDF2 ceiling, Workers gains a native
  Argon2id or scrypt primitive, OWASP revises its PBKDF2-HMAC-SHA256 guidance, or the measured
  cost per 1,000 iterations changes materially
values:
  auth.pbkdf2_platform_max_iterations: 100000
  auth.pbkdf2_rounds: 6
  auth.pbkdf2_effective_iterations: 600000
  auth.pbkdf2_max_derivation_ms: 250
  auth.access_token_ttl_seconds: 600
  auth.refresh_token_ttl_seconds: 2592000
  auth.signing_key_verify_grace_seconds: 1200
  auth.signing_key_cache_seconds: 60
  auth.refresh_replay_window_seconds: 30
  auth.access_token_refresh_margin_seconds: 120
  auth.max_failed_logins_per_15min: 10
  auth.invitation_expiry_seconds: 604800
---

## The platform ceiling, and why it is the important number here

**Measured on the deployed Node** (`mailda.swmengappdev.workers.dev`, 4 August 2026) by asking the
real edge to derive at increasing iteration counts:

| Requested iterations | Result |
|---:|:---|
| 1,000 | ok |
| 10,000 | ok |
| 50,000 | ok |
| **100,000** | **ok** |
| 100,001 | `Pbkdf2 failed: iteration counts above 100000 are not supported (requested 100001).` |
| 150,000 | same failure |
| 600,000 | same failure |

**Cloudflare Workers rejects any single PBKDF2 call above 100,000 iterations.**

This was a landmine of the worst shape, and how it presented is worth recording: **local `workerd`
does not enforce the ceiling.** The whole test suite passed at 600,000 iterations under
`@cloudflare/vitest-pool-workers`, while the deployed Worker returned HTTP 500 on every sign-in —
including on a *wrong* password, which is what located it, since a wrong password never reaches
token minting. A number taken from OWASP guidance and confirmed by a Node benchmark was still
wrong, because neither of those is the runtime that has to execute it. The first version of this
receipt asserted 600,000 in a single call and was wrong on the only platform that matters.

**Consequence for any future change here: measure against a deployed Node, not against local
workerd and not against Node.** A green test suite is not evidence about this limit.

## Sized: 6 rounds x 100,000, chained

600,000 iterations of work, reached in six calls that each stay inside the ceiling:

```
dk₀ = PBKDF2-SHA256(password, salt ‖ 0, 100_000)
dkᵢ = PBKDF2-SHA256(dkᵢ₋₁,    salt ‖ i, 100_000)
```

Each round's output is the next round's input, so the chain cannot be parallelised or
short-circuited: an attacker guessing a password must perform all 600,000 HMAC evaluations in
sequence, exactly as they would against a single 600,000-iteration call. The work factor is
equivalent; only the call structure differs. A 32-byte derived key is the ideal input length for
HMAC-SHA256, and the round index is folded into the salt so no round can repeat another's input.

This is a **composition, not standard PBKDF2**, and that is a genuine cost: it is not a
construction someone can look up and check against a specification. It is written down here, and in
`password.ts`, precisely so that "why six rounds?" has an answer that is not folklore.

### Cost

Measured in Node over WebCrypto (`packages/contract/bench/pbkdf2.bench.ts`) — native in both
runtimes, so the figures transfer, though they are not Cloudflare hardware:

| Iterations | ms |
|---:|---:|
| 100,000 | 11.8 |
| 600,000 | 69.7 |

Roughly linear at **0.116 ms per 1,000 iterations**, so six chained rounds cost about **70 ms**.
Against the 30M CPU-ms/month included on Workers Paid (receipt: `cloudflare-plan-costs.md`) that is
roughly **428,000 sign-ins per month** before hashing alone incurs overage — not a constraint for an
organizational mail system.

`auth.pbkdf2_max_derivation_ms = 250` is a tripwire, not a target — ~3.5x the measured cost. It
fires if the platform slows sharply or the round count is raised carelessly, and a good sign-in
never approaches it.

## Verifiers describe themselves

The stored verifier is a single PHC-style string:

```
pbkdf2-sha256$r=6$i=100000$<salt-b64>$<hash-b64>
```

Not three loose columns. The reason is this exact incident: the parameters that produced a hash must
travel *with* the hash, or a later change to the platform ceiling silently changes what an existing
row means. If Cloudflare raises the ceiling to 600,000 and the code switches to a single round, a
row recording only "600000 iterations" would be re-derived as one call and produce a different key —
locking out every existing user. Self-describing verifiers make that unrepresentable, and they are
also how Argon2id arrives later without a migration: a new prefix, old rows still verifying.

## Why PBKDF2 and not Argon2id

Argon2id is the better primitive: memory-hard, so it resists GPU and ASIC attack in a way PBKDF2
does not. **Workers has no native Argon2id.** The options are a WASM build — bundle weight in every
Worker, plus its own timing behaviour to establish — or PBKDF2 via WebCrypto, which is native and
audited.

This is recorded as a **known weakness, not a solved problem.** PBKDF2 at 600,000 effective
iterations is an accepted baseline, not a strong one: an attacker holding a leaked verifier and
commodity GPUs recovers weak passwords far faster than they would against Argon2id. Two things
mitigate it and neither eliminates it — the self-describing verifier allows raising the cost or
changing the primitive without invalidating users, and §8 specifies passkeys, which remove the
offline-attack surface entirely rather than repricing it.

**The honest position: password auth is the weakest link in this design, and it is a deliberate
interim.**

## Token lifetimes

- `auth.access_token_ttl_seconds = 600` — ten minutes. §7 and §28 require revoked authority to
  disappear immediately, and a signed token cannot be recalled. Ten minutes is the window in which a
  revoked user retains read access, and it is the number to argue about if that is too long. Shorter
  means more refreshes; longer means a wider revocation hole.
- `auth.refresh_token_ttl_seconds = 2592000` — thirty days, DB-backed and therefore genuinely
  revocable. This is where revocation actually bites.
- `auth.signing_key_verify_grace_seconds = 1200` — twenty minutes, 2x the access-token TTL. After
  rotation a retiring key must still verify tokens it signed, and every such token has expired by
  the time the window closes. Rotation that signs users out is rotation nobody performs.
- `auth.signing_key_cache_seconds = 60` — how long an isolate reuses a cached verification key, and
  therefore the staleness bound on withdrawing one. An order of magnitude below the access-token
  TTL, so this cache is never what makes revocation slow.
- `auth.refresh_replay_window_seconds = 30` — how long a rotated refresh token still returns its
  successor instead of tripping reuse detection. Sized to cover a lost response and a two-tab race,
  not a session: longer than any request round trip, far shorter than the token's life. Set it to 0
  and a dropped response signs the user out; set it to hours and a captured token stays usable for
  hours.
- `auth.access_token_refresh_margin_seconds = 120` — how far ahead of expiry the client refreshes, so
  a token is replaced while still valid and a 401 from ordinary expiry never reaches a user. Must
  exceed the worst plausible clock skew plus one round trip.
- `auth.max_failed_logins_per_15min = 10` — a tripwire past where a human typing a password goes.
  Recorded in D1 rather than in memory, because a new isolate forgets and an attacker can cause a
  new isolate at will.

## Correction — 21 August 2026: `auth.invitation_expiry_seconds = 604800` is sized, not measured

Seven days, and there is **no measurement behind it**, in the same way and for the same reason as
`approval.send_expiry_seconds` in `dispatch-recheck-cost.md` and `send.hold_window_default_seconds` in
`cloudflare-email-sending.md`: it is a statement about how long a human arrangement stays good, and no
measurement of this system could settle it. Recorded here so a reader does not conclude the receipt rule was
skipped.

**What an invitation is, which is what the number has to be sized against.** Until #83 a Node could not add a
second person at all — the only account was the one the claim created. An invitation is a secret an
administrator mints and hands over out of band; whoever holds it becomes a member of the organization by
choosing a password. So it is a **bearer credential for membership**, and its lifetime is the window in which
a leaked one is still useful to an attacker.

What it trades off, in both directions:

- **Long enough to survive an ordinary handover.** An administrator who mints one on a Friday for somebody
  starting on Monday, or pastes it into a message that is read after a weekend and a public holiday, must not
  find it dead. Four days clears that — `approval.send_expiry_seconds` argues exactly this — and a week
  clears it with a working day's slack on either side. An expiry that fires on a legitimate invitation is a
  tripwire a good widget touches, which AGENTS.md says makes the tripwire wrong rather than the widget.
- **Short enough that a stale link is not a standing key.** This is the direction that matters more than it
  does for an approval, and it is why the number is not thirty days: the credential creates an *account*,
  not a decision about one message. A link in a year-old email thread is how somebody becomes a member of an
  organization nobody meant to add them to, and the only defence against that is the clock.

**Why it is not configurable.** A per-invitation duration was considered and rejected. `supervised.read`
takes one from the caller because §7 makes *time* part of the scope somebody approved — two people agreed to
that window. An invitation has no approver: one administrator acts alone, and a field they can set to a year
is a field that will be set to a year the first time a handover is awkward. The fixed window is the whole
protection.

**What is deliberately absent.** No renewal, and no extension. Re-minting is one call and produces a fresh
secret with a fresh window, which is the same act with an honest audit trail — `access.invited` names the
administrator each time. An extension would let one person quietly keep a bearer credential alive
indefinitely with nothing in the trail saying how long it had really been out.
