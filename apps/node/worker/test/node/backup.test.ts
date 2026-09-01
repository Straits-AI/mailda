import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const backup = await import("../../../../../packages/cli/src/backup.mjs");
const {
  backupIndex, checkBackup, exportableTables, needsIndexRebuild, sha256Of, whyAdminCannotExist,
} = backup;

/**
 * Whether a backup on disk is the one its index describes (#92).
 *
 * ## Why this is the part worth testing
 *
 * A backup is written often and read once, in a hurry, on the worst day. Everything about that shape argues
 * for the checker rather than the writer: the writer's mistakes show up immediately, and the checker's show up
 * as a green light in front of a directory that cannot restore.
 *
 * So these are all failure cases. The corruptions are the ones that actually happen — a truncated copy, a
 * partial download, a file somebody edited and re-hashed — and each has to be **named**, because "this backup
 * is bad" sends an operator back to a Node that may no longer exist.
 */

/**
 * The CLI's **code**, with comments stripped.
 *
 * Stripped for a reason that cost a test: an assertion here searched for `"Every one opened and"` to locate
 * the clean-sweep message, and found it four hundred characters earlier inside a **comment quoting that very
 * message** — so an ordering check compared a comment against the code it documents and failed against
 * correct source. That is the seventh time a lexical assertion in this repository has been defeated by a
 * substring, and `deploy-sequence.test.ts` had already learned it; this file had not.
 */
const cli = readFileSync(join(import.meta.dirname, "../../../../../packages/cli/src/mailda.mjs"), "utf8")
  .split("\n")
  .filter((line) => {
    const trimmed = line.trimStart();
    return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
  })
  .join("\n");

const CATALOG = "PRAGMA foreign_keys=OFF;\nINSERT INTO messages VALUES ('msg_1');\n";
const INVENTORY = [
  JSON.stringify({ key: "org_x/raw/a.eml", bytes: 100, uploaded: "2026-08-31T00:00:00.000Z", keyGeneration: 1, recordedSha256: "a".repeat(64) }),
  JSON.stringify({ key: "org_x/raw/b.eml", bytes: 200, uploaded: "2026-08-31T00:00:01.000Z", keyGeneration: 1, recordedSha256: null }),
].join("\n") + "\n";

function taken(overrides: Record<string, unknown> = {}) {
  return backupIndex({
    node: "https://node.example",
    nodeVersion: "c7e7b917-0402-4ea5-b868-aa8e2f574dc4",
    takenAt: "2026-08-31T12:00:00.000Z",
    catalog: CATALOG,
    inventory: INVENTORY,
    objects: 2,
    unaccounted: 1,
    verified: null,
    ...overrides,
  });
}

const bytes = (text: string) => Buffer.from(text, "utf8");

