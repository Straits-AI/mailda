# Approvals

How an act that this Node will not perform on one person's word gets decided: what an approval is, who may
decide it, what happens when two people act at once, and what is deliberately absent.

Implemented by `apps/node/worker/src/approvals.ts` with `migrations/0020_approvals.sql`,
`0021_hold_lift.sql` and `0022_approval_expiry.sql`, on top of the policy object in `src/policy.ts`
(`0019_policy.sql`) and the eligible-set query in `src/deciders.ts`; the dispatch-time recheck an approved send
gets is `src/outbound/recheck.ts`. Decision record: [#61][61], with [#60][60] for the policy outcomes a send's
approval hangs off, [#64][64] for the legal-hold lift and [#62][62] for the recheck, the effect envelope and
expiry.

## Two subjects, one mechanism

An approval decides on a **subject**: `(subject_kind, subject_id)`, unique over the pair.

| Kind | The subject is | Completion does | Stages come from |
|:--|:--|:--|:--|
| `send_manifest` | a `send_manifests` row | releases the send to `held` | the fold over every matching `require_approval` policy version |
| `hold_lift` | a `hold_lifts` row — one request to lift one legal hold | applies the lift: `lifted_at`, `lifted_reason`, `lift_id` | `[2]`, which is [#64][64]'s decision and not a policy's |

It shipped manifest-shaped — `manifest_id TEXT NOT NULL`, `UNIQUE (manifest_id)` — and the lift was the second
caller, which found that on its first day. The two alternatives lose for the same reason in two directions: a
nullable `hold_id` beside `manifest_id` starts a column per subject kind and makes *which subject* a question
nothing validates, and a separate `hold_lift_approvals` table duplicates the fold, the eligible set and the
conditional completion — **and all three of [#61][61]'s defects were in that last one**, so a second copy is a
second place for them.

**A lift's subject is the request, not the hold**, and that is what keeps the index a full `UNIQUE` rather than
a partial one over pending rows. Asking again has to have a representation: a send re-seals and mints a new
manifest id, a refused lift mints a new `hold_lifts` row. Had the subject been the hold id, one denial would
have made that hold unliftable for ever — [#64][64]'s operational trap arriving through the schema.

Two columns carry across both kinds, checked rather than assumed:

- **`mailbox_id`** keeps its name and meaning. For a send it is the mailbox the message is from; for a lift it
  is the *held* mailbox. In both cases it answers one question: who holds `approval.decide` here.
- **`actor_user_id`** was `author_user_id`. It always meant *the person whose act this approval gates, and
  therefore the one person who may never decide it* — the author of the send, the requester of the lift. A lift
  has no author, and a name that overclaims by one word is how a reader is handed a landmine.

One caller-visible consequence: the refusal for deciding your own is `E_APPROVER_IS_ACTOR`, renamed from
`E_APPROVER_IS_AUTHOR`, and its `what` is per subject kind — *"you composed this send"* against
*"you requested this hold lift"*. A `Record` keyed on the kind means a new subject is a compile error rather
than a sentence about the wrong act.

A future subject kind with **no mailbox at all** — §18 names domain and routing changes — is a real question
and it is not answered: a nullable `mailbox_id` would make eligibility a question nothing validates. That kind
either names a mailbox or brings a second source for its eligible set.

`subject_kind` carries **no CHECK constraint**, and that is stated rather than implied: SQLite cannot add one
with `ALTER TABLE`, and no trigger can exist in this tree because the Node applies migrations by splitting on
semicolons. The constraint is `APPROVAL_SUBJECT_KINDS` in `src/approvals.ts` plus a closed-world test that
requires one writer for the table and every subject-kind literal in `src/` to be a declared one.

## The shape

A policy version whose outcome is `require_approval` carries **stages**: an ordinal and a count of distinct
decisions. That one structure expresses all three review shapes §18 asks for.

| §18 asks for | Written as | Means |
|:--|:--|:--|
| parallel | `[2]` | one stage, two distinct people, no order between them |
| sequential | `[1, 1]` | two stages, one person each, in order |
| dual control | either | whichever of the two the organization means |

**The order is on the stages, not on the people.** That is what makes an order expressible at all: a set
defined by a relation has no natural sequence, and naming people in a policy would widen authority. Each
stage's membership stays derived from relations; only the stages are ordered.

A `require_approval` version with **no stage rows** means one stage of count 1 — one decision by somebody other
than the author, which is the least the words can mean, and which is also what every version published before
migration 0020 means. Writing `[1]` explicitly normalises to the same thing, so one rule has exactly one stored
form.

## Who may decide

```
eligible(approval) = approval.decide holders on the approval's mailbox
                   − the actor: the send's author, or the lift's requester
                   − everybody who has already decided in this approval
```

`approval.decide` is a relation on the **mailbox** (`src/access.ts`), grantable by an administrator like any
other. It is not implied by `org.admin` and not implied by `send.propose`: the first would make every
administrator an approver, and the second would make every author an approver of their own mailbox.

**Distinctness is measured on `user_id`, not on tuples.** `readableSubjects` authorizes a principal as
`[userId, ...teamIds]`, so a relation can be held through a team — which means the holder set is a set of
*tuples* while a decider is a *person*. One person in two teams that both hold `approval.decide` would satisfy
a count of 2 if the count were taken at the tuple layer. Two things stop it:

- `decidersByMailbox` (`src/deciders.ts`) resolves team-held tuples to their members, requires a row in `users`
  (a tuple's subject may be a team), and de-duplicates on the person;
- `apd_one_per_person`, a UNIQUE index on `(approval_id, decider_user_id)`, which is the half that holds when
  two decisions race.

The query is the message; the index is the guarantee.

## Checked twice, and the second check is the point

| When | What it knows | What it does |
|:--|:--|:--|
| **Publication** (`publishPolicy`) | who holds `approval.decide` today; not who will write the message | refuses the publish, naming the mailbox, the stage and how many short |
| **Evaluation** (`sealManifest`) | the author too, and today's grants | seals the send `withheld` with `approval_unsatisfiable` |

Publication-only was rejected. Revoking `approval.decide` would then make a live policy unsatisfiable
**silently**, and gated sends would collect in `awaiting` with nothing having failed — the shape of a
`stale_when` that named the right condition and which nothing checked.

Publication of a policy with **no mailbox condition** is checked against every mailbox in the organization and
refused if any of them is short, because such a policy gates sends from all of them.

**What is still not covered**, stated rather than implied: a send *already* `awaiting` when the last approver
loses the relation is not re-checked. Nothing sweeps `awaiting` — it is never dispatched, so [#62][62]'s
dispatch-time recheck cannot see it — and the drain that exists is the author cancelling their own send. The
one live case that *is* closed is a withdrawal that leaves too few eligible people, because that path already
holds the eligible set. Closing the revoke case needs a pass over `awaiting` sends, which is the shape
[#63][63]'s notification cron already has.

## The state machine

```
seal, outcome = require_approval
        │
        ├── stages satisfiable ──► manifest awaiting / policy_approval_required
        │                          approval pending
        │                              │
        │                              ├── every stage satisfied ──► approval approved
        │                              │                            manifest held
        │                              │                                │
        │                              │                                └── dispatch rechecks it (#62)
        │                              │                                      ├── all six pass ► handed_over
        │                              │                                      └── any fails ──► withheld
        │                              │                                                        + the reason
        │                              │
        │                              ├── one denial ────────────► approval denied
        │                              │                            manifest withheld / approval_denied
        │                              │
        │                              └── withdrawal leaves too
        │                                  few eligible people ───► approval unsatisfiable
        │                              │                            manifest withheld / approval_unsatisfiable
        │                              │
        │                              └── the author cancels ────► approval cancelled
        │                                                           manifest cancelled
        │
        └── stages unsatisfiable ─► manifest withheld / approval_unsatisfiable
                                    no approval row at all
```

Cancelling is the drain `awaiting` has, so `cancelSend` settles the request in the same transaction as the
manifest. Two reasons, and neither is tidiness: `apr_pending` is an approver's queue, and a request whose send
no longer exists is dead work nobody can clear; and the decision path's conditional UPDATE keys on
`approvals.state`, so leaving it `pending` let an approval of a cancelled send close the request, move nothing,
and report the send as released.

`withheld` and `awaiting` keep [#62][62]'s convention: gates are `awaiting` plus a reason, refusals are
`withheld` plus a reason. The reason tokens are minted in code and the **words** live in
`src/client/delivery.client.js`, which is the one module a test can evaluate as the exact bytes a browser is
served.

An approved send goes back to `held`, with `state_reason` cleared: the gate is gone, so it is an ordinary send
waiting out whatever remains of its hold window. The record that it was gated and approved is in
`policy_outcome`, in the `approvals` row, and in the trail — not in a stale reason on a released row.

## The recheck before hand-over, and why only approved sends get it

Implemented by `apps/node/worker/src/outbound/recheck.ts`, called from `dispatchOne` beside the authority
re-read that has been there since ADR 39. Decision record: [#62][62].

§18 requires that *immediately before execution* a Node rechecks approval validity and revocation, current
actor authority, approver eligibility, policy, and every bound object hash. An **approved** send gets all of
it. An **unapproved** send gets the authority re-read and nothing else.

| Subject | Cost | Reason token when it fails |
|:--|--:|:--|
| current actor authority (both paths, ADR 39) | 0 extra | `authority_lost` |
| the approval is `approved`, nobody withdrew, somebody's approval stands | 2 | `approval_revoked` |
| the deadline has not passed | 0 — same row | `approval_expired` |
| every approver still holds `approval.decide`, and is not the author | 1 | `approver_ineligible` |
| `max(current policy) > max(bound policy)` | 1–3 | `policy_stricter` |
| both stored bodies still hash to what the manifest recorded | 4 | `evidence_changed` |
| the transport's capability | 1 on a Node that can send | recorded, not a gate |

**The two paths differ deliberately, and a future reader must not unify them.** The recheck is a measured
**8** subrequests — 9 with the shipped adapter — against a 16-subrequest dispatch, so making it universal is a
50% increase in what every send costs to buy a guarantee nobody asked for. `docs/receipts/dispatch-recheck-cost.md`
carries the figures, and the tripwire is on the *unapproved* path: a bound of 20 against a measured 16, which a
unified path would blow through. Deciding which path a send is on costs nothing — it is
`policy_outcome = 'require_approval'` on a row `dispatchOne` had already read.

**The checks run cheapest-first, so a refusal costs 6 rather than 24** and never touches R2 or the vault. The
consequence, stated because it is observable: when two things are wrong at once the *earlier* reason is
recorded. That is the first answer rather than the worst one, on purpose — reporting a hash mismatch on a send
whose approval had already lapsed would raise a corruption alarm about a message nobody was going to send.

**`evidence_changed` is the one reason that also raises.** Every other reason is the system working: authority
withdrawn, policy tightened, a deadline passed, and the person who wrote the message reads their own outbox row.
A hash mismatch means the archive differs from its own record — corruption, or tampering — so it writes an
operational log entry (`send.evidence_changed`, carrying the blob key and both hashes) and `doctor` reports it
as `send_evidence_changed`, which is `degraded`. An unreadable or missing object is the same reason with a
different detail: it is the same claim about the same object, and §24's worst failure.

**Two of the three body hashes, and that is structural.** `submitted_sha256` is written *during* dispatch,
immediately before the transport is asked, so at recheck time it does not exist. The submitted bytes are derived
from the normalized body, so verifying the input verifies what the output is built from.

`approval_revoked` is the one reason **no path in this Node produces**: `withdrawApproval` refuses a settled
request, which is exactly what makes an approved send safe to dispatch. It is checked anyway, because the point
of re-reading is not to trust what the manifest's state implies — and it is the layer that holds if that ever
stops being true. `test/outbound-recheck.test.ts` asserts the refusal as part of producing the state, so the
distinction is in the test rather than in a comment.

## The effect envelope

§18 makes every approval bind a canonical effect envelope, and the recheck is performed *against* it rather than
producing it as a by-product. It is built from the manifest row plus the approval, and recorded in the
`send.withheld` audit entry when a check refuses — **1,372 bytes** against the 2,048-byte detail cap, measured,
because an over-cap detail is replaced wholesale and would take the reason with it.

**Bound:** the manifest id as target resource, expected version *and* idempotency key — the manifest is the
revision and [ADR 9][9]'s effect key is already that id, so no second identifier was invented that would have to
be kept equal to it; From, To, Cc, Bcc and subject; both body hashes; the author as actor; the mailbox; the
policy outcome and version set as bound at the seal; the approval with its state, deadline, standing approvers
and withdrawals; the emitted header set; and the adapter's capability.

The header set is fixed and enumerable — From, To, Cc, Subject, Message-ID, Date, MIME-Version, Content-Type,
plus In-Reply-To and References on a reply, with To and Cc present only when they have recipients. `Bcc` is
absent, which is what Bcc means. It is derived from the same columns `renderRfc822` derives it from, and the
test renders real bytes and reads the names back out of them rather than trusting the list.

Two members are **recorded rather than checked**: the header set, because a manifest is immutable so what it
implies cannot have moved; and the capability, because the transport's own refusal is already the gate on it and
a seventh withholding reason is not something [#62][62] decided.

**Absent, each with its reason, carried on the envelope and recorded on every refusal:** rendered HTML (only a
typed body exists; `packages/contract`'s optional `bodyHtml` is a contract-versus-implementation gap),
attachment hashes and filenames (no attachment representation in the outbound path at all), template and prompt
versions (neither object exists), Butler version (Layer 4), delegator (no delegation mechanism), DLP results (no
DLP), and `submitted_sha256` (for the structural reason above).

## Expiry

`approvals.expires_at`, written at request time from `approval.send_expiry_seconds` — **four days**, sized rather
than measured, with the trade-off in `docs/receipts/dispatch-recheck-cost.md`: long enough that an approver
working across a weekend plus a public holiday is not defeated, short enough that an approval is not a standing
permission.

Three properties are decisions rather than accidents.

**It is a constant, not a per-policy field.** The policy object has no expiry column, and adding one would
invent a governance dimension no ticket has decided — [#60][60]'s own governing failure, a condition backed by no
interface. The named refinement if somebody asks for it: a nullable column on `policy_versions`, folded by
**minimum** over the matching versions rather than by maximum, because narrowing runs one way and the shorter
deadline is the stricter rule. The constant becomes the default.

**Nothing sweeps it.** A deadline passing is not an event; it is a fact the recheck reads. So an approver can
still decide a lapsed request and their decision lands — the send returns to `held`, and the recheck then
withholds it with `approval_expired`. One enforcement point rather than two, which is the same argument [#62][62]
makes for the reason vocabulary; a second would need its own release act and its own state. What that costs is a
decision taken on a request that will not send, so `expires_at` travels on `GET /api/approvals` and on every
`ApprovalRow`: the deadline is visible to the person being asked, before they answer.

**A `hold_lift` approval has no deadline**, and `EXPIRES_AFTER_SECONDS` is a total map over the subject kinds so
a third kind has to decide rather than inherit. Nothing rechecks a lift, so a deadline on one would be a limit no
code compares — the mirror image of a bound field nothing populates.

**NULL means no deadline is recorded**, for one of exactly two reasons: the request predates migration 0022, or
its kind has none. Neither is treated as expired. A migration inventing a deadline for a decision somebody
already took would be a false statement about the past, and the pre-0022 population is bounded by the hold
window and shrinks to nothing.

## Withdrawal and denial are asymmetric, deliberately

An approver may **withdraw** their own approval while the request is incomplete. A **denial** is terminal.

Without withdrawal, an approver who learns something has one remedy: persuading a colleague to deny. That
records *somebody else's judgement* as the reason a message was stopped, in a trail whose entire value is that
it does not do that.

A denial needs no counterpart. Re-sealing mints a new manifest and a fresh approval, which is the invalidation
mechanism Layer 5 already rests on — so "I changed my mind" is served by the author composing again.

Withdrawal is terminal for the withdrawer: they cannot decide again (`apd_one_per_person`). So the eligible set
only ever shrinks within one approval, and no amount of withdraw-and-approve oscillation lets one person fill
two slots. The withdrawn row is kept, with `withdrawn_at` set: *"I approved this and then took it back"* is a
fact an investigation asks about, and deleting the row would answer it with silence.

## The races

Both are settled the way every other conflict in this Node is settled — a conditional UPDATE, where the
conflict is the signal ([#9][9]).

**Two people casting what each read as the final approval.** Every statement in a decision shares one
predicate: *the approval is still pending*. So the loser writes nothing at all and is refused with
`E_APPROVAL_SETTLED`; exactly one decision releases the send.

**A withdrawal racing the final approval.** The completion transition is *"every stage satisfied AND nothing
withdrawn"*, evaluated inside the database at the moment of the write. `changes = 0` on it does **not** by
itself mean somebody withdrew — every non-final approval leaves it 0, legitimately. The signal is *"this
decision should have closed the last stage and did not"*, and that means a withdrawal, because a competing
finalisation is refused by the shared predicate rather than recorded. The decision is kept, the send stays
`awaiting`, and the caller is told which conflict happened.

**Two withdrawals landing together.** A withdrawal has to know what it leaves behind — whether enough eligible
people remain to finish the stages — and that shortfall is computed from decisions read a moment earlier. So its
predicate pins the **decision counts** as well as the request being open: the number standing and the number in
total, because a new approval and a withdrawal arriving together would leave the first unchanged. Any concurrent
change to `approval_decisions` therefore makes the withdrawal write nothing and answer `E_WITHDRAW_RACED`, which
the caller resolves by reading and withdrawing again. Without it, two withdrawals each reading a satisfiable
request would leave an unsatisfiable one reading as `pending` — the exact state this design closes.

The three statements that close an unsatisfiable request run after the withdrawal has moved that count, so they
carry a different gate: *this call's own withdrawal landed*, keyed on its `withdrawn_at`. Ungated they were
unconditional, and a withdrawal that lost to a completing approval rewrote the recipients of a released send to
`withheld`.

**A withdrawal racing the approval that completes a lift** is the one place the answer differs, and it differs
deliberately. That decision carries two audit entries — `approval.decided` and `hold.lifted` — and
`auditedBatchMany` gates a batch rather than an entry, so under the ordinary `pending` predicate a lost race
would insert a `hold.lifted` entry for a lift that did not happen: a false statement in the one place that is
supposed to be checkable. So that decision carries a **stronger** predicate — the approval is pending, *this*
decision closes every stage, and the hold is not already lifted — and a lost race records nothing and answers
`E_HOLD_LIFT_RACED`. A send keeps its decision because it still counts toward its stage whatever else happened;
the lift's completing decision and the lift itself are one act that must either both be true or both be absent.

The interleaving inside the product cannot be constructed from one isolate, so the refusal is exercised through
the other door into the same state — a hold lifted outside the product, which is the boundary the hold mechanism
has anyway (`wrangler d1 execute`, the dashboard). `test/legal-hold.test.ts` drives it and asserts that nothing
was recorded: no `hold.lifted`, no second `approval.decided`, no decision row, and a chain still contiguous.
Stated because a refusal nothing reaches is a refusal nobody has read.

**Two administrators asking for the same lift at once.** Every statement of a request carries *the hold exists,
is not lifted, and has no open lift other than this one*, so one request lands and the other is refused with
`E_HOLD_LIFT_PENDING`. There is no read beforehand that could disagree with it. The clause *"other than this
one"* is load-bearing rather than defensive: without it the batch invalidated its own predicate — the
`approvals` row goes in as `pending`, so the stage inserts that followed were silently skipped and the first
approver met an approval with an empty stage set.

## What is audited

Four actions, all in the same transaction as the rows they describe (`auditedBatch`, `auditedBatchMany`):

| Action | Subject | Says |
|:--|:--|:--|
| `approval.requested` | the approval | why it was asked — a policy, or an administrator's stated reason for a lift — with the stages and how many people were eligible |
| `approval.decided` | the approval | who approved or denied, at which stage; a denial records `outcome: refused` |
| `approval.withdrawn` | the approval | who took their own approval back, and whether that left the request unsatisfiable |
| `hold.lifted` | the **hold** | the lift took effect: the reason it was asked for, who asked, and **both** approvers by name |

The first three cover every subject kind, which is the return on generalising the table: a lift is requested,
decided and withdrawn by the same three acts. Only its *effect* earned a fourth, and its subject is the hold
rather than the approval, so `hold.placed` and `hold.lifted` line up for a reader filtering one hold. There is
deliberately no `hold.lift_requested`: `approval.requested` already records that act, in the same transaction as
the request row, and a second entry would make *"who asked to lift this hold"* answerable from two places that
can disagree.

`hold.lifted` names both approvers because dual control is only evidence if the trail says who the two were —
the eligible set is live and cannot be reconstructed from the tuples as they stand later.

`approval.requested` rides in the **same transaction as the seal**, alongside `send.sealed`, through
`auditedBatchMany` — two entries chained to each other, consecutive sequence numbers, one `batch()`. So a gated
send that exists without a request to decide is not unlikely, it is unrepresentable. Its subject is the
approval rather than the manifest, because it records that *people are being asked*, which is not something
`send.sealed` can say without becoming an entry about two things.

## Cost

Measured, not counted: `docs/receipts/approval-decision-cost.md`.

| Operation | Subrequests |
|:--|--:|
| eligibility check on one mailbox | 1 |
| any decision on a send — approve, final approve, deny | 6 |
| any withdrawal | 6 |
| seal gated by a hold | 11 |
| seal gated by an approval | 13 |
| requesting a legal-hold lift | 5 |
| approving a lift, stage still open | 6 |
| the approval that **applies** a lift | 7 |

And the dispatch, measured in `docs/receipts/dispatch-recheck-cost.md`:

| Operation | Subrequests |
|:--|--:|
| dispatching an **unapproved** send, hand-over included | 16 |
| dispatching an **approved** send, every check passing | 24, or 25 with the shipped adapter |
| an approved send refused at the first check | 6 |

The approval path adds **two** operations to a seal, and only there: a seal that no policy gated, or that a
hold gated, pays nothing for this mechanism. The `approvals` row, its stage rows and the second audit entry are
free, because they ride in the `batch()` the seal was already making. `expires_at` is free on every read of an
approval, for the same reason: a column added to a `SELECT` already being issued costs nothing, which is what
that receipt's *"the approvals tables gain a column a decision has to read"* clause exists to have checked.

The recheck's 8 is spent in the **dispatch** invocation, not in a Butler step — [#62][62] predicted it would
land on `mail.send.propose` and it does not, because dispatch runs from the sweeper's alarm with its own
subrequest budget. Both halves of that prediction were wrong and the receipt says so at length; the decision it
was drawn for stands on the measurement instead.

A lift costs one operation more than a send's decision, and exactly one: the request row, whose reason the
`hold.lifted` entry has to name. Everything else — the second audit entry and the `UPDATE holds` itself — is
free for the same reason, because it rides in the batch the decision was already making. That is what makes
*"the lift and its record are one act"* a property of the transaction rather than a claim.

## Named absent

- **A team constraint on a stage** (`{count: 1, team: finance}`). [#61][61] wanted it and it is not shipped:
  `team_members` is **read-only in the product** — three SELECTs in `src/authz-read.ts`, nothing writes it —
  and there is **no `teams` table at all**, so a team has no name and no existence of its own. A team-scoped
  stage would be expressible and unusable, and publication could not verify that a named team exists, only
  that it currently has members, which is a different question. Team management is [#73][73]. What this costs:
  the team *labels* on a sequential chain, not the chain — ordered stages of count 1 still give sequential
  review by two distinct people in a fixed order.
- **Notification.** Every act here is something a person is waiting on, and there is no notification mechanism
  in this product. [#63][63] owns the harder version — §7 requires a notice the investigator cannot switch off
  — and has already chosen the shape: the obligation is a row, an existing cron delivers it.
- **The approval evidence snapshot** (§18, §21): the minimum-necessary snapshot of the proposed effect and the
  excerpts an approver may see. `approval.decide` is not a read relation, so an approver holding nothing else
  on the mailbox can decide without being able to open the bytes. That is §21's rule about approval not
  granting ambient access — and it also means this build does not yet give an approver what §18 says they must
  see. Named here rather than closed by granting a read as a shortcut, which §21 explicitly forbids.
- **A sweep for lapsed approvals.** Expiry is built — see the section above — and it is enforced at the
  dispatch rather than by a pass over `pending` requests. So a lapsed request stays in an approver's queue with
  its deadline shown, and deciding it is honest work whose send is then withheld. What is absent is the cron
  that would resolve it without anybody looking, which is the same shape [#63][63]'s notification obligation
  wants and belongs with it.
- **Per-policy expiry.** A constant with a receipt rather than a policy condition, for the reason the section
  above gives, with the fold named for whoever asks.
- **A release act for a `policy_hold`.** [#60][60] gave it to any `send.propose` holder and nobody has built
  it. An approval-gated send now has its release; a hold-gated one still drains only by its author cancelling.

## Surface

```
GET  /api/approvals                  what is waiting on you: subject, stages, which stage is open, the reason,
                                     and the deadline — because nothing sweeps it, so it has to be visible
POST /api/approvals/:id/decide       { "decision": "approve" | "deny" } — no default, deliberately
POST /api/approvals/:id/withdraw     take back your own approval while the request is incomplete

POST /api/holds/:id/lift             { "reason": "..." } — org.admin asks; these three endpoints decide
```

Scoped to the mailboxes the caller holds `approval.decide` on, and excluding approvals of their own acts: a
queue that lists work nobody can do is a queue people learn to ignore. There is deliberately no UI — the shell
is Layer 1–3's surface — but the outbox already shows a send's consequence, because it renders `awaiting` and
`withheld` with the reason beside them, and `doctor` reports a pending lift beside the hold it would release.

**A lift is decided through the approvals endpoints, not through a second hold endpoint.** That is the whole
point of the subject: an approver's queue, a decision, a withdrawal and the trail behind them were never about
sends. `GET /api/approvals` carries the lift's `reason`, because somebody asked to re-permit destruction has to
see what they are agreeing to *before* they decide — a trail is where a decision is accounted for afterwards.

[9]: https://github.com/Straits-AI/mailda/issues/9
[60]: https://github.com/Straits-AI/mailda/issues/60
[61]: https://github.com/Straits-AI/mailda/issues/61
[62]: https://github.com/Straits-AI/mailda/issues/62
[63]: https://github.com/Straits-AI/mailda/issues/63
[64]: https://github.com/Straits-AI/mailda/issues/64
[73]: https://github.com/Straits-AI/mailda/issues/73
