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
| A paid Workers plan, for anything beyond toy volume | Real money, unquantified |
| Cloudflare Email Sending entitlement | **May not be obtainable** (§11B: beta) |

None of these is stated as a prerequisite. They surface as failures partway through the
checklist — the entitlement one at **step 7 of 13**, after the DNS work is already done.

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
| 3 | Mode | Cloudflare Native / Provider Connected / Full Mail Adapter, "with capability comparison." This is an **architecture decision asked of someone who has not used the product yet**. |
| 4 | Domain | Prove control. Fine if they have one. |
| 5 | **DNS / MX** | **The cliff.** See below. |
| 6 | First mailboxes | Fine. |
| 7 | **Outbound test** | May legitimately end in *"you cannot send"* (§11B). Discovered here, after the DNS work. |
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

**3. Move the mode choice later.** Step 3 asks for Cloudflare Native vs Provider Connected
vs Full Mail Adapter before the user has used anything. Cloudflare Native is the canonical
scaffold (§2) and should simply be the default, with the others offered once they know
what they need.

**4. Front-load the entitlement check.** The outbound entitlement state (§11B) is knowable
at install time from the account, not at step 7. A Node that will be receive-only should
say so before the user touches DNS.

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
