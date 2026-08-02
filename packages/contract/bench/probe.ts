import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import * as z from "zod";

const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
const big = "<p>x</p>".repeat(50_000);           // ~400 KB, all BMP
const astral = "🙂".repeat(10);                   // 10 code points, 20 UTF-16 units

const withMax = ajv.compile({ type: "string", maxLength: 2_000_000 });
const noMax   = ajv.compile({ type: "string" });

const time = (label: string, fn: () => void, n = 2000) => {
  for (let i = 0; i < 200; i++) fn();
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  console.log(`${label.padEnd(34)} ${(Number(process.hrtime.bigint() - t) / n / 1000).toFixed(3)} µs/op`);
};

console.log("=== is maxLength the cost? ===");
time("ajv 400KB WITH maxLength", () => withMax(big));
time("ajv 400KB WITHOUT maxLength", () => noMax(big));
time("zod 400KB .max()", () => z.string().max(2_000_000).safeParse(big));

console.log("\n=== do they agree on astral characters? ===");
const ajv15 = ajv.compile({ type: "string", maxLength: 15 });
const zod15 = z.string().max(15);
console.log(`"${astral}"  code points = ${[...astral].length}, UTF-16 units = ${astral.length}`);
console.log(`ajv maxLength:15 accepts : ${ajv15(astral)}`);
console.log(`zod .max(15)     accepts : ${zod15.safeParse(astral).success}`);
