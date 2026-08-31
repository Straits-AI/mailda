# The machine surfaces

The Agent Skill (#88) and the MCP server (#89), and the one question they both answer.

## Curation is the work; transport is not

#85 generated an SDK: 94 methods, one per route, named mechanically. That is the right surface for a program
somebody wrote on purpose, and the **wrong** one for an agent. Handing it over unchanged would be a worse
interface than the SDK it wraps.

Both surfaces need the same answer to the same question — *what should a machine be able to do here?* — so
it is answered once in `packages/contract/src/agent.ts` and both read it. Answering it twice is how the two
would come to disagree about which acts are safe, which is the worst thing they could disagree about.

## The rule

| tier | may be offered | what it is | count |
|:--|:--|:--|--:|
| `read` | yes | answers a question, changes nothing | 38 |
| `act` | yes | changes something, and a person can undo it | 8 |
| `governed` | **no** | needs more than one person, or cannot be undone | 30 |
| `operator` | **no** | installation, credentials, maintenance | 32 |
| `surface` | **no** | the machine surface itself | 1 |

These counts are checked against `exposureOf` by `test/node/agent-exposure-world.test.ts`, which was added
after every row of this table was found to be wrong at once — 41/12/25/17 against an actual 39/9/29/25. A table
of counts in a document about completeness reads as evidence of completeness, and nothing was watching it.

**The tier is necessary and not sufficient**, and that column used to say "offered" flat. 46 routes are `read`
or `act`; **23** are offered. The difference is the second question — can a machine ever be *provisioned* for
this route — and it is asked in `authority.ts` rather than here:

| withheld by | how many | example |
|:--|--:|:--|
| the tier | 63 | `POST /api/sends` — sealing a send is the one act nobody can undo |
| `org.admin`, which no mint confers | 20 | `GET /api/people`, `POST /api/butlers` |
| a filter no machine can satisfy | 2 | `GET /api/approvals` and `GET /api/auth/passkeys` — 200, and an empty list, for ever |
| requester-owned | 1 | `GET /api/exports/:exportId/objects/:objectId` |

The middle two are the ones worth understanding, because nothing refuses: the route answers, and the answer is
empty or the credential is rejected on a door it was told it could open. They were offered as tools for as
long as the catalogue was filtered by tier alone, and `test/mcp.test.ts` now asserts the intersection is empty
against the registry rather than against a list of names.

**Reads are derived, with one named exception.** Every `GET` is `read` by construction, because writing
ninety judgements where one rule suffices is how a registry acquires an entry that disagrees with its own
path. `GET /index.html` is the exception: the interface shell is a page, not a question anybody would ask a
Node, and offering it would put "fetch the HTML" in a list of capabilities.

Every route that changes something is classified by hand, and `exposureOf` **throws** on one that is not.
`agent-exposure-world.test.ts` runs it over the whole registry, so a new route fails rather than defaulting
— and the only defensible default is *refuse*, which would make a new capability silently never appear.

It worked twice on its first day: `POST /api/sends/:sendId/cancel` was the one changing route the first
draft forgot, and `POST /mcp` arrived from #89 needing a tier that did not exist.

## A tool's inputs include the route's query parameters (#91)

A path parameter becomes a required string and a request schema becomes `body`. A route's `query` becomes
**optional strings, flat beside the path ones** — flat because an agent filling this schema is choosing values
rather than building a URL, and the two names cannot collide: a path parameter is a `:name` in the path and a
query parameter is not.

It matters more here than the mechanism suggests. `getMessages` used to return the newest fifty with no way to
ask for anything else, so an agent looking for last month's invoice thread had one page and no way to know
there was more. It now reports a `next_cursor` and takes one, and the parameter's **description carries into
the tool schema** — because a paging control an agent cannot see the meaning of is a control it will not use.

An argument that is **absent or null** is omitted; everything else is forwarded, coerced with `String()`.
Omitting an absent one is what the route already means by absent — the newest page, every mailbox — and
forwarding the rest is the same principle from the other side: an empty `?q=` or a number where a cursor
belongs is a *wrong value*, and the honest failure for a wrong value is the route's own refusal, which names
the shape and the way back. A guard here would be a second, differently worded opinion about a value the route
already validates.

> This paragraph said "absent, empty or not a string is omitted", which described a version of `mcp.ts` that
> is not the one running: `if (value !== undefined && value !== null) search.set(name, String(value))`. An
> agent author reading the old sentence would have expected `?q=` to be dropped and seen it forwarded, which is
> the specific way stale documentation costs more than none.

## Two classes of machine caller, not one

`tools()` served one static catalogue to every caller, which treated "machine" as homogeneous. It is two:

| caller | offered |
|:--|:--|
| a person's **live session** — MCP or Skill inside a signed-in browser or CLI | read ∪ reversible-act routes |
| a delegated **`agt_` credential** | machine-useful routes ∩ the ceiling pinned at mint |
| a stranger | machine-useful routes, no ceiling — the conservative answer |

The cost of collapsing them was a specific tool. `POST /api/butlers/:butlerId/simulate` walks a Butler over a
real past delivery, causes nothing and cannot write; the curation says *"offering this to an agent is the point
of having built it"*. Its handler requires `org.admin`. A delegated credential can never hold that, so a single
list had to withhold the dry run from **everybody** — including the administrator whose assistant is exactly
the caller it was built for.

**Nothing was weakened to bring it back.** The handler still calls `isAdmin` first. What changed is only
whether a caller who could complete the call is told the tool exists. Every tool call still re-enters the
ordinary router and meets `principalFor`, the route's own check and its audit entry.

**A delegated credential cannot reach `/mcp` today**, and that is worth stating rather than implying
otherwise: `POST /mcp` is tier `surface` — a surface is not a capability on itself — so it is in no agent's
pinned ceiling and the token is refused before any catalogue is consulted. The agent branch is therefore
correct and unreachable. It is kept because the intersection is the right answer the moment somebody decides
a credential should reach the endpoint, and `test/mcp.test.ts` asserts the 403 so that decision announces
itself rather than arriving silently.

## `governed` is not about permission

§18 and #61 count **distinct people**. An agent acting inside somebody's session *is* that person — not a
second one — so every dual-control rule already refuses it. This tier adds no refusal; the Node has it.

What it prevents is **offering the act**. A Skill listing "approve a send" teaches an agent to try, and an
agent that tries keeps trying: it reads the refusal, sees `fix: ask somebody who holds approval.decide`, and
has no way to know that *it* can never be that somebody. **An offer a caller can never complete is a worse
interface than no offer.**

## The Skill names what it withholds

The tempting shape is a list of what is offered. That leaves every excluded act as an *absence*, and an
agent meeting an absence infers a gap rather than a decision — then goes looking for the route directly,
which is precisely what the curation exists to prevent.

So `skills/mailda/SKILL.md` ships the withheld list too, with the reason for each. An agent that reads
*"approving a send needs a second person and you are acting as the first"* stops; one that finds nothing
about approvals tries.

Generated by `pnpm skill`; `pnpm skill:check` fails on a diff.

## Where the MCP server lives, which was #89's real question

An MCP server is a thing an agent connects to, and every obvious shape collided with something decided:

| shape | cost |
|:--|:--|
| a second Worker | contradicts ADR 18's one-Worker rule; gives ADR 24 a second artifact to keep identical |
| **routes on this Worker** | **the Node grows a protocol surface somebody else specified** |
| a separately-run server | the first component holding credentials for a Node it is not part of |

The third is the one to reject hardest. ADR 7's premise is custody — your account, your data, your keys —
and a locally-run bridge holding a session token for a Node it is not part of is the shape that premise
exists to rule out, whatever its convenience.

So: **`POST /mcp` on this Worker**, MCP's Streamable HTTP transport. One Worker, no new account resource, no
customer-specific configuration, and the mail never leaves the Node that holds it. The cost is the middle
row and it is paid openly: the shape of that route is set by a specification this project does not control,
which is why it is the sole member of `EXTERNALLY_SPECIFIED` — a JSON-RPC reply is a union over every method
MCP defines, and describing it in `packages/contract` would restate that specification somewhere it could
disagree.

## A tool call re-enters this Node's own router

Not the functions beneath it. A call goes through `principalFor`, the route's authorization, the audit entry
it writes and the refusal it returns — every one unchanged. An MCP layer reaching past those would be a
second way into this Node's data with its own idea of who may do what.

**In process, not `fetch` against its own origin.** The first version did that and the tests refused it: a
Worker fetching its own hostname goes back out through the edge, spends a subrequest from a budget this Node
counts, and fails outright in workerd. It also re-enters at `handler.fetch` rather than at `route`, because
the second attempt skipped the `catch` that turns a `CallerError` into a four-part refusal — so a tool call
that should have answered 422 with a remedy answered 500 with nothing.

## Authentication is the caller's session

No MCP-specific token. That would be a third credential kind after passwords and passkeys (#84), and every
act would land in the audit trail under a machine rather than under the person who set it going. The test
asserts the trail: a Butler drafted through MCP names the **person** as its actor.

It is also what makes the `governed` tier's reasoning true rather than aspirational — an agent is that
person, so it cannot be the second one.

## Refusals are results, not protocol errors

A refusal comes back as a tool result with `isError`. The tool ran and the answer was no, and this Node's
refusals are written to be acted on — four parts naming what would change. Flattening one into `-32603`
throws away the only part an agent can use.

A tool that is not on the list *is* a protocol error (`-32602`): that is a mistake about this server rather
than an answer from it, and telling the two apart is how an agent learns which to retry. Asking for
`postSends` — a real route, deliberately withheld — gets `no tool named postSends`.

## Agents act in their own right now, under a named person's authority (#109)

The MCP surface used to authenticate with the caller's session and nothing else, and `mcp.ts` gave a real
argument for it: an MCP-specific token would mean "every act would land in the audit trail under a machine
rather than under the person who set it going".

**That argument was correct given one actor field, and it is not an argument once there are two.** The trail
now carries a delegator, so an agent's act lands under the agent *and* under the human accountable for it —
strictly more than the session path recorded. `audit_entries.delegator_user_id` is inside the hash chain, and
it was added to a live chain without invalidating history because it is appended only when present.

Both paths stay open, by decision. A person driving a tool by hand is not pretending to be a machine, and the
delegator is what tells the two apart:

```
session    → actor = usr_ana,  delegator = null
agt_ token → actor = agt_x,    delegator = usr_ana
```

### Three terms bound an agent, and two were already built

```
effective(agent) = pinned action ceiling ∩ live tuples of the agent ∩ live tuples of the sponsor
```

The second term is `relationship_tuples` with an `agt_` subject. That is also why there is no table of
mailboxes: **an agent's resource ceiling is its tuples**, conferred by an administrator through the same door
as every other relation.

The action ceiling is pinned at mint and there is deliberately no route that widens one — §16's *"new grants
do not silently expand a published Butler"*, applied to a second principal kind. It is enforced in
`principalFor`, so it binds against a REST route as well as the tool that wraps it; a ceiling checked only
where tools are dispatched is one any caller steps around by calling the route directly.

An action is grantable only if `agentGrantableActions()` names it, which is `exposureOf`'s `read` and `act`
tiers and nothing else. Deriving the list from the route registry rather than restating it means a route
reclassified to `governed` leaves every agent's reachable set on the same commit; a hand-written list would
have gone on permitting it.

### The third term was stated and not enforced

The sponsor sentence — *a human cannot delegate more authority than they continue to hold* — was in the
header of the file that was supposed to keep it, and nothing kept it. `principalFor` set `delegatorUserId`,
the audit trail recorded it, and no query read it. So an agent went on reading a mailbox after its sponsor's
relation was revoked, after the sponsor left the team that granted it, and where the sponsor had never held it.

`delegation.ts` is the third term, and two things about its shape were decided the hard way.

**It is derived from the subject, not threaded through the call.** The first fix read `who.delegatorUserId`,
which works exactly as far as a `Principal` travels — and `isAdmin` takes a bare identifier that thirty callers
pass `who.userId` into, `mailboxQueues` takes `(orgId, userId)`, and `outbound/manifest.ts` re-checks the
author's authority at seal time from a *column*, with no `Principal` in reach and never going to have one. So
the sponsor is looked up from the identifier's typed prefix, the way `kindOfActor` derives an actor's kind —
the decision this repository already credits with making attribution structural instead of remembered.
`delegatorUserId` stays, because the trail needs the sponsor recorded rather than re-derived (a derived trail's
answers move when somebody reassigns an agent). Two mechanisms that must agree, and a test that says they do.

**It is an intersection, and each term of the `EXISTS` is load-bearing.** `AND EXISTS`, not another subject in
the `IN` list, or the sponsor's row satisfies the predicate alone and the agent holds whatever the sponsor
holds. Same relation, or an agent's `content.read` rides on a sponsor's `metadata.read` and reads bytes the
sponsor cannot. Same object, or a sponsor with one mailbox of their own licenses an agent across the
organization. All three were found by mutating the clause; the assertions written before each term existed
passed without it.

Fixing the single-object check covered mailbox read, `send.propose` and `ediscovery.export`, because all three
land in `hasAnyRelation` — and it covered **one route**. The listing, both arms of the search, the dispatch
sweep, the case queues, the sends listing, the notifications feed, the seal-time parent check and `isAdmin` all
kept their old predicates and every test passed. `test/node/delegated-authority-world.test.ts` is the answer to
that class: it enumerates every predicate reading the table and fails until each is classified as intersected
(and its source actually carries a term) or exempt with a stated reason. A behavioural test covers a predicate
somebody remembered; the defect is the predicate nobody remembered.

### The credential is opaque, not a signature

ADR 27 puts authority in a short-lived signature and revocation in the database, which is right for a session
with a refresh. An agent has **no refresh** — a refreshable agent token is a permanent one with extra steps —
so its credential is long-lived, and a long-lived signature cannot be withdrawn before it expires. An opaque
secret checked against a stored hash makes revocation a column and expiry a comparison. The cost is a database
read per agent request, and it is the right way round.

### Minting is an administrator's act, and the sponsor is a parameter

`access.ts` confers every relation by `admin_grant`, so a second door with different rules would be two
stories about who may delegate authority. The sponsor is named rather than assumed, so the person who
authorises the identity need not be the person whose authority it borrows — an administrator minting an agent
for themselves is one person deciding both halves.

All three agent routes are `operator` and reach no machine. An agent that could mint agents escapes its own
ceiling in a single call, and one that could list them holds a map of how to escalate.

### The trail names the person, and now something can read it

`audit_entries.delegator_user_id` shipped with L1, inside the hashed form. Two things then kept it a secret
(audit P1-1): **four** call sites populated it out of every audited act in the product, and
`GET /api/audit` did not select it. So an agent's act recorded `agt_…` as the actor and nothing as the
delegator, and even where a delegator *was* recorded no reader could ask for it. A field inside the hash that
no surface exposes is worse than a missing one — a missing field is an obvious gap, while a
written-and-invisible one reads as a question already answered.

The suggested remedy was a typed actor union threaded through every audited operation so the field could not be
omitted. The fix took the other route, and the argument was already written in `audit.ts` beside `kindOfActor`:
attribution derived from the identifier's typed prefix is *structural*, while a design where each call site
passes it *"would be correct on the day it was written and wrong the first time a new effect node called a
fifth function"*. A delegator is the same shape of fact as a kind. So it is derived from the actor's prefix,
with nothing to thread and no caller who can forget — including callers that do not exist yet.

Three details:

- **Derived at write time and stored.** A trail that re-derived the sponsor when somebody *read* it would
  change its answer the moment an agent was reassigned, and an audit trail whose answers move is what the
  chain exists to prevent. Derived once, hashed, immutable — which is what this column's own docstring always
  demanded.
- **An explicit value wins.** `butler/effects.ts` passes a Butler's sponsor from its *pinned ceiling* — the
  version's sponsor as published rather than as it stands now. That is better information than a lookup, and
  precisely the answer that must not drift.
- **It costs a person nothing.** `sponsorOf` returns on a regular-expression test before preparing a
  statement, so a `usr_` actor — nearly every audited act — pays no query. An `agt_` pays one indexed read.

The audit table in the interface showed no actor at all before this: not the identifier, not the kind, not the
delegator. It now reads `agt_… for usr_…` in one cell, because those are one answer and splitting them across
columns invites a reader to take the first without the second.

### A ceiling is chosen in the product's words, not in HTTP

`POST /api/agents` shipped taking route strings, so minting a credential meant composing
`["GET /api/messages", "GET /api/messages/:receiptId/body", …]` by hand. Two costs, and the second is the one
that bites:

1. An administrator deciding what a machine may do is answering *"may it read mail? may it draft a reply?"* —
   not writing a routing table. The translation is where a mistake goes invisible, because nothing about
   `POST /api/matters` says whether granting it is a small thing.
2. **A ceiling assembled by hand has no completeness.** Reading mail takes four routes; grant three and the
   agent works until it needs the fourth, which arrives later as a refusal in the middle of something and
   reads as a bug rather than as a ceiling somebody chose.

`packages/contract/src/capability.ts` names a capability for **every** grantable route — the count is not
stated here on purpose, because a hand-written number in a document about completeness is what the tier table
above got wrong five times over; the guarantee is enforced instead, below. `GET /api/agent-capabilities`
publishes the vocabulary so the interface carries no second copy.

**Expanded at mint, and the expansion is what is stored.** The tempting design stores `mail.read` and resolves
it per request — which would be §16's rule broken: *new grants do not silently expand a published Butler*, and
a stored capability resolved at check time would widen **every existing agent** the day somebody added a route
to it. So the routes are pinned. Adding a route to a capability affects only agents minted afterwards, and
renaming a route leaves an agent holding a string that matches nothing rather than one that matches something
else. Both fail the safe way. It also meant **no schema change** — `agent_actions` already held routes.

**Read back as held-of-total.** An agent minted before a capability grew holds part of it, so the interface
shows `4 of 5` rather than the capability's name. A name would imply the fifth route, which the agent does not
have and — the ceiling being pinned, with no route that widens one — never will. Routes belonging to no current
capability are shown too, never dropped: the authority is still pinned and still checked, so hiding it would
under-report a live ceiling.

**`reachesContent` is marked, not inferred.** §7's whole model turns on metadata against content, and
`export.read` reaches message bytes while sounding administrative. That is the one fact somebody choosing must
not have to guess.

`test/node/capability-world.test.ts` requires every grantable route to belong to **exactly one** capability. A
route in none would be grantable in principle and unconferrable in practice, with nothing reporting it; a route
in two would make a ceiling ambiguous to revoke. The first is the likely one, because it happens by not doing
something.

### Authority lives on the route, and everything else is derived from it

Authorization is enforced per **route**; the capability vocabulary described it per **capability**, as a
hand-written summary of a set of routes. Sixteen summaries of facts that live in handlers, and they drifted in
three directions at once:

| capability | said | the routes check |
|:--|:--|:--|
| `mail.read` | content read reaches the original `.eml` | that route checks `message.export` too |
| `send.observe` | `mailbox.content.read` | `/submitted` checks `message.export` too |
| nine others | no relation at all | `org.admin`, or ownership of somebody else's export |

The last row is the one that mattered. Nine capabilities offered authority the product **cannot provision**:
an administrator could select `butler.read`, mint the agent, and hand over a credential refused on every route
it named.

Each route now declares an `authority` — `public`, `member`, `recovery`, `organization`, `filtered`,
`self-or-admin`, `mailbox` with `allOf`/`anyOf`, or `export`
with requester ownership — and the capability's requirements, the mint's validation, the interface's warnings
and the tests are all read from it. `anyOf` contributes nothing to a requirement and `allOf` contributes all of
it: a route satisfied by *either* of two relations cannot say which to grant, while one needing *both* must, or
the mint hands over a credential that fails on its own promise.

**`agentGrantableActions()` intersects the exposure tier with provisionability.** The tier says what kind of
act a route is; the authority says whether a machine can ever be given what it requires. Twenty-eight routes
are ordinary reads that check `org.admin`, and they were being offered. Deriving it here rather than adding a
sixth tier keeps the table answering the question it was built for.

The nine capabilities are gone as a *consequence* rather than by a list — their routes left the grantable set,
so the closed world stopped requiring a home for them. Building any of them means deciding that agents may hold
organization-scoped authority: recursive intersection through the sponsor, a depth bound, root attribution, and
organization grants selectable at mint. That is a design, not a list entry.

### The test that makes a capability a promise

`test/agent-capabilities.test.ts` mints an agent with **exactly** what each capability declares and drives
every route in it. Nothing may answer with an authority refusal, and the routes with real fixtures behind them
must answer 200 — because §5C makes an invisible thing and an absent one answer alike, so a 404 on a
non-existent id hides an under-provisioned caller. That last part is what makes it decisive: understating
`mail.read`'s authority passed the weaker version.

Two more things the route-level model fixed on the way:

- **`GET /api/mailboxes` is the work queue**, listing mailboxes the caller holds `send.propose` on. It sat
  inside `mail.read`, so a read-only agent could open messages and received an empty catalogue with no way to
  discover the ids it could read. `GET /api/mailboxes/readable` answers the other question.
- **The mint form used that same rail**, so an administrator could only select mailboxes they personally send
  from, and always sent themselves as sponsor. It reads `GET /api/people/:userId/mailboxes` now — every
  mailbox with what the **named sponsor** holds on it, with the rest listed and unselectable rather than
  hidden. Requirements are evaluated per mailbox: `content.read` on one and `message.export` on another no
  longer reads as satisfying a capability that needs both together.

### What this is not

Not an AI capability. Whether the holder is a language model, a script or a colleague's cron job is outside
it. The `llm.*` nodes and the model control plane are a different and later thing, and conflating them is how
"agent-native" becomes a claim about intent.
