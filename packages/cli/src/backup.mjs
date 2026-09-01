import { createHash } from "node:crypto";

/**
 * What a backup is, and what checking one offline can establish (#92).
 *
 * ## The shape
 *
 * Three files in a directory:
 *
 *   `catalog.sql`      — `wrangler d1 export`. The thing you restore. Carries the manifests, the audit
 *                        chain, and the wrapped vault escrow, because all three are rows.
 *   `inventory.jsonl`  — every R2 object with the hash its plaintext should have (`/api/evidence/inventory`).
 *                        The thing a restored bucket is checked against, object by object.
 *   `index.json`       — what the other two are supposed to contain, and a SHA-256 of each.
 *
 * ## What `verify-backup` can and cannot establish
 *
 * It reads the artifact and nothing else, so it answers exactly one question: **is this backup the one that
 * was taken?** Every file present, every hash matching, the line count agreeing with what the index claims.
 * That catches a truncated copy, a partial download, a corrupted transfer, and a directory somebody edited —
 * which is most of how a backup is found to be useless, and all of it findable *before* the day it is needed.
 *
 * It cannot establish that the evidence decrypts, because the objects are not in the backup: the inventory
 * lists them. Nor that the D1 dump restores. Both are properties of a *restore*, and #92 is explicit that the
 * restore is the step that makes the rest true. This is the part that can be checked every day without one.
 *
 * The distinction is stated in the command's own output rather than left to a reader, because "the backup
 * verified" is exactly the sentence somebody will remember on the day it matters.
 */

export function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The index describing a backup.
 *
 * `takenAt` and the Node's version are recorded because a backup is only meaningful against a schema: a dump
 * restored into code that predates its migrations is a Node answering requests it cannot honour, which is the
 * failure #98 spent its length on from the other direction.
 */
export function backupIndex({
  node, nodeVersion, takenAt, catalog, inventory, objects, unaccounted, verified,
  excludedTables = [], migrationsToReapply = [],
}) {
  return {
    format: "mailda-backup/1",
    node,
    nodeVersion,
    takenAt,
    catalog: { file: "catalog.sql", bytes: catalog.length, sha256: sha256Of(catalog) },
    inventory: {
      file: "inventory.jsonl",
      bytes: inventory.length,
      sha256: sha256Of(inventory),
      objects,
      /*
       * Carried in the index rather than left to be recounted, because it is the number an operator should
       * see *before* trusting a backup: objects the bucket holds that no live row names. A restore puts them
       * back and nothing will reference them.
       */
      unaccounted,
    },
    /**
     * What a verification sweep found at the moment the backup was taken, or `null` for "not asked".
     *
     * `null` is not "clean" and the checker below says so. A backup nobody verified is the ordinary case —
     * the sweep opens every object and costs accordingly — but recording the *absence* is what stops a later
     * reader inferring a clean bill of health from a quiet field.
     */
    verified,
    /**
     * What the export left out, and what a restore has to do about it.
     *
     * Both carried in the index rather than left to a runbook, because both are properties of **this**
     * backup: which tables the database had when it was taken, and which migrations it believed were
     * applied. A runbook describes the general case; a restore needs the particular one.
     */
    excludedTables,
    migrationsToReapply,
  };
}

/**
 * Whether a backup on disk is the one its index describes.
 *
 * Returns every problem rather than the first. A backup is checked rarely and usually in a hurry, and being
 * told about a missing file, then a bad hash, then a short inventory across three runs is how a restore turns
 * into an evening.
 */
