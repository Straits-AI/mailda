# The capability ceiling and the sponsor

Layer 4's shape decision 4, built. [#51](https://github.com/Straits-AI/mailda/issues/51) settled the other
two halves of its ticket — a Butler is a bare typed-prefix subject with no row behind it, and `send.propose`
stays bound to the mailbox — and left the manifest itself:

```text
effective(step) = pinned ceiling ∩ live tuples of the Butler ∩ live tuples of the sponsor
```

Three terms, and this file is what each one is, where it lives, what it costs, and what it does **not**
reach.

---

## 1. The ceiling: `capabilities:` inside the AST

§16 writes it as a top-level key of the Butler document, beside `metadata` and `trigger`, and that is where
it lives:

```json
{
  "apiVersion": "mailda/v1",
  "kind": "Butler",
  "metadata": { "name": "sales-enquiries", "owner": "team:sales" },
  "capabilities": [
    { "action": "mailbox.content.read", "resource": "mailbox:enquiries@example.com" },
    { "action": "send.propose",         "resource": "mailbox:enquiries@example.com" }
  ],
  "trigger": { "event": "mail.received", "mailbox": "enquiries@example.com" },
  "entry": "read_it",
  "nodes": [ … ]
}
```

**A ceiling grants nothing.** An administrator still has to write a tuple naming the `btl_`. What the
ceiling does is remove: an action it does not name is an action no later grant can ever supply, which is the
whole of the blueprint's promise that *"new grants do not silently expand a published Butler; republish is
required"* (blueprint:2769).

### Three actions, and only three

`mailbox.metadata.read`, `mailbox.content.read`, `send.propose` — exactly the relations a **shipped node can
require**. `approval.decide`, `message.export`, `ediscovery.export` and `supervised.read` are real relations
in `access.ts` that no node checks, so a ceiling naming one would be a declaration nothing reads: the
`mailbox.metadata.read` hole pointing the other way, where a relation was checked by nothing and therefore
conferred nothing.

### One resource grain, and §16's example is amended to it

`mailbox:<address>`. §16's example wrote `sender:enquiries@example.com`, and #51 settled that **the resource
is the mailbox**: `addresses` is unique on `(org_id, address)` and not on `mailbox_id`, `send_manifests`
carries a `mailbox_id`, and ADR 36 makes `From` the mailbox. §16 and §29 are amended in the same change as
this file, per AGENTS.md's rule that divergence is a bug in both places.

`case_type:` and `llm_profile:` — §16's other two grains — are **refused by name** at publication, because
both name objects that do not exist in this schema. Admitting them would be a ceiling entry that publishes
and bounds nothing.

The value is an address rather than a `mbx_` ULID because an author writes a document: they know
`enquiries@example.com` and `trigger.mailbox` is already one, so a ceiling in ids would make one document
speak two languages about one mailbox.

### What publication checks, which is what stops this being decoration

Two refusals, and between them the ceiling's **action set is exactly the action set the graph needs**:

| refusal | when |
|:--|:--|
| `E_BUTLER_CAPABILITY_NOT_DECLARED` | a node needs an action the ceiling does not declare |
| `E_BUTLER_CAPABILITY_UNUSED` | the ceiling declares an action no node needs |
| `E_BUTLER_CAPABILITY_RESOURCE_UNKNOWN` | a grain this Node cannot interpret |

The requirement per node type is a **total map** over the shipped set (`packages/butler-ast/src/capability.ts`),
so a node moving from reserved to shipped without an entry does not compile, and the compiler asks the one
question that matters: *what authority does this node take?* Nine of the fourteen shipped kinds need nothing,
and every one of them performs no I/O — the same line `cost.ts` draws, for the same reason. `lookup` depends
on its entity, because a message's subject and sender *are* content while a case is queue metadata and a
draft is bounded by authorship rather than by any mailbox relation.

**The over-declaration refusal is the one worth arguing for.** A ceiling padded *just in case* is a ceiling
that does not bind: declaring `mailbox.content.read` for a Butler that reads nothing is a pre-authorisation
for a node the author has not written, and adding that node later is exactly the moment republication exists
to make deliberate.

It also answers the obvious objection. If the action set is derivable, is the declaration not two places
holding one fact — the correspondence problem this AST refuses for `join`'s absent `of` list and ADR 35's
effect key? It is, and the difference is that **publication proves the two agree**, which is the remedy
`join` could never have because nothing there could check. What the author supplies that nothing can derive
is *which mailbox*.

