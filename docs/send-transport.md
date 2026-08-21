# The send transport

Which API carries a Node's mail, what each can and cannot do, and where the credential lives.

## ADR 33, and what was actually wired

> **The transport offers both send APIs, and every send records which one carried it.**

The recording half was built and correct — `recheck.ts` puts `adapter` on the sealed envelope beside
`canSend`, `arbitraryRecipients` and `verifiedAt`. One adapter was wired, so a question the envelope was
designed to answer had one answer for every send ever made.

## Two adapters, and they are not interchangeable

| | `cloudflare-email-sending` | `cloudflare-email-rest` |
|:--|:--|:--|
| reached by | the `send_email` binding | `POST /accounts/{id}/email/sending/send` |
| credential | **none** | an API token with `Email Sending: Edit` |
| `authored` fidelity | yes — raw RFC 5322 | **no** — structured JSON only |
| per-recipient outcome | none | `delivered` / `permanent_bounces` / `queued` |
| failure detail | a thrown message, classified by text | documented codes (`10105`, `10203`) |

**The binding is preferred wherever it exists**, and that is a decision with two reasons rather than an
ordering. It holds no credential, so a Node using it has nothing that can leak and nothing to rotate; and it
is the only adapter that can carry `authored` fidelity, which customer mail uses because the record must
prove the exact bytes.

So the REST adapter answers one question: *what does a Node do when it has no binding?* Before #86 the
answer was "nothing, permanently" — the binding arrives by editing `wrangler.jsonc` and redeploying, which a
Node whose operator cannot redeploy it cannot do.

When neither is available the binding is still returned, deliberately. Its refusal names the `send_email`
binding an operator should install; the REST adapter's would name a token, which is the second-best answer.
The most useful refusal wins.

## Two of the ticket's three arguments did not survive, and that shaped the adapter

#86 argued the REST endpoint takes structured recipients in one request where the binding takes one per
call — fifty recipients being fifty subrequests. Both halves are already answered in this tree, against it:

- `dispatch.ts` submits **once per recipient on purpose**, because migration 0013 makes the *delivery* the
  unit. That is what makes a correct Bcc possible, what lets a retry reach only the recipients that never
  left, and what gives each delivery its own recorded outcome. Batching would collapse all of it into one
  verdict for the group.
- and it would save nothing: *"measured before choosing: one structured send to three recipients moved
  Cloudflare's own count from 0 to 3, so submitting N times costs nothing extra."*

**So this adapter does not batch.** What is left is narrower than the ticket claimed and still worth having:
a Node with no binding can send; a permanent bounce known at submission becomes `suppressed` rather than an
optimistic `handed_over`; and `adapter` on the envelope becomes informative.

## Where the credential lives, and why it is not a Secrets Store binding

This is the first credential authorizing an external effect this Node has ever held, so it is the first real
test of ADR 22 — *"every credential that authorizes an external effect is a **Secrets Store** binding"* — and
the rule as written does not survive ADR 24. `wrangler.jsonc` already records why: a `secrets_store_secrets`
block needs an account-specific `store_id` in committed config, which is exactly the byte-identical-fork
collision ADR 24 forbids, and measurement showed removing the id drops the binding **silently** rather than
relinking the way D1 and R2 do.

ADR 28 settled this for the encryption keys and its reasoning transfers whole: what ADR 22 was buying is that
*serializing `env` discloses nothing*, and that survives when the secret arrives over RPC and through a
decrypt at the point of use. So the token is wrapped under the **credential KEK** and stored in
`sending_transport`. `src/auth/kek.ts` needed no change to accept it — its own header names *"transport
credentials"* as what that key protects, so the seam was built for this and had never held one.

It is read with `await unwrapCredential(...)` per submission and **not cached**: a cached transport token is
a secret with a lifetime beyond the call that needed it, which is the property ADR 22 exists to prevent, and
the saving would be one indexed read of a one-row table.

**No route returns it.** `GET /api/transport` reports *that* a token is configured, for which account, and
when — the whole question an operator has. A route that could hand it back would make every administrator a
holder of the account's sending authority.

## Why the surface is the interface and not the CLI

`mailda set-password` is a script because a password hash needs no vault. This cannot be: wrapping needs the
KeyVault Durable Object, which only the Worker can reach, so **a credential this Node encrypts can only be
supplied through this Node.**

The form is on the **doctor** screen, beside the `transport_adapters` finding it answers. That is the one
place in the interface where a report and its remedy sit together, and the reason is that this remedy has
nowhere else to be — `limits` is deliberately not configurable, and a settings screen an operator has to go
looking for is worse than the page they already open when a Node will not send.

## Which outcome a failure becomes, and why the direction matters

The four `SubmitOutcome` kinds are not interchangeable. `refused` claims the message provably never left and
is safe to retry once the cause is fixed; `outcome_unknown` claims the opposite, and ADR 40 forbids retrying
one automatically because Cloudflare offers no idempotency key to deduplicate against.

| answer | outcome | because |
|:--|:--|:--|
| `10105 not_entitled`, `10203 sending_disabled` | `refused` | the API rejected it; nothing was submitted |
| `401` / `403` | `refused` | the token is wrong, and the message says which permission it needs |
| `429` | `throttled` | provably never left — the one failure safe to retry automatically |
| any other `4xx` | `refused` | rejected at the boundary |
| `5xx`, or a request that never completed | `outcome_unknown` | Cloudflare may have accepted it and failed to answer |

`success: false` on a `200` is a failure. Reading only the HTTP status would report a refusal as a
hand-over, which is the one direction that loses mail silently.

## What this does not fix

**ADR 34.** A REST call surfaces `10105 not_entitled` on a real send, which is a genuine signal about
entitlement — but only after committing a message. It still cannot answer *"can this Node send"* before a
person composes, which is what §14 requires. `verifiedAt` stays `null` for both adapters, and the honest
sentence is in `detail` rather than in a boolean.
