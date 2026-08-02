# AGENTS.md — how we work on Mailda

This is the working agreement for everyone touching this repository: humans and agents,
equally bound. `Mailda-Full-Engineering-Blueprint.md` says **what** we are building.
This file says **how** we decide, measure, name and ship it.

Read both before writing code. If the two ever conflict, the blueprint wins on product
contract; this file wins on method.

---

## Vocabulary

We use these five words precisely. They are not decoration — they are the review language.

**landmine** — a decision that costs nothing now and blows up later. By the time it
detonates it is load-bearing. An unmeasured limit. A silent `catch`. A hardcoded `25 * 1024
* 1024` that was true on the day it was typed. A field named `synced` that only forwards.

**receipt** — the measurement behind a number. No receipt, no number. A receipt says what
was measured, on what, when, and what makes it stale.

**tripwire** — a limit placed past where any good widget goes, so only broken things touch
it. A good Butler, a good mailbox, a good message never feels it exists. If a good one
touches it, the tripwire is wrong — not the widget.

**simple** — how cleanly the logic breaks down. Each step follows from the last, no step
doing two jobs.

**obvious** — the next reader never asks "why is this here?". Measured by the reader, not
by the author. Not always simple; sometimes obvious has more parts.

When we argue, we argue in these terms. "This is a landmine" is a specific, answerable
claim. "I don't like it" is not.

---

## Principles

### 1. Boil the ocean

Do not be afraid to propose seemingly insane solutions. We are rethinking what
organizational mail infrastructure *is*: a mail system the customer owns outright, running
in their own Cloudflare account, that keeps working after every Mailda service is
disconnected. Nothing about that is an incremental improvement to an inbox.

Three things we refuse to trade against each other:

- **Ownership is absolute.** No mandatory account, licence server, telemetry endpoint or
  hosted control plane. If a feature only works when Mailda Control is reachable, it is not
  a feature, it is a hostage.
- **Automation authoring must feel like the web.** Butlers are the developer surface.
  Typed nodes, a real type checker, a real compiler, fixtures and simulation — round-tripped
  between a visual graph and text against **one AST**. A web developer or a coding agent
  should be productive in an hour, and the errors should be good enough that the agent can
  fix its own mistake without a human.
- **Efficiency is a feature, not a tax on the above.** Workers CPU-ms, D1 rows and bytes,
  R2 objects, DO wake-ups and queue messages are the customer's bill. We drive them down
  hard, and we do not buy a millisecond with a worse developer experience or a dishonest
  semantic.

If a proposal sacrifices any one of the three to get the other two, it is not the answer
yet. Say so and keep looking.

### 2. Every number needs a receipt

A limit without a measurement is a landmine.

Before writing any number — a max, a byte cap, a timeout, a concurrency, a threshold, a
retry count, an SLO — measure the real thing first, then size it as a tripwire. Capacity is
free until touched: reserve big, commit lazily, never eagerly zero what you can allocate on
demand. Be generous. **If a good widget hits a budget, the budget is wrong.** Remeasure and
update the receipt.

Numbers in Mailda come from exactly three places, and each has a receipt:

| Kind | Source of truth | Where it may live |
|---|---|---|
| **Platform limit** (25 MiB inbound, 50 recipients, D1 database ceiling) | The provider, detected at runtime | Adapter capability data only. Never a constant in application code. |
| **Measured tripwire** (fan-out ceiling, parser recursion depth, queue concurrency) | Our own measurement of real corpora and real runs | One named constant with a receipt ID beside it |
| **Objective** (p95 latency, RPO/RTO, freshness) | A verified observation, recomputed continuously | Computed and displayed from live evidence, never a literal in the UI |

Platform limits are **adapter data, not assumptions scattered through application code**
(Blueprint §11B). They change under us. Cloudflare's Email Sending entitlement is *detected*,
never assumed — a healthy Node may be `receive_only`, and the code must say so rather than
fail mysteriously.