### What publication cannot check

The resource. A node's mailbox is an `Expr`, and `packages/butler-ast` deliberately does not parse
expressions — `"${event.mailbox_id}"` and `"mbx_01J…"` are both opaque non-empty strings there. So the
resource half is unverifiable at publication **by construction**, and it is enforced at runtime instead, per
step, in the statement that already asks about tuples.

### Frozen, and frozen by the clause that was already there

The ceiling is inside `ast_json`, so `btv_frozen` (migration 0027) already refuses to move it, `ast_sha256`
already fingerprints it, and `src/butlers.ts` already derives it from `source_text` so it cannot disagree
with what its author wrote. A column on `butler_versions` was the alternative and is worse in all three of
those ways — most of all the first, because a fourth content column is a fourth thing to remember in a
trigger whose first draft was found to have a two-statement bypass.

### The cost of that, paid once: every version published before #51 stops running

Frozen cuts both ways, and this is the half worth saying out loud. `capabilities` is a **required** key, so a
version published before this change does not check: `checkButler` refuses it with `E_BUTLER_MALFORMED`, and
because `interpret` re-checks the stored AST on every run, that version refuses each run with
`ast_does_not_check` and the checker's finding in the operational log. It cannot be repaired in place —
`btv_frozen` is what makes the ceiling pinned, and it does not have an exception for this. The remedy is
republication, which is what publication already means here.

The direction is the safe one: a Butler with no declared ceiling stops rather than runs unbounded, loudly,
per run, with a finding naming the missing key. It is stated here and in `docs/butler-ast.md` because nothing
enforces it and no migration records it — the change is to what a stored document must contain, and there is
no column to write an expand/contract note against.

---

## 2. The sponsor: `butler_versions.published_by`

### How that was established

§7's own sentence separates the terms: *"the intersection of the authenticated principal, **sponsoring
grant**, immutable Butler/version capability manifest, … live relationship"* (blueprint:702). §16's
delegation flow says what a sponsor does: *"Sponsor selects mailbox, readable data, actions, senders,
recipient constraints, budget, expiry and approval requirements"* (blueprint:485) — the sponsor is **whoever
declares the bound**. In this Node the bound is `capabilities:` in the source text and the act that makes it
live is publication, which `butlers.ts` gates on `org.admin`. So the sponsor is the publisher.

### This does not undo #50, and the reason is one sentence

#50 decided a Butler's **principal** is the Butler, and explicitly rejected the publisher on four counts. All
four are about *identity*; none is about *capping*, and **an intersection is monotone downward** — adding the
sponsor term can only ever remove authority, never add it.

| #50's objection to the publisher as principal | why capping is not that |
|:--|:--|
| *"grants everything that person can do, for ever"* | grants **nothing**; the Butler still needs its own tuple. A mailbox the publisher can reach and the Butler cannot stays unreachable |
| *"puts a person's name on mail they never composed"* | the actor is still the `btl_`; `published_by` appears in no `actor_user_id` and no `From` |
| *"excludes a real human from a gate they never asked for"* | `approversOf` excludes the **actor**, still the Butler, so the publisher stays eligible to approve and to release |
| *"a policy could not tell a Butler's send from that person's own"* | unchanged; #60's `actor` condition still compares the `btl_` |

Identity is a claim about who did something and can be true or false. A ceiling is a claim about what cannot
be done and can only subtract. That is why capping is safe exactly where identifying was not.

### Revocation, and departure

**Revocation stops the Butler on the next node.** Nothing about the sponsor term is cached — it is two live
queries per check, exactly like every human check in this Node (§7, §28). The stop is *visible* rather than
silent: the effect row records `sponsor_lacks_it`, which the run listing shows and an operator can filter on.
That matters because a ceiling that quietly empties and a Butler that quietly does nothing look identical
from the outside, which is why the three refusal reasons stay distinguishable.

**Departure is revocation, and that is a statement about this Node rather than about people.** There is no
deactivation flag and no `DELETE FROM users` anywhere in this Worker — checked, not assumed — so the only way
somebody stops holding authority is that an administrator revokes it. See the residual below for what that
does not close.

### A published version with no publisher is refused

Unreachable through `publishButler` and unwritable since 0031, so it means a hand-edited row. The run refuses
with `sponsor_unknown` rather than defaulting, because every available default is wrong: an empty sponsor
would make the term match nothing and read as a revocation, and treating the absence as *"no sponsor term"*
would silently delete a term of §7's intersection for exactly the row that could not account for itself.

