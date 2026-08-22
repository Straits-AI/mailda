# The API contract

How the routes this Node serves are described once, and what holds the description to the handler.

## What ADR 12 locks, and what was actually true

> **UI, CLI, SDK, Skill and MCP parity is generated from shared contracts.**

Two of the five surfaces existed and neither was generated from anything. `packages/contract` held one
command's schemas — `send-mail.ts` — while the Node served seventy-one distinct paths. It also declared
`"main": "./src/index.ts"` and had **no `index.ts`**, and no file in the repository imported the package at
all. A package with no importers has no way to be wrong, which is the whole problem with the shape.

## The registry, and why it came before schemas

`packages/contract/src/routes.ts` describes every route: method, path template, and a one-line summary in the
words a generated client would carry as a doc comment.

It is deliberately **not** request and response schemas yet. Those are worth having only once the set of
routes is pinned — a schema for a route that has quietly moved is a schema for nothing. And the property ADR
12 is actually about is not the count of surfaces; it is *generated from shared contracts*, the thing that
stops clients drifting from one Node. Writing an SDK by hand would add a sixth thing to keep in step and
satisfy the letter of the decision while defeating it.

## The chain, and what holds each link

| link | held by | failure if it breaks |
|:--|:--|:--|
| client → registry | `PathFor<M>` — the template is typed per method | **compile error** |
| registry → handler, paths | `test/node/route-registry.test.ts` | test failure, both directions |
| registry → handler, methods | the same file | test failure, both directions |

`ROUTES` is `as const satisfies readonly RouteSpec[]`, and that is the enforcement rather than a style
choice: a `readonly RouteSpec[]` annotation widens every `path` to `string`, which makes a wrong route a
runtime throw found when a test happens to exercise that call. Keeping the literals lets `route()` accept
only templates that appear in the array, so a client naming a route this Node does not serve — or the right
path under the wrong verb — stops the build.

The registry is checked against `src/index.ts` **lexically**, because that file is a Worker module and cannot
be imported under Node. The extraction reads the only two shapes this Worker uses to decide a route: a string
compared to `url.pathname`, and a regex literal handed `.exec(url.pathname)`. A route dispatched some third
way would be invisible — stated rather than hidden, and survivable because it fails as *absence*, which the
anti-vacuity floor catches.

Both directions matter and they catch different mistakes. A path the Worker serves and the registry omits is
a route no generated surface will ever expose. A path in the registry the Worker does not serve is worse: a
generated client would call it and get a 404 that reads as a missing resource rather than a wrong request.

## What the exercise found

**A live defect, and it had shipped.** `src/client/app/api.ts` sent `PUT /api/policies/:id/draft`; the
handler answered only `POST`. So **editing a policy draft from the interface returned 404 `not_found`** — on
a governance surface, for as long as the route existed. Confirmed against a running Node before it was
fixed: PUT 404, POST 200; and after: PUT 200, POST 404.

Nothing caught it because `test/policy-routes.test.ts` built every request with one helper that hard-coded
`method: "POST"`. **A helper that fixes the method cannot detect a method divergence**, and fourteen green
tests sat over the defect. The helper now takes the verb.

Fixed as **PUT** rather than by teaching the client POST, on two grounds: `/api/butlers/:id/draft` — the same
act one layer along — is already PUT, so POST here left the Node holding two verbs for one operation; and
replacing a draft wholesale is what PUT means. Nothing that worked broke, because nothing worked.

**Five routes have no method guard.** `/health`, `/api/doctor`, `/api/me`, `/index.html` and
`/.well-known/jwks.json` test only `url.pathname`, so `DELETE /health` is served exactly as `GET /health` is.
All five are read-only, so nothing is destroyed — but a generated client would state a method this Node does
not check. Rather than change five handlers as a side effect of writing a registry, the set is **named** in
`METHOD_UNCHECKED` and asserted exactly, so a sixth is a decision somebody makes on purpose.

## The two named routes, and why they are the exception

Every caller writes its template inline: the string *is* the lookup key, and naming eighty-odd routes would
be a second vocabulary to keep in step. `EXPORTS_LIST` and `EXPORT_RUN` are named because
`matter-and-scope-world.test.ts` scans the Worker's source for the literal `/exports/` — guarding the R2 key
`${orgId}/exports/${exportId}/`, which three spellings would let the reconciler scan a prefix nothing writes
and report clean. An HTTP path is a different thing and a lexical guard cannot tell them apart. The client
already carried the right answer in a comment: *stop needing the exception, not widen the guard.* So the one
spelling moved into the registry, which is the file whose job is to hold each route exactly once.

## Step 2: schemas, and why they are partial on purpose

`packages/contract/src/schemas.ts` describes what travels over the routes, and `RouteSpec` gained optional
`request` and `response` fields to carry them. **Every describable route is described — 90 of 90** — and the
test asserts equality rather than a floor, so a route added without a schema fails. That number is
exported by `schemaCoverage()` and asserted, so it is something a reader watches move rather than an
impression.