Objectives that cannot be evidenced are not displayed. Admin and `mailda doctor` compute
the *achieved* protection window from the last verified backup, bookmark and restore drill.
We never print an aspirational RPO (Blueprint §24). That rule generalizes: an unverified
number is worse than a blank, because a blank prompts a question and a wrong number ends one.

#### Receipt format

Every measured tripwire, platform limit and objective gets a file in `docs/receipts/`. The
frontmatter is machine-readable, because **the constants are generated from it**:

```markdown
---
id: butler-fanout-max-effects
kind: measured-tripwire        # platform-limit | measured-tripwire | slo
measured_on: 2026-08-03
stale_when: a certified pack ships a legitimate fan-out above 200
values:
  butler.fanout.max_effects: 500
---

**Measured:** 12,400 published Butler versions across the reference and certified packs;
p99.9 fan-out was 61 effects, maximum observed 143 (bulk-invoice-reconcile v3).
**Sized:** 500 — 3.5× the worst real workflow. Only a loop bug reaches it.
**Cost if wrong:** a runaway Butler starves inbound receipt for the whole Node.
```

`values` is a map because one measurement often establishes several related numbers, and
splitting them across files scatters a single receipt.

**You cannot write the number — you can only write the receipt.** A build step emits
`packages/budgets` from `docs/receipts/*.md`; that module is generated and never
hand-edited. CI regenerates on every commit and fails on any diff. Benchmarks re-run
nightly and flag drift against the recorded value — not per commit, because timing
benchmarks in CI are flaky, a flaky check gets muted, and a muted receipt check is worse
than no check because it still reads as verified.

At review, a literal number in a diff is answered with one question: **where's the receipt?**
An acceptable answer is a receipt ID, an adapter capability field, or "it's `0`/`1` and
means none/one".

### 3. A limit developers can hit is a limit they must see

Developers will not read our code. Their agents read our errors. An agent can fix
`max_recipients=50, asked for 63`. It cannot fix a blank window, a spinner, or a message
that arrived and vanished.

Every budget failure names **the budget, the limit, and the ask** — at compile time if it
is knowable there (`mailda butler compile`, `mailda deploy --plan`, `--dry-run`), loudly at
runtime if it is not. A silent budget is worse than no budget.

The shape:

```
E_BUDGET_EXCEEDED  butler.fanout.max_effects=500, this run asked for 512
  butler   lead-response@v7   step  notify_owners   run  run_01JQ...
  receipt  docs/receipts/butler-fanout-max-effects.md
  raise    mailda policy set butler.fanout.max_effects 750 --org acme
```

Four required parts: the stable code, the named budget with its number and the ask, the
identifiers to find it, and the exact command that changes it if the answer is "raise it".

This is not only about budgets. The same standard covers every refusal:

- A policy denial exposes a `policy_decision_id` and plain-language reason.
- A capability gap names the adapter or permission required, never just greys a control.
- `outcome_unknown` says "the provider may have accepted this effect" and offers only the
  semantically safe actions. It never silently retries and it never rounds itself to
  "failed".

**Never swallow.** A `catch` that does not re-raise, record an exception, or produce a
visible operational state is a landmine with a timer on it. The most dangerous mail failure
is "accepted but absent" (Blueprint §24) — every silent catch is a way to build one.

### 4. Fight for the obvious solution

Measure twice, cut once. Understand the problem fully before building, because cleverness is
what gets written when you haven't. The biggest simplicity win is refusing to solve problems
we don't have. Good code is the most simple thing that delivers full functionality and
performance: nothing traded away, nothing bolted on.

Push back when you see a more obvious way. That includes pushing back on this file, on the
blueprint, and on whoever asked. State it once, clearly; if the decision stands, build the
decided thing properly and note the concern where the next reader will find it.

