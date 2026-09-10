import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "../../src");

/**
 * Nothing this Node does with mail depends on its Cloudflare grant (#162).
 *
 * ## Why this is a test and not a sentence
 *
 * #162 requires that *"revoking the grant in Cloudflare leaves mail, users, Butlers, schedules, API/CLI,
 * backup and recovery working — drilled, not asserted."* It was drilled: on 10 September 2026 the live Node's
 * grant was put into `grant_refused`, and health, sign-in, search and `doctor` were unchanged — `doctor`
 * exited **0** and reported it as a note rather than a degradation.
 *
 * A drill is a fact about one afternoon. What makes the claim keep being true is that **no code outside two
 * files can reach the grant at all**, and that is what this checks. An import added to `dispatch.ts` next
 * month would make the drilled claim false with nothing to notice.
 *
 * ## The two permitted readers, and why each is not the mail path
 *
 * `index.ts` — the five routes that exist to *manage* the grant. `doctor.ts` — the two findings that
 * *report* it. Neither is reached by receiving, sealing, dispatching, indexing, a Butler run, a backup or a
 * recovery.
 *
 * The table is by file rather than by function deliberately: a file that imports the module has taken a
 * dependency on it whatever it does with it, and the question here is reachability rather than intent.
 */

/** Every `src/**\/*.ts`, so a new directory cannot escape the scan. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const ALL = sources(src);
const relative = (path: string) => path.slice(src.length + 1);

describe("the Cloudflare grant is reachable from nothing that carries mail", () => {
  it("scans the whole source tree, so nothing below passes by finding no files", () => {
    // Anti-vacuity. A broken walk would make every assertion here agree with everything.
    expect(ALL.length).toBeGreaterThan(50);
    expect(ALL.map(relative)).toContain("provider/cloudflare-grant.ts");
    expect(ALL.map(relative)).toContain("outbound/dispatch.ts");
  });

  it("is imported by the routes that manage it and the doctor that reports it, and nothing else", () => {
    const importers = ALL
      .filter((path) => relative(path) !== "provider/cloudflare-grant.ts")
      .filter((path) => readFileSync(path, "utf8").includes("provider/cloudflare-grant"))
      .map(relative)
      .sort();

    /*
     * If this fails, something new can reach the grant. Ask whether that thing runs on a path a *revoked*
     * grant must not break — receiving, sealing, dispatching, indexing, a Butler run, a backup, a recovery.
     * If it does, #162's claim is no longer true and the drill has to be redone, not the list widened.
     */
    expect(importers).toEqual(["doctor.ts", "index.ts"]);
  });

  it("has its table read by the migration, the module and the doctor, and nothing else", () => {
    /*
     * The second door. An import is not the only way in — raw SQL against `provider_binding` would reach the
     * same row without naming the module, which is how a closed world over imports alone would be evaded.
     */
    const readers = ALL
      .filter((path) => readFileSync(path, "utf8").includes("provider_binding"))
      .map(relative)
      .sort();
    expect(readers).toEqual(["doctor.ts", "migrate.ts", "provider/cloudflare-grant.ts"]);
  });

  it("keeps a refused grant out of the verdict, which is what makes a revocation harmless", () => {
    /*
     * The drill's other half. `doctor`'s verdict escalates on `refuse` and `degraded` only, and `mailda
     * deploy` reads that verdict — so a grant finding at either severity would fail a deploy for a
     * revocation an operator performed on purpose.
     *
     * Asserted against the source because the live drill cannot be re-run in CI: the finding is built with
     * `severity: "report"` and carries `ok` false, which is the pair that means *worth acting on, nothing
     * broken*. Confirmed live on 10 September 2026 — `doctor` exited 0 with the grant refused.
     */
    const doctor = readFileSync(join(src, "doctor.ts"), "utf8");
    const finding = /check: "provider_binding",[\s\S]{0,2000}?severity: "[a-z]+"/.exec(doctor)?.[0] ?? "";
    expect(finding, "the provider_binding finding could not be found").toContain("check: \"provider_binding\"");
    expect(finding).toContain('severity: "report"');
    expect(finding).not.toContain('severity: "degraded"');
    expect(finding).not.toContain('severity: "refuse"');
  });
});
