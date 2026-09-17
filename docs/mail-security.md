# Mail security: what this Node establishes about a message, and what it does not

**The stance.** Mail security here is deterministic first. The receiving server already authenticates every
message; the operator writes the rules; a person or their own agent decides. A model, if one is ever
consulted, produces a *score a policy reads* — never authority, never a decision (ADR 9, ADR 10) — and it
runs in the customer's own account or not at all. *"Not AI in the app; the app in your AI"* is the line, and
the MCP server, the Agent Skill and the SDK are where that happens.

## What is built

### The receiving server's verdict (0055, 17 September 2026)

Cloudflare's MX authenticates every inbound message and writes an `Authentication-Results` header —
SPF, DKIM, DMARC, ARC — before handing it to the Worker (receipt: `email-authentication-results.md`).
`src/authentication-results.ts` reads the header bearing the receiving MX's own authserv-id and **no other**:
RFC 8601 §7.1 says a header from an earlier hop, or one a sender wrote to claim `dmarc=pass`, is not the
receiver's verdict. `materialise.ts` stores the result on the message row as the row is created.

Three spellings, three states, and the distinction is the design:

| stored | means |
|:--|:--|
| `pass`, `fail`, `none`, … | RFC 8601's own words, as Cloudflare wrote them |
| `absent` | the header was looked for and the receiving server had not written one |
| `NULL` | this message was materialised before the Node evaluated authentication — and the cron evaluates those a few a minute (`authentication-backfill.ts`), one evidence read each, until none is left |

A `none` for DMARC is most of the internet — the From domain publishes no policy — and is said plainly, so
the one red thing on the screen is a `fail` against a domain that asked receivers to `reject`.

Where it shows: the message's **sender** line in the reading pane; `auth_*` on every listed message in the
API; `dmarc`, `spf`, `dkim` as facts a Butler guard reads (`docs/butler-engine.md`); and the doctor's
`inbound_authentication`, which counts the week. None of the three chooses a recipient — the taint decision
(#52) stands.

## What is not built, in the order it should be

1. **A policy that acts on the verdict.** `dmarc == "fail"` as a condition in the closed set Layer 5 has;
   the outcomes are the ones §18 names. Today a Butler guard can route on the fact; a policy cannot yet.
2. **Attachments.** A policy, not a scanner: allowed types, size, executables and archives-in-archives —
   by extension *and* magic bytes, since one lies.
3. **Links.** Nothing is rewritten (ADR 37); the real destination is shown, lookalikes against the
   customer's own domain are flagged, `javascript:` and `data:` are refused at render.
4. **Suppression.** The `email.sending` events already carry bounces and complaints; a list derived from
   them, consulted at seal time, is `send-breakers.md` one step further. Whether Cloudflare's
   `drop_suppressed_recipients` is the same list is unmeasured.
5. **A classifier.** The one row a model helps with, and the lightweight-edge case: Workers AI text
   classification in the customer's own account, milliseconds a message, no data leaving. Ships as an
   explicit policy signal, receipted for cost and false-positive rate, off by default, never authority.