describe("a backup that is what it says it is", () => {
  it("passes when every file is present and hashes as recorded", () => {
    const outcome = checkBackup({
      index: taken(),
      catalog: bytes(CATALOG),
      inventory: bytes(INVENTORY),
    });
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it("records the Node's version, because a dump is only meaningful against a schema", () => {
    /*
     * A catalog restored into code that predates its migrations is a Node answering requests it cannot
     * honour — the failure #98 spent its length on, arrived at from the other side. The version is what lets
     * somebody restoring know which code this dump expects.
     */
    expect(taken().nodeVersion).toBe("c7e7b917-0402-4ea5-b868-aa8e2f574dc4");
    expect(taken().takenAt).toBe("2026-08-31T12:00:00.000Z");
    expect(taken().format).toBe("mailda-backup/1");
  });
});

describe("which tables a D1 export may ask for", () => {
  /*
   * The platform limit that made this necessary, from the first real run of `mailda backup`:
   *
   *     D1 Export error: cannot export databases with Virtual Tables (fts5)
   *
   * This catalog has two, so **no Mailda Node could be exported at all** — the command was unusable from the
   * day it shipped, and only running it found that. A selective export is accepted, so the tables are named.
   *
   * Excluding the search index is not a workaround: `AGENTS.md` already says search indexes are rebuildable
   * derivatives, and it is derived from evidence that *is* in the backup. The platform limit pushed the design
   * where the repository's own rule pointed.
   */
  const MASTER = [
    { name: "users", sql: "CREATE TABLE users (id TEXT)" },
    { name: "d1_migrations", sql: "CREATE TABLE d1_migrations (id INTEGER, name TEXT)" },
    { name: "message_search", sql: "CREATE VIRTUAL TABLE message_search USING fts5(subject)" },
    { name: "message_search_data", sql: "CREATE TABLE message_search_data (id INTEGER)" },
    { name: "message_search_idx", sql: "CREATE TABLE message_search_idx (segid)" },
    { name: "message_body_search", sql: "CREATE VIRTUAL TABLE message_body_search USING fts5(body)" },
    { name: "message_body_search_config", sql: "CREATE TABLE message_body_search_config (k)" },
    { name: "_cf_KV", sql: "CREATE TABLE _cf_KV (key)" },
    { name: "sqlite_sequence", sql: "CREATE TABLE sqlite_sequence (name)" },
  ];

  it("keeps the real tables and drops the index, its shadows, and what is not ours", () => {
    const { included, excluded } = exportableTables(MASTER);
    expect(included).toEqual(["users"]);
    expect(excluded.map((one) => one.name)).toEqual([
      "_cf_KV", "d1_migrations", "message_body_search", "message_body_search_config",
      "message_search", "message_search_data", "message_search_idx", "sqlite_sequence",
    ]);
  });

  it("finds shadow tables by their owner's prefix, not by a list of suffixes", () => {
    /*
     * fts5 owns `_data`, `_idx`, `_content`, `_docsize`, `_config` today and is free to add another. A list of
     * suffixes would let a new one through into the export, where it would restore as a table fts5 does not
     * expect — so the rule is "named after a virtual table" rather than "ends in one of these".
     */
    const withNewSuffix = [...MASTER, { name: "message_search_futurething", sql: "CREATE TABLE x (y)" }];
    const { included } = exportableTables(withNewSuffix);
    expect(included).not.toContain("message_search_futurething");
  });

  it("includes a table added later without anybody listing it", () => {
    // Derivation rather than a list: the property a hardcoded set would quietly lose is that a new table is
    // in the next backup by default. A backup silently missing a table is the worst available outcome.
    const { included } = exportableTables([...MASTER, { name: "invented_later", sql: "CREATE TABLE x (y)" }]);
    expect(included).toContain("invented_later");
  });

  it("leaves out the destination's own migration bookkeeping", () => {
    /*
     * `d1_migrations` describes the **database**, not the organization. A destination is deployed before it
     * is restored into, so its own migrations have already run and its own rows already describe the schema
     * its code created; restoring the source's rows would overwrite that with a claim about a different
     * database.
     *
     * That was the cause of a trap this command shipped with: the restored catalog said the search migrations
     * were applied while the virtual tables they create were absent, so `migrations apply` believed it and
     * skipped. Excluding the table removes the trap rather than documenting a workaround for it.
     */
    const { included, excluded } = exportableTables(MASTER);
    expect(included).not.toContain("d1_migrations");
    expect(excluded.find((one) => one.name === "d1_migrations")?.why).toContain("destination's own");
  });

  it("says the search index needs rebuilding, and only when one was excluded", () => {
    // The one derivative the export leaves out. Its tables exist on a restored Node — its own migrations
    // create them — and only their contents are missing.
    expect(needsIndexRebuild(MASTER)).toBe(true);
    expect(needsIndexRebuild([{ name: "users", sql: "CREATE TABLE users (id TEXT)" }])).toBe(false);
  });
});

describe("a verification that examined nothing", () => {
  it("is reported as such, rather than as a verified backup", () => {
    /*
     * `{checked: 0, faults: 0}` is what both a Node with no mail and a broken sweep produce, and the checker
     * used to look only at `faults`. Measured: the first real backup recorded `verified: {checked: 0}` beside
     * `inventory: {objects: 3}` — three sealed objects with recorded hashes, none examined (#131).
     *
     * Third time this same vacuity has had to be caught in this feature: in the verifier's tests, in the CLI's
     * success message, and now in the index. Each layer read the layer below's honest zero as its own good news.
     */
    const outcome = checkBackup({
      index: taken({ verified: { checked: 0, faults: 0 } }),
      catalog: bytes(CATALOG),
      inventory: bytes(INVENTORY),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.notes.join(" ")).toContain("checked **nothing**");
    expect(outcome.notes.join(" ")).toContain("not a clean bill of health");
  });
});

describe("the corruptions that actually happen", () => {
  it("catches a truncated catalog, and says which file and by how much", () => {
    // The commonest real failure: a copy that stopped. It leaves a file that opens and reads fine.
    const outcome = checkBackup({
      index: taken(),
      catalog: bytes(CATALOG.slice(0, 20)),
      inventory: bytes(INVENTORY),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems.map((one) => one.what).join(" ")).toContain("catalog.sql");
    expect(outcome.problems.map((one) => one.what).join(" ")).toContain("20 bytes");
  });

  it("catches a file that was edited and kept its length", () => {
    /*
     * The corruption a size check cannot see. Same length, different content — a hand edit, or a transfer
     * that flipped bytes. This is what the hash is for, and a checker that only compared sizes would pass it.
     */
    const edited = CATALOG.replace("msg_1", "msg_2");
    expect(edited.length).toBe(CATALOG.length);
    const outcome = checkBackup({ index: taken(), catalog: bytes(edited), inventory: bytes(INVENTORY) });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]?.what).toContain("does not hash to what the index recorded");
  });

  it("catches an inventory that was rewritten with its hash updated", () => {
    /*
     * The one corruption that leaves a *valid* file whose hash also agrees: somebody regenerated both. The
     * object count in the index is the third witness — a shorter inventory describes less of the bucket, and
     * every line in it still parses.
     */
    const shortened = `${INVENTORY.split("\n")[0]}\n`;
    const outcome = checkBackup({
      index: taken({ inventory: shortened }),
      catalog: bytes(CATALOG),
      inventory: bytes(shortened),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]?.what).toContain("holds 1 object(s), and the index says 2");
  });

  it("names a missing file rather than failing on its hash", () => {
    const outcome = checkBackup({ index: taken(), catalog: null, inventory: bytes(INVENTORY) });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]?.what).toBe("catalog.sql is missing");
    // One problem, not two: a missing file must not also be reported as a hash mismatch.
    expect(outcome.problems).toHaveLength(1);
  });

  it("reports every problem at once, because a backup is checked in a hurry", () => {
    const outcome = checkBackup({ index: taken(), catalog: null, inventory: bytes("nonsense\n") });
    expect(outcome.problems.length).toBeGreaterThan(1);
  });

  it("refuses a directory that is not a backup, without guessing", () => {
    const outcome = checkBackup({ index: null, catalog: null, inventory: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]?.what).toContain("index.json is missing");
  });

  it("refuses a format it does not know rather than checking it anyway", () => {
    // A future backup read by an older CLI. Checking it against today's rules would produce confident
    // nonsense, which is worse than declining — the operator still has the files.
    const outcome = checkBackup({
      index: { ...taken(), format: "mailda-backup/2" },
      catalog: bytes(CATALOG),
      inventory: bytes(INVENTORY),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]?.what).toContain("unknown backup format");
  });
});

