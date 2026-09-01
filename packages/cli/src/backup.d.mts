/**
 * Types for `backup.mjs`, so a TypeScript test can import it.
 *
 * Hand-written like its siblings, and compared against the module's real exports by
 * `test/node/declaration-drift.test.ts` — which exists because one of them kept exporting a function after
 * the function was deleted.
 */

export interface BackupPart {
  file: string;
  bytes: number;
  sha256: string;
}

export interface BackupIndex {
  format: string;
  node: string;
  nodeVersion: string | null;
  takenAt: string;
  catalog: BackupPart;
  inventory: BackupPart & { objects: number; unaccounted: number };
  /** What a sweep found when the backup was taken, or `null` for "not asked" — which is not "clean". */
  verified: { checked: number; faults: number } | null;
}

export function sha256Of(bytes: Uint8Array | string): string;

export function backupIndex(args: {
  node: string;
  nodeVersion: string | null;
  takenAt: string;
  catalog: Uint8Array | string;
  inventory: Uint8Array | string;
  objects: number;
  unaccounted: number;
  verified: { checked: number; faults: number } | null;
}): BackupIndex;

/**
 * Whether a backup on disk is the one its index describes — every problem, not the first.
 *
 * Answers that one question and no other: it cannot establish that the evidence decrypts (the objects are not
 * in the backup, the inventory lists them) or that the dump restores. Both are properties of a restore.
 */
export function checkBackup(args: {
  index: BackupIndex | null;
  catalog: Uint8Array | null;
  inventory: Uint8Array | null;
}): {
  ok: boolean;
  problems: Array<{ what: string; fix: string }>;
  notes: string[];
};

/**
 * Why an administrator's credentials cannot exist on this Node, or `null` if they can.
 *
 * An unclaimed Node has no organization, therefore no users, therefore nobody holding `org.admin`. Asking
 * such an operator for credentials is asking for something that cannot exist.
 */
export function whyAdminCannotExist(report: unknown): { what: string; why: string; fix: string } | null;

export interface ExcludedTable {
  name: string;
  why: string;
}

/**
 * Which tables a D1 export may include, and which it must leave out.
 *
 * `wrangler d1 export` refuses a whole database containing an fts5 virtual table, so the tables are named
 * rather than the database. The search index is excluded because it is a rebuildable derivative — carrying it
 * would be backing up a cache.
 */
export function exportableTables(sqliteMaster: Array<{ name?: unknown; sql?: unknown }>): {
  included: string[];
  excluded: ExcludedTable[];
};

/**
 * The migrations a restore has to re-run, because the tables they create are not in the backup.
 *
 * `d1_migrations` is exported like any table, so a restored catalog claims they were applied while the
 * virtual tables they create are absent.
 */
/** Whether a restore must rebuild the search index — the one derivative the export leaves out. */
export function needsIndexRebuild(sqliteMaster: Array<{ name?: unknown; sql?: unknown }>): boolean;
