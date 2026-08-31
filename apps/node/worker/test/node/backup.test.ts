import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const backup = await import("../../../../../packages/cli/src/backup.mjs");
const { backupIndex, checkBackup, sha256Of } = backup;

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

describe("the command says what a passing check does not mean", () => {
  const cli = readFileSync(
    join(import.meta.dirname, "../../../../../packages/cli/src/mailda.mjs"),
    "utf8",
  );

  it("tells the operator the evidence bytes are not in the backup", () => {
    /*
     * The half this command does not do, and the half an operator will assume it did. An inventory without
     * the objects restores nothing — so `backup` says so last, where it is read, rather than only in a doc.
     */
    expect(cli).toContain("the evidence bytes are NOT in this backup");
  });

  it("tells the operator what a verified backup has not established", () => {
    // "The backup verified" is the sentence somebody will remember on the day it matters.
    expect(cli).toContain("what that does not establish");
    expect(cli).toContain("that the evidence decrypts");
    expect(cli).toContain("that the catalog restores");
  });
});