describe("what the index says about its own limits", () => {
  it("treats an unverified backup as not asked, never as clean", () => {
    /*
     * The distinction this whole file exists to protect. `verified: null` is the ordinary case — the sweep
     * opens every object and costs accordingly — and a reader inferring a clean bill of health from a quiet
     * field is exactly how a backup comes to be trusted for something it never claimed.
     */
    const outcome = checkBackup({ index: taken(), catalog: bytes(CATALOG), inventory: bytes(INVENTORY) });
    expect(outcome.ok).toBe(true);
    expect(outcome.notes.join(" ")).toContain("nothing verified the evidence");
  });

  it("fails a backup that was already faulty when it was taken", () => {
    // Not a note. Evidence that was not intact at backup time is a backup of a known-broken state, and
    // finding that out on the day of the restore is the whole failure this ticket is about.
    const outcome = checkBackup({
      index: taken({ verified: { checked: 500, faults: 3 } }),
      catalog: bytes(CATALOG),
      inventory: bytes(INVENTORY),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]?.what).toContain("3 fault(s) were already present");
  });

  it("says how many objects nothing references, rather than hiding them", () => {
    const outcome = checkBackup({ index: taken(), catalog: bytes(CATALOG), inventory: bytes(INVENTORY) });
    expect(outcome.notes.join(" ")).toContain("named by no live row");
  });

  it("hashes what it is given, so the index cannot describe a different file", () => {
    expect(sha256Of(CATALOG)).toBe(taken().catalog.sha256);
    expect(sha256Of("something else")).not.toBe(taken().catalog.sha256);
  });
});

