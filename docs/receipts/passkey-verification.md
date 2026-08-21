---
id: passkey-verification
kind: measured-tripwire
measured_on: 2026-08-22
stale_when: >
  @simplewebauthn/server splits attestation verification behind a subpath export or otherwise sheds its
  X.509 dependencies, Workers gains a native WebAuthn verifier, or #84 decides to enforce device
  attestation and starts using the machinery this receipt records as dead weight
values:
  auth.webauthn_bundle_kib: 794
  auth.webauthn_gzip_kib: 129
  auth.passkey_challenge_ttl_seconds: 300
  auth.passkeys_per_user_max: 10
---

## The decision, and the number that did not decide it

ADR 29 locks *"passkeys are the authentication Mailda builds; password authentication survives as a
per-user fallback."* It is inverted in practice — passwords are the only authentication — and #84 is the
ticket to correct that.

Verifying a WebAuthn assertion means parsing attacker-supplied CBOR, extracting a COSE public key, and
checking a signature over a structure the attacker also supplies. Measured, with the module actually
invoked so nothing is tree-shaken:

| | Raw | Gzip |
|---|---:|---:|
| Worker without it | 2141.60 KiB | 537.30 KiB |
| With `@simplewebauthn/server` invoked, nothing else changed | 2935.26 KiB | 666.17 KiB |
| **The library's cost** | **+793.7 KiB** | **+128.9 KiB** |
| Shipped: #84 complete, library and feature | 2968.26 KiB | 675.24 KiB |
| **What a deploying operator actually pays** | **+826.7 KiB** | **+137.9 KiB** |

Both rows, for `butler-source-format.md`'s reason: the middle figure prices the **dependency**, which is what
the decision was made on, and the last is what a Node's bundle does once the whole feature lands — the
verification, the storage, the five routes, the two client surfaces. The 9 KiB of gzip between them is
Mailda's own.

That is **2.5× what the YAML parser cost** and it is being adopted where that one was argued over, so the
reasoning has to be stated rather than assumed.

## Most of it is dead weight, measured rather than suspected

The dependency tree is `@peculiar/asn1-*` and `@peculiar/x509` — X.509 certificate-chain parsing, which
exists to verify **attestation statements** in the `packed`, `tpm`, `android-key` and `apple` formats. This
Node requests `attestationType: "none"`, so none of it is ever exercised.

Confirmed that the split cannot be avoided:

| imported | Raw | Gzip |
|---|---:|---:|
| authentication only | 2935.14 KiB | 666.37 KiB |
| registration only | 2935.14 KiB | 666.34 KiB |

Both halves cost what the whole costs: one module graph, no tree-shaking benefit. So it is all-or-nothing,
and roughly two thirds of the bytes are for a feature this Node deliberately does not use.

## Adopted anyway, by this repository's own test

`mime-header-parse.md` set the test when it *deferred* a parser:

> The blast radius of a bug is a **mis-threaded conversation or a mangled subject** — wrong display, in a
> runtime with no memory unsafety, on a path that reaches the DOM only through `textContent`. Body parsing is
> the opposite: nested boundaries, transfer encodings, and **attacker-chosen structure**, feeding a renderer.
> That is where a mature parser earns 107 KiB.

Apply it here. The structure is attacker-chosen, and it feeds an **authentication decision**. The blast
radius of a bug is account takeover on a system holding an organization's mail. There is no weaker reading
available, and no part of this product where the argument for a mature implementation is stronger.

The tempting counter — *"the cryptography is Web Crypto either way, so what is left is a few comparisons"* —
is true and is not the point. The comparisons are exactly where WebAuthn implementations go wrong: the
challenge must be server-issued and single-use, the origin must match, the RP ID hash must match, the user-
presence flag must be set, and the signature counter must not go backwards. **Omitting any one of them is an
auth bypass rather than a bug**, and each is an omission a reviewer has to notice. A library makes omission
harder; a hand-rolled path makes it a matter of care, and care is not a control.

### What is spent, in context

537 → 666 KiB gzip is 6.6% of the Workers Paid 10 MB script ceiling and well inside the Free 3 MB one.
The import is dynamic, so — per `butler-source-format.md`'s finding that esbuild inlines dynamic imports for
the Workers target — **the bytes ship in the one script and the module's top-level initialization does not
run** until something authenticates. Inbound mail never pays for it.

Recorded so the reversal is cheap if it becomes right: if the package ever moves attestation behind a
subpath export, or if this Node ever needs device attestation and starts using the X.509 machinery, this
receipt is stale and the figures should be retaken rather than trusted.

## Bounds

- **`auth.passkey_challenge_ttl_seconds = 300`** — how long a server-issued challenge stays redeemable.

  Sized rather than measured, and short on purpose. A challenge is the anti-replay device: it is minted by
  this Node, stored, and deleted the moment it is used, so its lifetime is the window in which an
  intercepted one is still worth something. Five minutes is the far side of any legitimate ceremony —
  touching a key, a fingerprint, a device prompt — and well inside a user's patience for retrying.

  It is **not** `auth.invitation_expiry_seconds`'s kind of value. An invitation is a bearer credential
  someone may carry around for a day; a challenge is consumed seconds after it is issued, and a long
  lifetime buys nothing while widening the window.

- **`auth.passkeys_per_user_max = 10`** — how many credentials one account may register.

  Sized. The reason for a bound at all is that registration is an authenticated write with no other limit,
  so without one an account can grow an unbounded table. The reason it is ten rather than one or three is
  that **the whole point of passkeys is having more than one**: a phone, a laptop, a hardware key, a
  partner's device for a shared mailbox, and a spare in a drawer. A bound that made people delete a working
  credential to add another would push them back to the password this ADR is trying to demote.

## What this does not change, said because it is the question people ask

**Dual control.** §18 and #61 count **distinct people**, not credentials. Authentication strength is
orthogonal to identity: a passkey does not make one person two, and a password does not make them half.
Nothing about separation of duty moves, and `test/passkeys.test.ts` asserts that rather than leaving it as
an assumption somebody rediscovers.

**The recovery path.** #84 worried that making passkeys primary turns `mailda set-password` — which runs
outside the audit trail — into the ordinary recovery route for every account. That only follows if passwords
are **removed**, and ADR 29 explicitly does not: *"password authentication survives as a per-user
fallback."* A lost passkey is answered by the fallback doing its job. `set-password` stays what it was: the
hatch for an account that has lost both, loud about running outside what the chain can prove.
