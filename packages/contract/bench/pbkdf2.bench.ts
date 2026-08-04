/**
 * PBKDF2-HMAC-SHA256 cost, for the login path's iteration count.
 *
 * Run in Node: `performance.now()` inside Workers is Spectre-clamped and cannot time
 * computation (see docs/receipts/authz-check-rows-read.md). PBKDF2 via WebCrypto is native
 * in both runtimes rather than JS, so the figures transfer better than a pure-JS benchmark
 * would — but they are still not workerd on Cloudflare hardware.
 */
const enc = new TextEncoder();

async function derive(iterations: number): Promise<void> {
  const key = await crypto.subtle.importKey("raw", enc.encode("correct horse battery staple"), "PBKDF2", false, ["deriveBits"]);
  await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: crypto.getRandomValues(new Uint8Array(16)), iterations },
    key, 256,
  );
}

for (const iterations of [100_000, 210_000, 310_000, 600_000, 1_000_000]) {
  await derive(iterations);
  const runs = iterations > 500_000 ? 5 : 12;
  const started = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) await derive(iterations);
  const ms = Number(process.hrtime.bigint() - started) / runs / 1e6;
  console.log(`MEASURE pbkdf2 iterations=${iterations.toLocaleString().padStart(9)}  ${ms.toFixed(1)} ms/derivation`);
}
