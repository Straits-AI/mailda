---
id: forward-fan-out
kind: measured-tripwire
measured_on: 2026-10-07
stale_when: >
  a healthy address needs to forward to more than 8 destinations; Cloudflare documents a limit on forward() calls
  per message or changes what one refusal does to the calls beside it; or a fan-out is measured slower than 4,344 ms
  or refused for a reason other than verification
values:
  forward.max_destinations: 8
---

## Question

How many destinations may one address forward to (ADR 47, amended 7 October 2026), when `email()` calls
`message.forward()` for every one of them, for every message, while the handler waits? And does one refused call
change what happens to the others?

Cloudflare's runtime reference documents no limit on `forward()` calls per message and shows several in one handler
(developers.cloudflare.com, Email Workers runtime API); its limits page lists 200 destination
addresses per account and nothing per message (developers.cloudflare.com, Email Routing limits). The 200 is a
platform limit and stays Cloudflare's; nothing here restates it.

## Method

A live drill on the zone `mailda.site`, approved by the owner for that zone only, 7 October 2026, cleaned up the same
day (the drill's rule, its Worker and the eight destinations it registered were deleted; the zone's routing and the
account's other destinations were left as they were). One throwaway Worker, `mailda-fanout-drill`, behind one literal
rule, read `message.raw` to the end and then called `forward()` for ten destinations at once (`Promise.all`), each
call timed and caught on its own, and logged one line to `wrangler tail`. The ten: eight plus-address aliases of the
owner's Gmail, registered by the drill and verified by the owner; the owner's own Gmail, already a verified
destination; and one alias never registered. One message, sent by the owner from Gmail, 6,010 bytes. The tail and the
drill's code were working files outside this repository and were not kept (they carry the owner's addresses); every
figure below was read from that tail.

## Results

**Eight calls handed over together.** Every verified destination's `forward()` resolved (with no result, as
`docs/receipts/email-worker-forward.md` found for one), in 807 to 4,342 ms each.

**A refusal is its own.** Two calls threw `destination address not verified` in 2 and 3 ms: the alias never
registered, and one alias whose link had not been clicked when the message arrived. The eight beside them resolved as
if they were not there. So each destination is settled on its own row, and one unverified destination never costs the
others their forward.

**The handler waited for the slowest.** The invocation's wall time was 4,344 ms, the slowest call's own, not the sum
(about 26 seconds in sequence); its CPU time was 3 ms. Waiting on `forward()` is wall time, which an email handler is
not billed CPU for, so the cost of more destinations is the wait, bounded by the slowest call. The slowest single
forward measured remains 8,799 ms (`docs/receipts/email-worker-forward.md`, a 24 MB message).

Not measured: more than ten calls, more than eight resolving, and what Gmail showed (copies of one Message-ID to
aliases of one inbox may be shown once, so arrivals were counted by the calls that resolved, not by the inbox).

## Sized

**`forward.max_destinations` = 8**, the most measured to be handed over for one message. The only real workload seen
forwards to 2 (whymelabs.com's Worker, eight addresses each to the same two inboxes), so 8 is four times that; an
address that needs more readers is a mailbox with members, not a longer list. Raising it means measuring more calls
resolving together, not reading this number as a ceiling Cloudflare set.

**Cost if wrong.** Too low, an administrator is refused by name (`E_BUDGET_EXCEEDED`, the budget, the limit and the
ask) and gives the rest a mailbox. Too high, a list longer than anything measured would be called on every message,
and a failure nobody had seen would arrive in production; each call is still recorded on its own row and shown, so it
would be visible, not silent.
