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

### Quarantine on DMARC failure (0056, 17 September 2026)

The first thing the Node *does* with the verdict, and the narrowest honest thing. A mailbox has a switch,
off by default (`PATCH /api/mailboxes/:id {quarantineDmarcFail}`, the checkbox on the queue screen). With
it on, a delivery whose DMARC failed **and** whose From domain published `p=reject` or `p=quarantine` is
filed — the evidence is immutable and the `messages` row exists — but opens no case, sits in no queue and
appears in no listing until an administrator releases it. A `p=none` domain said "do nothing", and the Node
does nothing: that is the domain's decision, not this Node's to override.

The decision is made once, in `materialise.ts`, from the mailbox's switch at the moment the message is
filed; turning the switch off later does not release what is already held. Held deliveries are listed at
`GET /api/quarantine` (administrators; on the queue screen when the count says there are any) with the
domain, the policy and a reason token from the closed set `dmarc_fail_reject | dmarc_fail_quarantine`.
`POST /api/quarantine/:messageId/release` runs the same `caseForDelivery` materialise would have, so a
released message is exactly what an unquarantined one would have been, only later. There is no delete;
nothing deletes mail on this Node. Every act is audited (`mailbox.quarantine_set`, `message.quarantined`,
`message.released`) and the doctor's `inbound_authentication` says how many are held.

Not a general policy engine, deliberately. The condition is fixed because it is the one condition whose
authority is the sender's own domain rather than this Node's guess; a policy that acted on `spf=softfail`
would be guessing. The row below is still open for the conditions that are not this one.

### Attachments, judged by name and by bytes (0057, 17 September 2026)

A policy, not a scanner. `src/attachments.ts` reads each attached part's name and first bytes from the same
parse the search index uses, and says one of five words: `executable` (the name says program — `.exe`,
`.dll`, `.jar`, `.lnk`, `.msi`…), `script` (`.js`, `.vbs`, `.ps1`, `.bat`…; text has no signature, so the
name decides), `disguised` (the bytes begin `MZ`, `\x7fELF` or a Mach-O magic and the name did not say
program — an `.exe` renamed `invoice.pdf`), `archive` (a `.zip`/`.rar`/`.7z`/gzip by name or signature,
Office documents excepted since they are ZIPs by construction), `plain`. The magic numbers are the formats'
own, published, and `test/node/attachments.test.ts` pins each to the verdict it produces.

`messages.attachments` and `attachments_dangerous` are counted at filing (null before this Node looked, or
when the body could not be parsed); the body route lists every part with its verdict and none of its bytes;
Butler guards read both counts; the doctor's `inbound_authentication` counts the week's dangerous ones.
A mailbox's second switch, `quarantineDangerousAttachments`, holds back a delivery whose count is above
zero — the same mechanism as the DMARC switch, reason `attachment_dangerous`, released the same way. The
sender's domain speaks first: a disowned message carrying an executable is held for the DMARC reason.

Archives are named and never opened. Whether a `.zip` holds an executable is not looked at, and the verdict
says `archive` rather than pretending it has — the *archives-in-archives* case is the part of row 2 still open.

### Links, judged against what they say (17 September 2026)

Nothing is rewritten (ADR 37): the href a reader clicks is the sender's, and a hover shows it. What a hover
cannot do is compare, and `src/render/links.ts` does, as the sanitiser passes each kept anchor: `mismatch`
(the text names a host — `https://acme.example/login`, `www.bank.test` — and the href goes to another
registrable domain), `lookalike` (the host resembles one of this organization's own domains, read from
`addresses`, and is not it: ours as a label or prefix, one edit away, or punycode), `userinfo`
(`https://ours@theirs`), `ip_host`, `plain`. `javascript:`, `data:` and every scheme but `http(s)` and
`mailto` were already refused at render and stay refused. The body route returns every link judged, and the
reading pane lists the flagged ones above the body with where each really goes. Bounded at 200 links a body.

The own-domain comparison has no public-suffix list behind it — the registrable domain is the last two
labels, three under `co.uk`-shaped suffixes — and the edit distance is one, so `rn` for `m` is a link the
reader judges. Render-time only: no count is stored, so no Butler guard or quarantine reads it yet.

## What is not built, in the order it should be

1. **A policy that acts on the verdict.** Quarantine above is the fixed case. `dmarc == "fail"` as a
   condition in the closed set Layer 5 has, with the outcomes §18 names, is the general one, and it is still
   open. Today a Butler guard can route on the fact; a policy cannot yet.
2. **Attachments, the rest of the row.** Executables, scripts and disguises are judged above. Still open:
   a size bound, an allowed-type list a mailbox declares, and archives-in-archives — walking a ZIP's central
   directory to judge what it holds, without extracting it.
3. **Links, the rest of the row.** Judged at render above. Still open: a stored count a guard or a
   quarantine switch can act on, and a suffix list if a customer's own domain is misjudged.
4. **Suppression.** The `email.sending` events already carry bounces and complaints; a list derived from
   them, consulted at seal time, is `send-breakers.md` one step further. Whether Cloudflare's
   `drop_suppressed_recipients` is the same list is unmeasured.
5. **A classifier.** The one row a model helps with, and the lightweight-edge case: Workers AI text
   classification in the customer's own account, milliseconds a message, no data leaving. Ships as an
   explicit policy signal, receipted for cost and false-positive rate, off by default, never authority.
