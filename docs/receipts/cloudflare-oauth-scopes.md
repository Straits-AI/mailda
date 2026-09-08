---
id: cloudflare-oauth-scopes
kind: platform-limit
measured_on: 2026-09-08
stale_when: >
  Cloudflare's OAuth scope vocabulary stops being <group>:<verb>; a read-only scope appears for D1, Queues,
  Email Routing or Email Sending, which would let this Node ask for less than it does; wrangler stops being
  an OAuth client, since its bundle is where these strings were read; GET /client/v4/oauth/scopes becomes
  reachable without a token, which would make it the source instead; or a scope this Node requests is
  refused, since Cloudflare names any it will not grant
values:
  oauth.scope_shape_is_group_colon_verb: 1
  oauth.read_only_scope_exists_for_d1: 0
  oauth.read_only_scope_exists_for_queues: 0
  oauth.read_only_scope_exists_for_email: 0
---

# The scope vocabulary, and where it was finally read from

## Why this file exists, which is a process failure rather than a discovery

`cloudflare-grant.ts` shipped a list of **capabilities in prose and no scope strings**, on this argument:

> Cloudflare's scope names correspond to API-token permission names and are enumerated from
> `GET /client/v4/oauth/scopes`, which needs a token — and the only scope strings this repository has *seen*
> are the two in Cloudflare's own documentation example. Writing a list of eight or ten plausible names
> beside those would be a fabrication.

The refusal to invent names was right. The conclusion drawn from it was not: the Node **must** enumerate
scopes, so "we do not know them" was not a position it could ship from. Two consents against a real client
proved it, one round trip each:

1. Appending `offline_access` → `invalid_scope`. A client may request only what it was registered with.
2. Omitting `scope` entirely → *"0 total permissions"*, `Authorize` disabled. A client's registered scopes
   are a **ceiling on what it may request, not a default for what it does**.

Both are recorded in `cloudflare-oauth-endpoints.md`. What is recorded *here* is that neither was necessary to
learn that way. The documentation index at `developers.cloudflare.com/fundamentals/llms.txt` lists four OAuth
pages; one guessed URL 404'd early on and the search was abandoned in favour of inference from the discovery
document. **Three wrong readings of that document followed, and every one cost a live consent.** The
vocabulary was on this machine the whole time.

## Where the strings come from

`wrangler` is itself a Cloudflare OAuth client, and its bundle carries the vocabulary:

```text
$ grep -oE '"[a-z0-9_]+:(read|write|admin|run)"' node_modules/.../wrangler-dist/cli.js | sort -u | wc -l
76
```

The shape is **`<group>:<verb>`** — not the dotted `workers-platform.read` of Cloudflare's documentation
example, which appears nowhere in the vocabulary actually in use. `wrangler whoami` prints the same set as
`group (verb)`, which is how the format was first noticed.

What this Node asks for, and why each:

| scope | for | read-only form? |
|:--|:--|:--|
| `account:read` | the plan (ADR 25 needs Paid) and membership | yes |
| `zone:read` | which zone carries mail; name collisions | yes |
| `workers:read` | the inventory a deployment plan is diffed against | yes |
| `d1:write` | the catalog | **no** |
| `queues:write` | the delivery-events queue and its consumer | **no** |
| `email_routing:write` | receiving; L2's MX and routing diffs | **no** |
| `email_sending:write` | sending | **no** |

## Four of them have no read-only form, and that costs this design something

L1's whole point was that it **reads**. The capability list it replaced said so:

> `layer` is not decoration. L1 needs to *read*; provisioning authority belongs to the layer that provisions,
> and an operator asked for write access to their whole Workers platform in order to display an inventory
> would be right to refuse.

That argument stands, and Cloudflare does not permit it. There is no `d1:read`, `queues:read`,
`email_routing:read` or `email_sending:read` in the vocabulary — only `:write`. So an inventory of the
catalog, the queue or the mail routing costs write authority over them, at L1, for a layer that provisions
nothing.

Recorded as the provider's shape rather than smoothed over, because the consent screen shows an operator four
write permissions and the honest answer to *"why does a read-only layer need these"* is that there was no
narrower choice. `REQUIRED_SCOPES` carries `readOnlyExists` per entry so that stays legible, and a test
asserts every `:write` entry says which read scope does not exist.

## What is not established

**That these are the exact scopes a third-party client may request.** They are what a **first-party** client
(wrangler) requests. `GET /client/v4/oauth/scopes` is the authority and needs a token this Node does not have
— so the shape is measured and the *set* is inferred. Cloudflare names any scope it refuses, which makes the
failure loud and cheap: `/api/provider/authorize` accepts an override so an operator whose account offers a
different set can proceed without waiting for a release.

**Whether `workers:read` covers D1, R2, Queues and Workflows provisioning.** Auto-provisioning happens
through the deploy, and which scope authorises it is untested. There is no `r2:*` in the vocabulary at all —
only `r2_catalog:write` — which suggests buckets are reached through `workers:write`, unverified.

**Whether `offline_access` is reachable any other way.** A client cannot request it; the refresh token is
expected from the `refresh_token` grant type instead. That expectation is untested until a consent completes.
