---
id: mime-header-parse
kind: measured-tripwire
measured_on: 2026-08-04
stale_when: >
  postal-mime's bundle cost changes materially, Workers gains a native MIME parser, or #28 decides
  to render message bodies and needs structural parsing
values:
  mime.postal_mime_bundle_kib: 107
  mime.postal_mime_gzip_kib: 26
  mime.max_header_bytes: 65536
  mime.max_references_depth: 50
---

## The dependency question, measured

Parsing MIME properly means RFC 2047 encoded words, RFC 2231 parameter continuations, nested
multipart, quoted-printable, base64, and a long tail of malformed real-world mail. Hand-rolling that
is how parser bugs become security bugs, so `postal-mime` — purpose-built for Workers — was the
obvious candidate.

Measured against the deployed Worker's bundle, with the parser actually invoked so nothing is
tree-shaken away:

| | Raw | Gzip |
|---|---:|---:|
| Worker today | 125.53 KiB | 35.97 KiB |
| With `postal-mime` invoked | 232.16 KiB | 61.60 KiB |
| **Cost** | **+106.6 KiB** | **+25.6 KiB** |

(An unused import measured +1 KiB. That figure is meaningless — esbuild had shaken the parser out — and
it is recorded because it is the number a careless measurement would have produced.)

Nowhere near a platform limit; Workers Paid allows far more. The cost is cold-start weight in every
customer's Node, and #15 rejected Ajv partly on a smaller figure than this.

## Decided: not yet. Headers are parsed here, bodies are #28's problem

**What this layer needs is headers, and headers are not where the danger is.**

Threading needs `Message-ID`, `In-Reply-To` and `References`; the list view needs `Subject`, `From`
and `Date`. These are structured tokens and short text, with one genuinely fiddly part (RFC 2047
encoded words). The blast radius of a bug is a **mis-threaded conversation or a mangled subject** —
wrong display, in a runtime with no memory unsafety, on a path that reaches the DOM only through
`textContent`.

Body parsing is the opposite: nested boundaries, transfer encodings, and attacker-chosen structure,
feeding a renderer. That is where a mature parser earns 107 KiB, and **that decision belongs to #28**,
which is the ticket that actually renders a body. Paying for it a layer early would buy nothing.

Consequence recorded plainly: if #28 adopts `postal-mime`, the header parser here is **deleted** rather
than kept alongside it. Two parsers for one format is drift, and the second one is always the one
nobody updates.

## Bounds

- `mime.max_header_bytes = 65536` — how much of an object is read looking for the header/body
  separator. A message with no `\r\n\r\n` in its first 64 KiB is malformed, and reading further to
  prove it costs memory against the 128 MB limit for no benefit. 64 KiB is far past any legitimate
  header block, including long `Received` chains and DKIM signatures.
- `mime.max_references_depth = 50` — how many ids are read from a `References` chain before stopping.
  Only two are stored (see below), so this bounds parse work on a hostile header, not storage.

## Why only two ids are stored

A `References` chain grows with the thread, so storing it whole would make the metadata row grow
without bound — and `message-metadata-bytes.md` measured **1,253 bytes per message**, from which
§11B's shard thresholds are derived. An unbounded column invalidates that arithmetic silently.

Threading needs exactly two anchors: the **root** (first id in `References`, or the message's own id
when there is none) and the **parent** (`In-Reply-To`). Both are single ids and therefore bounded. The
full chain stays in the immutable MIME, where a reply's own `References` header is assembled from it
at composition time — which is a read the composer performs anyway to quote the body.

`To` and `Cc` are likewise **not** stored, for the same reason: reply-all needs them, and reply-all is
composing, which already reads the evidence.
