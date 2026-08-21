import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { fill, sqlLiteral } from "../../scripts/d1.mjs";

/**
 * The operator tools, which are the only way to recover a Node nobody can sign into.
 *
 * ## The defect these exist because of
 *
 * `set-password.mjs` and `seed-claim-secret.mjs` both ran D1 statements with
 * `wrangler d1 execute --param <value>`. **There is no `--param` flag.** Wrangler treats it as an unknown
 * option, loses `--command` along with it, and answers *"You must provide either --command or --file"*. So
 * the password reset — added in a commit titled "add the password reset that had no path" — had never worked
 * on any Node, from the day it was written until now.
 *
 * Nothing caught it because these are `.mjs` scripts outside both vitest projects, run by hand, by an
 * operator who by definition is already having a bad day. This file puts them in the suite.
 */

const SCRIPTS = join(import.meta.dirname, "../../scripts");

describe("values reach D1 as themselves", () => {
  it("wraps a string, doubles its quotes, and leaves nothing else", () => {
    expect(sqlLiteral("plain")).toBe("'plain'");
    expect(sqlLiteral("o'brien")).toBe("'o''brien'");
    // The shape somebody would actually try. It has to come back as *data*, not as syntax.
    expect(sqlLiteral("'); DROP TABLE users; --")).toBe("'''); DROP TABLE users; --'");
  });

  it("passes numbers and null through, and refuses everything else", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(null)).toBe("NULL");
    /*
     * Refused rather than coerced: every coercion here is a way for a value to arrive looking like something
     * it is not, and a wrong row in a recovery tool is worse than a stopped one.
     *
     * Cast, because `d1.d.mts` now refuses these at compile time — and the runtime guard still has to exist,
     * because every caller is an `.mjs` script that no compiler ever looks at. Testing it means reaching
     * past the type the way those scripts do by default.
     */
    const loose = sqlLiteral as (value: unknown) => string;
    expect(() => loose(new Date())).toThrow(/refusing to write a object/);
    expect(() => loose(Number.NaN)).toThrow(/refusing to write NaN/);
    expect(() => loose(undefined)).toThrow(/refusing to write a undefined/);
  });

  it("substitutes each placeholder once, and counts them", () => {
    expect(fill("SELECT ? , ?", ["a", 1])).toBe("SELECT 'a' , 1");
    // Both directions of a miscount are a row that is subtly wrong rather than an error, so both throw.
    expect(() => fill("SELECT ?, ?", ["a"])).toThrow(/not enough values/);
    expect(() => fill("SELECT ?", ["a", "b"])).toThrow(/2 value\(s\) given for 1 placeholder/);
  });

  it("does not substitute a question mark inside a string literal", () => {
    /*
     * A `?` in somebody's data is not a placeholder. Counting it as one would refuse valid SQL; substituting
     * into it would rewrite the data — which is the worse direction, and the reason the scan tracks quotes.
     */
    expect(fill("SELECT 'why?' , ?", ["x"])).toBe("SELECT 'why?' , 'x'");
    expect(fill("SELECT 'it''s a ?' , ?", ["x"])).toBe("SELECT 'it''s a ?' , 'x'");
  });
});

describe("no operator tool reaches for a wrangler flag that does not exist", () => {
  /**
   * The tripwire for the defect itself.
   *
   * `--param` reads exactly like a real flag and is not one, and the failure is a usage message rather than
   * an error about the flag — so the next person to write one of these scripts would reach for it again.
   * Asserted over the whole directory rather than the two known files, because the point is the next script.
   */
  it("never passes --param to wrangler d1 execute", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SCRIPTS)) {
      if (!name.endsWith(".mjs")) continue;
      const source = readFileSync(join(SCRIPTS, name), "utf8");
      source.split("\n").forEach((line, index) => {
        // The word appears in `d1.mjs`'s own header explaining the defect, which is prose rather than a call.
        if (/"--param"|'--param'/.test(line)) offenders.push(`${name}:${index + 1}`);
      });
    }
    expect(
      offenders.length === 0 ? null
        : `${offenders.join(", ")} passes --param to wrangler, which has no such flag: it swallows `
          + "--command with it and the statement never runs. Use fill() from scripts/d1.mjs",
    ).toBeNull();
  });

  /** Anti-vacuity: the scan really does look at the files that had the defect. */
  it("is looking at the scripts it claims to", () => {
    const names = readdirSync(SCRIPTS).filter((name) => name.endsWith(".mjs"));
    expect(names).toContain("set-password.mjs");
    expect(names).toContain("seed-claim-secret.mjs");
    expect(names.length).toBeGreaterThanOrEqual(5);
  });
});
