---
id: email-authentication-results
kind: platform-limit
measured_on: 2026-09-17
stale_when: >
  Cloudflare's Email Routing MX stops writing an Authentication-Results header, changes its authserv-id
  from mx.cloudflare.net, or stops evaluating any of SPF, DKIM, DMARC and ARC on inbound mail
values:
  inbound.authentication_results_written: 1
  inbound.authentication_methods_reported: 4
---

**Measured:** two messages held by the live Node `mailda.swmengappdev.workers.dev`, read back through
`GET /api/messages/:id/raw` on 17 September 2026: one from Gmail (3 August), one a bounce from
`cf-bounce.mailda-test.whymelabs.com` (15 September). Both carry, first among the headers Cloudflare added:

```text
Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.s=20251104 header.b=LZOq2czn;
  dmarc=pass header.from=gmail.com policy.dmarc=none;
  spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-ed1-x535.google.com) smtp.helo=…;
  spf=pass (mx.cloudflare.net: domain of wmhy.tech@gmail.com designates 2a00:1450:4864:20::535 as permitted sender)
    smtp.mailfrom=wmhy.tech@gmail.com;
  arc=pass smtp.remote-ip="2a00:1450:4864:20::535"
```

So the receiving MX authenticates every inbound message and records four methods (SPF, twice, for HELO and
MAIL FROM; DKIM per signature; DMARC with the From domain and its published policy; ARC) under the
authserv-id `mx.cloudflare.net`. Beside it, the same messages carry `ARC-Authentication-Results` and
`Received-SPF`, and the Gmail one an `Authentication-Results` from `mx.google.com` for an earlier hop.

**What this is adapter data for.** `src/authentication-results.ts` reads the header bearing this authserv-id
and no other (RFC 8601 §7.1: a header from any other server, including one a sender forged, is not this
Node's verdict), and `materialise.ts` stores the four results on the message row (migration 0055). It is the
deterministic half of mail security: no model, no lookup, no request beyond the bytes already held. What it
does not establish is whether a message is *unwanted* (a DMARC pass from a domain nobody has heard of is
still a pass), which is the half a classifier would speak to, and that is a separate decision.

**Cost:** 139 bytes a message on the row (`message-metadata-bytes.md`, re-measured the same day), no index,
and one pass over a header block that was already being parsed.
