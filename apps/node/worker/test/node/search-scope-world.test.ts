import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workerDir = join(import.meta.dirname, "../..");

/**
 * A closed world over every read of the search index (#107).
 *
 * ## Why this is lexical, and the honest reason
 *
 * `messagePageQuery`'s search subquery reads
 * `WHERE message_search MATCH ? AND org_id = ?`, and **the `org_id` half changes no behaviour today.** The
 * listing already scopes to one organization with `WHERE r.org_id = ?` on the outer query, so the subquery
 * could return every organization's matching ids and the answer would be identical.
 *
 * That was established by deleting the clause and re-running `test/message-search.test.ts`: every test still
 * passed, including the cross-organization one. So a behavioural test **cannot** hold this predicate, and a
 * comment claiming the tests cover it would be the defect #103 names — which is what the first draft of that
 * file said, before it was checked.
 *
 * **The body index is not the same case.** It cannot carry an `org_id` at all, so there the join *is* the
 * only scoping and removing it would be a live cross-organization read rather than a redundancy. Both rules
 * live here because both are claims about the shape of a statement, but only one of them is guarding
 * something a test could not otherwise reach.
 *
 * AGENTS.md principle 2b says every assertion needs to be able to fail. An unfalsifiable clause with a
 * comment calling it a defence is worse than no clause, because the next reader trusts it. The two honest
 * responses were to delete the clause or to guard it with something that can fail; this is the second, and it
 * is the shape `content-deletion-world.test.ts` and `original-bytes-world.test.ts` already use for properties
 * that live in the source rather than in a response.
 *
 * ## What it is actually defending
 *
 * The risk is not today's query. It is the next one. `MATCH` is evaluated before any join, so a read of this
 * index that does *not* join `messages` — a count, an autocomplete, a "did you mean", a maintenance
 * script — matches across every organization on the Node, and nothing downstream would narrow it. This file
 * makes that read impossible to add silently: any new `MATCH` against `message_search` must name `org_id` in
 * the same statement or fail here.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(workerDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out;
}

/** The metadata index, which can carry its own `org_id`. */
const INDEX = "message_search";

/**
 * The body index, which cannot.
 *
 * A contentless FTS5 table stores no column values, so an `UNINDEXED org_id` reads back `null` — measured
 * before the migration was written. Its rows therefore cannot say which organization they belong to, and the
 * scoping has to come from the join to `messages` in the same statement. Same property as `INDEX`'s rule,
 * different mechanism, so it gets its own assertion rather than being folded in.
 */
const BODY_INDEX = "message_body_search";

/**
 * Statements that read the index, as text.
 *
 * Split on `MATCH` rather than parsed: a statement here is a template literal spanning several lines, so the
 * unit examined is the text from the `MATCH` back to the nearest `SELECT` and forward to the closing quote.
 * Crude on purpose — the question is only whether `org_id` is named nearby, and a parser would be a second
 * thing to get wrong.
 */
