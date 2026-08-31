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
export function backupIndex({ node, nodeVersion, takenAt, catalog, inventory, objects, unaccounted, verified }) {
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
  if (index.verified === null || index.verified === undefined) {
    notes.push(
      "nothing verified the evidence when this backup was taken, so the hashes in it are what the Node "
      + "recorded rather than what its objects currently contain. `mailda backup --verify` does that sweep.",
    );
  } else if (index.verified.faults > 0) {
    problems.push({
      what: `${index.verified.faults} fault(s) were already present when this backup was taken`,
      fix: "the evidence was not intact at the time. `mailda verify-evidence` names each one",
    });
  }

  return { ok: problems.length === 0, problems, notes };
}