The denominator is 90 rather than 94 because **four** routes cannot carry a JSON response schema and are
named in `NOT_JSON`: `/index.html` is the interface shell, `/api/messages/:receiptId/raw` and
`/api/sends/:sendId/submitted` are the stored and submitted bytes, and an export object is whatever was
exported. A target that counts routes no schema can describe is one nobody can reach.

The fourth joined late and only by being driven: `submitted` was assumed to answer JSON and answers the
submitted message itself. Which is the only answer that could be right — the point of storing the bytes is
that they *are* the bytes, and a JSON envelope would make the record a description of the message rather
than the message.

The partialness is the honest part. A file of ninety-four hand-written shapes that nothing compares against a
real response would be ninety-four guesses wearing the clothes of a contract — and **worse than none**,
because a generated client would trust it. So schemas arrive with their validation, one tranche at a time:
`apps/node/worker/test/contract-responses.test.ts` drives every schema-bearing route against a real Node and
parses the answer, so a schema that does not describe reality fails rather than misleads.

### `.strict()` on responses, and it is doing security work in two places

A lenient response schema would pass over a route that had grown a field the contract does not mention, which
is the drift ADR 12 exists to stop arriving through the door marked "compatible". Two of these turn that from
tidiness into a property:

- **`GET /api/transport`** reads a credential and must never return it. The schema has no field for a token,
  so a route that grew one fails.
- **`GET /api/auth/passkeys`** must never return a public key. Same shape, same reason.

Requests are deliberately **not** strict: a caller sending a field this Node ignores is harmless, and
refusing it would break every client written against a later version.

### One schema states a property two routes have to share

`POST /api/auth/login` and `POST /api/auth/passkeys/verify` both carry `signedInResponse`. ADR 29 makes
passkeys primary and passwords the fallback, and #84's rule is that nothing downstream learns which one
signed you in — so giving the two routes different shapes would be the first place that broke. The schema is
where it is stated; `contract-responses.test.ts` parses a real passkey assertion's answer with it.

### What it found

**`usr` was not in `ID_PREFIXES`.** `claim.ts` and `invitations.ts` have minted `ctx.id("usr")` since the
first layer, and nothing had ever needed to *validate* a user id — so the prefix lived only as a literal.
Writing the pattern by hand was not an option: `id-prefix-world.test.ts` forbids it outright, because that is
exactly how `case_` and `cas_` came to disagree. Registering it then made that tripwire fire on the two mint
sites, which now go through the registry. The gap and its closure were both the mechanism working.

## What the nine tranches found

Every one turned something up, which is the argument for doing this at all rather than trusting the shapes.

| found | where |
|:--|:--|
| `PUT /api/policies/:id/draft` returned 404 — **the UI could never save a policy** | step 1 |
| the route tests hard-coded `method: "POST"`, so no test *could* catch a verb divergence | step 1 |
| `packages/contract` had no `index.ts` and nothing imported it | step 1 |
| five routes have no method guard at all | step 1 |
| `/health` has never returned `ok` | tranche 2 |
| `BreakerReading` omits `retryAfterSeconds` and `retryAfterExact` | tranche 2 |
| `TeamRow` omits `createdBy` | tranche 3 |
| `usr` was not in `ID_PREFIXES`, and registering it made the id-prefix tripwire fire on both mint sites | step 2 |
| `POST /api/prepare` is the migration endpoint, not what its name says | tranche 9 |
| `butlerRunRow` was missing `state_at` — a **third** client omission, hidden because an earlier tranche asserted the list was empty | tranche 11 |
| `GET /api/messages/:id/body` takes an **`ir_` receipt id**, not a `msg_` message id | tranche 12 |
| `GET /api/sends/:id/submitted` does not answer JSON at all | tranche 13 |

Several shapes are recorded specifically so that somebody tidying up does not break them: a `200` carrying an
`error` field on sign-out (one shape for "you are not signed in", however you got there); a seal answering at
the top level (the response *is* the envelope); `alreadyHeld` on a grant; `replayed` on a refresh;
`stillVerifiesForSeconds` on a rotation; `tooFreshToJudge` separate from `stranded`.

## Reaching every route took fixtures the product's own rules dictated

Nothing here was seeded past a refusal. Where a route could not be reached, the reason was a rule, and the
fixture was built to satisfy it rather than around it:

- **Dual control.** Four routes refuse on a one-admin Node, so the contract tests grew a second and third
  administrator. That is what made `approvalRow` checkable at all.
- **The three-term ceiling.** A Butler run needed the Butler's own tuple, the sponsor's, a declared
  capability, *and* a lowercase address — a ULID is uppercase and a ceiling lowercases what it declares, so
  it refused `capability_not_declared` until that was fixed.
- **A stub transport.** `submitted` and `retry` need a send that was actually attempted. `dispatchDue` takes
  the adapter as a parameter precisely so a test can decide what the world answers, and the stub **refuses**
  — because `retry-effect` is offered only where non-acceptance is recorded, so a stub that accepted would
  produce a send with nothing to retry.

## What comes next

Step 3: the SDK, Agent Skill and MCP server — each **generated** rather than written. That was blocked on
this being complete, and it no longer is.
