import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { sendMailInput, sendMailInputJsonSchema } from "../src/send-mail.ts";
import { payloads } from "./payloads.ts";

/**
 * Measures the two candidates from #15 — Zod on the hot path, versus a validator
 * compiled from the JSON Schema the catalog already emits.
 *
 * Run in Node, not in workerd, and that is a deliberate compromise recorded in the
 * receipt: `performance.now()` inside Workers is Spectre-clamped and reports whole
 * milliseconds (see docs/receipts/authz-check-rows-read.md), so it cannot time pure
 * computation at all. Node and workerd both run V8, so the *relative* comparison holds
 * even though absolute numbers on Cloudflare's hardware will differ.
 */

// Ajv's default entry point is draft-07. draft 2020-12 — the dialect OpenAPI 3.1
// uses, and what the catalog emits (#3) — requires the 2020 build. `format` keywords
// are ignored entirely without ajv-formats, which would silently make the compiled
// validator more permissive than the published contract.
const ajv = new Ajv2020({ allErrors: false, strict: false });
addFormats(ajv);
const ajvValidate = ajv.compile(sendMailInputJsonSchema as object);

function measure(label: string, iterations: number, run: () => void): number {
  // Warm up so we compare steady state, not JIT tiering.
  for (let n = 0; n < Math.min(iterations, 2000); n++) run();
  const started = process.hrtime.bigint();
  for (let n = 0; n < iterations; n++) run();
  const elapsedNs = Number(process.hrtime.bigint() - started);
  const perOpUs = elapsedNs / iterations / 1000;
  console.log(`MEASURE ${label.padEnd(38)} ${perOpUs.toFixed(3)} µs/op`);
  return perOpUs;
}

const ITERATIONS = 20_000;
const results: Record<string, number> = {};

console.log("=== valid payloads ===");
for (const [name, payload] of Object.entries(payloads.valid)) {
  results[`zod.${name}`] = measure(`zod  ${name}`, ITERATIONS, () => {
    sendMailInput.safeParse(payload);
  });
  results[`ajv.${name}`] = measure(`ajv  ${name}`, ITERATIONS, () => {
    ajvValidate(payload);
  });
}

console.log("=== invalid payloads (rejection path) ===");
for (const [name, payload] of Object.entries(payloads.invalid)) {
  results[`zod.${name}`] = measure(`zod  ${name}`, ITERATIONS, () => {
    sendMailInput.safeParse(payload);
  });
  results[`ajv.${name}`] = measure(`ajv  ${name}`, ITERATIONS, () => {
    ajvValidate(payload);
  });
}

console.log("\n=== ratio (zod / ajv), higher means ajv is faster ===");
for (const name of Object.keys(payloads.valid).concat(Object.keys(payloads.invalid))) {
  const zod = results[`zod.${name}`]!;
  const ajv2 = results[`ajv.${name}`]!;
  console.log(`RATIO ${name.padEnd(38)} ${(zod / ajv2).toFixed(2)}x`);
}
