import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every rate this Node computes counts **attributed** delivery events, and this is what makes that a
 * property of the source rather than a sentence in a comment (#66).
 *
 * ## The defect this is placed in front of
 *
 * `send_recipient_events` has a second writer. `recordDeliveryReport` (`src/outbound/delivery-report.ts`)
 * inserts `event_type = "inbound.delivery_report"` with `terminal = 1` and `manifest_id` **NULL** for delivery
 * reports about *other systems' mail* — its own header names the three ways one arrives. A `COUNT(*)` over
 * that table without `manifest_id IS NOT NULL` counts somebody else's bounces into this Node's rate and stops
 * a Node that has not sent a single bad message, which is the read-a-wrong-number inversion a circuit breaker
 * exists to prevent.
 *
 * ## Why this is a source scan and not a behavioural test
 *
 * `test/breakers.test.ts` builds both corpora — twenty of this Node's own bounces, twenty foreign reports —
 * and asserts that one trips and the other does not. That is the *behavioural* half and it is the more
 * important one, because it exercises the real writer.
 *
 * What it cannot do is bind a **seventh** sub-select. A breaker added next month with a copied `COUNT(*)` and
 * a dropped clause would pass every test in that file, because those tests only ask about the rates that
 * exist today. This asks the question the other way round: *does every sub-select that counts this table
 * carry the predicate*, whatever the sub-selects turn out to be. That is the same shape
 * `test/node/wrangler-world.ts` and `content-deletion-world.test.ts` use, and the reason this repository
 * prefers it: a closed world fails on the thing nobody thought of.
 */

const workerDir = join(import.meta.dirname, "..", "..");
const srcDir = join(workerDir, "src");
const source = readFileSync(join(srcDir, "breakers.ts"), "utf8");

/**
 * Each `(SELECT … FROM send_recipient_events … )` sub-select in the breaker statement, as text.
 *
 * Matched on the table name rather than on the whole statement, so a sub-select added anywhere in the file —
 * inside `BREAKER_SQL` or in a second statement somebody writes later — is caught by the same rule.
 */
function eventSubSelects(): string[] {
  return [...source.matchAll(/\(SELECT[\s\S]*?FROM send_recipient_events[\s\S]*?\)\s+AS\s+\w+/g)]
    .map((match) => match[0]);
}

/** Source with block and line comments removed, so prose about SQL is not mistaken for SQL. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

describe("every rate over send_recipient_events counts attributed events only", () => {
  it("finds the sub-selects at all, so the rule below cannot pass by matching nothing", () => {
    // Anti-vacuity, and it is the whole reason this assertion exists separately: a regex that stopped
    // matching would make every check below trivially true. Five today — the bounce denominator, the bounce
    // numerator, the bounce oldest, the complaint denominator, the complaint numerator and the complaint
    // oldest — and the bound is `>=` so adding one does not fail here, it fails the rule below if it is
    // written wrong.
    expect(eventSubSelects().length).toBeGreaterThanOrEqual(6);
  });

  it("puts manifest_id IS NOT NULL on every one of them", () => {
    const missing = eventSubSelects().filter((sub) => !sub.includes("manifest_id IS NOT NULL")
      && !sub.includes("${ATTRIBUTED}"));
    expect(
      missing.length === 0 ? null
        : `${missing.length} sub-select(s) over send_recipient_events do not restrict to attributed events. `
          + "recordDeliveryReport writes terminal=1 rows with manifest_id NULL for OTHER systems' bounces, so "
          + "this rate would count somebody else's failures into this Node's — the inversion #66's landmine "
          + `comment names. The offending text: ${missing.join(" || ")}`,
    ).toBeNull();
  });

  it("keeps the predicate in one constant, so it cannot be spelled two ways", () => {
    // Six copies is six chances for one to be dropped, and the one dropped is the one that counts foreign
    // mail. The constant is what makes "every sub-select" a property of one line.
    expect(source).toContain('const ATTRIBUTED = "manifest_id IS NOT NULL"');
  });

  it("writes nothing, which is the other half of what the doctor path requires of it", () => {
    // `src/breakers.ts` is on `DOCTOR_PATH`, and its header claims it "writes nothing at all". The meter
    // honesty guard checks no `batch()` and no named prepared statement — it does **not** check for writes,
    // so without this the claim would be a sentence nothing enforces. It matters beyond tidiness: `doctor`
    // is a diagnostic, and a diagnostic that writes is one that changes what it is reporting on.
    const writes = [...source.matchAll(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/g)].map((m) => m[0]);
    expect(
      writes.length === 0 ? null
        : `src/breakers.ts contains ${writes.join(", ")} — it is on doctor's path and must stay read-only. `
          + "The pause's write path is src/domain-pause.ts for exactly this reason.",
    ).toBeNull();
  });

  it("keeps domain_pauses to the two writers its asymmetry is made of", () => {
    // Placing is `src/approvals.ts` (the completing decision's `UPDATE domain_pauses`), because a pause is
    // #61's fifth approval subject. Everything else — the request row and the lift — is `src/domain-pause.ts`.
    // A third writer would be a way to stop or restart a domain's mail that skips one of those two acts, and
    // it is exactly what `content-deletion-world.test.ts` refuses for `holds` on #64's terms.
    const offenders: string[] = [];
    for (const relative of readdirSync(srcDir, { recursive: true, encoding: "utf8" })) {
      if (!relative.endsWith(".ts") || relative === "migrate.ts") continue;
      // Comments stripped first, because `src/audit.ts` *describes* the one `UPDATE domain_pauses` in the
      // catalogue entry for `domain.pause_placed` — and a scan that cannot tell a sentence about SQL from
      // SQL is a scan that fails on good documentation, which is how a guard gets deleted.
      const text = withoutComments(readFileSync(join(srcDir, relative), "utf8"));
      if (!/\b(INSERT INTO domain_pauses|UPDATE domain_pauses|DELETE FROM domain_pauses)\b/.test(text)) {
        continue;
      }
      const path = relative.replace(/\\/g, "/");
      if (path !== "approvals.ts" && path !== "domain-pause.ts") offenders.push(path);
    }
    expect(
      offenders.length === 0 ? null
        : `domain_pauses is written from ${offenders.join(", ")} as well as approvals.ts and `
          + "domain-pause.ts. Placing takes two administrators and lifting takes one; a third writer is a "
          + "way to stop or restart a customer's mail that goes through neither.",
    ).toBeNull();

    // Anti-vacuity: the two expected writers must actually be found, or the scan is passing on nothing.
    for (const expected of ["approvals.ts", "domain-pause.ts"]) {
      expect(
        withoutComments(readFileSync(join(srcDir, expected), "utf8")),
        `${expected} must write domain_pauses, or this scan is passing on nothing`,
      ).toMatch(/\b(INSERT INTO|UPDATE) domain_pauses\b/);
    }
  });

  it("names the second writer where the SQL is, not only in a ticket", () => {
    // AGENTS.md: the next reader must never ask "why is this here?". A `manifest_id IS NOT NULL` with no
    // explanation reads as defensive tidiness, and the first person tidying the SQL would remove it.
    expect(source).toContain("recordDeliveryReport");
    expect(source).toContain("delivery-report.ts");
  });
});
