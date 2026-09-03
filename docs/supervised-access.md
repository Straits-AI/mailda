# Supervised access — matters, the time-boxed grant, the record, and the notice

What §7 asks for and what this Node builds. Issue #63, Layer 5, both parts. Read `docs/approvals.md`
first: a supervised read is an approval subject, and everything about stages, eligibility and the races
lives there.

Part A built the **authority**: a matter that can close, a time-boxed dual-approved grant that cites one,
and an expiry that is a hard stop. Part B builds the two things it named absent — **what the reader then
read**, and **the person whose mail it was being told** — and resolves the collision between them.

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
read"* to be answered. What a closed matter changes is that no new grant may cite it — and that it
**dates** the notices it was holding. See *The collision, and which way it was resolved* below.

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
POST /api/matters/:id/close                                                    -> dates the notices it held
GET  /api/notifications                                        -> your own notices, delivered by the cron
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

## Recording is per act, and it is structural

§7 requires a record of every supervised **query**, **result opened**, **preview** and **attachment
read**. Three actions carry it, and every one is keyed on the **grant**, like `supervised.granted`, so
everything done under one access is one filter:

| action | emitted by | says |
|---|---|---|
| `supervised.query` | `listMessages`, `queueFor` | a listing, **with the ids it returned** |
| `supervised.query_empty` | `listMessages` | a **search** that matched nothing, with a keyed digest of the term and never the term (#158) |
| `supervised.opened` | `GET /api/messages/:id/body` | one result's content |
| `supervised.attachment` | `GET /api/messages/:id/raw`, `GET /api/sends/:id/submitted` | raw evidence — the `.eml`, which carries every attachment |

**Per act, not per row.** A search matching 5,000 messages is **one** entry, which is what keeps
`audit-and-log-retention.md`'s "a handful per message" sizing true of a real investigation: tens of
entries in a session, not thousands. An act spanning two live grants is recorded against each, because
the trail is filtered by grant and one entry naming two would answer that filter from neither.

### Making it impossible to read without recording

A supervised read that is not recorded is the defect this whole ticket exists to prevent, so the record is
not a call anybody has to remember. **It is a parameter they cannot omit.**

`mayRead` takes a `SupervisedAct`, and when a *grant* is what authorized, it appends the entry **inside
itself, before it returns `true`**. A read path added next year gets the authority and the record together
or gets neither, and the compiler is what says so. `hasAnyRelation` returns the grant id rather than a
boolean so the two authorities can be told apart: `UNION ALL … LIMIT 1` stops at the tuple arm, so somebody
holding the ordinary relation never reaches the grant arm and never produces an entry — correct, and free.

**A listing cannot use that shape**, and the reason is real rather than a shortcut: its authorization
precedes its result, so an entry written at the check would be written blind and could not name the ids §7
asks for. `listMessages` and `queueFor` record after their rows come back, and what keeps *that* structural
is that a grant id reaches them from exactly one place — `liveGrantsBySubject` and `mayReadMetadata` —
so `test/node/matter-and-scope-world.test.ts` requires every caller of either to emit `supervised.query`
before it returns. A second listing path that forgot would fail at the moment it was written.

**Both fail closed.** `recordDisclosure` throws where `audit` swallows, and the difference is the whole
contract: `audit` records something that already happened and must not fail its own request, while a
disclosure has *not* happened yet and must not happen unrecorded. A Node that cannot append answers
`E_SUPERVISED_UNRECORDABLE` (503) and hands over nothing. That is a third audit classification alongside
`standalone`, and `audit-coverage.test.ts` pins both sets exactly.

**Part A said the supervised arm of `mayReadMetadata` was unreachable. That was one relation too strong**
and is corrected: `send.propose` and `mailbox.content.read` are separate, so a drafter who may propose
sends from a mailbox they may not read is expressible, and for that person a grant is exactly what puts
subject lines on the screen. The arm is live, it owes a record, and `queueFor` writes one.

### A search that matched nothing is recorded, and the term is not (#158)

`supervised.query` is written only when the page returned rows, and that is right for a **listing** — paging
past the end of a scope discloses nothing, so recording it would put an act in the trail that showed nobody
anything.

**A search inverts the argument, and the body index is why.** ADR 28's amendment states what a contentless
index gives somebody with the data: the ability to *confirm a guess* — to learn that a given word occurs in a
given message. A **null** answer is half of that capability. So a supervised reader could search a
colleague's mailbox for a word, learn it is not there, and leave no record; repeated, that is
dictionary-style probing with §7's record blind to it, which is the shape `SECURITY.md` lists as reportable.

`supervised.query_empty` closes it. The condition is narrow, and each clause excludes a case that genuinely
discloses nothing: the page returned no supervised rows (otherwise `supervised.query` has it), a search term
was given (an unsearched empty page is the original argument, still sound), and the reader holds at least one
live grant (somebody searching only their own mail has probed nobody).

**What it costs, and the first version of this sentence was wrong.** It said an ordinary reader's search costs
nothing extra. It does: the grant read runs before anybody knows whether there are grants to find, and asking
a cheaper question first is not possible because *"does this reader hold a live grant"* **is** the query.

Measured in `supervised-recording.test.ts` rather than argued, every pair returning zero rows so no other
recording is in the way:

| page | subrequests |
|:--|--:|
| empty **listing**, reader with no grant | 2 |
| empty **listing**, reader holding a grant | **2** — the hot path, unchanged |
| empty **search**, reader with no grant | 3 |
| empty **search**, reader holding a grant | 6 |

So one indexed read on a searched empty page for **every** reader, and three more for a supervised one: the
vault round trip for the key, the batch carrying the entry, and the audit chain's tip read that every audited
act pays. The unsearched listing — the hot path this trade was refused to protect — costs the same whether or
not the reader holds a grant, which is asserted rather than inspected.

**One entry per live grant**, because the page is one query spanning everything the reader may see. An empty
answer means the term occurs in none of it, which is a fact about each of those mailboxes individually — a
reader with grants on two colleagues' mail who searches once has probed both, and one entry would understate
it by a mailbox.

#### The hard half was the entry's shape, not whether to write it

An entry that does not name the term answers nothing; a term in the audit trail is the investigator's own
search words, retained for whoever reads it. Three options, none free — the plain term, a digest, or a count
alone — and the decision was the **digest**: an auditor learns that a mailbox was probed, how often, and how
many probes were the same word, and never what the word was.

**The digest is keyed, and that is the whole of it.** `sha256("redundancy package")` is reversible with a
wordlist in seconds — the search space is English, not 2^256 — so an unkeyed digest would deliver the plain
term to exactly the reader it was chosen to withhold it from, while looking cryptographic. So the digest is
an HMAC under a key derived by HKDF from this Node's **content** key, which never enters D1.

Content rather than credential, and that is the security argument rather than a preference. An attacker
holding the content key can already read every message, so reversing a probe digest tells them strictly less
than they have; the credential key forges sessions and reads no mail, so adding "and reverses every recorded
search term" to its compromise would be a genuine widening — the opposite of what #7's key split is for.

The key is read with `ensureKey` and **not** `sealingKey`, which would mark the generation used. #138 measured
what that costs: on a fresh Node the escrow's generation 1 becomes unusable, a redemption that answers 200 and
installs nothing. `doctor` triggered that once per install; this path would trigger it on an ordinary
supervised search.

`keyGeneration` rides in the entry beside the digest, because the derived key follows the content key — so a
rotation makes old and new digests incomparable and repeat-counting restarts. An auditor who could not see
that would read the reset as the probing having stopped.

#### `disclosure: true`, for a disclosure that consists of nothing being returned

`recordDisclosure` throws where `audit` swallows, so a Node that cannot append this entry **does not answer
the search**: the reader never learns "no match" off the record. That is the contract read exactly as written
for the one case where the disclosure is an absence. Classifying it `standalone` instead would have been the
easy reading and the wrong one — a probe recorded on a best-effort basis goes unrecorded precisely when the
trail is under pressure.

### The id list is bounded, and it is never truncated

A query entry carries **which ids it returned**, not just how many — a result list renders subject and
sender, so *"a query matched 40 things"* understates what a person saw by forty subjects.

#63's correction worked out the bound: a Mailda id is a typed-prefix ULID of **31 characters**, 34 as a
JSON array element, so about **59** fit inside `audit.max_detail_bytes`. Measured on the shape that
shipped it is **57** — the sibling set differs — and that number is *printed rather than asserted*,
because the design deliberately does not rest on it:

- `buildSupervisedQuery` asks `detailFits`, which is `boundedDetail`'s **own** measurement exported for
  that one caller, so the bound cannot be restated and drift;
- an oversized list is **split** into continuation entries carrying `part`/`of`, in one transaction, so a
  half-recorded query is not representable;
- it is never handed to `boundedDetail`, which would replace it with `{truncated, bytes, head}` — a
  **prefix** of the ids, a record that understates the exposure, which is the exact failure per-act
  recording was chosen to avoid.

What *is* asserted is that the listing's real page fits in one entry, with 57 the measured margin above it. A
sibling field added tomorrow lowers the fill and breaks nothing.

**That page is `messages.page_size` now, not a `LIMIT 50` (#91).** The listing pages, so the sentence above
has an extra consequence worth stating: **each page is one act and gets its own entry.** A reader who pages
three times has seen three sets of subject lines at three instants under whatever grants were live at each,
so three `supervised.query` entries, each naming the ids *that page* returned — and paging back over the same
ground records again, because the mail was shown again. One entry per traversal was the alternative and it
cannot be honest: it would have to accumulate across requests and name an instant at which some of those ids
may no longer have been disclosable.

Two smaller decisions inside that. The listing reads **one row past the page** to know whether a next page
exists, and that row is never recorded — an id in the trail nobody saw is a wrong record in the direction that
overstates. And the entry carries **no page number**, because two pages of one traversal already have disjoint
id lists, and a `page` field would spend bytes from the cap the id list is competing for on something the ids
say. The fill of 57 is also what the page size is sized under: `docs/receipts/message-page-size.md` takes the
tighter of the list budget and this number, so one act stays one row.

---

## The notice, and the collision it had to resolve first

### The collision, and which way it was resolved

§7 makes the notice due **after the matter closes**. Part A decided — correctly — that closing a matter
does **not** revoke a live grant, because a cascade would be a second answer to *"may this person still
read"* and the design has exactly one. Those two collide: **the close can precede the reading it
describes**, so a notice could tell somebody their mail *was* read while it still was.

Two shapes were available.

**Refuse the close while a grant citing the matter is live.** Rejected, and the argument is not about
tidiness. Closing is the act the notice hangs on, and `closeMatter` deliberately lets an `org.admin` close
somebody else's matter *because the investigator is the one party with a reason to delay it*. A block that
any live grant could hold open hands that delay straight back — to the person who asked for the grant, and
who chooses its duration, which nothing caps. There is no revocation path by design, so the block could
not even be cleared: the only remedy would be waiting out a deadline nobody may move. It would also push
people toward never closing matters at all, and **a notice that never becomes due is worse than a late
one.**

**Hold the notice.** Taken. `due_at` is never earlier than the instant the reading stopped:

```
no matter cited          due_at = the grant's own expires_at   (known when the grant takes effect)
a matter still open      due_at = NULL until the close, then
                                  max(matter.closed_at, grant.expires_at)
a matter already closed  due_at = max(matter.closed_at, grant.expires_at), written when the grant
                                  takes effect
```

"After the matter closes" therefore means *after the reading actually stopped*, which is what the sentence
was for. The `max` is computed in the close's own transaction, and the close instant is read off the row
the close just wrote rather than passed in — with an `EXISTS` on `closed_at IS NOT NULL`, so a close that
lost its race dates nothing.

**The third arm is not symmetry; it is the hole that made the whole mechanism suppressible.** The close's
statement runs in the close's transaction, so it can only date notices that already exist — and a grant is
asked for at one instant and takes effect two approvals later, with nothing refusing a close in between.
`requestSupervisedRead` refuses a *new* request citing a closed matter, which looked like the whole
defence and is not: the request that matters was made while the matter was open.

So the order **request, close, approve** left `due_at` NULL with nothing that would ever write it. No
second close is permitted; the cron delivers only what is due; `supervision_notices_overdue` is
`due_at IS NOT NULL` by construction; and `supervision_notice_missing` counts rows, and the row was there.
The reader then read, every act was recorded, and the person whose mail it was was never told — **without
an audited row being deleted**, arranged by the investigator, who opened the matter and may therefore
close it. Both orderings now write the same instant from the same expression
(`whenTheReadingStopped` in `src/notifications.ts`), and `supervision_notice_stranded` counts what would be
left if that ever stopped being true.

**The residual, stated rather than left to be found:** a matter left open indefinitely defers its notices
indefinitely. That is §7's own shape rather than a gap in this one — pre-close confidentiality is what
makes the notice meaningful — and the control that exists is that closing is not the investigator's
privilege: any `org.admin` can close somebody else's matter, for exactly this reason.

### It is a row, not a Workflow

`workflow-provisioning.md` settled that before preference could: a Workflow instance is **not a durable
record** (state retained 3 days on Free, 30 on Paid, configurable) and a matter can stay open for months.
A DO alarm is worse — `wrangler.jsonc` records its absorbing failure state, *stop re-arming and nothing
external notices, ever*.

The deciding property: **`doctor` can count rows and cannot see inside a sleeping instance.**

- The row is written in the **same `batch()`** as the `UPDATE supervised_grants SET granted_at` that makes
  the grant live, carrying the same `EXISTS (approved)` gate. A live grant with no notice owed is not
  unlikely, it is unrepresentable.
- The one-minute cron `wrangler.jsonc` already declares delivers it — a branch in a trigger that already
  runs. Cron's measured weakness is lateness (`cron-lateness.md`, p99 **8.1 s**), irrelevant to a notice
  measured in days, and the scan is idempotent so a missed run costs a minute. **The wiring is tested
  through the exported `scheduled` handler**, not by calling the scan: a scan nothing calls is a row that
  sits, and deleting the one call would otherwise have left every notice owed with the suite green.
- **Suppressing a notice requires deleting an audited row.** `supervision_notice_missing` compares the
  count of `supervised.granted` entries in the hash-linked trail against the rows in `notifications`, so
  removing the row shows up in `doctor` and removing the entry instead breaks `verifyChain` at a nameable
  point. Neither half goes quietly. The product has **no** delete, dismiss or mark-read — a world test
  forbids `DELETE FROM notifications` anywhere in `src/`, because a product that can clear one makes a
  missing row ordinary and the finding meaningless.
- **And deletion is not the only way to suppress one**, which the first version of this mechanism proved:
  a row that is present and can never fall due is just as suppressed and passes both checks above.
  `supervision_notice_stranded` counts undated notices whose matter has already closed. It should never
  fire — the F-A section says why the state is no longer reachable — and it is measured rather than
  asserted, at no extra cost, because it is a fifth scalar sub-select in the same statement.

### Delivery is in-product, and that follows rather than being chosen

`transport.ts` already has to catch Cloudflare's *destination address is not a verified address*, so a
legal obligation carried by outbound mail is one defeated by a mail-routing setting. `GET
/api/notifications` has no such dependency, and the shell renders it as a band above every screen.

*"Cannot be switched off by the investigator"* holds **structurally**. A §7 notice is addressed to the
**mailbox** (`user_id` NULL) and its audience is resolved live from `relationship_tuples`; a supervised
grant is a `supervised_grants` row and never a tuple, so the investigator can never appear in that set.
Addressing it to the mailbox rather than freezing a person is also the right answer on its own terms: a
Mailda mailbox is shared by construction and has no owner column, and freezing the set would tell somebody
who has since left and stay silent to whoever took the mailbox over.

### What the notice says, and why

§7 requires the employee be told; it does not say what. Both ends are wrong. *"Your mailbox was accessed
under matter M-19"* is compliance theatre, and this project's argument is that an unusable record is not a
record. A transcript of every query hands somebody a restatement of their own mail in a table with
different access rules from the mail.

So it errs toward **enough to act on**:

| told | why |
|---|---|
| **who read it**, by name and address | the first question anybody asks; a notice that withholds it invites them to find out by other means, and §7's own record names the supervisor |
| the **scope**, in the product's two words | "how much of it" has a real answer |
| `granted_at` → `expires_at` | "for how long", from the row the two approvers agreed to |
| **what they did**: queries run, messages those queries listed, contents opened, raw messages read | the part that makes it actionable — the difference between a grant nobody used and one under which four hundred messages were opened |
| the matter's **id and type**, and when it closed | enough to ask about, without publishing the accusation |

And deliberately **not**:

- **the matter's description.** `listMatters` already treats it as confidential — an org-wide listing would
  hand *"suspected exfiltration by Dana"* to Dana — and closing a matter is not a finding. The Node cannot
  vouch for that sentence, and publishing it as a system notice would overclaim in exactly the way
  AGENTS.md §4 forbids.
- **the ids themselves.** They are in the audit trail, where a record of *what* was read belongs and where
  whoever may audit can read them. A notice restating them would put an unbounded list in a row rendered
  to a person, and a second copy of a fact free to disagree with the first.

The counts come **from the trail** rather than being maintained beside it, so they cannot drift from the
entries they describe; and they are frozen into the row at delivery, so a notice says the same thing for
ever and reading the feed never re-aggregates a table that is never trimmed.

### #61 inherits the mechanism

#61's resolution deferred its own notification here and asked for a row in the same table with `due_at`
now, delivered by the same scan. That is what it is: `planApproval` emits one `approval_request` row per
person **asked**, in the request's own transaction, so an approval waiting on people nobody told is not a
state this Node can reach. The set is frozen rather than resolved live — *who was asked, at the instant of
asking* is the same fact `approval.requested`'s `eligible` count records — and §18's separation of duty is
applied once, in `planApproval`, so the requester is out of the notified set for the same reason they are
out of the eligible one.

### What it costs

Two receipts, both measured rather than reasoned.

- **The read path** (`authz-check-rows-read.md`, correction of 20 August). An ordinary read still costs
  **2** D1 executions — the record is owed only when a grant answered, and `LIMIT 1` stops at the tuple arm
  for everybody else. A supervised read costs **4**: the same 2, plus the append's chain-tip read and one
  `batch()`. `authz.supervised_read.max_queries = 4`, exactly and with no headroom, because every term is
  fixed. `sgr_live` gained `id` as a trailing key column (migration 0024) so the arm stays **covering**
  while returning the grant — printed in `test/explain.test.ts`.
- **The scan** (`supervised-notice-scan.md`). `notify.scan_batch = 50`: a full batch is `2 × 50 + 2 = 102`
  subrequests against 1,000 on Workers Free. An idle tick costs **one** query, because `ntf_due` is partial
  on `delivered_at IS NULL` and a delivered notice leaves the index for ever.
  `notify.overdue_grace_seconds = 3600` is derived from `cron.propagation_ceiling_seconds` (900 s) plus the
  schedule and the measured p99 lateness; without it, #61's immediately-due requests would have made every
  healthy Node report `degraded`, which is how a check gets muted.
- **`doctor`** gained **one** D1 query (15 → 16 subrequests), which is a fixed cost that does not grow with
  mailboxes, matters, grants or the age of the trail.

---

## Still not built, named rather than implied

**No step-up authentication and no `maximum_session`** from §7's config block; both are
authentication-strength questions this ticket does not settle. **No `read_reason_required`** beyond the
matter's own description. **No export** — #65 owns eDiscovery, and it is a supervised act that will need a
fourth action and a finer scope than the mailbox.

**A matter left open never dates its notices**, which is §7's own shape and is argued above rather than
hidden. **`doctor` counts the missing notices but does not name them**: a per-grant join would say *which*
grant lost its row and would cost a query proportional to grants, where the count answers the question the
finding exists to ask — *has anything been removed* — and the trail answers the next one.

**A supervised *listing* that returned nothing leaves no entry, and a supervised *search* now does.** Both
listings learn which grant answered **from the rows themselves** — `listMessages` from a `LEFT JOIN`,
`queueFor` from a check whose subject is the mailbox and not the result — so a page that matched nothing has
no grant to attribute.

This paragraph used to say the remedy was refused: *"closing it means asking which grants are live on every
listing, whether or not one answered — a second query on the hot read path for a record of having seen
nothing."* That trade is still refused for a listing and **taken for a search** (#158), because the two are
not the same act. An empty listing disclosed nothing; an empty search told the reader a word is absent from
somebody else's mail, which on a contentless index is half of ADR 28's confirm-a-guess capability.

The cost is confined to a **searched** page that returned nothing, where it is one indexed read for any
reader plus a digest and a write when a grant is found. The hot path this paragraph was protecting — an
ordinary listing, and an unsearched supervised page — is untouched.

What still goes unrecorded is the empty **listing** attempt, and a notice's `acts.queries` therefore counts
fruitful listings rather than all of them.

---

## Where things are

```
migrations/0023_supervised_read.sql            matters, supervised_grants, sgr_live
migrations/0024_supervised_acts_and_notices.sql notifications; sgr_live widened to carry the grant id
src/matters.ts                        MATTER_TYPES, open, close (which dates the notices), list
src/supervised.ts                     SUPERVISED_SCOPES, LIVE_SUPERVISED_GRANT, the request, the report,
                                      SupervisedAct, buildSupervisedQuery and buildSupervisedProbe
src/probe-digest.ts                   the keyed digest of a probed term, and why it is keyed rather than
                                      hashed and derived from the content key rather than the credential one
src/notifications.ts                  NOTIFICATION_KINDS, the statements that owe a notice, the feed,
                                      noticeState for doctor
src/notice-delivery.ts                the cron scan and what a notice says
src/audit.ts                          the five disclosure actions, DisclosureAction, recordDisclosure
src/access.ts                         supervised.read in GRANTABLE; Grantable derived so it is not admin-grantable
src/authz-read.ts                     which read paths accept a grant, holdsStandingRead, and where the
                                      recording lives
src/approvals.ts                      supervised_read as a subject kind; COMPLETING_EFFECT; the granting
                                      UPDATE and the notice beside it; #61's request notices
src/doctor.ts                         self_granted_access, supervision_notices_overdue,
                                      supervision_notice_missing, supervision_notice_stranded
src/client/app/chrome.tsx             the notice band, and the sentence it renders
test/supervised-read.test.ts          part A's behaviour: the expiry stop and the two doors
test/supervised-recording.test.ts     part B's: the acts, the id bound, the notice, the suppression
test/node/matter-and-scope-world.test.ts   the enums, the writers, the one grantor, the one live predicate,
                                      and that no listing discloses without recording
test/authz.measure.test.ts            what the arm and the record cost, both instruments
test/notifications.measure.test.ts    what the scan costs
```
