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

## What comes next

1. Request and response schemas per route, in the shape `send-mail.ts` already uses.
2. The SDK, Agent Skill and MCP server — each **generated** rather than written, which is only possible once
   1 exists. Doing them first is how five clients drift.