describe("asking for credentials that cannot exist", () => {
  it("refuses an unclaimed Node instead of demanding an email and password", () => {
    /*
     * Both `backup` and `verify-evidence` need `org.admin`, and both used to ask for `MAILDA_EMAIL` and
     * `MAILDA_PASSWORD` and then fail at sign-in. On an unclaimed Node that is a request for something that
     * **cannot exist**: claiming is what creates the first organization, the first user and that user's
     * password, so until then there are no users and nobody holds anything.
     *
     * The old message sent an operator to find credentials, which is the one thing that cannot work.
     */
    const refusal = whyAdminCannotExist({ claimed: false, verdict: "degraded" });
    expect(refusal).not.toBeNull();
    expect(refusal?.what).toContain("has not been claimed");
    expect(refusal?.fix).toContain("claim-secret");
    // And it names the deeper point: there is nothing to back up on such a Node either.
    expect(refusal?.why).toContain("nothing to back up");
  });

  it("says nothing about a claimed Node, whatever else it reports", () => {
    expect(whyAdminCannotExist({ claimed: true, verdict: "degraded" })).toBeNull();
    expect(whyAdminCannotExist({ claimed: true, verdict: "refuse" })).toBeNull();
  });

  it("does not guess when the report never said", () => {
    /*
     * A report with no `claimed` field is a Node this check cannot read — an older version, or a response
     * that was not what it looked like. Treating that as unclaimed would refuse a working backup; the
     * credentials path is what handles it, and it fails with the truth rather than a guess.
     */
    expect(whyAdminCannotExist({})).toBeNull();
    expect(whyAdminCannotExist(undefined)).toBeNull();
    expect(whyAdminCannotExist(null)).toBeNull();
  });
});

describe("a sweep that checked nothing does not report a clean sweep", () => {

  it("says there was nothing to check, rather than that everything passed", () => {
    /*
     * Found by running `mailda verify-evidence` against a freshly claimed Node, which printed:
     *
     *     0 message(s) checked in 1 batch(es), 0.0 MiB read. Every one opened and
     *     hashed to what was recorded when it arrived.
     *
     * True, and it reads as reassurance about evidence that does not exist. The verifier has a test making
     * exactly this point — `intact: true` with `checked: 0` is honest *only because the caller reads
     * `checked`* — and then the caller wrote a sentence that did not read it. A vacuous pass in the reporting
     * layer is the same defect as one in the assertion layer, and harder to notice because it is prose.
     */
    expect(cli).toContain("nothing to check: this Node holds no stored evidence yet");
    expect(cli).toContain("That is not a clean sweep");

    // And it returns before the clean-sweep sentence rather than printing both.
    const empty = cli.indexOf("nothing to check: this Node holds no stored evidence yet");
    const clean = cli.indexOf("Every one opened and");
    expect(empty).toBeLessThan(clean);
    expect(cli.slice(empty, clean)).toContain("return;");
  });
});

