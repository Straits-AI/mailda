# Onboarding: first contact to first real use

**Status:** analysis, not a decision record. Traces the journey a new organisation
actually walks, marks where it breaks, and names the decisions that are missing.

Blueprint §5A specifies onboarding as a 13-step resumable checklist. This document is
about everything §5A does **not** cover, plus what the checklist feels like to walk.

---

## The arc

```
  hear about it → evaluate → decide to try → install → claim → configure
  → domain → MX → first inbound → first outbound → policy → invite → real use
```

§5A begins at **install**. Steps 1–3 of that arc have no specification anywhere in the
blueprint, and step 4 is undecided (#13). Everything before "install" is currently
assumed.

---

## Stage 1 — Hearing about it

**Specified:** nothing.

Mailda's positioning line is *"programmable mail for people, workflows, and agents."*
That describes the architecture, not a problem anyone has at 9am. Nobody searches for a
programmable mail operating system.

They search for, or complain about:

- "two of us replied to the same customer email"
- "I can't tell if anyone answered invoices@"
- "our shared inbox is a Gmail account we all know the password to"
- "I want an AI to draft replies but not send them"

**Gap:** there is no stated acquisition trigger, and no stated first user. §4A lists
thirteen personas but not which one arrives first, unprompted. The persona who installs
is almost certainly a technical founder or ops-minded engineer at a 5–50 person company —
someone who owns the domain and can change DNS. That person is not the same as the
"Organization Administrator" §4A describes, and definitely not the "Employee."

---

## Stage 2 — Evaluating

**Specified:** nothing before installation.

To get value from Mailda a prospect must already have, or be willing to obtain:

| Prerequisite | Cost to them |
|---|---|
| A Cloudflare account | Low — free to create |
| **A domain they control** | Hard blocker if they don't |
| **Willingness to change MX**, or delegate a subdomain | High — this is live mail |
| Workers Paid, **to send mail at all** | **$5/month minimum**, 3,000 emails included, then $0.35/1,000 |
| ~~Email Sending entitlement~~ | No longer *beta*-gated, but **plan**-gated: free plan cannot send at all |

None of these is stated as a prerequisite; they surface as failures partway through the
checklist.

**Gap:** no "can I even use this?" page. A prospect cannot self-qualify before investing
an hour.

---

## Stage 3 — Deciding to try

The blueprint offers two entry paths (§5A) — the Deploy to Cloudflare button, and
`npm create mailda@latest`.

**Both are currently blocked or unbuilt:**

- The button requires a **public repository**. `mailda` is private, so the button cannot
  work at all until open-sourcing is decided.
- The button deploys **one** Workers application, while a Node is nine least-privilege
  Workers (#4). Unresolved: #13.
- Auto-provisioning creates **one D1 per Worker, never shared** (receipt:
  `d1-auto-provisioning.md`), and it fails silently — nine Workers would deploy green onto
  nine disconnected catalogs.

**The deeper problem is that both paths assume commitment.** There is no way to look at
Mailda working before committing a domain. Every evaluation path runs through a DNS change.

---

## Stage 4 — Installing

**Specified:** §5A entry paths. **Decided:** partially — see #13.

The CLI path is six commands. That is fine for the technical founder identified above and
wrong for anyone else, but anyone else cannot change MX either, so the audience is
consistent at this stage.

What §5A gets right: one resumable setup state shared by both paths, so a technical
operator can install and hand the checklist to a business administrator without
restarting. That is a genuinely good design and rare.

---

## Stage 5–13 — The checklist, walked

§5A's thirteen steps, annotated with what they actually feel like.

| # | Step | Friction |
|---|---|---|
| 1 | Organization | Fine. Name, locale, timezone. |
| 2 | Owner security | Passkey plus **a second recovery owner** — at this point the user may be alone, and inventing a second owner is a real stall. |
| 3 | ~~Mode~~ | **Resolved 3 Aug 2026.** ADR 23 leaves one mode, so this step is withdrawn. |
| 4 | Domain | Prove control. Fine if they have one. |
| 5 | **DNS / MX** | **The cliff.** See below. |
| 6 | First mailboxes | Fine. |
| 7 | Outbound test | **Partly resolved 3 Aug 2026.** No longer beta-gated — but Email Sending is unavailable on the free plan, so `unavailable` is still a real state. Three states: free plan, paid-but-unverified-domain, paid-and-verified. |
| 8 | **Inbound test** | **The first moment anything feels real** — step 8 of 13. |
| 9 | Policy choices | Content supervision, external sending, AI, forwarding, retention, approval. Six governance decisions, plus #7's mandatory security-profile disclosure. A wall of consequential dialogs for someone who wanted email to work. |
| 10 | Directory | Fine, and optional. |
| 11 | Automation test | Sample Butler in simulation. Good — value with no risk. |
| 12 | Recovery | Backup target plus integrity verification. Correct, and heavy for step 12. |
| 13 | Readiness review | Good. Honest about deferred items. |

### The two structural problems

**Time to first value is step 8 of 13.** Seven steps of configuration before a single real
message appears. Everything up to then is trust in a process, with no feedback that any of
it works. For comparison, every mail product a user has ever adopted showed them a working
inbox in under two minutes.

**The MX cliff at step 5 is not reversible-feeling.** Pointing MX at Cloudflare means live
mail flows through software they have never seen working. §5A's "safe setup mode" covers
outbound (test sink), Butlers (simulation) and DNS (plan and rollback) — but a person
evaluating a mail system does not want a rollback plan, they want to not have bet their
mail in the first place.

The blueprint does offer **"a domain or delegated subdomain"** in step 4. A delegated
subdomain (`mail.example.com`, or better `try.example.com`) is the honest low-stakes path
and it is buried as a parenthetical. It should be the default suggestion, not an aside.

---

## What would fix the shape

Not decisions — candidates, to be argued properly.

**1. Value before DNS.** Install should produce a Node that is immediately explorable with
realistic fixture mail: a populated shared inbox, a case, a Butler run, an approval
waiting. §5A already ships fixtures for step 11's automation test; extending them to seed
the whole product costs little and moves first-value from step 8 to step 0. The user then
connects a domain *because they have seen the thing work*, not on faith.

Everything fixture-generated must be unmistakably marked, which §5A's safe setup mode
already requires.

**2. Make the delegated subdomain the default path.** `try.example.com` carries no real
mail. Promote it from parenthetical to the recommended choice, with apex MX as the
graduation step once they trust it.

**3. ~~Move the mode choice later.~~** Done differently — ADR 23 removed the choice.

**4. Front-load the domain-verification state.** Whether sending is limited to verified
destinations is knowable at install time from the account, not at step 7.

**5. Write the prerequisites page.** Domain, DNS control, Cloudflare account, expected
cost, and the honest sentence about Email Sending being beta. Let people disqualify
themselves in 30 seconds instead of an hour.

---

## What this changes about #13 and #14

It reframes them rather than resolving them.

The install shape matters far less than assumed, because **the button cannot be the
evaluation path anyway** — it needs a public repo, and it lands the user in the same
DNS-first checklist. One-click install does not fix onboarding; it speeds up the part that
was never the problem.

The part that *is* the problem — no value before commitment — is a product decision that
neither #13 nor #14 touches.


---

## Update, 3 August 2026

Three of the frictions above have been resolved by decisions taken after this was written.

**The mode choice (step 3) is gone.** ADR 23 leaves one deployment mode. Provider
Connected and Full Mail Adapter are withdrawn — see ADR 4 and ADR 5.

**The entitlement trap (step 7) is largely gone.** Cloudflare Email Service is no longer
beta or availability-gated. Verify the sending domain and arbitrary recipients work
immediately. Receipt: `cloudflare-email-service-limits.md`.

**Provider Connected is no longer a candidate evaluation path.** It was briefly considered
as the zero-commitment trial — connect Gmail, see your own real mail, no DNS change. That
does not survive contact with Gmail's access model: full-access scopes are *restricted*,
requiring a per-customer Google Cloud project, an OAuth client per organization, Pub/Sub
for push, and an annually renewed CASA assessment for anything not internal-only. It is
**more** setup than delegating a subdomain, not less.

**A candidate for the evaluation problem was found, tested, and then rejected.** The free
plan does receive real mail — verified live, a Gmail message reached a Worker and was
persisted at zero cost (`free-plan-node-capability.md`). It can even reply to previously
verified addresses. For a few hours that looked like the zero-cost evaluation path this
document went looking for.

It was withdrawn by ADR 25. Cloudflare's free plan forces **24-hour, non-configurable queue
retention**, and §22 requires retention to be set explicitly precisely because the default
silently deletes unread messages. A free-plan Node is therefore not a limited Node, it is one
that can lose mail — unacceptable for an evaluation that is meant to build trust.

The adoption argument also turned out to be weak: the real commitment a prospect makes is
**pointing MX at Cloudflare**, not paying $5. Anyone willing to do the first will do the
second.

**What remains unfixed, and is now the whole of it:** there is still no way to evaluate
Mailda without pointing MX at Cloudflare, and time to first value is still step 8 of 13. ADR
25 closed the free-plan route; the fixture-seeded install and the delegated-subdomain default
are the remaining candidates, and neither removes the DNS step. This document should not
pretend the problem is solved. With connectors
withdrawn, the two candidates are the ones already identified here — seed the install with
fixture mail, and promote the delegated subdomain from a §5A parenthetical to the
recommended path. §10's domain topology already defaults to `ops.example.com` or
`mail.example.com`; onboarding does not yet reflect that.


---

## Resolved, 3 August 2026 — ADR 26

This document's central finding was that there is no way to evaluate Mailda without a DNS
change. That is **true and now accepted** rather than solved, because the framing was wrong.

Two questions were being conflated. *"Do I want this?"* — answerable with any realistic data,
and it never needed the prospect's own mail. *"Does it work for my mail?"* — unanswerable
without pointing MX at Cloudflare, by fixtures or anything else. Two candidate answers were
burned attacking the second: provider connectors (ADR 4) and a free-plan trial (ADR 25).

**ADR 26 answers the first question outside the product**, on a hosted demo Mailda operates —
no install, no account, no DNS. Installing still requires DNS, and §5A's prerequisites say so
up front instead of revealing it at step 4.

The second structural finding — first value at step 8 of 13 — is addressed by reordering:
the inbound test is now step 6, with the five steps before it taking about a minute each. The
second-recovery-owner stall at step 2 became a warning at step 13 rather than a blocker.

Fixture mail is still built, but its home is the demo and the test suite, never a customer's
Node — which removes the lifecycle problem this document worried about: fabricated records
living in a compliance-scoped system, and a sixth "nothing here" state on every surface.

**What is not claimed.** Nobody can validate their own mail before committing DNS. That is a
property of running a mail system, not a deficiency engineered away. What changed is that
nobody has to commit before knowing whether they want it.