export function checkBackup({ index, catalog, inventory }) {
  const problems = [];

  if (index === null) {
    return { ok: false, problems: [{ what: "index.json is missing or unreadable", fix: "this directory is not a Mailda backup, or the copy is incomplete" }], notes: [] };
  }
  if (index.format !== "mailda-backup/1") {
    problems.push({
      what: `unknown backup format \`${index.format ?? "(absent)"}\``,
      fix: "this was written by a different version of mailda; restore with the version that wrote it",
    });
  }

  for (const [name, actual, declared] of [["catalog.sql", catalog, index.catalog], ["inventory.jsonl", inventory, index.inventory]]) {
    if (actual === null) {
      problems.push({ what: `${name} is missing`, fix: "the copy is incomplete — take or fetch the backup again" });
      continue;
    }
    if (declared === undefined || declared === null) {
      problems.push({ what: `index.json does not describe ${name}`, fix: "the index is from a different backup" });
      continue;
    }
    if (actual.length !== declared.bytes) {
      problems.push({
        what: `${name} is ${actual.length} bytes, and the index says ${declared.bytes}`,
        fix: "a truncated copy. Take or fetch the backup again",
      });
    }
    const digest = sha256Of(actual);
    if (digest !== declared.sha256) {
      problems.push({
        what: `${name} does not hash to what the index recorded`,
        fix: `expected ${String(declared.sha256).slice(0, 16)}…, found ${digest.slice(0, 16)}…. The file has changed since it was written`,
      });
    }
  }

  /*
   * The line count, checked against the index rather than trusted. A truncated JSONL is the one corruption
   * that leaves a *valid* file — every remaining line parses, and the inventory simply describes less of the
   * bucket than it did. The byte length above catches it too; this catches the case where somebody rewrote
   * the file and the hash was updated with it.
   */
  if (inventory !== null && index.inventory?.objects !== undefined) {
    const lines = inventory.toString("utf8").split("\n").filter((line) => line.trim() !== "").length;
    if (lines !== index.inventory.objects) {
      problems.push({
        what: `inventory.jsonl holds ${lines} object(s), and the index says ${index.inventory.objects}`,
        fix: "the inventory was rewritten. Take the backup again",
      });
    }
  }

  const notes = [];
  if (index.inventory?.unaccounted > 0) {
    notes.push(
      `${index.inventory.unaccounted} object(s) in this backup are named by no live row. A restore puts them `
      + "back and nothing will reference them — `mailda doctor` reports the same figure as evidence orphans.",
    );
  }
  if ((index.migrationsToReapply ?? []).length > 0) {
    notes.push(
      `this backup excludes the search index, so a restore must re-run ${index.migrationsToReapply.join(", ")} `
      + "and rebuild it. `d1_migrations` travels with the dump and says they were applied, so `migrations "
      + "apply` will skip them unless those rows are removed first.",
    );
  }
  if (index.verified === null || index.verified === undefined) {
    notes.push(
      "nothing verified the evidence when this backup was taken, so the hashes in it are what the Node "
      + "recorded rather than what its objects currently contain. `mailda backup --verify` does that sweep.",
    );
  } else if (index.verified.checked === 0) {
    /*
     * A sweep that examined nothing is not a verified backup, and the index cannot tell the difference on its
     * own: `{checked: 0, faults: 0}` is what both a clean Node with no mail and a broken sweep produce.
     *
     * This is the third time the same vacuity has had to be caught in this feature — once in the verifier's
     * own tests (`intact: true` over zero receipts), once in the CLI's success message, and now in the
     * index. Each layer reported the layer below's honest zero as its own good news.
     */
    notes.push(
      "the sweep that ran when this backup was taken checked **nothing** — zero messages. That is not a clean "
      + "bill of health. On a Node holding evidence it means the sweep found no receipts to check, which is "
      + "worth understanding before relying on this backup.",
    );
  } else if (index.verified.faults > 0) {
    problems.push({
      what: `${index.verified.faults} fault(s) were already present when this backup was taken`,
      fix: "the evidence was not intact at the time. `mailda verify-evidence` names each one",
    });
  }

  return { ok: problems.length === 0, problems, notes };
}

/**
 * Why an administrator's credentials cannot exist on this Node, or `null` if they can (#92).
 *
 * ## The confusing message this replaces
 *
 * `mailda backup` and `mailda verify-evidence` both need `org.admin`, so both asked for `MAILDA_EMAIL` and
 * `MAILDA_PASSWORD` and then failed at sign-in. On an **unclaimed** Node that is a request for something that
 * cannot exist: claiming is the step that creates the first organization, the first user and that user's
 * password — `claim.ts` says so in as many words, *"Claim is also where the owner sets a password, and that is
 * not incidental"*. No organization means no users, so there is nobody to be an administrator.
 *
 * The old path told the operator to go and find credentials, which is the one thing that cannot work. This
 * says what is actually missing.
 *
 * Reading `claimed` rather than probing the login route on purpose: a failed sign-in is recorded and counts
 * toward lockout, so diagnosing an unclaimed Node by attempting to authenticate against it would leave a
 * trail of failures for a Node that has nobody to lock out.
 */
