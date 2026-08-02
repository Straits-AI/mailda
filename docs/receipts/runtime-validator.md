---
id: runtime-validator
kind: measured-tripwire
measured_on: 2026-08-03
stale_when: >
  Zod's string length semantics change to code points, Ajv gains an O(1) maxLength fast
  path for BMP-only strings, or the catalog begins emitting maxLength in UTF-16 units
values:
  validator.typical_command_us: 2
  validator.worst_realistic_command_us: 46
  validator.bundle_bytes: 81203
---

**Measured:** `packages/contract/bench/validator.bench.ts` and `bench/bundle.ts`,
commit in this change. Node 22, not workerd — a compromise recorded below.

## The decision

**Zod validates on the hot path.** The seam #3 created — catalog emits JSON Schema, so
the runtime validator need not be Zod — stays in place because it cost nothing, but the
swap it was designed to enable is rejected on both performance *and* correctness.

## Why not measured in workerd

`performance.now()` inside Workers is Spectre-clamped and reports whole milliseconds
(established in `authz-check-rows-read.md`), so it cannot time pure computation at all.
Node and workerd both run V8, so the **relative** comparison holds; absolute numbers on
Cloudflare's hardware will differ. Anyone who needs absolute per-request CPU should read
it from a deployed Worker's telemetry, not from either of these harnesses.

## Throughput, µs/op over 20,000 iterations after warm-up

| Payload | Zod | Ajv (2020) |
|---|---:|---:|
| typical — 1 recipient, short body | **1.63** | 1.85 |
| 50 recipients (§11B's limit) | 18.28 | **17.76** |
| 20 attachment descriptors | 13.85 | **8.29** |
| 400 KB HTML body | **1.67** | 1014.22 |
| worst realistic (50 to, 20 cc, 20 attachments, 200 KB html) | **45.94** | 574.69 |
| reject: bad mailbox id | 11.65 | **0.37** |
| reject: 50th recipient invalid | 43.17 | **17.56** |

Ajv wins early rejection by 31×, and loses large bodies by 600×.

## Why Ajv collapses on large strings

Isolated in `bench/probe.ts`:

```
ajv 400KB WITH maxLength      1055.799 µs/op
ajv 400KB WITHOUT maxLength      0.104 µs/op
zod  400KB .max()               23.339 µs/op
```

`maxLength` is the entire cost. **JSON Schema defines `maxLength` in Unicode code
points**, so Ajv walks the whole string. Zod's `.max()` uses `String.prototype.length`
— UTF-16 code units — which is O(1).

Mail bodies are large by nature, and §5 makes rich HTML compose a core feature. A
validator that is 600× slower on the payload the product exists to carry is not a
candidate.

## The correctness finding, which matters more than the speed

The two do not agree, and the disagreement is not an edge case:

```
"🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂"   code points = 10, UTF-16 units = 20
ajv  maxLength: 15   accepts : true
zod  .max(15)        rejects : false
```

A compiled validator would be **more permissive than the published contract** for any
string containing astral characters — emoji, and a good deal of what §5C's
internationalisation requirements exist to support. Swapping validators would silently
change what the API accepts, in a direction that only shows up for non-Latin users.

**This also means the emitted OpenAPI is slightly wrong today.** `z.string().max(n)`
becomes `maxLength: n`, but they are different constraints: the document publishes a
code-point limit while the server enforces a UTF-16 limit. A client counting code points
can construct a request the contract says is valid and the server rejects. That is an
honest-semantics defect of the same family AGENTS.md names for overclaiming — the
document says something the code does not do — and it needs fixing in the catalog's
emitter, not here. Recorded on #3.

## Bundle

| | minified |
|---|---:|
| Zod + the `mail.send` schema | 79.3 KiB |
| Ajv 2020 + ajv-formats | 139.6 KiB |
| **delta** | **+60.3 KiB per Worker** |

Nine Workers pay this at cold start, so the compiled path would have cost roughly 540 KiB
across the Node for a validator that is slower on the payloads that matter.

## Sized

- `validator.typical_command_us = 2` — the common case, rounded up from 1.63.
- `validator.worst_realistic_command_us = 46` — the worst realistic single request.
  A tripwire: routine traffic never approaches it, and a regression that reintroduces
  code-point counting would exceed it by an order of magnitude.
- `validator.bundle_bytes = 81203` — 79.3 KiB. A guard against a dependency creeping
  onto the hot path.

## Operational note

Ajv's default entry point is **draft-07**. Draft 2020-12 — the dialect OpenAPI 3.1 uses
and the catalog emits — requires `ajv/dist/2020`. Separately, `format` keywords are
ignored entirely unless `ajv-formats` is registered, which would silently make a
compiled validator more permissive still. Both are easy to get wrong quietly; recorded
in case the seam is ever revisited.

## Residual

- Absolute per-request CPU on Cloudflare hardware is not established. Only the relative
  comparison and the bundle figure are.
- Only `mail.send` was measured. It was chosen as the widest and most consequential
  command, but a catalog-wide sweep would be a better basis once the catalog exists.
