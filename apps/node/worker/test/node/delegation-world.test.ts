import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workerDir = join(import.meta.dirname, "../..");

/**
 * Every audit event whose actor can be a machine names who is accountable for it (#109 L1).
 *
 * ## Why this is lexical, and why `actorKind` is not guarded the same way
 *
 * `kindOfActor` **derives** the kind from the actor's typed prefix, so a `btl_` records `actorKind: "butler"`
 * with no call site passing anything — and `audit.ts` argues at length that a design where each site passed
 * it "would be correct on the day it was written and wrong the first time a new effect node called a fifth
 * function".
 *
 * A delegator cannot work that way. It is **not derivable** from a `btl_`: resolving it would mean reading
 * the Butler's `sponsor_user_id`, and that field can be reassigned — so an entry written in March would start
 * reporting a different accountable person in July. The whole reason the column exists is that the answer
 * must be *recorded at the time* rather than looked up later.
 *
 * So it is genuine information only the caller holds, and the caller has to pass it. That is exactly the
 * shape `audit.ts` warns about, and this file is the mitigation: the guard the derived design did not need.
 *
 * ## What it checks
 *
 * Any `AuditEvent` literal whose `actorUserId` is a Butler's identity must set `delegatorUserId` in the same
 * literal. A human acting for themselves has no delegator and is untouched by this.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(workerDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.ts$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * Actor expressions that name a machine rather than a person.
 *
 * `butlerId` and the composition's author when a Butler composed it. Written as the expressions that appear
 * in the source rather than as a concept, because a concept cannot be grepped — and the alternative, parsing
 * TypeScript, is the thing `stylesheet-hazards.test.ts` records as not worth building until a fourth
 * recurrence.
 */
const MACHINE_ACTORS = ["butler.butlerId", "composition.authorUserId"];

/** An `AuditEvent` object literal, as the span from `action:` to the closing brace's line. */
function auditLiterals(source: string): string[] {
  const found: string[] = [];
  const lines = source.split("\n");
  for (let at = 0; at < lines.length; at++) {
    if (!/^\s*action:\s*"/.test(lines[at]!)) continue;
    // Forward to the first line that closes the literal at its own indentation or shallower.
    const indent = (/^\s*/.exec(lines[at]!) ?? [""])[0].length;
    const block: string[] = [];
    for (let to = at; to < lines.length; to++) {
      block.push(lines[to]!);
      const closing = /^\s*\}/.test(lines[to]!)
        && (/^\s*/.exec(lines[to]!) ?? [""])[0].length < indent;
      if (closing) break;
    }
    found.push(block.join("\n"));
  }
  return found;
}

describe("an act a machine performed names the human accountable for it", () => {
  it("finds audit literals to inspect, so nothing below passes by scanning nothing", () => {
    /*
     * Anti-vacuity. If the literal shape changed — a builder function, a different key order — this scan
     * would find nothing and agree with everything, while reporting a property it could no longer see.
     */
    const total = sourceFiles("src")
      .reduce((sum, file) => sum + auditLiterals(readFileSync(join(workerDir, file), "utf8")).length, 0);
    expect(total, "no audit event literals found in src — has the shape changed?").toBeGreaterThan(20);
  });

  it("sets a delegator wherever the actor is a machine", () => {
    const wrong: string[] = [];
    for (const file of sourceFiles("src")) {
      for (const literal of auditLiterals(readFileSync(join(workerDir, file), "utf8"))) {
        const machine = MACHINE_ACTORS.find((actor) => literal.includes(`actorUserId: ${actor}`));
        if (machine === undefined) continue;
        if (!literal.includes("delegatorUserId")) {
          const action = (/action:\s*"([^"]+)"/.exec(literal) ?? [])[1] ?? "?";
          wrong.push(`${file}: "${action}" has actor ${machine} and no delegatorUserId`);
        }
      }
    }
    expect(
      wrong.length === 0 ? null : `${wrong.length} machine-actor audit event(s) with nobody accountable:\n  `
      + `${wrong.join("\n  ")}\n\nThe actor is the machine; the delegator is the person who answers for it. `
      + "Without one, the trail can only recover the sponsor from a column that changes.",
    ).toBeNull();
  });

  it("keeps the delegator inside the hashed form, so it cannot be rewritten undetected", () => {
    /*
     * A delegator the chain did not cover would be a field an operator with database access could edit
     * without the trail noticing — and *"who was accountable"* is precisely the answer somebody would want to
     * change. Checked lexically because the behavioural half lives in `test/audit.test.ts`, which cannot see
     * whether a *future* field was included.
     */
    const audit = readFileSync(join(workerDir, "src/audit.ts"), "utf8");
    const canonical = audit.slice(audit.indexOf("function canonical"), audit.indexOf("const UTF8"));
    expect(canonical, "canonical() no longer includes the delegator, so the chain does not cover it")
      .toContain("delegatorUserId");
    // And `verifyChain` must read the column, or it recomputes a hash the append never produced.
    expect(audit, "verifyChain does not read delegator_user_id, so recomputation would disagree with storage")
      .toContain("delegator_user_id");
  });
});
