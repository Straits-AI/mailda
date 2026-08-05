import { type Bytes, HEADER_BYTES, TAG_BYTES, frameCountFor, open, openStream, seal } from "../src/index.ts";

/**
 * Frame-size sensitivity for #16.
 *
 * Run in Node, not workerd: `performance.now()` inside Workers is Spectre-clamped and
 * reports whole milliseconds, so it cannot time computation (see
 * docs/receipts/authz-check-rows-read.md). Both run V8 over a native AES-GCM
 * implementation, so the shape of the curve holds; absolute numbers on Cloudflare
 * hardware will differ.
 */
const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

const SIZES = [
  ["20 KB  plain text message", 20 * 1024],
  ["2 MB   message + inline images", 2 * 1024 * 1024],
  ["25 MiB max inbound (§11B)", 25 * 1024 * 1024],
] as const;

const FRAMES = [
  ["64 KiB", 65_536],
  ["256 KiB", 262_144],
  ["1 MiB", 1_048_576],
] as const;

function payload(n: number): Bytes {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out.subarray(0, Math.min(n, 65_536)));
  for (let i = 65_536; i < n; i += 65_536) out.copyWithin(i, 0, Math.min(65_536, n - i));
  return out;
}

async function time(runs: number, fn: () => Promise<unknown>): Promise<number> {
  await fn();
  // performance.now(), not process.hrtime — it exists in both runtimes, so this file needs no Node
  // type dependency to say the one thing it needs to say. The clamping caveat in the header applies to
  // workerd, and this bench deliberately does not run there.
  const started = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  return (performance.now() - started) / runs;
}

for (const [sizeLabel, size] of SIZES) {
  const plain = payload(size);
  const runs = size > 8_000_000 ? 5 : 40;
  console.log(`\n=== ${sizeLabel} ===`);
  for (const [frameLabel, frameSize] of FRAMES) {
    const sealed = await seal(key, plain, frameSize);
    const sealMs = await time(runs, () => seal(key, plain, frameSize));
    const openMs = await time(runs, () => open(key, sealed));

    const frames = frameCountFor(size, frameSize);
    const overhead = HEADER_BYTES + frames * TAG_BYTES;

    // Time to first byte: what a streaming reader waits before emitting anything.
    // Measured by reading exactly one chunk from the stream, not by timing a throw.
    const ttfbMs = await time(Math.min(runs * 4, 200), async () => {
      const reader = openStream(key, sealed).getReader();
      await reader.read();
      await reader.cancel();
    });

    console.log(
      `MEASURE ${frameLabel.padEnd(8)} frames=${String(frames).padStart(4)}  ` +
        `seal=${sealMs.toFixed(3)}ms  open=${openMs.toFixed(3)}ms  ` +
        `first_frame=${ttfbMs.toFixed(3)}ms  overhead=${overhead}B (${((overhead / size) * 100).toFixed(4)}%)`,
    );
  }
}

console.log("\n=== one-shot comparison (what #7 would have cost without framing) ===");
for (const [sizeLabel, size] of SIZES) {
  const plain = payload(size);
  const runs = size > 8_000_000 ? 5 : 40;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const encMs = await time(runs, async () => { await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain); });
  const decMs = await time(runs, async () => { await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct); });
  console.log(`MEASURE one-shot ${sizeLabel.padEnd(32)} encrypt=${encMs.toFixed(3)}ms  decrypt=${decMs.toFixed(3)}ms  (no bytes emitted until complete)`);
}
