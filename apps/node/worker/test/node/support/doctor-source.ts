import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(new URL("../../../src", import.meta.url).pathname);

/**
 * `doctor` as one text: `src/doctor.ts` — the report, the meter and the verdict — and every check module
 * under `src/doctor/`. Split on 16 September 2026 from one 3,139-line file, so a test that reads the doctor
 * for a check name or a phrase reads all of it rather than the file that happens to hold `runDoctor`.
 */
export function doctorFiles(): string[] {
  return [
    join(SRC, "doctor.ts"),
    ...readdirSync(join(SRC, "doctor")).filter((one) => one.endsWith(".ts")).map((one) => join(SRC, "doctor", one)),
  ];
}

export function doctorSource(): string {
  return doctorFiles().map((file) => readFileSync(file, "utf8")).join("\n");
}
