# Supervised access — matters, the time-boxed grant, and the door that stays open

What §7 asks for, what this Node builds, and the part of §7 that is **not built yet and is named rather
than implied**. Issue #63, Layer 5. Read `docs/approvals.md` first: a supervised read is an approval
subject, and everything about stages, eligibility and the races lives there.

---

## The sentence this work started from, and why it was only technically true

§7 says *"mailbox administration alone does not imply content access"*. On this Node that was true about the
**relation** and false about the **administrator**.

`org.admin` can grant any grantable relation to any subject, and nothing excluded itself as a subject. So an
administrator could give themselves `mailbox.content.read` on any mailbox in **one audited call** and read
anybody's mail. The relation genuinely did not imply the access; the authority to create the relation did.

Closing that was the tempting move and it sets a trap. In a two-person organization the only other approver
is the person being examined, so the ceremony is either theatre or the read is impossible — and "impossible"
for an administrator who is genuinely responsible for a mailbox is the kind of wall that gets solved by
editing the database directly, which is strictly worse than an audited self-grant because it leaves no
record at all.

So there are two doors, and the work was making them **look different**:

| | `supervised.read` | the self-grant |
|---|---|---|
| Ceremony | matter, scope, expiry, two approvers who are not the reader | one call by one administrator |
| Ends | at a stored instant, by construction | never, until somebody revokes |
| Record | `approval.requested`, `approval.decided` ×2, `supervised.granted` with the scope and the deadline | `access.granted` |
| In `doctor` | nothing — it is the normal path | `self_granted_access`, a `report` finding |

**This does not prevent an administrator from reading mail.** It makes the front door and the back door
distinguishable in the record. That sentence is in the migration, in `src/supervised.ts`, in the `doctor`
finding's own text and in a test, because the alternative phrasing would be a claim nothing enforces.

---

## Purpose is an object, and that was forced rather than preferred

§7 requires notifying the employee **after the matter closes**. Free text cannot close. That single
requirement decides the shape — this was not a choice between two designs, one of them simply cannot satisfy
the contract.

```
matters            id, org_id, type, description, opened_by, opened_at, closed_at, closed_by
supervised_grants  id, org_id, subject_id, mailbox_id, scope, matter_id, requested_at, expires_at, granted_at
```

It pays for itself twice more. Several grants can belong to one investigation, and §7's *"widening scope
requires a new approval"* becomes **a second grant citing the same matter** rather than an edit to a live
one — which matters, because an editable grant is an audit trail that can be rewritten in place. There is
deliberately no `UPDATE` of `scope` or `expires_at` anywhere in the product, and a test asserts the one
`UPDATE supervised_grants` that exists does not touch the deadline.

