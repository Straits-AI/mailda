---
id: body-render-bounds
kind: measured-tripwire
measured_on: 2026-08-05
stale_when: >
  HTMLRewriter stops being a Workers built-in, the sanitizer's allowlist changes materially, or the
  measured bundle cost of postal-mime moves
values:
  render.max_body_bytes: 1048576
  render.postal_mime_bundle_kib: 107
  render.sanitizer_bundle_kib: 0
---

## The sanitizer is free; the parser is not

`HTMLRewriter` is a **Workers built-in** — a streaming HTML parser, the same engine Cloudflare runs
HTML transformation on at scale. Sanitizing an email body therefore costs **zero bundle bytes**, which
is the fact that made ADR 37's "isolate *and* sanitize" cheap rather than a compromise. The usual reason
a project accepts a heavy sanitizer dependency is precisely that it needs a parser.

`postal-mime` costs **+107 KiB** raw / +26 KiB gzip, measured in `mime-header-parse.md` with the parser
actually invoked. ADR 27 deferred it and ADR 38 adopted it here, for **body extraction only** — the
render path, where structural parsing of attacker-chosen nesting is what a mature parser is for. Header
parsing stays with `mime.ts`, and the wrapper does not expose headers at all, so "one source of header
truth" is a module boundary rather than a rule to remember.

## Why a body is bounded at 1 MiB

Rendering means buffering: the sanitized output has to be counted (how many remote images were blocked)
and handed to a client, which cannot be done while streaming. That is a departure from §16's rule for
*evidence*, and it is bounded rather than argued away.

1 MiB, derived rather than measured, and the derivation is the honest part:

- A body larger than this is almost always image-heavy marketing mail, and Mailda is explicitly not for
  bulk mail — so the case being truncated is the case the product does not serve.
- **The full bytes are never withheld.** `/api/messages/:id/raw` streams the complete original frame by
  frame with no bound at all, so this limit affects the *rendered panel*, never the record.
- 1 MiB buffered is trivial against the 128 MB isolate limit, leaving the memory headroom that made
  framed evidence necessary in the first place (`evidence-frame-size.md`).

A truncated body is **stated in the response**, not silently cut. §5C's rule about distinguishable
states applies: "this body was too large to render in full" is a different thing from "this message has
no body", and a reader must be able to tell.
