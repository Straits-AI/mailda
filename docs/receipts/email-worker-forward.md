---
id: email-worker-forward
kind: platform-limit
measured_on: 2026-10-02
stale_when: >
  Cloudflare documents or changes what forward() does to a destination that is not verified, what the sender sees
  when a Worker catches its failure, or which headers its headers argument keeps; forward() starts returning a
  messageId; a second forward() of one message to one destination starts delivering twice; the Email Routing API
  starts creating a forward rule to an unverified destination; or a kept forward is measured on a message larger
  than 24,400,483 bytes, or slower than 8,799 ms
values:
  forward.after_raw_read_works: 1
  forward.largest_measured_bytes: 24400483
  forward.slowest_call_ms_observed: 8799
  forward.keeps_original_from_body_and_message_id: 1
  forward.result_carries_message_id: 0
  forward.unverified_destination_throws: 1
  forward.caught_failure_reaches_sender: 0
  forward.same_destination_twice_delivers_twice: 0
  forward.throw_after_forward_reinvokes: 0
  forward.non_x_headers_kept: 0
  forward.reject_text_reaches_sender: 1
  routing.forward_rule_to_unverified_creatable: 0
---

## Question

Can a Node that took over an Email Routing forward rule keep the rule's destination receiving, by calling
`message.forward()` from its own Worker after storing the message? And when that call fails, who learns? (ADR 47.)

## Method

A live drill on the zone `mailda.site`, approved by the owner for that zone only, 2 October 2026, cleaned up the
same day (every drill rule, the drill Worker and the one destination the drill added were deleted; the zone's
routing, DNS and other destinations were left exactly as before). One throwaway Worker,
`mailda-forward-drill`, behind one literal rule per case, each case logging one structured line per step to
Workers Logs and a `wrangler tail`. The raw tail and the drill's plan were working files outside this repository
and were not kept with it (they carry the owner's message ids and inboxes); every figure below was read from that
tail, and the drill can be repeated from the cases this section and the results name. Senders: the owner's Gmail, by hand, an outside MTA. Two
verified Gmail destinations the owner reads; one destination the drill registered and left unverified. The rules
and destinations were written with the operator's wrangler login.

## Results

**forward() works after `message.raw` has been read to the end.** The case that read the whole stream, hashed it
and then called `forward()` delivered, the same as the control that never touched `raw`. `canBeForwarded` was
`true` before and after the read. This is the order a Node needs: store first (which reads `raw`), then forward.

**Up to 24,400,483 bytes.** The largest message sent (a 17 MiB random attachment, 24,400,483 bytes raw) was read in
655 ms and forwarded; the `forward()` call took 8,799 ms, the slowest measured. Small messages took 630 to 5,452 ms.
These are observations of single calls, not a distribution: nothing here sizes a timeout.

**The copy is the original.** At the destination: the original `From`, body and `Message-ID`; the sender's DKIM
signature's `bh` unchanged, `dkim=pass` for gmail.com, DMARC pass. Cloudflare adds an SRS envelope sender
(`SRS0=…@mailda.site`), its DKIM for the zone and for `cloudflare-email.net`, an ARC set (`i=2`) and
`X-Forwarded-To`. `forward()` resolved with no result (`null`), though the documentation types an
`EmailSendResult` carrying a `messageId`, so a kept forward records no provider id.

**A destination that is not verified throws at once.** To an invalid address and to a registered-but-unverified
one alike: `Error: destination address not verified`, 2 to 3 ms after the call.

**A caught failure reaches nobody.** When the Worker caught that error and returned normally, the sender received
no bounce and no delay notice after the wait (more than an hour): SMTP answered 250 and nothing was delivered. This
is the "accepted but absent" shape AGENTS.md §3 names, so a Node that keeps a forward must record and show every
failure itself. `setReject(text)` reaches the sender verbatim as `555 5.7.1 <text>`.

**One destination twice delivers once.** The second `forward()` of the same message to the same destination threw
`message already forwarded to this destination`; one copy arrived.

**A throw after a successful forward still delivers.** The case that forwarded and then threw: the copy arrived, the
sender saw no bounce, and Cloudflare did not invoke the Worker again for that message.

**Only `X-` headers survive the headers argument.** An `X-` header arrived; a `Reply-To` passed beside it was
dropped silently, with no error. So the loop marker a Node adds is an `X-` header.

**The Routing API refuses to create a forward rule to an unverified destination**: `2054 Destination address is not
verified`. So a forward rule that exists was created to a verified destination, though the destination may have
been removed or re-registered since, which is why a Node reads the account's list before keeping it.

## Sized

Nothing is sized from this receipt: every value is a platform behaviour or a single observation. The Node uses the
behaviours (it awaits `forward()` after storing, never rejects after accepting, adds only `X-Mailda-Forwarded-By`,
forwards a receipt at most once) and states the two numbers as what was seen.

## Cost if wrong

If a failed `forward()` someday does bounce, the sender is told about a message this Node stored; nothing here
depends on the bounce not happening, since the Node records the failure either way. If a larger or slower message
fails where these did not, the attempt row says `refused` with Cloudflare's words, or stays `outcome_unknown`, which
doctor's `kept_forwards` finding counts.