### 0031 froze the sponsor, because 0027 did not know it was content

`btv_frozen` guarded `ast_json`, `source_text`, both digests and `version`. `published_by` was writable:

```sql
UPDATE butler_versions SET published_by = 'usr_someone_with_more' WHERE id = 'btv_…';
```

One statement, no error, and a frozen program's ceiling now capped against a different person's authority —
with the AST untouched and every digest still matching. Same class as the two holes #49 found and closed in
0027, reached through the one column that became a content column the day the sponsor term was built.
`published_at` joins it for a smaller reason, stated so it is not read as an oversight: a publication whose
*who* is frozen and whose *when* is not is a record that can still be made to lie about which of two versions
went live first.

---

## 3. Two queries, and the OR that must not answer the AND

#51 derived that three terms fit in **two** round trips, which is what keeps a Butler's check inside
`authz.check.max_queries = 2`:

1. **The ceiling is free.** It lives on the version row the run has already loaded to get its AST. What it
   costs is a sub-select over `addresses`, which is UNIQUE on `(org_id, address)` — one index seek per
   declared address, inside a statement that was going to be issued anyway.
2. **The sponsor's subjects: one query.** `readableSubjects`, shared with every human check rather than
   rewritten, because the sponsor's subjects and the sponsor's own checks must agree about who they are.
3. **Both tuple terms in one query.** The Butler needs no team expansion: `team_members.user_id` holds users
   and a Butler's subject is a `btl_`, so that read returns nothing by construction. #51 calls that a feature
   rather than a limitation — a Butler inheriting a team's grants is exactly how a declared ceiling stops
   meaning anything, because the ceiling would float with the team's grants.

### The subtlety, in the resolution's own words

An `IN` list over subjects answers *"does **any** of these hold it"*, which is an **OR**. The intersection
needs an **AND**. Written flat, as one `subject_id IN (butler, sponsor, …sponsorTeams)` with a `LIMIT 1`, a
Butler holds whatever its sponsor holds — the sponsor's row alone satisfies the predicate — and nothing
notices.

There are two shapes here, one conversion:

**Where the step names its mailbox** (`draft`, `mail.send.propose`), `effectiveOnMailbox` selects
`DISTINCT subject_id` rather than `1`. The query returns *which* subjects hold the relation and the AND is
evaluated on the result. The ceiling rides in the same statement as a second arm of a `UNION ALL`, so all
three terms come back from one round trip:

```sql
SELECT DISTINCT '#ceiling' AS holder
  FROM addresses WHERE org_id = ?1 AND mailbox_id = ?2 AND address IN (…)
UNION ALL
SELECT DISTINCT subject_id AS holder
  FROM relationship_tuples
 WHERE org_id = ?1 AND object_type = 'mailbox' AND object_id = ?2
   AND relation IN (…) AND subject_id IN (butler, sponsor, …sponsorTeams)
```

**Where the step discovers its mailbox** (`lookup`, `case.assign`, `case.close`), the mailbox is the query's
*output* — you cannot ask which subjects hold a relation on a mailbox before you know which mailbox it is —
so the terms are folded into that same statement as a ceiling sub-select and **two `EXISTS` clauses joined by
SQL's own `AND`**. The OR lives *inside* the sponsor's clause, over the sponsor's subjects, which is where an
OR is correct.

Two shapes of one rule is the thing `authz-read.ts` warns about, so the agreement is checked rather than
argued: `test/butler-capability.test.ts` walks all eight combinations of the three terms and asserts the two
shapes answer alike. **The two combinations where exactly one of the two subjects holds the relation are the
whole defect** — a flat `IN` list passes the other six.

### Three refusal reasons, because §5C requires three

| reason | means | remedy |
|:--|:--|:--|
| `capability_not_declared` | you never declared it | edit and republish |
| `butler_not_granted` | you declared it and nobody granted it to this Butler | ask an administrator |
| `sponsor_lacks_it` | it was granted and the sponsor no longer holds it | find out what happened to the sponsor |

The third is the one that will confuse people, because nothing about the Butler changed, so it names the
sponsor in the operational log.

**They are separable only where the step names its own mailbox.** A read that discovers its mailbox cannot
separate *"the ceiling does not name that mailbox"* from *"no tuple grants it"* without a second query, and
asking would also answer a question §5C wants left unanswered: absent and forbidden must look alike, so a
Butler cannot be used as an oracle for which ids exist. Those nodes record `not_readable` or
`case_not_actionable`, exactly as they did before.

