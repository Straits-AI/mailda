import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { emitSkill } from "./skill.ts";

/**
 * Writes the Skill. Split from `skill.ts` for the reason `write.ts` is split from `generate.ts`: a module
 * with a top-level side effect cannot be imported by the thing that checks it, and that made the SDK's own
 * drift test vacuous once already.
 */
const out = join(import.meta.dirname, "../../../skills/mailda/SKILL.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, emitSkill(), "utf8");
process.stdout.write(`wrote ${out}\n`);
