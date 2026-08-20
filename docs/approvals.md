# Approvals

How a send that a policy will not let out on its own gets decided: what an approval is, who may decide it,
what happens when two people act at once, and what is deliberately absent.

Implemented by `apps/node/worker/src/approvals.ts` and `migrations/0020_approvals.sql`, on top of the policy
object in `src/policy.ts` (`0019_policy.sql`). Decision record: [#61][61], with [#60][60] for the policy
outcomes it hangs off.

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
eligible(approval) = approval.decide holders on the manifest's mailbox
                   − the manifest's author
                   − everybody who has already decided in this approval
```

`approval.decide` is a relation on the **mailbox** (`src/access.ts`), grantable by an administrator like any
other. It is not implied by `org.admin` and not implied by `send.propose`: the first would make every
administrator an approver, and the second would make every author an approver of their own mailbox.

**Distinctness is measured on `user_id`, not on tuples.** `readableSubjects` authorizes a principal as
`[userId, ...teamIds]`, so a relation can be held through a team — which means the holder set is a set of
*tuples* while a decider is a *person*. One person in two teams that both hold `approval.decide` would satisfy
a count of 2 if the count were taken at the tuple layer. Two things stop it:

- `decidersByMailbox` resolves team-held tuples to their members, requires a row in `users` (a tuple's subject
  may be a team), and de-duplicates on the person;
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
        │                              │                            manifest held  (dispatches normally)
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

## What is audited

Three actions, all in the same transaction as the rows they describe (`auditedBatch`):

| Action | Subject | Says |
|:--|:--|:--|
| `approval.requested` | the approval | a policy required approval; the stages and how many people were eligible |
| `approval.decided` | the approval | who approved or denied, at which stage; a denial records `outcome: refused` |
| `approval.withdrawn` | the approval | who took their own approval back, and whether that left the request unsatisfiable |

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
| any decision — approve, final approve, deny | 6 |
| any withdrawal | 6 |
| seal gated by a hold | 11 |
| seal gated by an approval | 13 |

The approval path adds **two** operations to a seal, and only there: a seal that no policy gated, or that a
hold gated, pays nothing for this mechanism. The `approvals` row, its stage rows and the second audit entry are
free, because they ride in the `batch()` the seal was already making.

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
- **Expiry.** [#62][62] owns `approval_expired`, and an expiry column nothing sweeps would be a deadline that
  never passes.
- **A release act for a `policy_hold`.** [#60][60] gave it to any `send.propose` holder and nobody has built
  it. An approval-gated send now has its release; a hold-gated one still drains only by its author cancelling.

## Surface

```
GET  /api/approvals                  what is waiting on you: stages, which stage is open, whether you decided
POST /api/approvals/:id/decide       { "decision": "approve" | "deny" } — no default, deliberately
POST /api/approvals/:id/withdraw     take back your own approval while the request is incomplete
```

Scoped to the mailboxes the caller holds `approval.decide` on, and excluding their own authored sends: a queue
that lists work nobody can do is a queue people learn to ignore. There is deliberately no UI — the shell is
Layer 1–3's surface — but the outbox already shows the consequence, because it renders `awaiting` and
`withheld` with the reason beside them.

[9]: https://github.com/Straits-AI/mailda/issues/9
[60]: https://github.com/Straits-AI/mailda/issues/60
[61]: https://github.com/Straits-AI/mailda/issues/61
[62]: https://github.com/Straits-AI/mailda/issues/62
[63]: https://github.com/Straits-AI/mailda/issues/63
[73]: https://github.com/Straits-AI/mailda/issues/73
