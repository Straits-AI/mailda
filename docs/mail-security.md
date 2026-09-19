# Mail security: what this Node establishes about a message, and what it does not

**The stance.** Mail security here is deterministic first. The receiving server already authenticates every
message. The operator writes the rules. A person or their own agent decides. A model, if one is ever
consulted, produces a *score a policy reads*, never authority and never a decision (ADR 9, ADR 10), and it
runs in the customer's own account or not at all. *"Not AI in the app; the app in your AI"* is the line, and
the MCP server, the Agent Skill and the SDK are where that happens.

## What is built

### The receiving server's verdict (0055, 17 September 2026)

Cloudflare's MX authenticates every inbound message and writes an `Authentication-Results` header (SPF,
DKIM, DMARC, ARC) before handing it to the Worker (receipt: `email-authentication-results.md`).
`src/authentication-results.ts` reads the header bearing the receiving MX's own authserv-id and **no other**.
RFC 8601 §7.1 says a header from an earlier hop, or one a sender wrote to claim `dmarc=pass`, is not the
receiver's verdict. `materialise.ts` stores the result on the message row as the row is created.

Three spellings, three states, and the distinction is the design:

| stored | means |
|:--|:--|
| `pass`, `fail`, `none`, … | RFC 8601's own words, as Cloudflare wrote them |
| `absent` | the header was looked for and the receiving server had not written one |
| `NULL` | this message was materialised before the Node evaluated authentication. The cron evaluates those a few a minute (`authentication-backfill.ts`), one evidence read each, until none is left |

A `none` for DMARC is most of the internet, since most From domains publish no policy, and the screen says
so plainly. The one red thing on the screen is a `fail` against a domain that asked receivers to `reject`.

