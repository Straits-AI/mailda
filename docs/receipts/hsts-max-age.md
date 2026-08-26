---
id: hsts-max-age
kind: platform-limit
measured_on: 2026-08-26
stale_when: >
  the HSTS preload list revises its minimum max-age, RFC 6797 is superseded, or browsers begin
  refusing HTTP navigation to a host by default — at which point the header stops buying the first
  navigation anything and the number should go rather than grow
values:
  security.hsts_max_age_seconds: 31536000
---

**The provider here is the browser, and this is the one number in `Strict-Transport-Security` that
anything outside this repository specifies.** RFC 6797 defines `max-age` and declines to recommend a
value. The HSTS preload list — Chromium's, imported by Firefox and Safari — states a minimum of
**31536000 seconds (one year)** for a submission to be accepted, and that floor is the only externally
stated figure in the mechanism.

**Sized:** exactly the floor. One year, not the two years (`63072000`) most hardening guides print,
because nothing states where the second year comes from: doubling a number until it looks safe is how
`25 * 1024 * 1024` gets typed. A longer `max-age` is also **not free in the direction people assume** —
it is a commitment a customer cannot withdraw faster than their visitors' browsers expire it, and this
Node runs in the customer's own Cloudflare account under a hostname they may later move. A year of
HTTPS-only is a year we can defend from a document; two is taste.

## Why this is a platform limit that cannot be adapter capability data

AGENTS.md says platform limits live in adapter capability data and never as constants in application
code, because the provider changes them under us and a runtime probe is the only honest source. **There
is no probe available here.** A browser tells a server nothing about its HSTS policy, its preload list
version, or whether it honours the header at all; the request carries no field to read. So the rule's
mechanism is unavailable and its purpose — that the number is written down somewhere a person can check
against the provider — is served by this file plus the generated constant instead. That is stated here
rather than left as an apparent violation of the table.

## What the header does and does not close

It closes **the first navigation**. The session cookies are already `Secure`, so a credential cannot
travel over HTTP; what could was the initial `http://node.example` a person types or clicks, which is
one MITM away from never reaching the Node at all.

It is sent **without `includeSubDomains`**, deliberately, and that is the one place this Node declines
the usual advice. `includeSubDomains` from a Node deployed at `acme.com` is a claim about every host
under `acme.com` — hosts Mailda did not deploy, cannot see, and has no standing to speak for — held for
a year in every browser that saw one response. Mailda's premise is that the customer owns the
infrastructure; reaching outside our own hostname to assert HTTPS for siblings is the opposite of that,
and it is the kind of change whose blast radius is discovered by an unrelated team. The residual is
real and named: an attacker who can MITM plain HTTP on a *sibling* subdomain can set a cookie for the
parent domain (cookie tossing), which `includeSubDomains` would have stopped. The right place for a
domain-wide claim is the domain's owner making it once — Cloudflare exposes HSTS with
`includeSubDomains` as a zone setting under SSL/TLS — not a mail application making it for them on
install.
