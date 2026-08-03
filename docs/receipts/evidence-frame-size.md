---
id: evidence-frame-size
kind: measured-tripwire
measured_on: 2026-08-03
stale_when: >
  the cipher changes from AES-256-GCM, the header layout changes, R2 gains native
  transparent encryption, or Cloudflare Email's 25 MiB inbound limit moves
values:
  evidence.frame_bytes: 262144
  evidence.header_bytes: 32
  evidence.tag_bytes: 16
  evidence.max_seal_ms_25mib: 25
  evidence.max_open_ms_25mib: 25
  evidence.max_ttfb_ms: 1
---

**Measured:** `packages/evidence/bench/frame.bench.ts`, Node 22 over WebCrypto
AES-256-GCM. Not workerd — `performance.now()` there is Spectre-clamped and reports whole
milliseconds (see `authz-check-rows-read.md`), so it cannot time computation. Both run V8
over a native AES-GCM implementation, so the shape of the curve holds; absolute numbers on
Cloudflare hardware will differ.

## Why framing at all

#7 decided the default profile encrypts raw MIME, attachments and exports in R2. One-shot
AES-GCM cannot deliver that on a 25 MiB message (§11B records Cloudflare Email's inbound
limit): the object must be held whole against the Worker's 128 MB budget, and the
authentication tag only arrives at the end — so **not one byte can be emitted until the
entire object has been decrypted and verified**.

Measured, that wait is **13.2 ms of dead air** before the first byte of a 25 MiB
attachment. Framing reduces it to 0.145 ms.

## Frame size

| | 64 KiB | **256 KiB** | 1 MiB | one-shot |
|---|---:|---:|---:|---:|
| 25 MiB seal | 22.4 ms | 15.4 ms | 12.0 ms | 9.3 ms |
| 25 MiB open (total) | 23.2 ms | 17.2 ms | 12.3 ms | 13.2 ms |
| **time to first byte** | 0.067 ms | **0.145 ms** | 0.395 ms | **13.2 ms** |
| frames | 400 | 100 | 25 | 1 |
| storage overhead | 6,432 B (0.025%) | 1,632 B (0.006%) | 432 B (0.002%) | 16 B |
| range-read granularity | 64 KiB | 256 KiB | 1 MiB | whole object |

At 2 MB — a message with inline images, far more common than 25 MiB — 256 KiB frames cost
0.855 ms to open with 0.116 ms to first byte. At 20 KB every frame size collapses to a
single frame and the choice is irrelevant, which is the common case.

## Sized: 256 KiB

- **91× better time to first byte** than one-shot on a 25 MiB object (0.145 ms vs 13.2 ms).
- Total decrypt costs 30% more than one-shot — 4 ms on the largest message the platform
  accepts, against a 25 MiB network transfer. Negligible where it lands.
- 1 MiB is 28% cheaper in total CPU and would be the choice if throughput were the only
  axis. It was rejected on range granularity: reading one byte costs a whole frame, and
  attachment preview and ranged reads are user-facing paths. 256 KiB gives 4× finer
  granularity for 5 ms on the rarest object size.
- 64 KiB buys marginally better first-byte latency (0.067 ms — already imperceptible) for
  76% more total CPU and 4× the storage overhead. Not worth it.

Tripwires are set at 25 ms for seal and open on a 25 MiB object — roughly 1.5× the worst
measured — and 1 ms for time to first byte, ~7× the measured 0.145 ms. Routine traffic
never approaches them; a regression that reintroduces one-shot behaviour, or drops the
streaming reader, exceeds the TTFB tripwire by an order of magnitude.

## Format

```
header (32 bytes, authenticated as AAD on every frame)
  0  magic      "MLDA"      4
  4  version    1           1
  5  reserved   0           3
  8  frameSize  uint32 BE   4
 12  plainLen   uint64 BE   8
 20  baseNonce  random      8
 28  frameCount uint32 BE   4
then frameCount frames, each: ciphertext || 16-byte GCM tag
```

**Nonce discipline.** The 12-byte GCM nonce is `baseNonce(8) || frameIndex(4)`.
`baseNonce` is 8 fresh random bytes per object; `frameIndex` is unique within it. A nonce
therefore cannot repeat under a given DEK **by construction** rather than by care — GCM
nonce reuse is catastrophic and must not depend on anyone remembering.

**Truncation and reordering.** Every frame's AAD is the full header plus its own index,
and the header carries both plaintext length and frame count. Dropping a trailing frame,
swapping two frames, or splicing frames from another object all fail authentication rather
than yielding a valid plaintext prefix.

Verified by 11 tests in `packages/evidence/test/frame.test.ts`: round-trip across frame
boundaries including empty and off-by-one sizes, flipped bit, dropped trailing frame,
reordered frames, forged header length, wrong key, nonce uniqueness across 40 frames,
range mapping, and that the streaming reader errors rather than emitting a tampered frame.

## Memory

`openStream()` emits each frame as it authenticates and never materialises the whole
plaintext — that is the property the 128 MB Worker limit needs, and the reason framing
exists. `open()` does buffer the full plaintext; it is for small objects and tests, and
must not be used on a response path. The distinction is documented at both call sites
because getting it wrong is invisible until a 25 MiB message arrives.

## Residual

- Absolute CPU on Cloudflare hardware is not established; only the relative curve and the
  format are. A deployed Worker's telemetry would settle it.
- The write path was measured as `seal()` over a buffer. §13 requires raw MIME persisted
  before the receipt is durable, so ingress should stream-seal from the incoming body
  rather than buffer it first. That reader is not written yet.
- Per-object DEK wrapping by the root KEK (§12) is not implemented here. This measures the
  frame layer only; where the unwrap happens under #4's single-owner rule is still open.
- R2 ranged GET behaviour against a real bucket is untested — the wrangler token in use
  has no R2 scope. `framesForRange` is unit-tested arithmetic, not an integration test.