export function whyAdminCannotExist(report) {
  if (report?.claimed !== false) return null;
  return {
    what: "this Node has not been claimed, so it has no administrator to sign in as",
    why: "claiming creates the first organization, its first user, and that user's password — until then "
      + "there is no organization, so there are no users and nobody holds `org.admin`. There is also nothing "
      + "to back up yet: an unclaimed Node holds no mail",
    fix: "claim it first — `mailda claim-secret` writes the install secret, and the claim sets the first "
      + "administrator's email and password. Then re-run this with those in MAILDA_EMAIL and MAILDA_PASSWORD",
  };
}

/**
 * Which tables a D1 export may include, and which it must leave out (#92).
 *
 * ## The platform limit that made this necessary
 *
 * `wrangler d1 export` refuses a whole database outright:
 *
 *     D1 Export error: cannot export databases with Virtual Tables (fts5)
 *
 * Mailda's catalog has two — `message_search` and `message_body_search` — so **no Mailda Node could be
 * exported at all**. `mailda backup` was unusable from the day it shipped, and the first real run is what
 * found it. A selective export (`--table` per name) is accepted, so the fix is to name the tables rather than
 * ask for the database.
 *
 * ## Why excluding the index is right rather than a workaround
 *
 * `AGENTS.md`: *"Parsed forms, search indexes and AI outputs are rebuildable derivatives — and must actually
 * be rebuildable, tested."* The search index is derived from evidence that **is** in the backup, so carrying
 * it would be backing up a cache. The platform limit pushed the design where the repository's own rule
 * already pointed.
 *
 * ## What is excluded, and why each
 *
 *   virtual tables       fts5, which is what the exporter refuses.
 *   their shadow tables  `<name>_data`, `_idx`, `_content`, `_docsize`, `_config` — created and owned by
 *                        fts5, meaningless without it, and named by prefix rather than by a list so a
 *                        future suffix cannot be missed.
 *   `_cf_KV`             Cloudflare's own internal table, not this Node's data.
 *   `sqlite_*`           SQLite's own.
 *
 * Everything else is included by **derivation**, not by a list: a table added to a migration is in the next
 * backup without anybody remembering, which is the property a hardcoded list would quietly lose.
 */
export function exportableTables(sqliteMaster) {
  const tables = sqliteMaster.filter((row) => typeof row.name === "string");
  const virtual = tables
    .filter((row) => typeof row.sql === "string" && /VIRTUAL\s+TABLE/i.test(row.sql))
    .map((row) => row.name);

  const excluded = [];
  const included = [];
  for (const { name } of tables) {
    if (virtual.includes(name)) {
      excluded.push({ name, why: "a virtual table; `wrangler d1 export` refuses a database containing one" });
    } else if (virtual.some((v) => name.startsWith(`${v}_`))) {
      excluded.push({ name, why: "an fts5 shadow table, owned by a virtual table and meaningless without it" });
    } else if (name === "_cf_KV") {
      excluded.push({ name, why: "Cloudflare's internal table, not this Node's data" });
    } else if (name.startsWith("sqlite_")) {
      excluded.push({ name, why: "SQLite's own" });
    } else {
      included.push(name);
    }
  }
  return { included: included.sort(), excluded: excluded.sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * The migrations a restore has to re-run, because the tables they create are not in the backup.
 *
 * ## The trap this names
 *
 * `d1_migrations` **is** exported — it is an ordinary table. So a restored catalog says migration 0040 has
 * been applied while the virtual table it creates is absent, and `wrangler d1 migrations apply` will believe
 * it and skip. The restored Node then has a search index that exists in its bookkeeping and nowhere else,
 * and the failure surfaces the first time somebody searches.
 *
 * Recorded in the backup rather than left to the runbook alone, because the list is a property of the
 * migrations that were applied when the backup was taken — not of whatever the restoring checkout happens to
 * contain.
 */
export function migrationsToReapply(sqliteMaster, migrationRows) {
  const { excluded } = exportableTables(sqliteMaster);
  if (excluded.every((one) => !one.why.startsWith("a virtual table"))) return [];
  /*
   * Matched on the migration's own name rather than by number: the numbers move when migrations are
   * renamed, and a name that no longer exists in the restoring checkout is more obviously wrong than a
   * number that silently points at a different file.
   */
  return migrationRows
    .filter((row) => typeof row.name === "string" && /search/i.test(row.name))
    .map((row) => row.name)
    .sort();
}
