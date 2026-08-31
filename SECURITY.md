# Reporting a security problem

**Do not open a public issue.** Use GitHub's private vulnerability reporting on this repository —
[Security → Report a vulnerability](https://github.com/Straits-AI/mailda/security/advisories/new) — which
opens a draft advisory only maintainers and you can read.

If that is unavailable to you, say so in a public issue **without describing the problem** and a maintainer
will open a private channel.

## What this software is, which shapes what counts as a vulnerability

Mailda is not a service. One organization deploys one Node into **its own Cloudflare account**, holding its
own domain, its own D1 and R2 data, and its own encryption keys. There is no Mailda-operated control plane to
compromise and no shared tenancy to escape.

So the interesting boundaries are not the usual ones:

| boundary | what a finding here means |
|:--|:--|
| **between people in one organization** | a mailbox relation, a supervised grant or an approval that grants more than it says |
| **between the Node and its own operator** | a record the operator can rewrite without it being detectable |
| **between hostile mail and the reader** | a message escaping the sanitiser or the frame that contains it |
| **between a browser and the Node** | forgery, fixation, or a session surviving a revocation |
| **between the repository and a deployed Node** | anything in the update channel — the repo *is* how customers upgrade |

That last row is the one most worth your attention and the least obvious: a customer upgrades by merging from
this repository, so a compromise here reaches every Node that later pulls.

## What is already known and documented, so you need not report it

These are stated limitations rather than undiscovered problems. Reporting them is welcome but will be closed
as known, and each has an issue or a source comment explaining the reasoning:

- **A Cloudflare account operator can rewrite the audit chain.** The hash chain detects quiet modification of
  *individual* entries; somebody with D1 access can rebuild the whole chain. The code says so where the chain
  is verified. External anchoring is not built.
- **Cloudflare holds ciphertext and keys.** Content is encrypted under keys in Durable Object storage, which
  is Cloudflare's infrastructure. This defends against a D1 dump and a configuration leak, not against the
  platform — ADR 28 states that explicitly, and it is why Secrets Store was rejected as offering nothing
  extra.
- **A D1 dump reveals which words occur in which message.** The body search index is *contentless*: it stores
  the inverted index and no copy of any document, so a dump lets somebody **confirm a guess** — that a given
  word appears in a given message — and with a dictionary and patience, learn a good deal that way. It does
  not yield the text, the order of the words, or anything about a message whose words cannot be guessed. This
  is the narrowing ADR 28 took on 27 August 2026 and it is deliberate, not an oversight. Body search itself
  requires `mailbox.content.read`; the weaker `mailbox.metadata.read` reaches subjects and senders only.
- **No attachment scanning, spam filtering or URL detonation.** Inbound mail is stored as evidence and
  sanitised for display. It is not screened. A public mailbox on a production Node should not be accepting
  attachments yet.
- **Passwords remain a supported sign-in path.** Passkeys are the primary mechanism now, and ADR 29's plan to
  make passwords a per-user opt-in setting is not built.
- **Recovery codes restore the key vault and do not sign anybody in.** The redemption route is
  unauthenticated on purpose, because the state it exists for has no verifiable session keys. What it can do
  is bounded and asserted: it installs keys this Node already escrowed, issues no session, and grants nothing.

- **Authored commits are unsigned, and this is a decision rather than a gap.** Merge commits into `main` *are*
  signed — GitHub's web-flow key, `B5690EEEBB952194` — so every change that reaches `main` carries a signature
  over the merge that put it there. Individually authored commits report `N`, and there are no signed tags.

  Maintainer commit signing was considered under
  [#102](https://github.com/Straits-AI/mailda/issues/102) and **not adopted**, because a signature is worth
  what its verification is worth and nothing in this product's update path verifies one. `git pull` does not
  check signatures unless an operator configures `gpg.ssh.allowedSignersFile` and passes
  `--verify-signatures`, which nobody does. Requiring signatures would have constrained every commit to
  produce a property no consumer reads — the same defect as a condition backed by nothing.

  What answers the actual question — *did this come from there* — is the provenance attestation below, which
  is verifiable in one command and is tied to a workflow run in this repository over a commit that passed
  `check`. **What it does not answer is who wrote that commit.** Repository access is the control there:
  protected `main`, no bypass actors, a required green check, and a reviewed pull request per change.

  This changes if the update path ever verifies: shipping `git pull --verify-signatures` into `mailda update`,
  or a preflight that checks the upstream commit against a known key, would make signing load-bearing. Signing
  should follow that, not precede it.

## Verifying what you merged

Every push to `main` publishes a CycloneDX SBOM and a Sigstore-backed provenance attestation for it, produced
by the `sbom` job in `.github/workflows/ci.yml` after the suite passes. The attestation is keyless — GitHub's
OIDC identity rather than a maintainer's key — so it is available today, unlike commit signing above.

```sh
gh run download --repo Straits-AI/mailda --name mailda-sbom
gh attestation verify mailda-sbom.cdx.json --repo Straits-AI/mailda
```

What this establishes: the inventory came from a workflow run in this repository, over a commit that passed
`check`. What it does **not** establish: that the commit was authored by anyone in particular. That is the
signing gap above, and the distinction is the whole reason both are listed.

The SBOM is generated from `pnpm-lock.yaml` rather than from an install, so every third-party entry carries
the integrity hash the install would have verified, and the document is byte-identical across runs of the same
commit. A lockfile entry the generator cannot read fails the build instead of being omitted — an inventory
missing a dependency answers "is this here?" with a confident no.

## What is in scope and worth reporting

Anything that breaks a claim the code makes about itself. This project's own findings are almost all of that
shape — a comment asserting a property nothing enforced — so if you read a guarantee here and can defeat it,
that is a report, whether or not the defeat is dramatic.

Concretely: authorization that grants more than its relation names, a refusal that can be bypassed, evidence
that can be altered without detection, a supervised read that leaves no record, a legal hold that fails to
hold, a session that outlives its revocation, or anything reachable from a sibling subdomain of a customer's
own domain.

## What to expect

There is no service-level agreement and it would be dishonest to print one. This is a small project. You will
get an acknowledgement, an assessment of whether it is a vulnerability or a known limitation, and — if it is
the former — a fix with the reasoning written down, which is how everything else here is fixed.

Because customers upgrade by merging from this repository rather than by receiving a push, a fix reaches a
deployed Node only when its operator pulls. Advisories are therefore published on the repository, and a fix
that matters will say plainly what an operator has to do.
