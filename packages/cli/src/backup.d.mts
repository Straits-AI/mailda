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