A specifically Mailda flavour of obvious: **names must not overclaim.** The word in the
code, the word in the CLI, the word in the API and the word in the UI are the same word, and
that word is true. A forwarded copy is a `copy`, never a `sync`. A provider-native action is
`observed`, never `approved`. An AI extraction `returned a result`; it did not `understand`.
A reader who trusts a name and is wrong has been handed a landmine by the person who named it.

### 5. Architectural decisions are made for the long term

Do not accept a stopgap that only works for now and is meant to be replaced later. There is
no later; there is only the next person who finds it load-bearing.

The 21 decisions in Blueprint §29 are locked. You may reopen one — that is a real, allowed
move — but reopening means amending §29 in the same change, with the argument written down.
It never means quietly building against it.

If a shortcut is genuinely the right call, it is not a shortcut: write down why the
constraint that justified it is permanent. If you can't, it's a stopgap. Don't.

### 6. Grow the system in layers

Start from the smallest version that works end to end, and add each capability on top of a
product that already works. **Never trade a working product for unfinished complexity.**

Every layer is a Node someone could actually deploy and use:

| Layer | The Node can... | Proven by |
|---|---|---|
| 0 | Be deployed to a clean Cloudflare account and pass `doctor` | one-click and CLI reach equivalent healthy Nodes |
| 1 | Receive one real internet message, store it losslessly, show it to one authorized human | a real message from outside, visible in the web UI, original `.eml` exportable |
| 2 | Reply — sender authorization, policy, send intent, provider attempt, honest per-recipient state | `accepted` / `bounced` / `outcome_unknown` distinguished, never blurred |
| 3 | Share work — mailboxes, membership, assignment, collision, cases | two people work one queue without colliding |
| 4 | Automate — Butlers compiled, simulated against fixtures, published as immutable versions | replay causes zero provider calls |
| 5 | Govern — approvals bound to exact revisions, supervised access, audit, retention | editing an approval-bound field invalidates the approval |
| 6 | Extend — provider connectors, mail core, LLM profiles, external adapters | each certified independently; none required by the layers below |

The rule that makes the ladder real: **every layer stays green.** A change that breaks layer
1 to build layer 4 is not progress, it is a regression with a roadmap attached.

---

## Working rules

**The blueprint is the contract.** Building something it doesn't describe, or differently
from how it describes it, means editing the blueprint in the same change. Divergence
discovered later is treated as a bug in both places.

**Contracts before channels.** `packages/api-contract`, `domain-model`, `authz-model` and
`event-schemas` generate or validate UI, API, CLI, SDK, Skill and MCP behaviour. A capability
that exists in one channel and not another is a parity bug, not a feature. Never hand-write
what a contract can generate.

**Authorization is server-side and live.** Never trust a token claim for ACL, legal hold,
classification or approval state. Every operation re-evaluates the live relationship.

**Determinism by default.** The CLI and Butler runtime are deterministic. AI is invoked only
at an explicit LLM node or by an external agent through the deterministic interfaces. LLM
output is data, never authority.

**Evidence is immutable; everything else is a projection.** Raw MIME, composition manifests
and audit events are permanent. Parsed forms, search indexes and AI outputs are rebuildable
derivatives — and must actually be rebuildable, tested.

**Docs move with the code.** Any architectural change, new feature, or removed feature
updates `README.md` and the relevant technical docs in the same change. A receipt that no
longer matches the code is deleted or remeasured, never left to rot.

## Before you call it done

1. Every new number has a receipt, an adapter capability field, or is `0`/`1`.
2. Every reachable limit produces an error naming budget, limit, ask, and the way to raise it.
3. No `catch` swallows — each one re-raises, records, or surfaces an operational state.
4. Names don't overclaim, and match across code, CLI, API and UI.
5. The layer below still works.
6. Blueprint, README and technical docs reflect what the code now does.
7. You can answer "why is this here?" for every line, in one sentence, without reading it again.

---

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in `Straits-AI/mailda`, driven by the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