**Four matter types**, declared in `MATTER_TYPES`: `legal_hold` (#64's, cited by `holds.matter_id`),
`security_incident`, `departure_handover`, `regulatory_request`. The column has no `CHECK` — SQLite cannot
add one with `ALTER TABLE`, a trigger cannot exist in this tree because `src/migrate.ts` splits migrations on
semicolons, and recreating the table needs a `DROP TABLE` that `content-deletion-world.test.ts` refuses in
`migrations/` — so the union is the constraint and `test/node/matter-and-scope-world.test.ts` is what makes
it one: exactly one writer, and that writer narrows before it inserts. It deliberately does **not** scan for
undeclared literals, because nothing in `src/` names a matter type outside the declaration, so that scan
would pass over an empty set. Exactly how `APPROVAL_SUBJECT_KINDS` is held, minus the assertion that would
mean nothing here.

**A grant cites a matter or nothing.** The realistic first act is somebody needing to look at a mailbox
*now*, before anybody has decided what the matter is; `holds.matter_id` made the same call in 0018.
Requiring one would produce matters named "unknown" within a week, which is free text again with a table
around it. What a cited matter must be is this organization's and **still open**: opening fresh access under
a closed matter would make the notice §7 hangs on that close untrue about the access it describes.

**Any member may open a matter.** Gating it on `org.admin` would mean the only people who can state a
purpose are the people who already have the back door. A matter confers nothing; the check that matters is
on the grant. **Closing** takes the opener or an `org.admin`, because the investigator is the one party with
a reason to leave a matter open for ever.

**Closing does not revoke a live grant**, and that is not a gap. A grant's authority ends at its own
`expires_at` and nowhere else; cascading revocation would be a second place for *"may this person still
read"* to be answered. What a closed matter changes is that no new grant may cite it.

---

## Scope is what the grant carries

Two scopes, `metadata` and `content`, and they are not invented for this table: they are the two read
relations the product already has, so a scope maps onto a path that exists rather than one that would have
to be built. Content strictly implies metadata, which is the same asymmetry `mayReadMetadata` already
encodes for relations.

There is deliberately **no date window**, unlike a hold's `from_date`/`to_date`. A hold is tested against
the instant of the thing being destroyed, which the destroying call site always has. An authorization check
has a mailbox and no instant — `mayReadMetadata` answers a question about a queue, not about a message — so
a windowed grant would either leak out-of-window subject lines or grant nothing on that path. #65's
eDiscovery export is the ticket that needs the finer grain, and it needs a different check to hang it on.

### Which read paths participate, and why each answer is deliberate

`src/authz-read.ts` carries the table; this is the summary. A relation that grants nothing is the failure
this repository keeps hitting; a relation that grants too much is worse, because nothing reports it.

| Path | Accepts a grant? | Reasoning |
|---|---|---|
| `mayRead` (content) | yes, scope `content` | Reading the bytes is what a supervised read is for. Reaches `authorize()` — the raw `.eml` — and the submitted-bytes endpoint. |
| `mayReadMetadata` | yes, either scope | Content is the stronger authority on both structures. Its only call site is gated on `send.propose` first, so a grant does not put a mailbox in anybody's **queue**. |
| `listMessages` | yes, either scope | §7 lists *query* first among the supervised acts. A grant that could not list would only let somebody open a message whose receipt id they already knew. |
| `holdsStandingRead` | **no** | The gate in front of `mergeConversations`. Merging is irreversible restructuring of other people's queues; a read grant authorizing a write is the widening this must not be. |
| `maySend` | **no** | §7's supervised access is a read. A grant conferring it would let an investigator send from the mailbox they are investigating. |
| `mailboxesWithRelation` | **no** | Only ever asked for `send.propose`, to bound a dispatch sweep. An arm here would answer a question nobody asks. |

`holdsStandingRead` exists **only** so `supervised.read` cannot merge conversations. It is a separate named
function rather than a boolean argument, so the difference is visible at the call site.

---

## The grant flow

```
POST /api/supervised          {mailboxId, scope, durationSeconds, matterId?}   -> a request, granting nothing
POST /api/approvals/:id/decide {decision}                                      -> ×2, by two other people
GET  /api/supervised                                                           -> org.admin: who has been let in
POST /api/matters             {type, description}
GET  /api/matters                                                              -> org.admin: all; anybody: their own
POST /api/matters/:id/close
```

**`GET /api/matters` is filtered, and that is the disclosure boundary rather than a convenience.** A
description names the person being examined, and §7 makes the notice to that person due **after the matter
closes** — an org-wide listing would deliver it on the day the matter opened, to the one person it must not
reach first. So an `org.admin` sees every matter and anybody else sees the ones they opened. The need that
justified an open listing was the approvers', and it is served where it belongs: `GET /api/approvals`
carries the cited matter's **type and description** to the two people being asked, on the same `LEFT JOIN`
that fetches the grant. An approver reads the matter they are deciding on, not every matter in the building.

**The requester is the reader, and there is no field for the subject.** A request on somebody else's behalf
would put the reader outside #61's actor exclusion, leaving them free to approve their own access —
self-approval reached through a second name, which is what §18 is about. The two are the same principal by
construction.

**The grant is the third approval subject, not a second approval mechanism.** `APPROVAL_SUBJECT_KINDS`
gained `supervised_read`, and adding it was a compile error in three places until handled — `ACTOR_DID`,
`EXPIRES_AFTER_SECONDS` and `COMPLETING_EFFECT` are all `Record`s keyed on the union. Everything else is
#61's: the same eligible-set computation, the same actor exclusion, the same conditional UPDATE. All three
of #61's defects were in that race logic, so a second copy would be a second place for them.

**Generalising `decideApproval` cost one refactor, and it is the shape worth knowing.** The hold lift had a
hand-written "strong predicate" branch: a completing decision on a lift additionally required that the hold
was not already lifted, and a lost race recorded **nothing** rather than a `hold.lifted` entry for a lift
that did not happen. A supervised read needs exactly that, with `granted_at IS NULL` in place of
`lifted_at IS NULL`. So the branch became `COMPLETING_EFFECT`, a per-kind record of *what must still be
undone*, *the entry that rides with the effect*, and *the two refusals* — data, while the race logic stayed
written once.

**The approval carries no deadline of its own** (`EXPIRES_AFTER_SECONDS.supervised_read` is `null`). The
grant's `expires_at` is the single terminal check. The residual that follows: an approval decided *after*
that instant produces a grant that is already over, and there is no second enforcement point, because 0022
made the same call for `approvals.expires_at` — a lapsed request an approver can still decide has one
terminal check rather than two. What stops it being a surprise is that the deadline travels on
`GET /api/approvals` with the request.

**A denial forecloses nothing.** The approval's subject is a **request row**, not a person-and-mailbox pair,
so a denied grant stays as the record that somebody asked and was told no, and asking again mints a new row.
Keying on the pair would make one denial permanent, which is #64's operational trap arriving through the
schema. What *is* refused is a **second pending** request for the same person and mailbox: two would ask two
pairs of approvers about the same access, and whichever finished first would grant it while the other still
read as waiting for somebody.

### Expiry needed no mechanism, and that was checked rather than assumed

Nothing caches authorization. `src/authz-read.ts` re-reads on every call, so the request after the deadline
checks and finds the grant over. §7's list of things an expiry must terminate — search cursors, event
streams, attachment URLs, cached previews — was enumerated against this Node and came back **empty**:
nothing presigns, nothing streams, and the raw-evidence read is authorized per request inside `authorize()`.

So `test/supervised-read.test.ts` proves the **stop** rather than asserting the absence of a cache: a grant
of 60 seconds authorizes a raw read at +30 s and is refused at +60.001 s, with nothing having run in
between. Deleting `expires_at > ?` from the predicate leaves every other test in the file green and fails
only that one, which is the shape of the defect it exists for.

**Renewal is a new grant needing fresh approval.** §7 makes time part of the bound scope, so extending it is
widening. The matter is reused; the authorization is not.

### There is no maximum duration, and that is a decision

A request states its own duration and nothing caps it, so an approved ten-year grant is expressible. A cap
would be a number, AGENTS.md admits three kinds of number, and this is none of them: not a platform limit,
not measurable against any corpus, not an objective computed from evidence. Inventing one would put a figure
with no receipt in front of a governance decision nobody made.

What stands in for a cap is that the deadline is part of what the two approvers are shown before they
decide — `pendingApprovals` carries the mailbox, the scope, the matter's own type and description, and the
exact `expiresAt`, and a test pins that object. An implausible duration is refused by people rather than by a constant. If an organization
wants a ceiling, that is a policy object (#60) with a condition on this subject kind, and it arrives with
the ticket that asks for it.

---

## Cost: the receipt's `stale_when` fired, and the answer was measured

`docs/receipts/authz-check-rows-read.md` bounds the authorization path, and its `stale_when` names *"ABAC/
policy conditions begin reading additional rows on the request path"*. A grant lookup is exactly that, so it
was re-measured before anything shipped. The correction is dated in that file; the summary:

- **Two queries either way.** The grant lookup is a `UNION ALL` arm of the statement the check was already
  issuing, not a second round trip. `authz.check.max_queries = 2` holds, measured through `mayRead` itself
  with `metering()` rather than through a copy of its query — which is the only way that tripwire can
  actually be tripped.
- **One extra row, at most.** `sgr_live` is **partial** on `granted_at IS NOT NULL`, so on a Node where
  nobody holds supervised access the arm seeks an empty index. A check that *hits* the tuple arm is
  unchanged, because `LIMIT 1` stops there; a check that *misses* pays one row, because the compound has to
  exhaust the tuple arm first. Measured: 11→11 on a hit, 10→11 on a miss, 50→51 for a heavy user. The
  budget is 200.
- **The self-grant finding needs no index, and finding that out deleted one.** This migration first carried
  a partial index keyed on `actor_user_id = subject`; SQLite never chose it, and forced it was worse, because
  its test for whether a query implies a partial predicate does not credit a column-to-column comparison. The
  existing `audit_by_action` wins and is the right answer — the seek lands on this organization's
  `access.granted` entries, so the finding costs what *grants made* costs, not what the trail's whole history
  costs. Both plans are printed in `test/explain.test.ts`, which is the only reason it was found.
- **`sgr_live`'s column order was wrong once**, and the same file found it: `expires_at` is a range and
  `scope` an equality, so putting the range first truncated the usable prefix at four of five columns. #11's
  lesson, one table over. With `scope` ahead of the range and `granted_at` in the key — SQLite's
  covering-index test does not credit a partial predicate as supplying the column it constrains — the plan
  reads `USING COVERING INDEX sgr_live (org_id=? AND subject_id=? AND mailbox_id=? AND scope=? AND
  expires_at>?)`.
- The grant lookup does not become a tuple. `relationship_tuples` has no expiry column, and giving it one
  would put a time comparison into **every** authorization check in the product for the benefit of one
  relation. A separate table also happens to be the more honest shape: *"who can read this mailbox"* has two
  answers with different structures, and collapsing them would make the answer uniform and wrong.

---

## What is not built, named rather than implied

This is part A of #63. Two things §7 requires are **deliberately absent**, and both are owed to more than
one ticket.

**Per-act recording.** §7 requires a record of every query, result opened, preview and attachment read. #63
settled the design — three actions (`supervised.query`, `supervised.opened`, `supervised.attachment`), per
**act** rather than per row, with a query entry carrying the ids it returned — and a later correction to
that ticket worked out the real bound: **59 ids**, not "a page", because Mailda ids are typed-prefix ULIDs
of 31 characters and `boundedDetail` would silently truncate an oversized list into a *prefix* of what was
exposed. None of the three actions is declared in `AUDIT_ACTIONS`, because a declared action nothing emits
is a category of one and `audit-coverage.test.ts` fails on it. They arrive with the code that emits them.

So today this Node records **who was granted access to what, by whom, under which matter, until when** — and
not what they then read. `listMessages`'s own docblock says so, at the function it is about.

**The notification.** §7 requires the person whose mail was read to be told after the matter closes, and
that it be a durable job the investigator cannot disable. #63 settled the mechanism: the obligation is a
**row** written in the same transaction as the grant, delivered by the `*/1 * * * *` cron that
`wrangler.jsonc` already declares, with `doctor` counting the overdue ones — chosen over a Workflow instance
because `workflow-provisioning.md` records that an instance is not a durable record, and over a DO alarm
because that mechanism's failure state is *stop re-arming and nothing external notices*. **No row, no cron
branch, no count.** #61 deferred its own notification to #63 explicitly, so part B owes that answer to two
tickets.

`closeMatter` closes the matter and records `matter.closed`; nothing is notified. That seam is named in
`src/matters.ts`'s header, in `src/supervised.ts`'s, and here — because leaving it implicit is how a
half-closed world gets described as closed, and a reader who found a `closed_at` column and an audit action
could reasonably assume the notice went out.

**Also absent, and smaller:** no UI (the shell is Layer 1–3's surface), no step-up authentication and no
`maximum_session` from §7's config block (both are authentication-strength questions this ticket does not
settle), and no `read_reason_required` beyond the matter's own description.

---

## Where things are

```
migrations/0023_supervised_read.sql   matters, supervised_grants, sgr_live
src/matters.ts                        MATTER_TYPES, open, close, list
src/supervised.ts                     SUPERVISED_SCOPES, LIVE_SUPERVISED_GRANT, the request, the report
src/access.ts                         supervised.read in GRANTABLE; Grantable derived so it is not admin-grantable
src/authz-read.ts                     which read paths accept a grant, and holdsStandingRead
src/approvals.ts                      supervised_read as a subject kind; COMPLETING_EFFECT; the granting UPDATE
src/doctor.ts                         self_granted_access
test/supervised-read.test.ts          the behaviour, including the expiry stop and the two doors
test/node/matter-and-scope-world.test.ts   the enums, the writers, the one grantor, the one live predicate
test/authz.measure.test.ts            what the arm costs, both instruments
```