describe("the command says what a passing check does not mean", () => {

  it("names the tables in the export rather than asking for the database", () => {
    /*
     * The one line that makes `mailda backup` work at all. `wrangler d1 export` refuses a database containing
     * an fts5 virtual table — *"cannot export databases with Virtual Tables (fts5)"* — and this catalog has
     * two, so a whole-database export produced nothing and the command was unusable from the day it shipped.
     *
     * Asserted lexically because the suite does not run wrangler: a mutation reverting to the whole-database
     * form passed every value-level test here, and would have shipped a backup command that cannot back up.
     */
    expect(cli).toContain('included.flatMap((name) => ["--table", name])');
    /*
     * And **data only**. The schema comes from the restoring Node's own migrations, so an export carrying
     * `CREATE TABLE` would make every restore fail on its first statement — measured against a freshly
     * deployed destination, whose 53 tables already existed.
     */
    expect(cli).toContain('"--no-schema"');
    // And the list is derived from the database, not written down.
    expect(cli).toContain("exportableTables(master)");
    expect(cli).toContain("SELECT name, sql FROM sqlite_master");
  });

  it("tells the operator the evidence bytes are not in the backup", () => {
    /*
     * The half this command does not do, and the half an operator will assume it did. An inventory without
     * the objects restores nothing — so `backup` says so last, where it is read, rather than only in a doc.
     */
    expect(cli).toContain("the evidence bytes are NOT in this backup");
  });

  it("checks the claim state before it asks for credentials", () => {
    /*
     * Scoped to `backup`'s own body, and that is the sixth time in this repository a lexical assertion has
     * been caught reaching across a function boundary. Searching the whole file for
     * `set MAILDA_EMAIL and MAILDA_PASSWORD` finds `recoveryCodes`' prompt fifty thousand characters earlier,
     * so the order assertion compared two unrelated functions and failed against correct code.
     */
    const body = cli.slice(cli.indexOf("async function backup(argv)"), cli.indexOf("function verifyBackup"));
    expect(body.length, "the backup function could not be isolated").toBeGreaterThan(500);

    // Order is the whole point: asking first and refusing second is what produced the misleading message.
    const claimCheck = body.indexOf("whyAdminCannotExist(");
    const asksFor = body.indexOf("set MAILDA_EMAIL and MAILDA_PASSWORD");
    expect(claimCheck, "backup no longer checks whether an administrator can exist").toBeGreaterThan(-1);
    expect(asksFor, "backup no longer asks for credentials at all").toBeGreaterThan(-1);
    expect(claimCheck).toBeLessThan(asksFor);

    /*
     * Both administrator-only commands, not just the one that prompted it — two calls, counted rather than
     * asserted as "present", because applying this to one command and not the other is the likely half-fix.
     * The count is over comment-stripped source, so it counts calls and not the prose about them.
     */
    expect(cli.split("whyAdminCannotExist(").length - 1).toBe(2);

    /*
     * And it reads the claim state from a probe that tolerates a 401, not from the refusing report helper.
     * The first version called `doctorReport`, which fails on any non-2xx — fine on an unclaimed Node whose
     * report is public, and a 401 on every claimed one, so a check added to improve one message broke both
     * commands for the normal case. Found by running them against a real claimed Node.
     */
    expect(cli).toContain("async function claimState(origin)");
    expect(cli).toContain('if (response.status === 401) return "claimed"');
  });

  it("tells the operator what a verified backup has not established", () => {
    // "The backup verified" is the sentence somebody will remember on the day it matters.
    expect(cli).toContain("what that does not establish");
    expect(cli).toContain("that the evidence decrypts");
    expect(cli).toContain("that the catalog restores");
  });
});
