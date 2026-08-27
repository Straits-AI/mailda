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
 * That was established by deleting the clause and re-running `test/message-search.test.ts`: all twelve tests
 * still passed, including the cross-organization one. So a behavioural test **cannot** hold this predicate,
 * and a comment claiming the tests cover it would be the defect #103 names — which is what the first draft of
 * that file said, before it was checked.
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

/** The index's name, and the only way to read it. */
const INDEX = "message_search";

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

  it("keeps the index's writes in one file, so its lifetime cannot be split across two", () => {
    /*
     * The lesson `original-bytes-world.test.ts` was written for: two halves of one lifetime lived four
     * hundred lines apart, in different files, and diverged for four months because nothing ever put them
     * side by side. One file is what makes the next reader compare them.
     *
     * It matters more here than usual because the delete does not exist yet — see the case above. When
     * message deletion arrives, whoever adds it must put the index delete beside `indexMessage`, where the
     * insert it has to mirror is visible, rather than beside the message delete where the index is out of
     * sight. That is also what keeps it an ordinary statement rather than an FTS5 trigger, which is the
     * textbook pattern and which `content-deletion-world.test.ts`'s inventory could not see.
     */
    const writers = sourceFiles("src").filter((file) => {
      const source = readFileSync(join(workerDir, file), "utf8");
      return new RegExp(`INSERT INTO\\s+${INDEX}\\b`).test(source);
    });
    expect(writers).toEqual(["src/search.ts"]);
  });
});