Where it shows: the message's **sender** line in the reading pane; `auth_*` on every listed message in the
API; `dmarc`, `spf`, `dkim` as facts a Butler guard reads (`docs/butler-engine.md`); and the doctor's
`inbound_authentication`, which counts the week. None of the three chooses a recipient. The taint decision
(#52) stands.

### Quarantine on DMARC failure (0056, 17 September 2026)

The first thing the Node *does* with the verdict, and the narrowest honest thing. A mailbox has a switch,
off by default (`PATCH /api/mailboxes/:id {quarantineDmarcFail}`, the checkbox on the queue screen). With
it on, a delivery whose DMARC failed **and** whose From domain published `p=reject` or `p=quarantine` is
filed (the evidence is immutable and the `messages` row exists) but opens no case, sits in no queue and
appears in no listing until an administrator releases it. A `p=none` domain said "do nothing", and the Node
does nothing. That is the domain's decision, not this Node's to override.

The decision is made once, in `materialise.ts`, from the mailbox's switch at the moment the message is
filed. Turning the switch off later does not release what is already held. `GET /api/quarantine` lists held
deliveries (administrators; on the queue screen when the count says there are any) with the domain, the
policy and a reason token from the closed set `dmarc_fail_reject | dmarc_fail_quarantine`.
`POST /api/quarantine/:messageId/release` runs the same `caseForDelivery` materialise would have, so a
released message is exactly what an unquarantined one would have been, only later. There is no delete.
Nothing deletes mail on this Node. Every act is audited (`mailbox.quarantine_set`, `message.quarantined`,
`message.released`) and the doctor's `inbound_authentication` says how many are held.

Not a general policy engine, deliberately. The condition is fixed because it is the one condition whose
authority is the sender's own domain rather than this Node's guess. A policy that acted on `spf=softfail`
would be guessing. The row below is still open for the conditions that are not this one.

### Attachments, judged by name and by bytes (0057, 17 September 2026)

A policy, not a scanner. `src/attachments.ts` reads each attached part's name and first bytes from the same
parse the search index uses, and says one of five words. `executable`: the name says program (`.exe`,
`.dll`, `.jar`, `.lnk`, `.msi`…). `script`: `.js`, `.vbs`, `.ps1`, `.bat`…; text has no signature, so the
name decides. `disguised`: the bytes begin `MZ`, `\x7fELF` or a Mach-O magic and the name did not say
program, an `.exe` renamed `invoice.pdf`. `archive`: a `.zip`/`.rar`/`.7z`/gzip by name or signature,
Office documents excepted since they are ZIPs by construction. `plain`: none of the above. The magic numbers
are the formats' own, published, and `test/node/attachments.test.ts` pins each to the verdict it produces.

`messages.attachments` and `attachments_dangerous` are counted at filing (null before this Node looked, or
when the body could not be parsed). The body route lists every part with its verdict and none of its bytes.
Butler guards read both counts. The doctor's `inbound_authentication` counts the week's dangerous ones. A
mailbox's second switch, `quarantineDangerousAttachments`, holds back a delivery whose count is above zero,
the same mechanism as the DMARC switch, reason `attachment_dangerous`, released the same way. The sender's
domain speaks first: a disowned message carrying an executable is held for the DMARC reason.

The same judge reads outbound mail (0060). An attachment on an authored send is classified at the seal and a
dangerous one refuses the whole send, by name. A Node that would hold back a disguised program arriving does
not sign one leaving.

**Archives are listed, never extracted** (#267, 19 September 2026). A ZIP's central directory names every
entry, and `zipEntries` reads it from the end record back, so `invoice.zip` holding `Invoice.EXE` or
`run.ps1` is `archive_dangerous`, the sixth verdict, held and refused like the other three. Nothing is
inflated: a nested archive is a name in that list and stays closed, since what it holds is compressed data
and reading it would mean extracting. Names in a password-protected ZIP are still in the clear, so the
password hides nothing from this. What cannot be read whole (no end record in the last 64 KiB, a ZIP64
offset, a directory that runs off the end) is `archive`, the verdict that says nothing was looked at, rather
than a guess. RAR and 7z are still `archive` by name and signature only.

### Attachment limits a mailbox declares (0065, 19 September 2026)

Two settings on a mailbox, both empty by default: a size bound in bytes and a list of allowed extensions.
`PATCH /api/mailboxes/:id {attachmentMaxBytes, attachmentAllowedTypes}`, on the queue screen beside the
switches, administrator-only and audited (`mailbox.attachment_limits_set`). A delivery over the bound or
carrying a type off the list is held the way the switches hold: `attachment_too_large` or
`attachment_type_refused`, filed, no case, released the same way. The sender's domain speaks first and the
dangerous judge second, so a program under a document's name is held for what it is whatever its size. The
same judge (`overLimits`) runs at the seal: a send from the mailbox that breaks its own limits is refused by
name (`E_ATTACHMENT_OVER_MAILBOX_LIMIT`, `E_ATTACHMENT_TYPE_REFUSED`), read only when something is attached
so a plain send costs no extra query. Extensions rather than media types, because the name is what a person
reads and what the judge already goes by; a declared media type is the sender's claim.

### Links, judged against what they say (17 September 2026)

Nothing is rewritten (ADR 37). The href a reader clicks is the sender's, and a hover shows it. What a hover
cannot do is compare, and `src/render/links.ts` does, as the sanitiser passes each kept anchor. `mismatch`:
the text names a host (`https://acme.example/login`, `www.bank.test`) and the href goes to another
registrable domain. `lookalike`: the host resembles one of this organization's own domains, read from
`addresses`, and is not it, whether ours as a label or prefix, one edit away, or punycode. `userinfo`:
`https://ours@theirs`. `ip_host`. `plain`. `javascript:`, `data:` and every scheme but `http(s)` and
`mailto` were already refused at render and stay refused. The body route returns every link judged, and the
reading pane lists the flagged ones above the body with where each really goes. Bounded at 200 links a body.

The own-domain comparison has no public-suffix list behind it. The registrable domain is the last two labels,
three under `co.uk`-shaped suffixes, and the edit distance is one, so `rn` for `m` is a link the reader
judges. Render-time only: no count is stored, so no Butler guard or quarantine reads it yet.

### Suppression, derived from the provider's own word (0058, 17 September 2026)

There is no suppressions table. `send_recipient_events` already keeps every `email.sending` event verbatim,
and `src/suppression.ts` reads the list from it. An address whose most recent word was a **hard** bounce
(`payload.bounce.type = "hard"`) or a complaint is suppressed. A soft bounce is retries exhausted on an
address that exists, and is not. `sealManifest` asks once per composition and refuses the whole send with
`E_RECIPIENT_SUPPRESSED`, naming each address, the cause, the provider's words and when, before anything is
persisted. Not a silent drop. A send with a recipient quietly removed is a different message from the one
the author sealed.

The one write is the exception. `POST /api/suppressions/lift {address, reason}` is an administrator vouching
for an address, audited (`suppression.lifted`), and the derivation honours it only for events **before** the
lift. A bounce after somebody vouched suppresses again. `GET /api/suppressions` lists the list; the Limits
screen shows it beside the domain pauses. Whether Cloudflare's own `drop_suppressed_recipients` keeps the
same list is still unmeasured, which is why this Node keeps its own and says so at the seal.

### A policy on the verdict, at the reply (0063, 19 September 2026)

The send policy's sixth condition, `reply_to_dmarc_fail` (#260). A forged invoice arrives, somebody
answers it, and the answer carries what the forger asked for: the compromise is the reply, so that is where
the verdict is read. A published policy naming the condition matches a reply whose parent's stored
`auth_dmarc` is `fail`, and only `fail`. `none`, `absent` and a verdict not yet evaluated are not failures
this Node saw, and are not guessed to be. The outcomes are §18's four, so an organization can hold, require
approval for, or refuse replies to disowned mail. One indexed read of the parent row, made only when a
published policy constrains the condition, the same cost rule as `recipient_external`.

Still not a general verdict policy: an inbound message is filed by the quarantine switch above or not at
all, and `spf=softfail` still has no authority behind it.

### Held on request: the act a customer's own classifier reaches (0064, 19 September 2026)

The Node keeps no classifier, and the line at the top says where one goes: in the customer's own account,
scoring what a policy reads. What was missing was the act. `POST /api/quarantine/:messageId/hold
{reason, score?}` holds a filed delivery back from its queue the way the two switches do, with the reason
in words and the model's score on the audit entry (`message.held`). It is bounded by `mailbox.content.read`
on the mailbox, like a label, and it is offered to machines as `act` (#263): an agent minted for the
mailbox can read the page, score it against whatever it knows, and hold what it distrusts. A held message
is hidden by id, so nothing overwrites the first reason. The administrator sees the reason on the queue
screen beside the switches' rows and releases it with the same button, which is the person's answer to
the model, and the answer the next model reads.

`examples/hold-agent/` is a reference: nearest-neighbour over `bge-small` embeddings against this Node's
own released and held messages, through the SDK. A shape, not a receipt. Precision and recall are numbers
the customer's corpus produces, and nothing ships in the Node before it has them.

## What is not built, in the order it should be

1. **The rest of the verdict policy.** Inbound acts beyond the quarantine switch, and conditions with an
   authority behind them other than the sender's own domain, when one exists.
2. **Attachments, the rest.** Executables, scripts, disguises and ZIP listings are judged, and a mailbox can
   bound size and type. Still open: RAR and 7z listings, and a nested archive's contents, which cannot be
   read without extracting and will not be.
3. **Links, the rest of the row.** Judged at render above. Still open: a stored count a guard or a
   quarantine switch can act on, and a suffix list if a customer's own domain is misjudged.
4. **Suppression, the measurement.** Built above. Still open: whether Cloudflare's
   `drop_suppressed_recipients` keeps the same list, which needs a bounced address and a send with the
   option on. A receipt, not code.
5. **A classifier, measured and not shipped.** The seam exists now (held on request, above); the model
   does not. `docs/receipts/workers-ai-classifier.md`, 17 September:
   Workers AI lists two text-classification models, a sentiment model and a reranker, and the sentiment
   model scores "you have won a prize" as the most positive text tried. There is no lightweight edge
   classifier for this job on the platform today. What would work is nearest-neighbour over embeddings
   (`bge-small`, 384 dims, ~220 ms over REST) against **this Node's own decisions**, held, released and
   labelled, which is a signal whose authority is the Node's and which needs a corpus the Node has only
   begun to record. Re-measure when there is one. Nothing ships before precision and recall are numbers.