One exception, stated because a reader would otherwise look for a bug: **`mail.send.propose` never records
`butler_not_granted`.** Its mailbox is the draft's, which is unknown until `readDraft` has run, and
`readDraft` re-checks `send.propose` itself — so a Butler holding no tuple is refused there with Layer 2's
`E_MAY_NOT_SEND_AS_MAILBOX`, before the intersection is asked.

### What it costs, measured

`docs/receipts/butler-run-cost.md`, corrected 21 August 2026. Every bound is unchanged and every node grew by
the round trips the derivation predicted:

| node | before | now | bound |
|:--|--:|--:|--:|
| `lookup` | 2 | 3 | 4 |
| `case.close` | 2 | 3 | 4 |
| `case.assign` | 7 | 8 | 10 |
| `draft` | 6 | 8 | 10 |
| `mail.send.propose` | 23 | 25 | 28 |
| engine fixed | 3 | 3 | 3, pinned |

The folded nodes grew by **one** and the naming nodes by **two**, because for the folded ones the second
query is the statement they were already issuing. The engine's fixed cost did not move at all, which is the
measurement behind *"the pinned ceiling is free"*.

---

## What the ceiling does not reach

Named rather than implied, because a ceiling that is described as total and is not would be worse than one
described honestly.

- **The parent mailbox of a threaded reply.** `sealManifest` refuses a parent the author cannot read
  (`E_NO_SUCH_PARENT`), and that check is bounded by the Butler's own tuples, not by this ceiling. `inReplyTo`
  is an `Expr` and the parent's mailbox is not knowable at publication, so a later grant of
  `mailbox.content.read` on some other mailbox does let a published Butler thread onto a parent there. What it
  discloses is that a reply is in that thread; the recipients still come from the trigger (#52), and the reply
  is still addressed from a mailbox the ceiling names.
- **The trigger's own mailbox.** A Butler that only guards on `event.subject` and stops reads mail content
  with no capability declared. It discloses nothing — it cannot draft, send, assign or look anything up
  without declaring an action — and the run's recorded facts are separately gated by `inspectRun`'s
  `mayReadMetadata` (#63). Left as it is rather than requiring a declaration nothing would check.
- **A sponsor who has left and whose tuples were not revoked.** This Node has no user lifecycle: no
  deactivation flag, no delete path. So "the sponsor left" is expressible only as "somebody revoked their
  relations", and where nobody does, the ceiling keeps working on a departed person's authority. That is an
  argument for the user-lifecycle work rather than a gap this term can close from inside itself, and it is the
  one residual in this file that is a real hole rather than a bounded one.
- **The two-relation imprecision, in both of the places it appears.** A check that accepts
  `mailbox.metadata.read` **or** `mailbox.content.read` unions the ceiling's addresses for both, so a ceiling
  declaring only the weaker one passes on a mailbox where the Butler holds the stronger. The same looseness
  sits between the two tuple terms: each is a `relation IN (…)`, so the Butler may hold `metadata.read` while
  the **sponsor** holds `content.read` and both terms are satisfied by different relations. Every read that
  names the pair returns metadata-grade columns — a case's state and assignee, a conversation's grouping, a
  mailbox's name — so both actions authorize what is disclosed either way. The one-relation checks are exact
  and they are the ones that matter: `mailbox.content.read` for a message, `send.propose` for every effect.
  Making the pair exact would mean asking per relation, which is a second round trip for a distinction that
  changes no disclosure.

## Still not built

- **`case_type:` and `llm_profile:` grains**, refused by name, because both name objects that do not exist.
- **A per-sender grain.** `sender:enquiries@example.com` is more expressive and genuinely wanted eventually —
  a shared mailbox whose invoicing address only two people may send as is a real arrangement — but it moves
  `maySend`'s signature and every call site, stops `object_id` being a `mbx_` ULID for that relation, and
  requires re-arguing ADR 36 rather than citing it (#51).
- **The capability preview**, the surface that would show an author the three reasons *before* a run rather
  than after one. The three reasons exist and are recorded; nothing renders them, because there is still no
  authoring channel at all (`src/butlers.ts` header). It arrives with that channel.
- **A sponsor who is not the publisher.** A `sponsor:` field in `metadata` would let an administrator publish
  on somebody else's authority, which is a real arrangement and a real hazard — it lets one person cap a
  program against a colleague who never agreed. It needs consent, which needs a channel.
