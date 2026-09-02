import { BUDGETS } from "@mailda/budgets";

import { generationOf } from "./evidence-store.ts";
import { scannedPrefixes } from "./reconcile.ts";

/**
 * What is in the bucket, and what each object is supposed to hash to (#92).
 *
 * ## What this is for
 *
 * #92 asks a customer-owned deployment to survive losing its Cloudflare account: *"A backup that only
 * restores into the account that failed is not a backup for a product whose selling point is that you own the
 * account."* Step 1 of its restore drill is exporting D1, **the R2 object inventory**, and the manifests.
 *
 * D1 is solved — `wrangler d1 export` writes a `.sql` file and needs no code here. R2 is not: a copy of a
 * bucket into another account is a copy nobody has checked unless something says what should be there and
 * what each object should contain. That is this file.
 *
 * ## Every prefix, and a recorded hash for all four
 *
 * The prefixes come from `scannedPrefixes`, which #67 and #74 both exist because of: each was a prefix the
 * Worker wrote and no listing covered. Its completeness is enforced by
 * `test/node/evidence-prefix-world.test.ts`, which derives the written set from `src/` — so this inventory
 * inherits that property instead of carrying a second list. Building a *backup* on a copied list would be the
 * same defect in the place it costs most.
 *
 * Every one of the four turns out to have a referent row carrying the object's SHA-256, which is better than
 * a listing of sizes: a restored copy can be verified object by object rather than in aggregate.
 *
 *   | prefix      | table              | key column                                 | hash column          |
 *   |-------------|--------------------|--------------------------------------------|----------------------|
 *   | `raw/`      | `ingress_receipts` | `blob_key`                                 | `blob_sha256`        |
 *   | `drafts/`   | `drafts`           | `body_key`                                 | `body_sha256`        |
 *   | `exports/`  | `exports`          | `manifest_key`                             | `manifest_sha256`    |
 *   | `sent/`     | `send_manifests`   | three: typed, normalized and submitted     | one hash each        |
 *
 * The hashes are of **plaintext**, as everywhere in this Node, which is what makes them survive a re-seal
 * under a new key generation. A restored object is checked by decrypting it and hashing what comes out, not
 * by comparing stored bytes — `evidence-audit.ts` is the other half, and this is the list it would run over
 * in a fresh account.
 *
 * ## An object with no recorded hash is reported, not omitted
 *
 * `recordedSha256: null` means the bucket holds something no live row names. That is `reconcile.ts`'s
 * "object, no referent" — safe to delete after a grace period, and **not** safe to leave out of an inventory:
 * a backup that silently drops what it cannot explain is a backup that restores less than the operator
 * thinks. The count of them is returned so a caller can say how much of the bucket is accounted for.
 */

/**
 * Where a hash comes from, per prefix.
 *
 * Six rows, because `send_manifests` stages three objects per send — and grouped by the prefix **segment**
 * rather than left as a flat list, for a reason D1 supplied: a single `UNION ALL` over all six answered
 * *"too many terms in compound SELECT"*. The limit turned a design choice into the right design. A page is
 * always from one prefix, so only that prefix's referents can possibly name its keys; joining a page of raw
 * mail against the drafts table was pointless work as well as one arm too many.
 *
 * Worst case is now three arms, for `sent/`.
 *
 * **`bytes` is here for the verifier, which reads this same list** (#131). It names the column recording the
 * plaintext's length at the time it was sealed, and it is `null` on two tables that never recorded one — so
 * an `altered` fault on a draft can say *"1,024 bytes when sealed, 900 now"* and one on a send cannot. Stated
 * in the list rather than discovered per caller: the alternative was the verifier keeping a second table of
 * which columns exist, and a second list of prefixes is precisely how #67, #74 and #131 happened.
 */
const REFERENTS = [
  { segment: "raw", table: "ingress_receipts", key: "blob_key", hash: "blob_sha256", bytes: "raw_bytes" },
  { segment: "drafts", table: "drafts", key: "body_key", hash: "body_sha256", bytes: "body_bytes" },
  { segment: "exports", table: "exports", key: "manifest_key", hash: "manifest_sha256", bytes: null },
  {
    segment: "sent", table: "send_manifests",
    key: "body_typed_key", hash: "body_typed_sha256", bytes: null,
  },
  {
    segment: "sent", table: "send_manifests",
    key: "body_normalized_key", hash: "body_normalized_sha256", bytes: null,
  },
  {
    segment: "sent", table: "send_manifests",
    key: "submitted_key", hash: "submitted_sha256", bytes: null,
  },
] as const;

/**
 * The segment a prefix walks, out of `${orgId}/<segment>/`.
 *
 * Read from the prefix rather than from the loop index, so the referents cannot silently pair with the wrong
 * prefix if `scannedPrefixes` ever reorders. That function's contract is *which* prefixes exist, not what
 * order they come in.
 */
function segmentOf(prefix: string): string {
  return prefix.replace(/\/$/, "").split("/").at(-1) ?? "";
}

/**
 * The page size, borrowed from the reconciler rather than measured again.
 *
 * A page here costs one `R2.list` and one D1 query — strictly less than a reconcile page, which is measured
 * at this figure in `evidence-lifecycle.md`. Reusing a bound that is known to fit is honest; inventing a
 * second, larger one for a cheaper operation would be a number nobody measured.
 */
const PAGE = BUDGETS["reconcile.list_limit"];

export interface InventoryObject {
  key: string;
  bytes: number;
  uploaded: string;
  /** Which content key sealed it. Absent metadata is generation 0, the published pre-vault constant. */
  keyGeneration: number;
  /** What the plaintext should hash to, or `null` for an object no live row names. */
  recordedSha256: string | null;
}