function matchSites(): { file: string; statement: string }[] {
  const found: { file: string; statement: string }[] = [];
  for (const file of sourceFiles("src")) {
    const source = readFileSync(join(workerDir, file), "utf8");
    // Prose mentions are not statements. A `MATCH` inside a comment proves nothing either way.
    const code = source.split("\n").filter((line) => {
      const t = line.trimStart();
      return !(t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    }).join("\n");
    if (!code.includes(`${INDEX} MATCH`)) continue;
    for (const chunk of code.split(`${INDEX} MATCH`).slice(1)) {
      // The rest of this statement: up to the backtick or semicolon that ends it.
      found.push({ file, statement: chunk.split(/[`;]/)[0] ?? "" });
    }
  }
  return found;
}

describe("every read of the search index names the organization it is reading for", () => {
  it("finds a MATCH to inspect, so nothing below passes by scanning nothing", () => {
    /*
     * Anti-vacuity, and the failure this guards is real rather than theoretical: if the search predicate were
     * renamed, removed or moved into a builder this scan does not read, every assertion below would agree
     * with everything and the file would go on reporting success about a subsystem it no longer sees.
     */
    expect(matchSites().length, `no "${INDEX} MATCH" in src — has the search predicate moved?`)
      .toBeGreaterThan(0);
  });

  it("names org_id in the same statement as every MATCH", () => {
    /*
     * The rule. Checked per statement rather than per file, because a file holding one scoped read and one
     * unscoped read would pass any file-level check — and the unscoped one is the whole risk.
     */
    const unscoped = matchSites().filter(({ statement }) => !statement.includes("org_id"));
    expect(
      unscoped.length === 0 ? null : unscoped.map(({ file, statement }) =>
        `${file}: a ${INDEX} MATCH does not name org_id in the same statement — `
        + "MATCH is evaluated before any join, so this read spans every organization on the Node "
        + `unless something narrows it here. Statement: ${statement.trim().slice(0, 120)}`).join("\n"),
    ).toBeNull();
  });

  it("still has nothing that deletes a message, which is what carries the index-lifetime rule for now", () => {
    /*
     * #105 requires the index row to die with the message. **No code path deletes a message row.** Content
     * deletion today is the single `EVIDENCE.delete` in `reconcile.ts`, which destroys an R2 blob and leaves
     * `messages` intact — so the rule has no event to attach to, and a `DELETE FROM message_search` written
     * now would be a statement nothing reaches, plus an entry in `content-deletion-world.test.ts`'s inventory
     * describing a deletion that happens nowhere.
     *
     * So the rule is carried by this assertion instead, and the direction matters: it asserts a fact about
     * **today** and therefore fails on the day message deletion is added, rather than being an `if X then Y`
     * over an X that never happens — which would be a vacuous assertion of exactly the kind AGENTS.md
     * principle 2b forbids, and which the first draft of this work managed to write twice.
     *
     * When it fails, the fix is not to update the number. It is to delete the message's index row in the same
     * function, declare that delete in the content-deletion inventory, and delete this test — replacing it
     * with the guard assertion the inventory requires.
     */
    const deleters = sourceFiles("src").filter((file) =>
      /DELETE\s+FROM\s+messages\b/i.test(readFileSync(join(workerDir, file), "utf8")));
    expect(
      deleters.length === 0 ? null : `${deleters.join(", ")} deletes a message row, and `
      + `${INDEX} has no delete — the search index would keep answering with the subject line of a message `
      + "the product has been told to forget, with no message left for any deletion path to reach. "
      + "Add the index delete beside it, declare it in content-deletion-world, and replace this test.",
    ).toBeNull();
  });

  it("joins the body index to messages in the same statement, since it cannot carry an org_id", () => {
    /*
     * The body index's version of the rule above. It has no `org_id` column to name — a contentless table
     * stores no column values — so what must be present is the join that knows whose mail a rowid belongs to.
     *
     * A `MATCH` against this table without that join matches **every organization's message bodies** and hands
     * back rowids, which is worse than the metadata case: subjects are already plaintext in D1, and body
     * tokens are the thing ADR 28's amendment concedes narrowly and on the assumption that reads are scoped.
     */
    /*
     * The window is anchored on `FROM message_body_search`, not on the `MATCH`.
     *
     * The first version walked *backwards* from the match by a fixed number of characters, and that silently
     * bled into the neighbouring arm of the same `UNION` — which has its own `r.org_id = ?`, so deleting the
     * body arm's scoping left the rule passing. Anchoring on the `FROM` that names this table gives the arm
     * itself: its joins and its `WHERE` are all after it, and the other arm is all before it.
     *
     * Walking back to the nearest `SELECT` was the other candidate and is wrong: the shared column list
     * contains `(SELECT c.id FROM cases c …)`, so the nearest preceding `SELECT` is *inside* the columns and
     * the window would start after the joins.
     */
    const sites: { file: string; statement: string }[] = [];
    for (const file of sourceFiles("src")) {
      const code = readFileSync(join(workerDir, file), "utf8").split("\n").filter((line) => {
        const t = line.trimStart();
        return !(t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      }).join("\n");
      if (!code.includes(`${BODY_INDEX} MATCH`)) continue;
      for (const chunk of code.split(new RegExp(`FROM\\s+${BODY_INDEX}\\b`)).slice(1)) {
        // To the end of this arm: the closing paren of the subquery, a backtick, or a semicolon.
        sites.push({ file, statement: chunk.split(/[`;]|\n\s{0,8}\)/)[0] ?? "" });
      }
    }

    // Anti-vacuity: the same failure the metadata rule guards against, and the same reason.
    expect(sites.length, `no "${BODY_INDEX} MATCH" in src — has the body search predicate moved?`)
      .toBeGreaterThan(0);

    /*
     * `r.org_id` or `m.org_id` specifically, not any `org_id`. The authorization subquery contains
     * `WHERE org_id = ?` — which scopes the *reader's tuples*, not the mail — so a bare `includes("org_id")`
     * would be satisfied by a statement that never scoped the messages at all. Checked by deleting
     * `AND r.org_id = ?` from the body arm: the loose form passed, this one fails.
     */
    const unjoined = sites.filter(({ statement }) =>
      !/JOIN\s+messages\s+\w*\s*ON[^)]*rowid/.test(statement) || !/\b[rm]\.org_id\s*=/.test(statement));
    expect(
      unjoined.length === 0 ? null : unjoined.map(({ file }) =>
        `${file}: a ${BODY_INDEX} MATCH is not joined to messages on rowid with an org_id predicate in the `
        + "same statement. A contentless index cannot say whose mail a rowid is, so nothing else can scope "
        + "this read.").join("\n"),
    ).toBeNull();
  });

  it("requires content.read for the body index and never metadata.read", () => {
    /*
     * The authorization boundary, guarded lexically as well as behaviourally.
     * `test/message-search.test.ts` asserts a `metadata.read` holder gets no body matches, and that test does
     * fail when `BODY_SEARCH_RELATIONS` is widened — so this is belt and braces rather than the only guard.
     *
     * It is here because the behavioural test can only see the relations that exist today. This one fails if
     * the body arm is ever pointed at `RELATIONS_FOR_METADATA`, which is the single most likely edit: the two
     * constants sit next to each other, one is used twice, and the names are similar.
     */
    const source = readFileSync(join(workerDir, "src/authz-read.ts"), "utf8");
    expect(source, "the body arm no longer names BODY_SEARCH_RELATIONS")
      .toMatch(/authorizedBy\(BODY_SEARCH_RELATIONS, "sgc"\)/);

    /*
     * **And the grant half, which is where this rule was blind.** Standing relations were split correctly
     * from the start; the supervised arm was not. One subquery built from `SCOPES_FOR_METADATA` — which is
     * `["metadata", "content"]` — authorized *both* index arms, so a grant of scope `metadata` reached the
     * body index and became a membership oracle over message text.
     *
     * This file asserted the relation split and said nothing about the grant split, so it passed throughout.
     * A closed world that guards one of two authorization mechanisms is a closed world with a door in it.
     */
    expect(source, "the metadata arm no longer authorizes on the metadata-scoped grant subquery")
      .toMatch(/authorizedBy\(RELATIONS_FOR_METADATA, "sgm"\)/);
    expect(
      /content: liveGrantsBySubject\([^)]*SCOPES_FOR_CONTENT\)/.test(source),
      "listMessages no longer builds a content-scoped grant subquery, so the body arm is authorized by a "
      + "grant list that includes scope metadata",
    ).toBe(true);

    const access = readFileSync(join(workerDir, "src/access.ts"), "utf8");
    const declaration = /export const BODY_SEARCH_RELATIONS = \[([\s\S]*?)\]/.exec(access)?.[1] ?? "";
    expect(declaration, "the body index accepts a relation weaker than content.read — a metadata reader can "
      + "now learn which words occur in a message body").not.toContain("metadata.read");
    expect(declaration, "BODY_SEARCH_RELATIONS no longer names content.read, so body search grants nothing")
      .toContain("mailbox.content.read");
  });

  it("keeps the index's writes to the two files allowed to have them", () => {
    /*
     * The lesson `original-bytes-world.test.ts` was written for: two halves of one lifetime lived four
     * hundred lines apart, in different files, and diverged for four months because nothing ever put them
     * side by side.
     *
     * **This was one file and is now two, and the second one is not a relaxation.** `search-backfill.ts`
     * exists because `doctor-meter-honesty.test.ts` forbids `.batch(` in any file on the doctor path — the
     * cost meter counts a batch as zero executions — and `doctor` imports the counting functions from
     * `search.ts`. `decidersByMailbox` was split out for the same guard, and that guard's own comment records
     * it, so this is the established shape rather than a workaround.
     *
     * What the rule still holds is that there is no **third** writer. And the lifetime rule survives in the
     * form that matters: when message deletion arrives, the index delete belongs beside `indexBody` in
     * `search.ts`, where the insert it has to mirror is visible — not beside the message delete, where the
     * index is out of sight.
     */
    const writers = sourceFiles("src").filter((file) => {
      const source = readFileSync(join(workerDir, file), "utf8");
      return new RegExp(`INSERT (INTO|OR REPLACE INTO)\\s+(${INDEX}|${BODY_INDEX})\\b`).test(source);
    });
    expect(writers.sort()).toEqual(["src/search-backfill.ts", "src/search.ts"]);

    /*
     * And the split is only justified while the reason for it holds. If `search.ts` ever gains a `.batch(`,
     * the two files are separated for nothing and the guard that forced the split would be failing instead.
     */
    expect(
      readFileSync(join(workerDir, "src/search.ts"), "utf8").includes(".batch("),
      "search.ts now batches, which is what search-backfill.ts was split out to avoid — either move the "
      + "batch or merge the files back",
    ).toBe(false);
  });
});
