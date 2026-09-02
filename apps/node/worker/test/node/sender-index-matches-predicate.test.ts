import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { withoutComments } from "../without-comments.ts";

/**
 * The sender index and the sender predicate spell the same expression (#152).
 *
 * ## The gap a mutation found
 *
 * `test/sender-filter.measure.test.ts` proves that an index on `lower(envelope_from)` turns a 1,207-row scan
 * into a 9-row seek. But it **creates that index itself**, so the migration's actual SQL is never exercised:
 * dropping `lower(...)` from the shipped `CREATE INDEX` left all three of its assertions passing.
 *
 * That failure would be invisible and expensive. An index on the raw column cannot serve a predicate on the
 * expression, so the planner declines it, every sender-filtered page goes back to scanning the archive, and
 * the only symptom is a query that is slower than a receipt says it is.
 *
 * ## Why lexical is the right shape here
 *
 * The coupling *is* textual: SQLite matches an expression index by the expression's text, so "these two
 * strings agree" is precisely the property, not a proxy for it. What this cannot check is that the index
 * exists in the database — the measurement does that, and it is why both tests are needed.
 */

const worker = join(import.meta.dirname, "../..");

/** The sender index's definition, from whichever migration introduces it. */
function indexDefinition(): string {
  const dir = join(worker, "migrations");
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".sql")) continue;
    const sql = withoutComments(join(dir, name));
    const match = /CREATE INDEX\s+ir_org_sender\s+ON\s+([^;]+);/i.exec(sql);
    if (match !== null) return match[1] as string;
  }
  throw new Error("no migration creates ir_org_sender");
}

/** How `messagePageQuery` spells the sender filter. */
function predicate(): string {
  const source = withoutComments(join(worker, "src/authz-read.ts"));
  const match = /filters\.push\("AND ([^"]*envelope_from[^"]*)"\)/.exec(source);
  expect(match, "no sender predicate was found in messagePageQuery").not.toBeNull();
  return (match?.[1] ?? "");
}

describe("the sender index is the one the predicate can use", () => {
  it("finds both, so nothing below compares against nothing", () => {
    expect(indexDefinition()).toContain("ingress_receipts");
    expect(predicate()).toContain("envelope_from");
  });

  it("indexes the expression the predicate compares", () => {
    /*
     * `lower(envelope_from)` on both sides. An index on the bare column is not a candidate for a predicate
     * on the expression — SQLite matches these textually — so a mismatch costs the seek and reports nothing.
     */
    const index = indexDefinition().replace(/\s+/g, "");
    expect(index, "the index is not on lower(envelope_from), so the predicate cannot use it")
      .toContain("lower(envelope_from)");
    expect(predicate().replace(/\s+/g, "")).toContain("lower(r.envelope_from)=?");
  });

  it("keeps the ordering columns after the sender, so a filtered page still seeks", () => {
    /*
     * `accepted_at, id` trailing the sender is what makes a sender-filtered page a seek into the keyset
     * position rather than a sort of that sender's whole correspondence. An index of `(org_id, sender)`
     * alone would answer the filter and lose the paging, which is the half `ir_org_accepted` exists for.
     */
    const index = indexDefinition().replace(/\s+/g, "");
    expect(index).toContain("lower(envelope_from),accepted_at,id");
  });

  it("puts the organisation first, as every other index on this table does", () => {
    // A tenant-scoped table's index that does not lead with the organisation is one the planner can only
    // use after it has read somebody else's rows.
    expect(indexDefinition().replace(/\s+/g, "")).toMatch(/\(org_id,/);
  });
});