export interface InventoryPage {
  objects: InventoryObject[];
  /** Opaque. Encodes which prefix is being walked and where in it — never construct one by hand. */
  resumeAfter: string | null;
  /** Objects in this page that no live row names, so a caller can total what is unaccounted for. */
  unaccounted: number;
}

/**
 * A cursor that walks a list of things and holds a position inside one, as `<index>:<within>`.
 *
 * R2 gives a cursor per `list`, and there are four prefixes to walk, so paging needs to remember both. The
 * index is first and the remainder is `within` — split once rather than on every colon, because an R2 cursor
 * is opaque and may contain anything.
 *
 * Exported because `evidence-audit.ts` needs the same shape for a different `within` — a row id rather than
 * an R2 cursor (#131). One implementation, because two cursor formats that are *nearly* the same is how a
 * resumed sweep silently restarts at the beginning of the wrong table.
 *
 * Malformed input decodes to the beginning rather than throwing. A cursor is an opaque string a caller echoes
 * back, so the reachable faults are truncation and hand-editing, and starting over is the only answer that
 * cannot skip evidence — the direction this must never be wrong in.
 */
export function splitCursor(cursor: string | null): { index: number; within: string | undefined } {
  if (cursor === null || cursor === "") return { index: 0, within: undefined };
  const split = cursor.indexOf(":");
  if (split === -1) return { index: 0, within: undefined };
  const index = Number(cursor.slice(0, split));
  const within = cursor.slice(split + 1);
  return {
    index: Number.isInteger(index) && index >= 0 ? index : 0,
    within: within === "" ? undefined : within,
  };
}

export async function inventoryPage(
  env: Env,
  orgId: string,
  cursor: string | null = null,
  page: number = PAGE,
): Promise<InventoryPage> {
  const prefixes = scannedPrefixes(orgId);
  const { index, within } = splitCursor(cursor);

  /*
   * Walk forward until a prefix yields something or they are exhausted. An empty prefix must not end the
   * sweep: a Node with no drafts would otherwise stop before reaching its exports, and report a partial
   * inventory as a complete one — the failure this whole feature exists to prevent, one level up.
   */
  let at = index;
  let listed: R2Objects | null = null;
  let carried = within;
  while (at < prefixes.length) {
    /*
     * **`include: ["customMetadata"]`, or `keyGeneration` is a constant** (#141).
     *
     * R2 returns custom metadata from `list` only when asked — honoured since compatibility date 2022-08-04,
     * and this Worker's is far later. Without it `generationOf` saw `customMetadata: undefined` on every
     * object and fell back to generation 0, so **every inventory ever produced recorded generation 0 for
     * everything**, including objects `putEvidence` had sealed under generation 1. Measured on two live
     * Nodes, which both reported 0 for objects their own Workers could open.
     *
     * That is the field saying *which key opens this object*, in a backup artifact, wrong in the direction
     * that looks harmless — and it is the one check that would have caught #142, a copy whose metadata was
     * stripped, before an operator relied on it.
     *
     * Cloudflare documents that a page with `include` may return **fewer** than `limit` objects to make room
     * for the metadata. That is already safe here: `truncated` decides whether to continue, never the page
     * being full, and the comment on `resumeAfter` below says why.
     */
    listed = await env.EVIDENCE.list({
      prefix: prefixes[at], cursor: carried, limit: page, include: ["customMetadata"],
    });
    if (listed.objects.length > 0 || listed.truncated) break;
    at += 1;
    carried = undefined;
    listed = null;
  }

  if (listed === null) return { objects: [], resumeAfter: null, unaccounted: 0 };

  const keys = listed.objects.map((one) => one.key);
  const recorded = await hashesFor(env, orgId, keys, segmentOf(prefixes[at] as string));

  const objects: InventoryObject[] = listed.objects.map((one) => ({
    key: one.key,
    bytes: one.size,
    uploaded: one.uploaded.toISOString(),
    keyGeneration: generationOf(one),
    recordedSha256: recorded.get(one.key) ?? null,
  }));

  /*
   * `truncated` decides, never the page being full. R2 returns a cursor with a full page that happens to be
   * the last one, and treating a full page as "there is more" costs an empty request; treating a cursor's
   * presence as "there is more" would loop forever.
   */
  const resumeAfter = listed.truncated
    ? `${at}:${listed.cursor ?? ""}`
    : at + 1 < prefixes.length ? `${at + 1}:` : null;

  return {
    objects,
    resumeAfter,
    unaccounted: objects.filter((one) => one.recordedSha256 === null).length,
  };
}

/**
 * The recorded hash for each key, from the tables that can name **this prefix's** objects.
 *
 * One query per page. A statement per referent would be six subrequests per page and would put the
 * inventory's cost above the reconciler's, which is where the borrowed page size stops being justified.
 */
async function hashesFor(
  env: Env,
  orgId: string,
  keys: string[],
  segment: string,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const referents = REFERENTS.filter((one) => one.segment === segment);
  if (keys.length === 0 || referents.length === 0) return found;

  const holes = keys.map(() => "?").join(",");
  const arms = referents.map((one) =>
    `SELECT ${one.key} AS k, ${one.hash} AS h FROM ${one.table}
       WHERE org_id = ? AND ${one.key} IN (${holes})`);
  const binds = referents.flatMap(() => [orgId, ...keys]);

  const rows = await env.CATALOG.prepare(arms.join("\n UNION ALL "))
    .bind(...binds)
    .all<{ k: string | null; h: string | null }>();

  for (const row of rows.results) {
    if (typeof row.k === "string" && typeof row.h === "string") found.set(row.k, row.h);
  }
  return found;
}

/** The referent columns, for the closed-world test that checks every prefix has one. */
export const INVENTORY_REFERENTS = REFERENTS;
