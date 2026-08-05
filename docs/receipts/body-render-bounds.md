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
  render.max_attributes_per_element: 64
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


## Three high-severity findings, from adversarial review after this shipped

Recorded because the *method* is the lesson: my own tests found one bypass and gave false confidence on
a second. An independent reviewer running the code in the Workers runtime found three more, all with
measurements.

**1. Raw-text elements made inert payloads live.** `xmp`, `noembed`, `noframes`, `plaintext` and
`listing` switch the tokenizer to RAWTEXT, so their contents arrive as a single verbatim text chunk the
element handler never inspects. None were in either set, so they fell through to
`removeAndKeepContent()`: the wrapper was deleted and raw text written out, and the browser reparsed it
as markup. `<xmp><img src="https://tracker.example/x.gif"></xmp>` came out as a **working tracking
pixel with `blockedRemote` reporting 0** — the panel affirmatively told the reader nothing was withheld.
The payload was inert in the message the sender wrote; **the sanitizer is what made it dangerous.**

**2. A lone `<` spliced into a real tag.** `<foo><</foo>img src=...>` gives lol-html an unknown element
containing the text `<`, then the text `img src=...>`. Unwrapping made them adjacent and the browser
read a working `<img>`. The sanitizer's safety rested on an assumption it did not enforce — that the
browser would retokenize the output exactly as lol-html tokenized the input — and **removing tags is
precisely what breaks that assumption.**

**3. Attribute stripping was quadratic.** `removeAttribute` is a linear scan, so removing them one at a
time is O(n²). Measured in the Workers runtime:

| Attributes | Wall time |
|---:|---:|
| 10,000 | 112 ms |
| 20,000 | 497 ms |
| 50,000 | **34,952 ms** |
| 120,000 | 100,354 ms |

439 KB of attributes fits inside `render.max_body_bytes`, so the input bound did not contain it. 35
seconds exceeds the CPU limit, so the request was killed **every time** the reader opened that message —
permanent denial of the body panel, triggerable by anyone who can send mail. `render.max_attributes_per_element = 64`
is the bound; past it the element is dropped and its text kept, in one operation.

Also found: `renderBody` wrapped `extractBody` in a try/catch and **not** `sanitizeHtml`, so a rewriter
failure escaped as a 500 rather than the state §24 requires. The careful error handling stopped one line
short.

### The fix that closes the class rather than the instances

Adding five tag names fixes finding 1. **Escaping `<` on output fixes 1 and 2 together, and fails closed
for whatever the next parser differential turns out to be** — the two tokenizers can no longer disagree
about what is a tag.

That fix then introduced a bug of its own, caught by the test that had been giving false confidence:
letting HTMLRewriter escape via `html: false` **double-encoded**, because `chunk.text` returns raw
source rather than decoded text, so `&lt;` became `&amp;lt;` and the reader would have seen
`&lt;img ...` instead of what the sender wrote. Only `<` is escaped now — `&` cannot open a tag, so
escaping it buys nothing and costs correctness.
