import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ROUTES } from "@mailda/contract/routes";

import { emit } from "./generate.ts";

/**
 * The only thing in this package that touches the disk.
 *
 * Split from `generate.ts` after a top-level `writeFileSync` there made the drift test vacuous: importing
 * the generator to reach `methodNameFor` regenerated the file, so the test's "before" was never anything but
 * correct. Emitting is pure now, and this is the one line that writes.
 */
const out = join(import.meta.dirname, "generated.ts");
writeFileSync(out, emit(), "utf8");
process.stdout.write(`wrote ${ROUTES.length} methods to ${out}\n`);
